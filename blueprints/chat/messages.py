import re
import json
import html
import logging
from collections.abc import Iterator
from datetime import date
from typing import Any

from fastapi import Request
from starlette.responses import StreamingResponse

from services.async_utils import run_blocking
from services.db import get_db_connection
from services.chat_service import (
    save_message_to_db,
    get_chat_room_messages,
    validate_room_owner,
)
from services.llm_daily_limit import consume_llm_daily_quota
from services.llm import (
    get_llm_response,
    get_llm_response_stream,
    GEMINI_DEFAULT_MODEL,
    LlmInvalidModelError,
    LlmServiceError,
    is_streaming_model,
)
from services.request_models import ChatMessageRequest
from services.web import (
    jsonify,
    log_and_internal_server_error,
    require_json_dict,
    validate_payload_model,
)

from . import (
    chat_bp,
    get_session_id,
    cleanup_ephemeral_chats,
    ephemeral_store,
)

logger = logging.getLogger(__name__)

BASE_SYSTEM_PROMPT = """
あなたは、ユーザーをサポートする優秀なAIアシスタントです。
以下のガイドラインに従って、視覚的に分かりやすく、構造化された回答を生成してください。

1. **Markdownの積極的な活用**:
   - 回答の主要なセクションには「## 見出し」を使用してください。
   - 重要なポイントは **太字** で強調してください。
   - 情報を整理する際は、箇条書き（- または 1.）を使用してください。
   - 比較やデータを示す場合は、Markdownの表形式（Table）を活用してください。

2. **コードブロック**:
   - プログラミングコードやコマンド、設定ファイルの内容を出力する場合は、必ず適切な言語指定（例: ```python）を伴うコードブロックを使用してください。

3. **回答の構成**:
   - 最初に簡潔な結論や要約を述べ、その後に詳細な説明を続ける構成にしてください。
   - 長い回答になる場合は、適宜「### 小見出し」を使って論点を整理してください。

4. **few-shot例の扱い**:
   - 「入力例:」と「出力例:」が提供されることがありますが、これらはあくまで参考です。
   - ユーザーが【リクエスト】で求めている内容を最優先し、最新のコンテキストに合わせて最適な回答を提供してください。

回答は常に親切かつプロフェッショナルなトーンで、日本語で行ってください。
"""


def _sse_event(event: str, payload: dict[str, Any]) -> bytes:
    # SSE 形式で JSON ペイロードを1イベントとして返す
    # Encode one JSON payload as an SSE event.
    body = json.dumps(payload, ensure_ascii=False)
    return f"event: {event}\ndata: {body}\n\n".encode("utf-8")


def _iter_llm_stream_events(
    conversation_messages: list[dict[str, str]],
    model: str,
    *,
    chat_room_id: str,
    is_authenticated: bool,
    sid: str | None,
) -> Iterator[bytes]:
    # LLM 応答を SSE で配信し、配信完了後に履歴へ保存する
    # Stream LLM output via SSE and persist the final message on completion.
    chunks: list[str] = []
    try:
        for chunk in get_llm_response_stream(conversation_messages, model):
            chunks.append(chunk)
            yield _sse_event("chunk", {"text": chunk})
    except LlmServiceError:
        yield _sse_event("error", {"message": "内部エラーが発生しました。"})
        return

    bot_reply = "".join(chunks)

    try:
        if is_authenticated:
            save_message_to_db(chat_room_id, bot_reply, "assistant")
        elif sid is not None:
            ephemeral_store.append_message(sid, chat_room_id, "assistant", bot_reply)
    except Exception:
        logger.exception("Failed to persist streamed LLM response.")
        yield _sse_event("error", {"message": "応答は生成されましたが、履歴保存に失敗しました。"})
        return

    yield _sse_event("done", {"response": bot_reply})


def _build_llm_stream_response(
    conversation_messages: list[dict[str, str]],
    model: str,
    *,
    chat_room_id: str,
    is_authenticated: bool,
    sid: str | None,
) -> StreamingResponse:
    # 同期ジェネレータを StreamingResponse でラップして SSE 配信する
    # Wrap the sync generator with StreamingResponse for SSE delivery.

    return StreamingResponse(
        _iter_llm_stream_events(
            conversation_messages,
            model,
            chat_room_id=chat_room_id,
            is_authenticated=is_authenticated,
            sid=sid,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _fetch_prompt_data(task: str) -> dict[str, Any] | None:
    # タスク名に対応するプロンプトテンプレートとfew-shot例を取得する
    # Fetch prompt template and few-shot examples for a given task name.
    conn = None
    cursor = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        query = (
            "SELECT prompt_template, input_examples, output_examples "
            "FROM task_with_examples WHERE name = %s"
        )
        cursor.execute(query, (task,))
        return cursor.fetchone()
    finally:
        if cursor is not None:
            cursor.close()
        if conn is not None:
            conn.close()


def _fetch_chat_history(chat_room_id: str) -> list[dict[str, str]]:
    # API返却向けにチャット履歴を時系列で整形する
    # Fetch and format chat history in chronological order for API response.
    conn = None
    cursor = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        query = """
            SELECT message, sender, timestamp
            FROM chat_history
            WHERE chat_room_id = %s
            ORDER BY id ASC
        """
        cursor.execute(query, (chat_room_id,))
        rows = cursor.fetchall()
        messages = []
        for (msg, sender, ts) in rows:
            messages.append(
                {
                    "message": msg,
                    "sender": sender,
                    "timestamp": ts.strftime("%Y-%m-%d %H:%M:%S"),
                }
            )
        return messages
    finally:
        if cursor is not None:
            cursor.close()
        if conn is not None:
            conn.close()


@chat_bp.post("/api/chat", name="chat.chat")
async def chat(request: Request):
    await run_blocking(cleanup_ephemeral_chats)
    data, error_response = await require_json_dict(request)
    if error_response is not None:
        return error_response

    payload, validation_error = validate_payload_model(
        data,
        ChatMessageRequest,
        error_message="'message' が必要です。",
    )
    if validation_error is not None:
        return validation_error

    user_message = payload.message
    chat_room_id = payload.chat_room_id
    model = payload.model or GEMINI_DEFAULT_MODEL

    # 非ログインユーザーの場合、新規チャット・続けてのチャットの回数としてカウント
    # Count each guest request toward daily free chat quota.
    session = request.session
    if "user_id" not in session:
        today = date.today().isoformat()
        if session.get("free_chats_date") != today:
            session["free_chats_date"] = today
            session["free_chats_count"] = 0
        if session.get("free_chats_count", 0) >= 10:
            return jsonify({"error": "1日10回までです"}, status_code=403)
        session["free_chats_count"] = session.get("free_chats_count", 0) + 1

    system_prompt = {
        "role": "system",
        "content": BASE_SYSTEM_PROMPT,
    }

    match = re.match(r"【状況・作業環境】(.+)\n【リクエスト】(.+)", user_message)

    sid = None
    if "user_id" in session:
        try:
            payload, status_code = await run_blocking(
                validate_room_owner,
                chat_room_id,
                session["user_id"],
                "他ユーザーのチャットルームには投稿できません",
            )
            if payload is not None:
                return jsonify(payload, status_code=status_code)
        except Exception:
            return log_and_internal_server_error(
                logger,
                "Failed to validate chat room ownership before posting.",
            )

        escaped = html.escape(user_message)
        formatted_user_message = escaped.replace("\n", "<br>")

        await run_blocking(save_message_to_db, chat_room_id, formatted_user_message, "user")
        all_messages = await run_blocking(get_chat_room_messages, chat_room_id)
    else:
        sid = get_session_id(session)
        if not await run_blocking(ephemeral_store.room_exists, sid, chat_room_id):
            return jsonify({"error": "該当ルームが存在しません"}, status_code=404)

        escaped = html.escape(user_message)
        formatted_user_message = escaped.replace("\n", "<br>")
        await run_blocking(
            ephemeral_store.append_message, sid, chat_room_id, "user", formatted_user_message
        )
        all_messages = await run_blocking(ephemeral_store.get_messages, sid, chat_room_id)

    extra_prompt = None
    # 後段で条件付き few-shot を組み立てるための初期化
    # Initialize holder for optional few-shot prompt data.
    prompt_data = None

    if match and len(all_messages) == 1:
        task = match.group(2).strip()

        # DBから指定タスクのプロンプトテンプレートと few-shot 例を取得する
        # Load task-specific prompt template and few-shot examples from DB.
        prompt_data = await run_blocking(_fetch_prompt_data, task)

    conversation_messages = []

    if prompt_data:
        input_examples_str = prompt_data.get("input_examples", "")
        output_examples_str = prompt_data.get("output_examples", "")
        extra_prompt = ""

        def parse_examples(ex_str: str) -> list[str]:
            if not ex_str:
                return []
            ex_str = ex_str.strip()
            if ex_str.startswith("["):
                try:
                    return json.loads(ex_str)
                except Exception:
                    logger.warning("Failed to parse examples JSON; using raw text fallback.")
                    return [ex_str]
            else:
                return [ex_str]

        loaded_input_examples = parse_examples(input_examples_str)
        loaded_output_examples = parse_examples(output_examples_str)

        num_examples = min(len(loaded_input_examples), len(loaded_output_examples))
        if num_examples > 0:
            few_shot_text_lines = []
            for i in range(num_examples):
                inp_text = loaded_input_examples[i].strip()
                out_text = loaded_output_examples[i].strip()
                few_shot_text_lines.append("Q{}: {}\nA{}: {}".format(i+1, inp_text, i+1, out_text))
            extra_prompt = "\n\n".join(few_shot_text_lines)

        conversation_messages.append({
            "role": "system",
            "content": BASE_SYSTEM_PROMPT,
        })
        conversation_messages.append({
            "role": "system",
            "content": extra_prompt,
        })
    else:
        conversation_messages.append(system_prompt)

    conversation_messages += all_messages

    can_access_llm, _, daily_limit = await run_blocking(consume_llm_daily_quota)
    if not can_access_llm:
        return jsonify(
            {
                "error": (
                    f"本日のLLM API利用上限（全ユーザー合計 {daily_limit} 回）に達しました。"
                    "日付が変わってから再度お試しください。"
                )
            },
            status_code=429,
        )

    if is_streaming_model(model):
        return _build_llm_stream_response(
            conversation_messages,
            model,
            chat_room_id=chat_room_id,
            is_authenticated="user_id" in session,
            sid=sid,
        )

    try:
        bot_reply = await run_blocking(get_llm_response, conversation_messages, model)
    except LlmInvalidModelError as exc:
        return jsonify({"error": str(exc)}, status_code=400)
    except LlmServiceError:
        return log_and_internal_server_error(
            logger,
            "Failed to get LLM response.",
        )

    if "user_id" in session:
        await run_blocking(save_message_to_db, chat_room_id, bot_reply, "assistant")
    else:
        sid = get_session_id(session)
        await run_blocking(ephemeral_store.append_message, sid, chat_room_id, "assistant", bot_reply)

    return jsonify({"response": bot_reply})


@chat_bp.get("/api/get_chat_history", name="chat.get_chat_history")
async def get_chat_history(request: Request):
    await run_blocking(cleanup_ephemeral_chats)
    chat_room_id = request.query_params.get('room_id')
    if not chat_room_id:
        return jsonify({"error": "room_id is required"}, status_code=400)

    session = request.session
    if "user_id" in session:
        try:
            payload, status_code = await run_blocking(
                validate_room_owner,
                chat_room_id,
                session["user_id"],
                "他ユーザーのチャット履歴は見れません",
            )
            if payload is not None:
                return jsonify(payload, status_code=status_code)
        except Exception:
            return log_and_internal_server_error(
                logger,
                "Failed to validate chat room ownership before history fetch.",
            )

        try:
            messages = await run_blocking(_fetch_chat_history, chat_room_id)
            return jsonify({"messages": messages})
        except Exception:
            return log_and_internal_server_error(
                logger,
                "Failed to fetch chat history.",
            )
    else:
        sid = get_session_id(session)
        if not await run_blocking(ephemeral_store.room_exists, sid, chat_room_id):
            return jsonify({"error": "該当ルームが存在しません"}, status_code=404)

        messages = await run_blocking(ephemeral_store.get_messages, sid, chat_room_id)
        return jsonify({"messages": messages})
