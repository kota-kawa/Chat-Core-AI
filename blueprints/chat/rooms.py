from datetime import date
import logging
from typing import Any

from fastapi import Request

from services.async_utils import run_blocking
from services.db import get_db_connection
from services.chat_service import (
    create_or_get_shared_chat_token,
    create_chat_room_in_db,
    get_shared_chat_room_payload,
    rename_chat_room_in_db,
    validate_room_owner,
)

from services.request_models import (
    ChatRoomIdRequest,
    NewChatRoomRequest,
    RenameChatRoomRequest,
    ShareChatRoomRequest,
)
from services.web import (
    frontend_url,
    jsonify,
    log_and_internal_server_error,
    require_json_dict,
    validate_payload_model,
)

from . import chat_bp, cleanup_ephemeral_chats, ephemeral_store, get_session_id

logger = logging.getLogger(__name__)


def _fetch_user_rooms(user_id: int) -> list[dict[str, Any]]:
    # 認証ユーザーのチャットルーム一覧を新しい順で取得する
    # Fetch authenticated user's chat rooms ordered by newest first.
    conn = None
    cursor = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        query = """
            SELECT id, title, created_at
            FROM chat_rooms
            WHERE user_id = %s
            ORDER BY created_at DESC
        """
        cursor.execute(query, (user_id,))
        rows = cursor.fetchall()
        rooms = []
        for (room_id, title, created_at) in rows:
            rooms.append(
                {
                    "id": room_id,
                    "title": title,
                    "created_at": created_at.strftime("%Y-%m-%d %H:%M:%S"),
                }
            )
        return rooms
    finally:
        if cursor is not None:
            cursor.close()
        if conn is not None:
            conn.close()


def _delete_room_for_user(room_id: str, user_id: int) -> tuple[dict[str, str], int]:
    # 所有者確認後に履歴→ルームの順で削除し、整合性を保つ
    # Validate owner, then delete history and room to keep data consistent.
    conn = None
    cursor = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        check_q = "SELECT user_id FROM chat_rooms WHERE id = %s"
        cursor.execute(check_q, (room_id,))
        result = cursor.fetchone()
        if not result:
            return {"error": "該当ルームが存在しません"}, 404
        if result[0] != user_id:
            return {"error": "他ユーザーのチャットルームは削除できません"}, 403

        del_history_q = "DELETE FROM chat_history WHERE chat_room_id = %s"
        cursor.execute(del_history_q, (room_id,))
        del_room_q = "DELETE FROM chat_rooms WHERE id = %s"
        cursor.execute(del_room_q, (room_id,))
        conn.commit()
        return {"message": "削除しました"}, 200
    finally:
        if cursor is not None:
            cursor.close()
        if conn is not None:
            conn.close()


@chat_bp.post("/api/new_chat_room", name="chat.new_chat_room")
async def new_chat_room(request: Request):
    await run_blocking(cleanup_ephemeral_chats)
    data, error_response = await require_json_dict(request)
    if error_response is not None:
        return error_response

    payload, validation_error = validate_payload_model(
        data,
        NewChatRoomRequest,
        error_message="'id' フィールドが必要です。",
    )
    if validation_error is not None:
        return validation_error

    room_id = payload.id
    title = payload.title

    session = request.session
    if "user_id" in session:
        # ログインユーザーの場合はDBに保存（利用回数制限なし）
        # Persist for authenticated users in DB without daily free limit.
        user_id = session["user_id"]
        try:
            await run_blocking(create_chat_room_in_db, room_id, user_id, title)
            return jsonify(
                {
                    "message": "チャットルームが作成されました。",
                    "id": room_id,
                    "title": title,
                },
                status_code=201,
            )
        except Exception:
            return log_and_internal_server_error(
                logger,
                "Failed to create chat room for authenticated user.",
            )
    else:
        # 非ログインユーザーの場合は、1日10回まで利用可能
        # Guests can create chats up to 10 times per day.
        today = date.today().isoformat()
        if session.get("free_chats_date") != today:
            session["free_chats_date"] = today
            session["free_chats_count"] = 0
        if session.get("free_chats_count", 0) >= 10:
            return jsonify({"error": "1日10回までです"}, status_code=403)
        session["free_chats_count"] = session.get("free_chats_count", 0) + 1

        sid = get_session_id(session)
        await run_blocking(ephemeral_store.create_room, sid, room_id, title)

        return jsonify(
            {
                "message": "エフェメラルチャットルームが作成されました。",
                "id": room_id,
                "title": title,
            },
            status_code=201,
        )


@chat_bp.get("/api/get_chat_rooms", name="chat.get_chat_rooms")
async def get_chat_rooms(request: Request):
    await run_blocking(cleanup_ephemeral_chats)
    session = request.session
    if "user_id" in session:
        # ログインユーザー：DBから取得
        # Authenticated users read room list from DB.
        user_id = session["user_id"]
        try:
            rooms = await run_blocking(_fetch_user_rooms, user_id)
            return jsonify({"rooms": rooms})
        except Exception:
            return log_and_internal_server_error(
                logger,
                "Failed to fetch chat rooms for authenticated user.",
            )
    else:
        # 非ログインユーザーにはサイドバー上でチャットルーム一覧は表示しない
        # Do not show sidebar room list for guests.
        return jsonify({"rooms": []})


@chat_bp.post("/api/delete_chat_room", name="chat.delete_chat_room")
async def delete_chat_room(request: Request):
    await run_blocking(cleanup_ephemeral_chats)
    data, error_response = await require_json_dict(request)
    if error_response is not None:
        return error_response

    payload, validation_error = validate_payload_model(
        data,
        ChatRoomIdRequest,
        error_message="room_id is required",
    )
    if validation_error is not None:
        return validation_error

    room_id = payload.room_id

    session = request.session
    if "user_id" in session:
        try:
            payload, status_code = await run_blocking(
                _delete_room_for_user, room_id, session["user_id"]
            )
            return jsonify(payload, status_code=status_code)
        except Exception:
            return log_and_internal_server_error(
                logger,
                "Failed to delete chat room for authenticated user.",
            )
    else:
        sid = get_session_id(session)
        if not await run_blocking(ephemeral_store.delete_room, sid, room_id):
            return jsonify({"error": "該当ルームが存在しません"}, status_code=404)
        return jsonify({"message": "エフェメラルチャットルームを削除しました"}, status_code=200)


@chat_bp.post("/api/rename_chat_room", name="chat.rename_chat_room")
async def rename_chat_room(request: Request):
    await run_blocking(cleanup_ephemeral_chats)
    data, error_response = await require_json_dict(request)
    if error_response is not None:
        return error_response

    payload, validation_error = validate_payload_model(
        data,
        RenameChatRoomRequest,
        error_message="room_id と new_title が必要です",
    )
    if validation_error is not None:
        return validation_error

    room_id = payload.room_id
    new_title = payload.new_title

    session = request.session
    if "user_id" in session:
        try:
            payload, status_code = await run_blocking(
                validate_room_owner,
                room_id,
                session["user_id"],
                "他ユーザーのチャットルームは変更できません",
            )
            if payload is not None:
                return jsonify(payload, status_code=status_code)

            await run_blocking(rename_chat_room_in_db, room_id, new_title)
            return jsonify({"message": "ルーム名を変更しました"}, status_code=200)
        except Exception:
            return log_and_internal_server_error(
                logger,
                "Failed to rename chat room for authenticated user.",
            )
    else:
        sid = get_session_id(session)
        if not await run_blocking(ephemeral_store.rename_room, sid, room_id, new_title):
            return jsonify({"error": "該当ルームが存在しません"}, status_code=404)
        return jsonify({"message": "ルーム名を変更しました"}, status_code=200)


@chat_bp.post("/api/share_chat_room", name="chat.share_chat_room")
async def share_chat_room(request: Request):
    await run_blocking(cleanup_ephemeral_chats)
    data, error_response = await require_json_dict(request)
    if error_response is not None:
        return error_response

    payload, validation_error = validate_payload_model(
        data,
        ShareChatRoomRequest,
        error_message="room_id is required",
    )
    if validation_error is not None:
        return validation_error

    user_id = request.session.get("user_id")
    if not user_id:
        return jsonify({"error": "ログインが必要です"}, status_code=403)

    room_id = payload.room_id
    try:
        owner_error, owner_status = await run_blocking(
            validate_room_owner,
            room_id,
            user_id,
            "他ユーザーのチャットルームは共有できません",
        )
        if owner_error is not None:
            return jsonify(owner_error, status_code=owner_status)

        share_token, status_code = await run_blocking(create_or_get_shared_chat_token, room_id)
        if status_code == 404 or not share_token:
            return jsonify({"error": "該当ルームが存在しません"}, status_code=404)
        share_url = frontend_url(f"/shared/{share_token}")
        return jsonify(
            {
                "share_token": share_token,
                "share_url": share_url,
            }
        )
    except Exception:
        return log_and_internal_server_error(
            logger,
            "Failed to create share link for chat room.",
        )


@chat_bp.get("/api/shared_chat_room", name="chat.shared_chat_room")
async def shared_chat_room(request: Request):
    await run_blocking(cleanup_ephemeral_chats)
    token = (request.query_params.get("token") or "").strip()
    if not token:
        return jsonify({"error": "token is required"}, status_code=400)

    try:
        payload, status_code = await run_blocking(get_shared_chat_room_payload, token)
        return jsonify(payload, status_code=status_code or 200)
    except Exception:
        return log_and_internal_server_error(
            logger,
            "Failed to fetch shared chat room payload.",
        )
