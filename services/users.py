from typing import Any

from .db import get_db_connection
from .default_tasks import default_task_rows

DEFAULT_USERNAME = "ユーザー"
DEFAULT_AVATAR_URL = "/static/user-icon.png"
EMAIL_AUTH_PROVIDER = "email"
GOOGLE_AUTH_PROVIDER = "google"


def copy_default_tasks_for_user(user_id: int) -> None:
    # 共有タスクをユーザー専用タスクとして重複なく複製する
    # Copy shared default tasks into user-owned rows without duplicates.
    """user_id IS NULL の共通タスクを指定ユーザーに複製"""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            SELECT name, prompt_template, input_examples,
                   output_examples, display_order
              FROM task_with_examples
             WHERE user_id IS NULL
            """
        )
        defaults = cursor.fetchall()
        if not defaults:
            defaults = default_task_rows()

        for name, tmpl, inp, out, disp in defaults:
            cursor.execute(
                """
                SELECT 1 FROM task_with_examples
                 WHERE user_id = %s AND name = %s
                """,
                (user_id, name)
            )
            if cursor.fetchone():
                continue
            cursor.execute(
                """
                INSERT INTO task_with_examples
                      (user_id, name, prompt_template,
                       input_examples, output_examples, display_order)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (user_id, name, tmpl, inp, out, disp)
            )

        conn.commit()
    finally:
        cursor.close()
        conn.close()


def get_user_by_email(email: str) -> dict[str, Any] | None:
    # メールアドレス一致のユーザー1件を返す
    # Fetch a single user by email.
    """メールアドレスでユーザーを取得"""
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT * FROM users WHERE email = %s", (email,))
        return cursor.fetchone()
    finally:
        cursor.close()
        conn.close()


def get_user_by_google_id(google_user_id: str) -> dict[str, Any] | None:
    # Google の安定IDでユーザーを取得する
    # Look up a user by Google provider identity.
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            SELECT *
              FROM users
             WHERE auth_provider = %s
               AND provider_user_id = %s
            """,
            (GOOGLE_AUTH_PROVIDER, google_user_id),
        )
        return cursor.fetchone()
    finally:
        cursor.close()
        conn.close()


def get_user_by_id(user_id: int) -> dict[str, Any] | None:
    # プロフィール表示に必要なユーザー情報を取得する
    # Fetch user fields needed by profile and session endpoints.
    """ユーザーIDでユーザーを取得"""
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            SELECT id, email, is_verified, created_at,
                   username, bio, avatar_url
              FROM users
             WHERE id = %s
            """,
            (user_id,)
        )
        return cursor.fetchone()
    finally:
        cursor.close()
        conn.close()


def create_user(
    email: str,
    username: str | None = None,
    avatar_url: str | None = None,
    *,
    auth_provider: str = EMAIL_AUTH_PROVIDER,
    provider_user_id: str | None = None,
    provider_email: str | None = None,
    is_verified: bool = False,
) -> int | None:
    # 未認証ユーザーを作成し、採番された user_id を返す
    # Create an unverified user and return the generated user_id.
    """未認証ユーザーを新規作成"""
    normalized_username = (username or "").strip() or DEFAULT_USERNAME
    normalized_avatar_url = (avatar_url or "").strip() or DEFAULT_AVATAR_URL
    normalized_provider_user_id = (provider_user_id or "").strip() or None
    normalized_provider_email = (provider_email or "").strip() or None
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            INSERT INTO users (
                email,
                username,
                avatar_url,
                is_verified,
                auth_provider,
                provider_user_id,
                provider_email
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                email,
                normalized_username,
                normalized_avatar_url,
                is_verified,
                auth_provider,
                normalized_provider_user_id,
                normalized_provider_email,
            ),
        )
        conn.commit()
        row = cursor.fetchone()
        return row[0] if row else None
    finally:
        cursor.close()
        conn.close()


def link_google_account(user_id: int, google_user_id: str, provider_email: str) -> None:
    # 既存ユーザーへ Google 連携情報を紐付け・更新する
    # Attach or refresh Google provider metadata for an existing user.
    normalized_google_user_id = (google_user_id or "").strip()
    normalized_provider_email = (provider_email or "").strip() or None
    if not normalized_google_user_id:
        raise ValueError("google_user_id is required")

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            UPDATE users
               SET auth_provider = %s,
                   provider_user_id = %s,
                   provider_email = %s
             WHERE id = %s
            """,
            (
                GOOGLE_AUTH_PROVIDER,
                normalized_google_user_id,
                normalized_provider_email,
                user_id,
            ),
        )
        conn.commit()
    finally:
        cursor.close()
        conn.close()


def update_user_profile_from_google_if_unset(
    user_id: int,
    name: str | None = None,
    picture: str | None = None,
) -> None:
    # 既定値のままのプロフィール項目だけ Google 情報で初期化する
    # Seed profile fields from Google only when the user still has defaults.
    normalized_name = (name or "").strip()
    normalized_picture = (picture or "").strip()

    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            SELECT username, avatar_url
              FROM users
             WHERE id = %s
            """,
            (user_id,),
        )
        current = cursor.fetchone()
        if not current:
            return

        next_username = current.get("username") or DEFAULT_USERNAME
        next_avatar_url = current.get("avatar_url") or DEFAULT_AVATAR_URL

        if normalized_name and next_username.strip() in {"", DEFAULT_USERNAME}:
            next_username = normalized_name
        if normalized_picture and next_avatar_url.strip() in {"", DEFAULT_AVATAR_URL}:
            next_avatar_url = normalized_picture

        cursor.execute(
            """
            UPDATE users
               SET username = %s,
                   avatar_url = %s
             WHERE id = %s
            """,
            (next_username, next_avatar_url, user_id),
        )
        conn.commit()
    finally:
        cursor.close()
        conn.close()


def set_user_verified(user_id: int) -> None:
    # 認証完了後に is_verified フラグを更新する
    # Mark user as verified after successful verification.
    """ユーザーを認証済みに更新"""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            UPDATE users SET is_verified = TRUE
            WHERE id = %s
            """,
            (user_id,)
        )
        conn.commit()
    finally:
        cursor.close()
        conn.close()
