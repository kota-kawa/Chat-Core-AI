from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlsplit

from fastapi import Request

from .db import get_db_connection
from .web import FRONTEND_URL

DEFAULT_PASSKEY_RP_NAME = "Chat Core"


def get_passkey_rp_name() -> str:
    configured_name = (os.getenv("WEBAUTHN_RP_NAME") or os.getenv("PASSKEY_RP_NAME") or "").strip()
    return configured_name or DEFAULT_PASSKEY_RP_NAME


def get_passkey_rp_id(request: Request) -> str:
    configured_rp_id = (os.getenv("WEBAUTHN_RP_ID") or os.getenv("PASSKEY_RP_ID") or "").strip()
    if configured_rp_id:
        return configured_rp_id

    candidates = (
        FRONTEND_URL,
        str(request.base_url),
        str(request.url),
    )
    for candidate in candidates:
        hostname = urlsplit(candidate).hostname
        if isinstance(hostname, str) and hostname:
            return hostname

    return "localhost"


def get_passkey_origins(request: Request) -> list[str]:
    origins: list[str] = []
    candidates = (
        FRONTEND_URL,
        str(request.base_url),
        str(request.url),
    )
    for candidate in candidates:
        parts = urlsplit(candidate)
        if not parts.scheme or not parts.netloc:
            continue
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in origins:
            origins.append(origin)
    return origins or ["http://localhost:3000"]


def list_passkeys_for_user(user_id: int) -> list[dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            SELECT id,
                   credential_id,
                   sign_count,
                   aaguid,
                   credential_device_type,
                   credential_backed_up,
                   label,
                   created_at,
                   last_used_at
              FROM user_passkeys
             WHERE user_id = %s
             ORDER BY created_at DESC, id DESC
            """,
            (user_id,),
        )
        rows = cursor.fetchall() or []
        return [dict(row) for row in rows]
    finally:
        cursor.close()
        conn.close()


def get_passkey_by_credential_id(credential_id: str) -> dict[str, Any] | None:
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            SELECT id,
                   user_id,
                   credential_id,
                   public_key,
                   sign_count,
                   aaguid,
                   credential_device_type,
                   credential_backed_up,
                   label,
                   created_at,
                   last_used_at
              FROM user_passkeys
             WHERE credential_id = %s
            """,
            (credential_id,),
        )
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        cursor.close()
        conn.close()


def create_passkey(
    user_id: int,
    credential_id: str,
    public_key: str,
    sign_count: int,
    *,
    aaguid: str | None = None,
    credential_device_type: str | None = None,
    credential_backed_up: bool = False,
    label: str | None = None,
) -> dict[str, Any] | None:
    normalized_label = (label or "").strip() or None
    normalized_aaguid = (aaguid or "").strip() or None
    normalized_device_type = (credential_device_type or "").strip() or None

    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            INSERT INTO user_passkeys (
                user_id,
                credential_id,
                public_key,
                sign_count,
                aaguid,
                credential_device_type,
                credential_backed_up,
                label,
                last_used_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
            RETURNING id,
                      credential_id,
                      sign_count,
                      aaguid,
                      credential_device_type,
                      credential_backed_up,
                      label,
                      created_at,
                      last_used_at
            """,
            (
                user_id,
                credential_id,
                public_key,
                int(sign_count),
                normalized_aaguid,
                normalized_device_type,
                bool(credential_backed_up),
                normalized_label,
            ),
        )
        conn.commit()
        row = cursor.fetchone()
        return dict(row) if row else None
    except Exception:
        conn.rollback()
        raise
    finally:
        cursor.close()
        conn.close()


def update_passkey_usage(
    passkey_id: int,
    sign_count: int,
    *,
    credential_backed_up: bool | None = None,
    credential_device_type: str | None = None,
) -> None:
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            UPDATE user_passkeys
               SET sign_count = %s,
                   credential_backed_up = COALESCE(%s, credential_backed_up),
                   credential_device_type = COALESCE(%s, credential_device_type),
                   last_used_at = CURRENT_TIMESTAMP
             WHERE id = %s
            """,
            (
                int(sign_count),
                credential_backed_up,
                (credential_device_type or "").strip() or None,
                passkey_id,
            ),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cursor.close()
        conn.close()


def delete_passkey(user_id: int, passkey_id: int) -> bool:
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            DELETE FROM user_passkeys
             WHERE id = %s
               AND user_id = %s
            """,
            (passkey_id, user_id),
        )
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted
    except Exception:
        conn.rollback()
        raise
    finally:
        cursor.close()
        conn.close()
