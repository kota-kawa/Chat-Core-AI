from __future__ import annotations

import json
import secrets
from http.cookies import SimpleCookie
from typing import Any

from fastapi import Request
from itsdangerous import BadSignature, URLSafeSerializer
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from services.async_utils import run_blocking
from services.cache import get_redis_client, mark_redis_unavailable
from services.csrf import CSRF_SESSION_KEY

REDIS_BACKEND = "redis"
COOKIE_BACKEND = "cookie"
SESSION_IDS_TO_DELETE_SCOPE_KEY = "_session_ids_to_delete"


def rotate_session_identifier(request: Request) -> None:
    # ログイン成功時はセッションIDを再発行して fixation を防ぐ
    # Rotate the session identifier after authentication to mitigate session fixation.
    scope = request.scope
    current_session_id = scope.get("session_id")
    if isinstance(current_session_id, str) and current_session_id:
        pending = scope.setdefault(SESSION_IDS_TO_DELETE_SCOPE_KEY, set())
        pending.add(current_session_id)
    scope["session_id"] = None


class PermanentSessionMiddleware:
    # Redis が利用可能ならサーバー側保存を優先し、障害時は署名付き Cookie へフォールバックする
    # Prefer Redis-backed sessions when available and fallback to signed cookie payloads on failure.
    def __init__(
        self,
        app: ASGIApp,
        *,
        secret_key: str,
        session_cookie: str = "session",
        max_age: int | None = None,
        path: str = "/",
        same_site: str = "lax",
        https_only: bool = False,
    ) -> None:
        self.inner = HybridSessionMiddleware(
            app,
            secret_key=secret_key,
            session_cookie=session_cookie,
            max_age=max_age,
            path=path,
            same_site=same_site,
            https_only=https_only,
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        await self.inner(scope, receive, send)


class HybridSessionMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        secret_key: str,
        session_cookie: str = "session",
        max_age: int | None = None,
        path: str = "/",
        same_site: str = "lax",
        https_only: bool = False,
    ) -> None:
        self.app = app
        self.session_cookie = session_cookie
        self.max_age = max_age
        self.path = path
        self.same_site = same_site
        self.https_only = https_only
        self.serializer = URLSafeSerializer(secret_key, salt="strike.session")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        cookie_state = self._load_cookie_state(scope)
        session_data, session_id = await run_blocking(self._restore_session, cookie_state)
        if CSRF_SESSION_KEY not in session_data:
            session_data[CSRF_SESSION_KEY] = secrets.token_urlsafe(32)
        scope["session"] = session_data
        scope["session_id"] = session_id

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                await run_blocking(self._commit_session, scope, headers)
            await send(message)

        return await self.app(scope, receive, send_wrapper)

    def _load_cookie_state(self, scope: Scope) -> dict[str, Any] | None:
        headers = Headers(scope=scope)
        cookie_header = headers.get("cookie")
        if not cookie_header:
            return None

        cookies = SimpleCookie()
        cookies.load(cookie_header)
        if self.session_cookie not in cookies:
            return None

        signed_value = cookies[self.session_cookie].value
        try:
            payload = self.serializer.loads(signed_value)
        except BadSignature:
            return None

        if isinstance(payload, str):
            return {"backend": REDIS_BACKEND, "id": payload}
        if isinstance(payload, dict):
            return payload
        return None

    def _restore_session(
        self, cookie_state: dict[str, Any] | None
    ) -> tuple[dict[str, Any], str | None]:
        if not cookie_state:
            return {}, None

        backend = cookie_state.get("backend")
        if backend == COOKIE_BACKEND:
            data = cookie_state.get("data")
            if isinstance(data, dict):
                return data, None
            return {}, None

        if backend != REDIS_BACKEND:
            return {}, None

        session_id = cookie_state.get("id")
        if not isinstance(session_id, str) or not session_id:
            return {}, None

        redis_client = get_redis_client()
        if redis_client is None:
            return {}, None

        try:
            payload = redis_client.get(self._redis_key(session_id))
        except Exception as exc:
            mark_redis_unavailable(exc)
            return {}, None

        if not payload:
            return {}, None

        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            return {}, None
        if isinstance(data, dict):
            return data, session_id
        return {}, None

    def _commit_session(self, scope: Scope, headers: MutableHeaders) -> None:
        session = scope.get("session") or {}
        session_id = scope.get("session_id")
        pending_delete_ids = scope.get(SESSION_IDS_TO_DELETE_SCOPE_KEY) or set()

        if not session:
            for stale_session_id in pending_delete_ids:
                self._delete_session(stale_session_id)
            if session_id:
                self._delete_session(session_id)
            self._set_cookie(headers, "", max_age=0)
            return

        is_permanent = session.get("_permanent") is True
        cookie_max_age = self.max_age if is_permanent else None

        if not session_id:
            session_id = secrets.token_urlsafe(32)
            scope["session_id"] = session_id

        for stale_session_id in pending_delete_ids:
            if stale_session_id != session_id:
                self._delete_session(stale_session_id)
        scope[SESSION_IDS_TO_DELETE_SCOPE_KEY] = set()

        if self._save_session(session_id, session):
            self._set_cookie(
                headers,
                self.serializer.dumps({"backend": REDIS_BACKEND, "id": session_id}),
                cookie_max_age,
            )
            return

        self._set_cookie(
            headers,
            self.serializer.dumps({"backend": COOKIE_BACKEND, "data": session}),
            cookie_max_age,
        )

    def _save_session(self, session_id: str, session: dict[str, Any]) -> bool:
        redis_client = get_redis_client()
        if redis_client is None:
            return False

        payload = json.dumps(session, ensure_ascii=False)
        try:
            if self.max_age is not None:
                redis_client.set(self._redis_key(session_id), payload, ex=self.max_age)
            else:
                redis_client.set(self._redis_key(session_id), payload)
        except Exception as exc:
            mark_redis_unavailable(exc)
            return False
        return True

    def _delete_session(self, session_id: str) -> None:
        redis_client = get_redis_client()
        if redis_client is None:
            return
        try:
            redis_client.delete(self._redis_key(session_id))
        except Exception as exc:
            mark_redis_unavailable(exc)

    def _redis_key(self, session_id: str) -> str:
        return f"session:{session_id}"

    def _set_cookie(
        self, headers: MutableHeaders, value: str, max_age: int | None = None
    ) -> None:
        cookie = SimpleCookie()
        cookie[self.session_cookie] = value
        cookie[self.session_cookie]["path"] = self.path
        cookie[self.session_cookie]["httponly"] = True
        if self.same_site:
            cookie[self.session_cookie]["samesite"] = self.same_site
        if self.https_only:
            cookie[self.session_cookie]["secure"] = True
        if max_age is not None:
            cookie[self.session_cookie]["max-age"] = str(max_age)
        if max_age == 0:
            cookie[self.session_cookie]["expires"] = "Thu, 01 Jan 1970 00:00:00 GMT"
        headers.append("set-cookie", cookie.output(header="").strip())
