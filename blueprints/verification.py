import logging
import time

from fastapi import APIRouter, Depends, Request

from services.async_utils import run_blocking
from services.auth_limits import consume_auth_email_send_limits
from services.auth_session import establish_authenticated_session
from services.csrf import require_csrf
from services.email_service import send_email
from services.llm_daily_limit import consume_auth_email_daily_quota
from services.request_models import AuthCodeRequest, EmailRequest
from services.security import constant_time_compare, generate_verification_code
from services.users import (
    create_user,
    get_user_by_email,
    set_user_verified,
    get_user_by_id,
    copy_default_tasks_for_user,
)
from services.web import (
    jsonify,
    log_and_internal_server_error,
    require_json_dict,
    validate_payload_model,
)

verification_bp = APIRouter(dependencies=[Depends(require_csrf)])
logger = logging.getLogger(__name__)

VERIFICATION_CODE_TTL_SECONDS = 300
VERIFICATION_CODE_MAX_ATTEMPTS = 5


def _clear_registration_verification_session(session: dict) -> None:
    session.pop("verification_code", None)
    session.pop("temp_user_id", None)
    session.pop("verification_code_issued_at", None)
    session.pop("verification_code_attempts", None)

@verification_bp.post("/api/send_verification_email", name="verification.api_send_verification_email")
async def api_send_verification_email(request: Request):
    """
    register.html から「確認メール送信」ボタン押下で呼ばれる
    - メールアドレスをDBに登録 (is_verified=False)
    - 6桁のコードを生成し、Gmailにて送信
    - コードは session["verification_code"] に一時的に保存 (本番ではDBでもOK)
    - session["temp_user_id"] に仮保存
    Called by "Send verification email" on register page.
    - Ensure user exists with is_verified=False
    - Generate six-digit code and send via Gmail
    - Temporarily store code and user id in session
    """
    data, error_response = await require_json_dict(request, status="fail")
    if error_response is not None:
        return error_response

    payload, validation_error = validate_payload_model(
        data,
        EmailRequest,
        error_message="メールアドレスが指定されていません",
        status="fail",
    )
    if validation_error is not None:
        return validation_error

    email = payload.email
    allowed, limit_error = consume_auth_email_send_limits(request, email)
    if not allowed:
        return jsonify({"status": "fail", "error": limit_error}, status_code=429)

    can_send_email, _, daily_limit = await run_blocking(consume_auth_email_daily_quota)
    if not can_send_email:
        return jsonify(
            {
                "status": "fail",
                "error": (
                    f"本日の認証メール送信上限（全ユーザー合計 {daily_limit} 件）に達しました。"
                    "日付が変わってから再度お試しください。"
                ),
            },
            status_code=429,
        )

    # すでにユーザーがあれば再利用、なければ作成
    # Reuse existing user or create a new unverified user.
    user = await run_blocking(get_user_by_email, email)
    if not user:
        user_id = await run_blocking(create_user, email)
    else:
        user_id = user["id"]

    # 6桁コード生成→セッションへ
    # Generate a six-digit code and keep it in session temporarily.
    code = generate_verification_code()
    request.session["verification_code"] = code
    request.session["temp_user_id"] = user_id  # どのユーザーか紐付け
    request.session["verification_code_issued_at"] = int(time.time())
    request.session["verification_code_attempts"] = 0
    # Link verification flow to this user id.

    subject = "AIチャットサービス: 認証コード"
    body_text = f"以下の認証コードを登録画面に入力してください。\n\n認証コード: {code}"
    try:
        await run_blocking(send_email, to_address=email, subject=subject, body_text=body_text)
        return jsonify({"status": "success"})
    except Exception:
        return log_and_internal_server_error(
            logger,
            "Failed to send registration verification email.",
            status="fail",
        )

@verification_bp.post("/api/verify_registration_code", name="verification.api_verify_registration_code")
async def api_verify_registration_code(request: Request):
    """
    register.html の「認証する」ボタンで呼ばれる。
    ・セッション保存の認証コードと照合
    ・一致すればユーザーを is_verified=True にしログイン状態へ
    ・このタイミングで初期タスクをユーザー専用に複製
    Called by "Verify" action on register page.
    - Compare submitted code with session code
    - Mark user as verified and log them in
    - Copy default tasks for the verified user
    """
    data, error_response = await require_json_dict(request, status="fail")
    if error_response is not None:
        return error_response

    payload, validation_error = validate_payload_model(
        data,
        AuthCodeRequest,
        error_message="認証コードが違います。",
        status="fail",
    )
    if validation_error is not None:
        return validation_error

    user_code = payload.authCode
    session = request.session
    session_code = session.get("verification_code")
    user_id = session.get("temp_user_id")

    if not session_code or not user_id:
        return jsonify({"status": "fail", "error": "セッション情報がありません。最初からやり直してください"}, status_code=400)

    issued_at = int(session.get("verification_code_issued_at") or 0)
    attempts = int(session.get("verification_code_attempts") or 0)

    if issued_at <= 0 or int(time.time()) - issued_at > VERIFICATION_CODE_TTL_SECONDS:
        _clear_registration_verification_session(session)
        return jsonify({"status": "fail", "error": "認証コードの有効期限が切れています。"}, status_code=400)

    if attempts >= VERIFICATION_CODE_MAX_ATTEMPTS:
        _clear_registration_verification_session(session)
        return jsonify({"status": "fail", "error": "認証コードの試行回数が上限に達しました。"}, status_code=400)

    submitted_code = str(user_code or "")
    if not constant_time_compare(submitted_code, str(session_code)):
        attempts += 1
        session["verification_code_attempts"] = attempts
        if attempts >= VERIFICATION_CODE_MAX_ATTEMPTS:
            _clear_registration_verification_session(session)
            return jsonify({"status": "fail", "error": "認証コードの試行回数が上限に達しました。"}, status_code=400)
        return jsonify({"status": "fail", "error": "認証コードが一致しません。"}, status_code=400)

    # ここから成功処理 ----------------------------------------------------
    # Success path starts here.
    user = await run_blocking(get_user_by_id, user_id)
    if not user:
        _clear_registration_verification_session(session)
        session.pop("user_id", None)
        session.pop("user_email", None)
        return jsonify({"status": "fail", "error": "ユーザーが存在しません"}, status_code=400)

    await run_blocking(set_user_verified, user_id)                 # ユーザーを認証済みに
    # Mark user as verified.
    await run_blocking(copy_default_tasks_for_user, user_id)       # ★ 共通タスクを複製 ★
    # Copy shared default tasks to this user.

    # ログイン状態にセット
    # Set authenticated session fields.
    establish_authenticated_session(request, int(user_id), user["email"])

    # 一時セッション情報のクリア
    # Clear temporary verification session data.
    _clear_registration_verification_session(session)

    return jsonify(
        {
            "status": "success",
            "flow": "register",
            "offer_passkey_setup": True,
        }
    )
