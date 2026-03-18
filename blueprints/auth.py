import logging
import os
import time
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, Request
from starlette.responses import RedirectResponse

try:
    from google_auth_oauthlib.flow import Flow
except ModuleNotFoundError:  # pragma: no cover - optional for test envs
    Flow = None

try:
    from google.auth.exceptions import GoogleAuthError
except ModuleNotFoundError:  # pragma: no cover - optional for test envs
    class GoogleAuthError(Exception):
        pass

try:
    from oauthlib.oauth2.rfc6749.errors import OAuth2Error
except ModuleNotFoundError:  # pragma: no cover - optional for test envs
    class OAuth2Error(Exception):
        pass

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
from services.csrf import require_csrf
from services.users import (
    get_user_by_email,
    get_user_by_id,
    get_user_by_google_id,
    create_user,
    link_google_account,
    set_user_verified,
    copy_default_tasks_for_user,
    update_user_profile_from_google_if_unset,
    GOOGLE_AUTH_PROVIDER,
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

GOOGLE_LOGIN_UNAVAILABLE_ERROR = "Googleログインを現在利用できません。"

GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "openid",
]

auth_bp = APIRouter(dependencies=[Depends(require_csrf)])
logger = logging.getLogger(__name__)

LOGIN_VERIFICATION_CODE_TTL_SECONDS = 300
LOGIN_VERIFICATION_CODE_MAX_ATTEMPTS = 5


def _google_client_config() -> dict[str, Any]:
    return {
        "web": {
            "client_id": (os.getenv("GOOGLE_CLIENT_ID") or "").strip(),
            "project_id": os.getenv("GOOGLE_PROJECT_ID", ""),
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
            "client_secret": (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip(),
            "redirect_uris": [],
            "javascript_origins": [os.getenv("GOOGLE_JS_ORIGIN", "https://chatcore-ai.com")],
        }
    }


def _validate_google_oauth_settings(client_config: dict[str, Any]) -> str | None:
    web_config = client_config.get("web") if isinstance(client_config, dict) else None
    if not isinstance(web_config, dict):
        return "Google OAuth client config is invalid."

    missing_keys: list[str] = []
    client_id = web_config.get("client_id")
    if not isinstance(client_id, str) or not client_id:
        missing_keys.append("GOOGLE_CLIENT_ID")

    client_secret = web_config.get("client_secret")
    if not isinstance(client_secret, str) or not client_secret:
        missing_keys.append("GOOGLE_CLIENT_SECRET")

    if missing_keys:
        return f"Missing required Google OAuth environment variables: {', '.join(missing_keys)}"

    return None


def _clear_google_oauth_session(session: dict[str, Any]) -> None:
    session.pop("google_oauth_state", None)
    session.pop("google_redirect_uri", None)


def _google_login_unavailable_response() -> Any:
    return jsonify({"error": GOOGLE_LOGIN_UNAVAILABLE_ERROR}, status_code=503)


def _redirect_to_login_after_google_failure(session: dict[str, Any]) -> RedirectResponse:
    _clear_google_oauth_session(session)
    return RedirectResponse(frontend_login_url(), status_code=302)


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
    response.raise_for_status()
    return response.json()


def _clean_google_field(user_info: dict[str, Any], key: str) -> str:
    value = user_info.get(key)
    return value.strip() if isinstance(value, str) else ""


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
        _clear_google_oauth_session(session)
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
        logger.error(
            "Google login is unavailable because google-auth-oauthlib is not installed."
        )
        return _google_login_unavailable_response()
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI") or url_for(
        request, "auth.google_callback", _external=True
    )
    client_config = _google_client_config()
    settings_error = _validate_google_oauth_settings(client_config)
    if settings_error:
        logger.error(
            "Google login is unavailable due to configuration error: %s",
            settings_error,
        )
        return _google_login_unavailable_response()
    client_config["web"]["redirect_uris"] = [redirect_uri]
    try:
        flow = Flow.from_client_config(
            client_config,
            scopes=GOOGLE_SCOPES,
            redirect_uri=redirect_uri,
        )
        # OAuth state をセッション保存し、コールバックで照合する
        # Persist OAuth state in session and verify it in callback.
        authorization_url, state = flow.authorization_url(prompt="consent")
    except (
        GoogleAuthError,
        OAuth2Error,
        requests.RequestException,
        ValueError,
    ):
        logger.exception("Failed to initialize Google OAuth authorization URL.")
        return _google_login_unavailable_response()
    request.session["google_oauth_state"] = state
    request.session["google_redirect_uri"] = redirect_uri
    return RedirectResponse(authorization_url, status_code=302)


@auth_bp.get("/google-callback", name="auth.google_callback")
async def google_callback(request: Request):
    session = request.session
    if Flow is None:
        return _redirect_to_login_after_google_failure(session)
    state = session.get("google_oauth_state")
    if not state:
        return _redirect_to_login_after_google_failure(session)
    redirect_uri = session.get("google_redirect_uri") or os.getenv(
        "GOOGLE_REDIRECT_URI"
    )
    if not redirect_uri:
        redirect_uri = url_for(request, "auth.google_callback", _external=True)
    client_config = _google_client_config()
    settings_error = _validate_google_oauth_settings(client_config)
    if settings_error:
        logger.error(
            "Google OAuth callback aborted due to configuration error: %s",
            settings_error,
        )
        return _redirect_to_login_after_google_failure(session)
    client_config["web"]["redirect_uris"] = [redirect_uri]
    try:
        flow = Flow.from_client_config(
            client_config,
            scopes=GOOGLE_SCOPES,
            state=state,
            redirect_uri=redirect_uri,
        )
    except (
        GoogleAuthError,
        OAuth2Error,
        requests.RequestException,
        ValueError,
    ):
        logger.exception("Failed to initialize Google OAuth callback flow.")
        return _redirect_to_login_after_google_failure(session)
    # コールバックURLから認可コードを交換し、アクセストークンを取得する
    # Exchange callback authorization response for access token.
    authorization_response = _build_google_authorization_response(request, redirect_uri)
    try:
        await run_blocking(flow.fetch_token, authorization_response=authorization_response)
    except (
        GoogleAuthError,
        OAuth2Error,
        requests.RequestException,
        ValueError,
    ):
        logger.exception("Google OAuth token exchange failed.")
        return RedirectResponse(frontend_login_url(), status_code=302)
    finally:
        _clear_google_oauth_session(session)

    credentials = flow.credentials
    access_token = getattr(credentials, "token", "")
    if not isinstance(access_token, str) or not access_token:
        logger.error("Google OAuth callback completed without an access token.")
        return RedirectResponse(frontend_login_url(), status_code=302)

    try:
        user_info = await run_blocking(_fetch_google_user_info, access_token)
    except requests.RequestException:
        logger.exception("Failed to fetch Google user info.")
        return RedirectResponse(frontend_login_url(), status_code=302)
    email = _clean_google_field(user_info, "email")
    google_user_id = _clean_google_field(user_info, "id")
    display_name = _clean_google_field(user_info, "name")
    picture = _clean_google_field(user_info, "picture")
    verified_email = bool(user_info.get("verified_email"))
    if not email or not google_user_id or not verified_email:
        return RedirectResponse(frontend_login_url(), status_code=302)

    try:
        user = await run_blocking(get_user_by_google_id, google_user_id)
        should_mark_verified = False
        if user:
            user_id = user["id"]
            await run_blocking(link_google_account, user_id, google_user_id, email)
            should_mark_verified = not user.get("is_verified")
        else:
            user = await run_blocking(get_user_by_email, email)
            if user:
                existing_google_user_id = (user.get("provider_user_id") or "").strip()
                if existing_google_user_id and existing_google_user_id != google_user_id:
                    return RedirectResponse(frontend_login_url(), status_code=302)
                user_id = user["id"]
                await run_blocking(link_google_account, user_id, google_user_id, email)
                should_mark_verified = not user.get("is_verified")
            else:
                # Google 初回ログイン時は Google プロフィールを初期値に使って自動作成する
                # Auto-create a verified user seeded from the Google profile.
                user_id = await run_blocking(
                    create_user,
                    email,
                    username=display_name or None,
                    avatar_url=picture or None,
                    auth_provider=GOOGLE_AUTH_PROVIDER,
                    provider_user_id=google_user_id,
                    provider_email=email,
                    is_verified=True,
                )
                if not user_id:
                    logger.error(
                        "Google OAuth callback: user creation returned no id for email %s",
                        email,
                    )
                    return RedirectResponse(frontend_login_url(), status_code=302)

        await run_blocking(
            update_user_profile_from_google_if_unset,
            user_id,
            display_name or None,
            picture or None,
        )
        if should_mark_verified:
            await run_blocking(set_user_verified, user_id)

        await run_blocking(copy_default_tasks_for_user, user_id)
        persisted_user = await run_blocking(get_user_by_id, user_id)
        session["user_id"] = user_id
        session["user_email"] = persisted_user["email"] if persisted_user else email
        set_session_permanent(session, True)
        return RedirectResponse(frontend_url("/"), status_code=302)
    except Exception:
        logger.exception("Google OAuth callback: unexpected error during user lookup/creation.")
        return RedirectResponse(frontend_login_url(), status_code=302)

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
