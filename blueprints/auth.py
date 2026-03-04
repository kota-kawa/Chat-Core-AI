import copy
import logging
import os
import time
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests
from dotenv import load_dotenv
from fastapi import APIRouter, Request
from starlette.responses import RedirectResponse

try:
    from google_auth_oauthlib.flow import Flow
except ModuleNotFoundError:  # pragma: no cover - optional for test envs
    Flow = None

from services.web import (
    log_and_internal_server_error,
    jsonify,
    require_json_dict,
    validate_payload_model,
    frontend_login_url,
    frontend_url,
    redirect_to_frontend,
    set_session_permanent,
    url_for,
)
from services.request_models import AuthCodeRequest, EmailRequest
from services.async_utils import run_blocking
from services.users import (
    get_user_by_email,
    get_user_by_id,
    create_user,
    set_user_verified,
    copy_default_tasks_for_user,
)
from services.email_service import send_email
from services.llm_daily_limit import consume_auth_email_daily_quota
from services.runtime_config import is_production_env
from services.security import constant_time_compare, generate_verification_code

# 認証関連の環境変数を初期化する
# Load environment variables needed by auth flows.
load_dotenv()

# 開発環境では OAuth の http コールバックを許可する
# Allow OAuth over HTTP in non-production environments.
if not is_production_env():
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

GOOGLE_CLIENT_CONFIG = {
    "web": {
        "client_id": os.getenv("GOOGLE_CLIENT_ID"),
        "project_id": os.getenv("GOOGLE_PROJECT_ID", ""),
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        "client_secret": os.getenv("GOOGLE_CLIENT_SECRET"),
        "redirect_uris": [],
        "javascript_origins": [os.getenv("GOOGLE_JS_ORIGIN", "https://chatcore-ai.com")],
    }
}

GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "openid",
]

auth_bp = APIRouter()
logger = logging.getLogger(__name__)

LOGIN_VERIFICATION_CODE_TTL_SECONDS = 300
LOGIN_VERIFICATION_CODE_MAX_ATTEMPTS = 5


def _build_google_authorization_response(request: Request, redirect_uri: str) -> str:
    # Reverse proxy 配下では request.url が http になる場合があるため、
    # token 交換に使う URL は redirect_uri の scheme/host/path を優先する。
    # Behind reverse proxies, request.url may appear as http.
    # Prefer redirect_uri origin/path when building authorization_response.
    redirect_parts = urlsplit(redirect_uri)
    if redirect_parts.scheme and redirect_parts.netloc:
        return urlunsplit(
            (
                redirect_parts.scheme,
                redirect_parts.netloc,
                redirect_parts.path,
                request.url.query,
                "",
            )
        )
    return str(request.url)


def _fetch_google_user_info(access_token: str) -> dict[str, Any]:
    # Google API からログインユーザーのプロフィール情報を取得する
    # Fetch authenticated user info from Google UserInfo API.
    response = requests.get(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=10,
    )
    return response.json()


@auth_bp.get("/register", name="auth.register_page")
async def register_page(request: Request):
    """
    登録ページ(統合認証ページを返す)
    Return the registration entry page (served by frontend).
    """
    return redirect_to_frontend(request)

@auth_bp.get("/api/current_user", name="auth.api_current_user")
async def api_current_user(request: Request):
    session = request.session
    if "user_id" in session:
        user = await run_blocking(get_user_by_id, session["user_id"])
        if user:
            return jsonify({"logged_in": True, "user": {"id": user["id"], "email": user["email"]}})
        # user_id in session but user no longer exists; clear the stale session
        # セッション内 user_id が無効なため、古いログイン情報を破棄する
        session.pop("user_id", None)
        session.pop("user_email", None)
        session.pop("login_verification_code", None)
        session.pop("login_temp_user_id", None)
        session.pop("login_verification_code_issued_at", None)
        session.pop("login_verification_code_attempts", None)
        session.pop("google_oauth_state", None)
        session.pop("google_redirect_uri", None)
        set_session_permanent(session, False)
        return jsonify({"logged_in": False})
    else:
        return jsonify({"logged_in": False})


@auth_bp.get("/login", name="auth.login")
async def login(request: Request):
    """
    ログインページ（統合認証ページを返す）
    Return the login entry page (served by frontend).
    """
    return redirect_to_frontend(request)

@auth_bp.get("/logout", name="auth.logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse(frontend_login_url(), status_code=302)


@auth_bp.get("/google-login", name="auth.google_login")
async def google_login(request: Request):
    if Flow is None:
        return jsonify({"error": "google-auth-oauthlib is required"}, status_code=500)
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI") or url_for(
        request, "auth.google_callback", _external=True
    )
    client_config = copy.deepcopy(GOOGLE_CLIENT_CONFIG)
    client_config["web"]["redirect_uris"] = [redirect_uri]
    flow = Flow.from_client_config(
        client_config,
        scopes=GOOGLE_SCOPES,
        redirect_uri=redirect_uri,
    )
    # OAuth state をセッション保存し、コールバックで照合する
    # Persist OAuth state in session and verify it in callback.
    authorization_url, state = flow.authorization_url(prompt="consent")
    request.session["google_oauth_state"] = state
    request.session["google_redirect_uri"] = redirect_uri
    return RedirectResponse(authorization_url, status_code=302)


@auth_bp.get("/google-callback", name="auth.google_callback")
async def google_callback(request: Request):
    if Flow is None:
        return jsonify({"error": "google-auth-oauthlib is required"}, status_code=500)
    session = request.session
    state = session.get("google_oauth_state")
    if not state:
        return RedirectResponse(frontend_login_url(), status_code=302)
    redirect_uri = session.get("google_redirect_uri") or os.getenv(
        "GOOGLE_REDIRECT_URI"
    )
    if not redirect_uri:
        redirect_uri = url_for(request, "auth.google_callback", _external=True)
    client_config = copy.deepcopy(GOOGLE_CLIENT_CONFIG)
    client_config["web"]["redirect_uris"] = [redirect_uri]
    flow = Flow.from_client_config(
        client_config,
        scopes=GOOGLE_SCOPES,
        state=state,
        redirect_uri=redirect_uri,
    )
    # コールバックURLから認可コードを交換し、アクセストークンを取得する
    # Exchange callback authorization response for access token.
    authorization_response = _build_google_authorization_response(request, redirect_uri)
    await run_blocking(flow.fetch_token, authorization_response=authorization_response)
    session.pop("google_oauth_state", None)
    session.pop("google_redirect_uri", None)

    credentials = flow.credentials
    user_info = await run_blocking(_fetch_google_user_info, credentials.token)
    email = user_info.get("email")
    if not email:
        return RedirectResponse(frontend_login_url(), status_code=302)
    user = await run_blocking(get_user_by_email, email)
    if not user:
        # Google 初回ログイン時はユーザーを自動作成して認証済みにする
        # Auto-create and verify user on first Google login.
        user_id = await run_blocking(create_user, email)
        await run_blocking(set_user_verified, user_id)
    else:
        user_id = user["id"]

    await run_blocking(copy_default_tasks_for_user, user_id)
    session["user_id"] = user_id
    session["user_email"] = email
    set_session_permanent(session, True)
    return RedirectResponse(frontend_url("/"), status_code=302)

@auth_bp.post("/api/send_login_code", name="auth.api_send_login_code")
async def api_send_login_code(request: Request):
    """
    ログイン用の認証コード送信 API
    - POST JSON: { "email": "ユーザーのメールアドレス" }
    - 対象ユーザーが存在し、かつ is_verified=True であれば認証コードを生成し、メール送信する
    - 認証コードとユーザーIDはセッション変数 (login_verification_code, login_temp_user_id) に一時保存
    Login verification code API.
    - POST JSON: { "email": "..."}
    - Send code only for existing verified users
    - Store code and temporary user id in session
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
    user = await run_blocking(get_user_by_email, email)
    if not user or not user["is_verified"]:
        return jsonify(
            {"status": "fail", "error": "ユーザーが存在しないか、認証されていません"},
            status_code=400,
        )
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
    # 認証コードを発行し、検証用にセッションへ保持する
    # Generate and store login verification code in session.
    code = generate_verification_code()
    request.session["login_verification_code"] = code
    request.session["login_temp_user_id"] = user["id"]
    request.session["login_verification_code_issued_at"] = int(time.time())
    request.session["login_verification_code_attempts"] = 0
    subject = "AIチャットサービス: ログイン認証コード"
    body_text = f"以下の認証コードをログイン画面に入力してください。\n\n認証コード: {code}"
    try:
        await run_blocking(send_email, to_address=email, subject=subject, body_text=body_text)
        return jsonify({"status": "success", "message": "認証コードを送信しました"})
    except Exception:
        return log_and_internal_server_error(
            logger,
            "Failed to send login verification code email.",
            status="fail",
        )

@auth_bp.post("/api/verify_login_code", name="auth.api_verify_login_code")
async def api_verify_login_code(request: Request):
    """
    ログイン用の認証コード確認 API
    - POST JSON: { "authCode": "ユーザーが入力した認証コード" }
    - セッションに保存した認証コードと照合し、一致すればログイン（session["user_id"] にユーザーIDを保存）する
    Login code verification API.
    - POST JSON: { "authCode": "..."}
    - Compare submitted code with session-stored code and complete login on match
    """
    data, error_response = await require_json_dict(request, status="fail")
    if error_response is not None:
        return error_response

    payload, validation_error = validate_payload_model(
        data,
        AuthCodeRequest,
        error_message="認証コードが違います",
        status="fail",
    )
    if validation_error is not None:
        return validation_error

    auth_code = payload.authCode
    session = request.session
    session_code = session.get("login_verification_code")
    user_id = session.get("login_temp_user_id")
    if not session_code or not user_id:
        return jsonify(
            {"status": "fail", "error": "セッション情報がありません。最初からやり直してください"},
            status_code=400,
        )
    issued_at = int(session.get("login_verification_code_issued_at") or 0)
    attempts = int(session.get("login_verification_code_attempts") or 0)
    if issued_at <= 0 or int(time.time()) - issued_at > LOGIN_VERIFICATION_CODE_TTL_SECONDS:
        session.pop("login_verification_code", None)
        session.pop("login_temp_user_id", None)
        session.pop("login_verification_code_issued_at", None)
        session.pop("login_verification_code_attempts", None)
        return jsonify({"status": "fail", "error": "認証コードの有効期限が切れています。"}, status_code=400)
    if attempts >= LOGIN_VERIFICATION_CODE_MAX_ATTEMPTS:
        session.pop("login_verification_code", None)
        session.pop("login_temp_user_id", None)
        session.pop("login_verification_code_issued_at", None)
        session.pop("login_verification_code_attempts", None)
        return jsonify({"status": "fail", "error": "認証コードの試行回数が上限に達しました。"}, status_code=400)

    submitted_code = str(auth_code or "")
    if constant_time_compare(submitted_code, str(session_code)):
        session["user_id"] = user_id
        user = await run_blocking(get_user_by_id, user_id)
        session["user_email"] = user["email"] if user else ""
        set_session_permanent(session, True)
        session.pop("login_verification_code", None)
        session.pop("login_temp_user_id", None)
        session.pop("login_verification_code_issued_at", None)
        session.pop("login_verification_code_attempts", None)
        await run_blocking(copy_default_tasks_for_user, user_id)
        return jsonify({"status": "success", "message": "ログインに成功しました"})
    else:
        attempts += 1
        session["login_verification_code_attempts"] = attempts
        if attempts >= LOGIN_VERIFICATION_CODE_MAX_ATTEMPTS:
            session.pop("login_verification_code", None)
            session.pop("login_temp_user_id", None)
            session.pop("login_verification_code_issued_at", None)
            session.pop("login_verification_code_attempts", None)
            return jsonify({"status": "fail", "error": "認証コードの試行回数が上限に達しました。"}, status_code=400)
        return jsonify({"status": "fail", "error": "認証コードが一致しません。"}, status_code=400)
