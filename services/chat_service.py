import secrets
from typing import Any

from .db import get_db_connection


def save_message_to_db(chat_room_id: str, message: str, sender: str) -> None:
    # チャットメッセージを履歴テーブルへ追加する
    # Insert a chat message into the history table.
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        query = "INSERT INTO chat_history (chat_room_id, message, sender) VALUES (%s, %s, %s)"
        cursor.execute(query, (chat_room_id, message, sender))
        conn.commit()
    finally:
        cursor.close()
        conn.close()


def create_chat_room_in_db(room_id: str, user_id: int, title: str) -> None:
    # チャットルームのメタ情報を保存する
    # Persist chat room metadata.
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        query = "INSERT INTO chat_rooms (id, user_id, title) VALUES (%s, %s, %s)"
        cursor.execute(query, (room_id, user_id, title))
        conn.commit()
    finally:
        cursor.close()
        conn.close()


def rename_chat_room_in_db(room_id: str, new_title: str) -> None:
    # 既存チャットルームのタイトルを更新する
    # Update the title of an existing chat room.
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        query = "UPDATE chat_rooms SET title = %s WHERE id = %s"
        cursor.execute(query, (new_title, room_id))
        conn.commit()
    finally:
        cursor.close()
        conn.close()


def get_chat_room_messages(chat_room_id: str) -> list[dict[str, str]]:
    # LLM へ渡す role/content 形式で履歴を整形して返す
    # Return history formatted as role/content messages for LLM calls.
    """GPTへのAPI呼び出しに使う形で取得"""
    conn = get_db_connection()
    cursor = conn.cursor()
    messages = []
    try:
        query = (
            "SELECT message, sender FROM chat_history WHERE chat_room_id = %s ORDER BY id ASC"
        )
        cursor.execute(query, (chat_room_id,))
        rows = cursor.fetchall()
        for (message, sender) in rows:
            role = 'user' if sender == 'user' else 'assistant'
            messages.append({"role": role, "content": message})
        return messages
    finally:
        cursor.close()
        conn.close()


def validate_room_owner(
    room_id: str, user_id: int, forbidden_message: str
) -> tuple[dict[str, str] | None, int | None]:
    # 指定ルームの所有者チェックを行い、失敗時はAPI返却形式で返す
    # Validate room ownership and return API-shaped error on failure.
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
            return {"error": forbidden_message}, 403
        return None, None
    finally:
        if cursor is not None:
            cursor.close()
        if conn is not None:
            conn.close()


def create_or_get_shared_chat_token(room_id: str) -> tuple[str | None, int | None]:
    # 共有リンク用トークンを作成し、既存がある場合は再利用する
    # Create share token for a room and reuse the existing one when present.
    conn = None
    cursor = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT share_token FROM shared_chat_rooms WHERE chat_room_id = %s",
            (room_id,),
        )
        existing = cursor.fetchone()
        if existing:
            return existing[0], None

        cursor.execute("SELECT 1 FROM chat_rooms WHERE id = %s", (room_id,))
        if not cursor.fetchone():
            return None, 404

        while True:
            token = secrets.token_urlsafe(18)
            cursor.execute(
                "SELECT 1 FROM shared_chat_rooms WHERE share_token = %s",
                (token,),
            )
            if cursor.fetchone():
                continue

            cursor.execute(
                """
                INSERT INTO shared_chat_rooms (chat_room_id, share_token)
                VALUES (%s, %s)
                """,
                (room_id, token),
            )
            conn.commit()
            return token, None
    finally:
        if cursor is not None:
            cursor.close()
        if conn is not None:
            conn.close()


def get_shared_chat_room_payload(
    token: str,
) -> tuple[dict[str, Any] | None, int | None]:
    # 共有トークンに対応する公開チャット履歴を返す
    # Return publicly viewable chat payload for the given share token.
    conn = None
    cursor = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT cr.id, cr.title, cr.created_at
              FROM shared_chat_rooms scr
              JOIN chat_rooms cr ON cr.id = scr.chat_room_id
             WHERE scr.share_token = %s
             LIMIT 1
            """,
            (token,),
        )
        room_row = cursor.fetchone()
        if not room_row:
            return {"error": "共有リンクが見つかりません"}, 404

        room_id, title, created_at = room_row
        cursor.execute(
            """
            SELECT message, sender, timestamp
              FROM chat_history
             WHERE chat_room_id = %s
             ORDER BY id ASC
            """,
            (room_id,),
        )
        rows = cursor.fetchall()
        messages = []
        for (message, sender, timestamp) in rows:
            messages.append(
                {
                    "message": message,
                    "sender": sender,
                    "timestamp": timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                }
            )

        return (
            {
                "room": {
                    "id": room_id,
                    "title": title,
                    "created_at": created_at.strftime("%Y-%m-%d %H:%M:%S"),
                },
                "messages": messages,
            },
            200,
        )
    finally:
        if cursor is not None:
            cursor.close()
        if conn is not None:
            conn.close()
