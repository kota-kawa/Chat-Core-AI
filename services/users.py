from typing import Any

from .db import get_db_connection
from .default_tasks import default_task_rows

DEFAULT_USERNAME = "ユーザー"


def copy_default_tasks_for_user(user_id: int) -> None:
    # 共有タスクをユーザー専用タスクとして重複なく複製する
    # Copy shared default tasks into user-owned rows without duplicates.
    """user_id IS NULL の共通タスクを指定ユーザーに複製"""
    conn = get_db_connection()
    cursor = conn.cursor()

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


def create_user(email: str) -> int | None:
    # 未認証ユーザーを作成し、採番された user_id を返す
    # Create an unverified user and return the generated user_id.
    """未認証ユーザーを新規作成"""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            INSERT INTO users (email, username, is_verified)
            VALUES (%s, %s, FALSE)
            RETURNING id
            """,
            (email, DEFAULT_USERNAME)
        )
        conn.commit()
        row = cursor.fetchone()
        return row[0] if row else None
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
