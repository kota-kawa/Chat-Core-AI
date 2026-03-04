from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Tuple, TypeVar
from urllib.parse import urlencode, urlsplit

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, ValidationError
from starlette.responses import JSONResponse, RedirectResponse

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:3000")
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_INTERNAL_ERROR_MESSAGE = "内部エラーが発生しました。"
ModelT = TypeVar("ModelT", bound=BaseModel)


async def get_json(request: Request) -> Any | None:
    # JSONパース失敗時は例外を外へ出さず None を返す
    # Return None instead of raising when JSON parsing fails.
    try:
        return await request.json()
    except Exception:
        return None


def jsonify(payload: Any, status_code: int = 200) -> JSONResponse:
    # FastAPI 互換のJSONエンコードを通してレスポンスを返す
    # Build a JSON response via FastAPI-compatible jsonable encoding.
    return JSONResponse(content=jsonable_encoder(payload), status_code=status_code)


def log_and_internal_server_error(
    logger: logging.Logger,
    context: str,
    *,
    status: str | None = None,
    message: str = DEFAULT_INTERNAL_ERROR_MESSAGE,
    error_key: str = "error",
) -> JSONResponse:
    # ログ出力と500レスポンス生成を共通化する
    # Centralize exception logging and HTTP 500 response creation.
    logger.exception(context)
    payload: Dict[str, Any] = {error_key: message}
    if status is not None:
        payload["status"] = status
    return jsonify(payload, status_code=500)


async def require_json_dict(
    request: Request,
    *,
    error_message: str = "JSON形式が不正です。",
    status: str | None = None,
) -> tuple[Dict[str, Any] | None, JSONResponse | None]:
    # リクエストボディがdictであることを保証し、違う場合は400を返す
    # Ensure request body is a dict; otherwise return HTTP 400 response.
    data = await get_json(request)
    if isinstance(data, dict):
        return data, None

    payload: Dict[str, Any] = {"error": error_message}
    if status is not None:
        payload["status"] = status
    return None, jsonify(payload, status_code=400)


def validate_payload_model(
    data: Dict[str, Any],
    model_class: type[ModelT],
    *,
    error_message: str,
    status: str | None = None,
    error_key: str = "error",
) -> tuple[ModelT | None, JSONResponse | None]:
    # Pydantic v2/v1 両対応でバリデーションし、失敗時は統一エラーを返す
    # Validate payload with Pydantic v2/v1 compatibility and return unified errors.
    try:
        validate = getattr(model_class, "model_validate", None)
        if callable(validate):
            return validate(data), None
        return model_class.parse_obj(data), None  # pragma: no cover - pydantic v1 fallback
    except ValidationError:
        payload: Dict[str, Any] = {error_key: error_message}
        if status is not None:
            payload["status"] = status
        return None, jsonify(payload, status_code=400)


def set_session_permanent(session: dict, value: bool) -> None:
    # セッション永続化フラグを明示的に付与/削除する
    # Explicitly set or clear the session permanence flag.
    if value:
        session["_permanent"] = True
    else:
        session.pop("_permanent", None)


def flash(request: Request, message: str, category: str = "message") -> None:
    # セッションに一時メッセージを積む
    # Push a flash message into session storage.
    flashes: List[Tuple[str, str]] = request.session.setdefault("_flashes", [])
    flashes.append((category, message))


def get_flashed_messages(
    request: Request, *, with_categories: bool = False
) -> List[str] | List[Tuple[str, str]]:
    # 1回読み取りで消費されるフラッシュメッセージを取得する
    # Pop one-time flash messages from session.
    flashes = request.session.pop("_flashes", [])
    if with_categories:
        return flashes
    return [message for _, message in flashes]


def url_for(request: Request, endpoint: str, **values: Any) -> str:
    # FastAPI の URL 生成に query/path パラメータ分離を加え、Flask互換呼び出しを吸収する
    # Extend FastAPI URL building with path/query split for Flask-style compatibility.
    external = values.pop("_external", False)
    if "filename" in values and "path" not in values:
        values["path"] = values.pop("filename")

    path_param_names: List[str] = []
    for route in request.app.router.routes:
        if getattr(route, "name", None) == endpoint:
            path_param_names = list(getattr(route, "param_convertors", {}).keys())
            break

    path_params = {}
    for key in list(values.keys()):
        if key in path_param_names:
            path_params[key] = values.pop(key)

    url = request.url_for(endpoint, **path_params)
    if values:
        url = url.include_query_params(**values)

    if external:
        return str(url)

    if url.query:
        return f"{url.path}?{url.query}"
    return url.path


def frontend_url(path: str = "", *, query: str | None = None) -> str:
    # フロントエンドURLを安全に連結して返す
    # Build an absolute frontend URL with normalized path/query.
    base = FRONTEND_URL.rstrip("/")
    if path:
        normalized = path if path.startswith("/") else f"/{path}"
        url = f"{base}{normalized}"
    else:
        url = f"{base}/"
    if query:
        return f"{url}?{query}"
    return url


def sanitize_next_path(next_path: Any, default: str = "/") -> str:
    # `next` は同一サイト内の相対パスのみ許可し、外部URLは拒否する
    # Allow only same-site relative paths for `next`; reject external URLs.
    if not isinstance(next_path, str):
        return default

    candidate = next_path.strip()
    if not candidate.startswith("/"):
        return default

    parsed = urlsplit(candidate)
    if parsed.scheme or parsed.netloc:
        return default

    return candidate


def redirect_to_frontend(
    request: Request, path: str | None = None, *, status_code: int = 302
) -> RedirectResponse:
    # 現在パス（または指定パス）をFRONTEND_URLへリダイレクトする
    # Redirect current (or provided) path to FRONTEND_URL.
    target_path = path if path is not None else request.url.path
    query = request.url.query or None
    return RedirectResponse(frontend_url(target_path, query=query), status_code=status_code)


def frontend_login_url(next_path: str | None = None) -> str:
    # ログイン後遷移先を next クエリに埋め込んだログインURLを組み立てる
    # Build login URL with optional post-login `next` query parameter.
    safe_next_path = sanitize_next_path(next_path, default="/") if next_path else None
    query = urlencode({"next": safe_next_path}) if safe_next_path else None
    return frontend_url("/login", query=query)
