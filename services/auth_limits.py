from __future__ import annotations

import hashlib
import logging
import math
import os
import time
from threading import Lock
from typing import Any

from fastapi import Request

from services.cache import get_redis_client

logger = logging.getLogger(__name__)

DEFAULT_AUTH_EMAIL_PER_IP_LIMIT = 10
DEFAULT_AUTH_EMAIL_PER_EMAIL_LIMIT = 5
DEFAULT_AUTH_EMAIL_WINDOW_SECONDS = 600
DEFAULT_AUTH_EMAIL_COOLDOWN_SECONDS = 60
DEFAULT_ADMIN_LOGIN_PER_IP_LIMIT = 10
DEFAULT_ADMIN_LOGIN_WINDOW_SECONDS = 900
DEFAULT_PASSKEY_AUTH_OPTIONS_PER_IP_LIMIT = 30
DEFAULT_PASSKEY_AUTH_VERIFY_PER_IP_LIMIT = 30
DEFAULT_PASSKEY_AUTH_WINDOW_SECONDS = 300

_in_memory_lock = Lock()
_in_memory_windows: dict[str, tuple[int, float]] = {}


def _get_positive_int_env(name: str, default: int) -> int:
    raw_value = os.getenv(name, str(default))
    try:
        parsed = int(raw_value)
    except (TypeError, ValueError):
        logger.warning("Invalid %s value %r. Falling back to %s.", name, raw_value, default)
        return default
    return max(parsed, 0)


def get_request_client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if isinstance(forwarded_for, str) and forwarded_for.strip():
        return forwarded_for.split(",")[0].strip()

    client = getattr(request, "client", None)
    client_host = getattr(client, "host", None)
    if isinstance(client_host, str) and client_host.strip():
        return client_host.strip()

    return "unknown"


def _hash_identifier(raw_value: str) -> str:
    return hashlib.sha256(raw_value.encode("utf-8")).hexdigest()


def _consume_with_redis(
    redis_client: Any,
    redis_key: str,
    *,
    limit: int,
    window_seconds: int,
) -> tuple[bool, int, int] | None:
    lua_script = """
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local current = tonumber(redis.call('GET', key) or '0')
local key_ttl = tonumber(redis.call('TTL', key) or ttl)

if current >= limit then
  if key_ttl < 0 then
    key_ttl = ttl
  end
  return {0, current, key_ttl}
end

current = redis.call('INCR', key)
if current == 1 then
  redis.call('EXPIRE', key, ttl)
  key_ttl = ttl
else
  key_ttl = tonumber(redis.call('TTL', key) or ttl)
  if key_ttl < 0 then
    key_ttl = ttl
  end
end

return {1, current, key_ttl}
"""
    try:
        result = redis_client.eval(lua_script, 1, redis_key, limit, window_seconds)
        if not isinstance(result, (list, tuple)) or len(result) != 3:
            raise ValueError(f"Unexpected Redis rate-limit result: {result}")
        allowed = int(result[0]) == 1
        current = int(result[1])
        retry_after = max(int(result[2]), 1)
        remaining = max(limit - current, 0)
        return allowed, remaining, retry_after
    except Exception:
        logger.exception("Redis auth rate limiting failed; falling back to in-memory.")
        return None


def _consume_with_in_memory(
    key: str,
    *,
    limit: int,
    window_seconds: int,
) -> tuple[bool, int, int]:
    now = time.monotonic()
    with _in_memory_lock:
        expired_keys = [
            existing_key
            for existing_key, (_, expires_at) in _in_memory_windows.items()
            if expires_at <= now
        ]
        for expired_key in expired_keys:
            _in_memory_windows.pop(expired_key, None)

        current, expires_at = _in_memory_windows.get(key, (0, now + window_seconds))
        if expires_at <= now:
            current = 0
            expires_at = now + window_seconds

        if current >= limit:
            retry_after = max(int(math.ceil(expires_at - now)), 1)
            return False, 0, retry_after

        current += 1
        _in_memory_windows[key] = (current, expires_at)
        retry_after = max(int(math.ceil(expires_at - now)), 1)
        remaining = max(limit - current, 0)
        return True, remaining, retry_after


def consume_rate_limit(
    key_prefix: str,
    identifier: str,
    *,
    limit: int,
    window_seconds: int,
) -> tuple[bool, int, int]:
    normalized_identifier = (identifier or "").strip().lower() or "unknown"
    redis_key = f"{key_prefix}:{_hash_identifier(normalized_identifier)}"

    if limit <= 0:
        return False, 0, max(window_seconds, 1)

    redis_client = get_redis_client()
    if redis_client is not None:
        redis_result = _consume_with_redis(
            redis_client,
            redis_key,
            limit=limit,
            window_seconds=window_seconds,
        )
        if redis_result is not None:
            return redis_result

    return _consume_with_in_memory(
        redis_key,
        limit=limit,
        window_seconds=window_seconds,
    )


def consume_auth_email_send_limits(request: Request, email: str) -> tuple[bool, str | None]:
    client_ip = get_request_client_ip(request)
    normalized_email = (email or "").strip().lower()

    per_ip_limit = _get_positive_int_env(
        "AUTH_EMAIL_PER_IP_LIMIT",
        DEFAULT_AUTH_EMAIL_PER_IP_LIMIT,
    )
    per_email_limit = _get_positive_int_env(
        "AUTH_EMAIL_PER_EMAIL_LIMIT",
        DEFAULT_AUTH_EMAIL_PER_EMAIL_LIMIT,
    )
    window_seconds = _get_positive_int_env(
        "AUTH_EMAIL_WINDOW_SECONDS",
        DEFAULT_AUTH_EMAIL_WINDOW_SECONDS,
    )
    cooldown_seconds = _get_positive_int_env(
        "AUTH_EMAIL_COOLDOWN_SECONDS",
        DEFAULT_AUTH_EMAIL_COOLDOWN_SECONDS,
    )

    allowed, _, retry_after = consume_rate_limit(
        "auth_email:ip",
        client_ip,
        limit=per_ip_limit,
        window_seconds=window_seconds,
    )
    if not allowed:
        return (
            False,
            (
                "認証メール送信の試行回数が多すぎます。"
                f"{retry_after}秒ほど待ってから再試行してください。"
            ),
        )

    allowed, _, retry_after = consume_rate_limit(
        "auth_email:email",
        normalized_email,
        limit=per_email_limit,
        window_seconds=window_seconds,
    )
    if not allowed:
        return (
            False,
            (
                "このメールアドレスへの認証メール送信が多すぎます。"
                f"{retry_after}秒ほど待ってから再試行してください。"
            ),
        )

    allowed, _, retry_after = consume_rate_limit(
        "auth_email:cooldown",
        normalized_email,
        limit=1,
        window_seconds=cooldown_seconds,
    )
    if not allowed:
        return (
            False,
            (
                "認証メールは短時間に連続送信できません。"
                f"{retry_after}秒ほど待ってから再試行してください。"
            ),
        )

    return True, None


def consume_admin_login_limit(request: Request) -> tuple[bool, str | None]:
    client_ip = get_request_client_ip(request)
    per_ip_limit = _get_positive_int_env(
        "ADMIN_LOGIN_PER_IP_LIMIT",
        DEFAULT_ADMIN_LOGIN_PER_IP_LIMIT,
    )
    window_seconds = _get_positive_int_env(
        "ADMIN_LOGIN_WINDOW_SECONDS",
        DEFAULT_ADMIN_LOGIN_WINDOW_SECONDS,
    )

    allowed, _, retry_after = consume_rate_limit(
        "admin_login:ip",
        client_ip,
        limit=per_ip_limit,
        window_seconds=window_seconds,
    )
    if allowed:
        return True, None

    return (
        False,
        (
            "管理者ログインの試行回数が多すぎます。"
            f"{retry_after}秒ほど待ってから再試行してください。"
        ),
    )


def consume_passkey_auth_options_limit(request: Request) -> tuple[bool, str | None]:
    client_ip = get_request_client_ip(request)
    per_ip_limit = _get_positive_int_env(
        "PASSKEY_AUTH_OPTIONS_PER_IP_LIMIT",
        DEFAULT_PASSKEY_AUTH_OPTIONS_PER_IP_LIMIT,
    )
    window_seconds = _get_positive_int_env(
        "PASSKEY_AUTH_WINDOW_SECONDS",
        DEFAULT_PASSKEY_AUTH_WINDOW_SECONDS,
    )

    allowed, _, retry_after = consume_rate_limit(
        "passkey_auth_options:ip",
        client_ip,
        limit=per_ip_limit,
        window_seconds=window_seconds,
    )
    if allowed:
        return True, None

    return (
        False,
        (
            "Passkey認証の開始回数が多すぎます。"
            f"{retry_after}秒ほど待ってから再試行してください。"
        ),
    )


def consume_passkey_auth_verify_limit(request: Request) -> tuple[bool, str | None]:
    client_ip = get_request_client_ip(request)
    per_ip_limit = _get_positive_int_env(
        "PASSKEY_AUTH_VERIFY_PER_IP_LIMIT",
        DEFAULT_PASSKEY_AUTH_VERIFY_PER_IP_LIMIT,
    )
    window_seconds = _get_positive_int_env(
        "PASSKEY_AUTH_WINDOW_SECONDS",
        DEFAULT_PASSKEY_AUTH_WINDOW_SECONDS,
    )

    allowed, _, retry_after = consume_rate_limit(
        "passkey_auth_verify:ip",
        client_ip,
        limit=per_ip_limit,
        window_seconds=window_seconds,
    )
    if allowed:
        return True, None

    return (
        False,
        (
            "Passkey認証の試行回数が多すぎます。"
            f"{retry_after}秒ほど待ってから再試行してください。"
        ),
    )
