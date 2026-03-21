import json
import logging
import os
import time
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

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

try:
    from webauthn import (
        generate_authentication_options,
        generate_registration_options,
        verify_authentication_response,
        verify_registration_response,
    )
    from webauthn.helpers import (
        base64url_to_bytes,
        bytes_to_base64url,
        options_to_json,
    )
    from webauthn.helpers.structs import (
        AuthenticatorSelectionCriteria,
        PublicKeyCredentialDescriptor,
        PublicKeyCredentialHint,
        ResidentKeyRequirement,
        UserVerificationRequirement,
    )
except ModuleNotFoundError:  # pragma: no cover - optional for test envs
    generate_authentication_options = None
    generate_registration_options = None
    verify_authentication_response = None
    verify_registration_response = None
    options_to_json = None
    base64url_to_bytes = None
    bytes_to_base64url = None
    AuthenticatorSelectionCriteria = None
    PublicKeyCredentialDescriptor = None
    PublicKeyCredentialHint = None
    ResidentKeyRequirement = None
    UserVerificationRequirement = None

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
from services.auth_limits import consume_auth_email_send_limits
from services.request_models import AuthCodeRequest, EmailRequest
from services.async_utils import run_blocking
from services.auth_session import establish_authenticated_session
from services.csrf import require_csrf
from services.passkeys import (
    PASSKEY_CHALLENGE_TTL_SECONDS,
    clear_passkey_session,
    create_passkey,
    get_credential_lookup_id,
    get_passkey_authentication_ceremony,
    delete_passkey,
    get_passkey_registration_ceremony,
    get_passkey_by_credential_id,
    passkey_ceremony_is_expired,
    get_passkey_origins,
    get_passkey_rp_id,
    get_passkey_rp_name,
    list_passkeys_for_user,
    store_passkey_authentication_ceremony,
    store_passkey_registration_ceremony,
    update_passkey_usage,
)
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
from blueprints.verification import (
    api_send_verification_email,
    api_verify_registration_code,
)

# 認証関連の環境変数を初期化する
# Load environment variables needed by auth flows.
load_dotenv()

# 開発環境では OAuth の http コールバックを許可する
# Allow OAuth over HTTP in non-production environments.
if not is_production_env():
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

GOOGLE_LOGIN_UNAVAILABLE_ERROR = "Googleログインを現在利用できません。"
PASSKEY_UNAVAILABLE_ERROR = "Passkeyログインを現在利用できません。"

GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "openid",
]

auth_bp = APIRouter(dependencies=[Depends(require_csrf)])
logger = logging.getLogger(__name__)

LOGIN_VERIFICATION_CODE_TTL_SECONDS = 300
LOGIN_VERIFICATION_CODE_MAX_ATTEMPTS = 5


def _clear_login_verification_session(session: dict[str, Any]) -> None:
    session.pop("login_verification_code", None)
    session.pop("login_temp_user_id", None)
    session.pop("login_verification_code_issued_at", None)
    session.pop("login_verification_code_attempts", None)


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


def _passkey_unavailable_response() -> Any:
    return jsonify({"status": "fail", "error": PASSKEY_UNAVAILABLE_ERROR}, status_code=503)

def _user_id_from_session(session: dict[str, Any]) -> int | None:
    user_id = session.get("user_id")
    if isinstance(user_id, int):
        return user_id
    return None


async def _copy_default_tasks_after_login(user_id: int, *, context: str) -> None:
    try:
        await run_blocking(copy_default_tasks_for_user, user_id)
    except Exception:
        logger.exception("%s: failed to copy default tasks for user %s", context, user_id)


def _build_absolute_url_from_reference(reference_url: str, path: str) -> str | None:
    parts = urlsplit(reference_url)
    if not parts.scheme or not parts.netloc:
        return None

    normalized_path = path if path.startswith("/") else f"/{path}"
    return urlunsplit((parts.scheme, parts.netloc, normalized_path, "", ""))


def _append_query_params(url: str, **params: str) -> str:
    parts = urlsplit(url)
    existing_params = dict(parse_qsl(parts.query, keep_blank_values=True))
    existing_params.update(params)
    return urlunsplit(
        (
            parts.scheme,
            parts.netloc,
            parts.path,
            urlencode(existing_params),
            parts.fragment,
        )
    )


def _google_callback_redirect_target(
    request: Request,
    path: str,
    *,
    redirect_uri: str | None = None,
) -> str:
    session_redirect_uri = request.session.get("google_redirect_uri")
    configured_redirect_uri = (os.getenv("GOOGLE_REDIRECT_URI") or "").strip()
    references: tuple[str | None, ...] = (
        redirect_uri,
        session_redirect_uri if isinstance(session_redirect_uri, str) else None,
        configured_redirect_uri or None,
        str(request.url),
    )
    for reference in references:
        if not isinstance(reference, str) or not reference:
            continue
        target = _build_absolute_url_from_reference(reference, path)
        if target:
            return target
    return frontend_url(path)


def _redirect_to_login_after_google_failure(
    request: Request,
    session: dict[str, Any],
    *,
    redirect_uri: str | None = None,
) -> RedirectResponse:
    target_url = _google_callback_redirect_target(
        request,
        "/login",
        redirect_uri=redirect_uri,
    )
    _clear_google_oauth_session(session)
    return RedirectResponse(target_url, status_code=302)


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


def _build_google_login_host_redirect(
    request: Request, redirect_uri: str
) -> RedirectResponse | None:
    # Google callback のホストとログイン開始ホストがズレると host-only cookie の
    # セッションが引き継がれないため、認可開始前に callback 側ホストへ寄せる。
    # Canonicalize the auth-start host to the callback host so host-only session cookies survive.
    redirect_parts = urlsplit(redirect_uri)
    if not redirect_parts.scheme or not redirect_parts.netloc:
        return None

    request_host = request.headers.get("host") or request.url.netloc
    if not isinstance(request_host, str) or not request_host:
        return None

    if request_host.lower() == redirect_parts.netloc.lower():
        return None

    canonical_url = urlunsplit(
        (
            redirect_parts.scheme,
            redirect_parts.netloc,
            request.url.path,
            request.url.query,
            "",
        )
    )
    return RedirectResponse(canonical_url, status_code=302)


def _fetch_google_user_info(access_token: str) -> dict[str, Any]:
    # Google API からログインユーザーのプロフィール情報を取得する
    # Fetch authenticated user info from Google UserInfo API.
    response = requests.get(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=10,
    )
    response.raise_for_status()
    try:
        return response.json()
    except ValueError as e:
        raise requests.RequestException(f"Invalid JSON response: {e}") from e


def _clean_google_field(user_info: dict[str, Any], key: str) -> str:
    value = user_info.get(key)
    if value is None:
        return ""
    return str(value).strip()


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
        clear_passkey_session(session)
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


@auth_bp.post("/api/auth/send_email_code", name="auth.api_send_email_code")
async def api_send_email_code(request: Request):
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

    user = await run_blocking(get_user_by_email, payload.email)
    if user and user.get("is_verified"):
        return await api_send_login_code(request)
    return await api_send_verification_email(request)


@auth_bp.post("/api/auth/verify_email_code", name="auth.api_verify_email_code")
async def api_verify_email_code(request: Request):
    session = request.session
    if session.get("login_verification_code") and session.get("login_temp_user_id"):
        return await api_verify_login_code(request)
    if session.get("verification_code") and session.get("temp_user_id"):
        return await api_verify_registration_code(request)
    return jsonify(
        {"status": "fail", "error": "セッション情報がありません。最初からやり直してください"},
        status_code=400,
    )


@auth_bp.get("/api/passkeys", name="auth.api_list_passkeys")
async def api_list_passkeys(request: Request):
    user_id = _user_id_from_session(request.session)
    if user_id is None:
        return jsonify({"status": "fail", "error": "ログインが必要です"}, status_code=401)

    passkeys = await run_blocking(list_passkeys_for_user, user_id)
    return jsonify({"status": "success", "passkeys": passkeys})


@auth_bp.post("/api/passkeys/delete", name="auth.api_delete_passkey")
async def api_delete_passkey(request: Request):
    user_id = _user_id_from_session(request.session)
    if user_id is None:
        return jsonify({"status": "fail", "error": "ログインが必要です"}, status_code=401)

    data, error_response = await require_json_dict(request, status="fail")
    if error_response is not None:
        return error_response

    try:
        passkey_id = int(data.get("passkey_id"))
    except (TypeError, ValueError):
        return jsonify({"status": "fail", "error": "Passkeyが指定されていません"}, status_code=400)

    deleted = await run_blocking(delete_passkey, user_id, passkey_id)
    if not deleted:
        return jsonify({"status": "fail", "error": "Passkeyが見つかりません"}, status_code=404)

    return jsonify({"status": "success"})


@auth_bp.post("/api/passkeys/register/options", name="auth.api_passkey_register_options")
async def api_passkey_register_options(request: Request):
    if (
        generate_registration_options is None
        or options_to_json is None
        or AuthenticatorSelectionCriteria is None
        or ResidentKeyRequirement is None
        or UserVerificationRequirement is None
        or PublicKeyCredentialHint is None
        or PublicKeyCredentialDescriptor is None
        or base64url_to_bytes is None
        or bytes_to_base64url is None
    ):
        return _passkey_unavailable_response()

    user_id = _user_id_from_session(request.session)
    if user_id is None:
        return jsonify({"status": "fail", "error": "ログインが必要です"}, status_code=401)

    user = await run_blocking(get_user_by_id, user_id)
    if not user:
        return jsonify({"status": "fail", "error": "ユーザーが存在しません"}, status_code=404)

    existing_passkeys = await run_blocking(list_passkeys_for_user, user_id)
    exclude_credentials = [
        PublicKeyCredentialDescriptor(id=base64url_to_bytes(row["credential_id"]))
        for row in existing_passkeys
        if isinstance(row.get("credential_id"), str) and row["credential_id"]
    ]

    options = generate_registration_options(
        rp_id=get_passkey_rp_id(request),
        rp_name=get_passkey_rp_name(),
        user_name=user["email"],
        user_id=str(user_id).encode("utf-8"),
        user_display_name=(user.get("username") or user["email"]),
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=exclude_credentials,
        hints=[
            PublicKeyCredentialHint.CLIENT_DEVICE,
            PublicKeyCredentialHint.HYBRID,
        ],
    )
    store_passkey_registration_ceremony(
        request.session,
        bytes_to_base64url(options.challenge),
    )
    return jsonify(json.loads(options_to_json(options)))


@auth_bp.post("/api/passkeys/register/verify", name="auth.api_passkey_register_verify")
async def api_passkey_register_verify(request: Request):
    if (
        verify_registration_response is None
        or base64url_to_bytes is None
        or bytes_to_base64url is None
    ):
        return _passkey_unavailable_response()

    user_id = _user_id_from_session(request.session)
    if user_id is None:
        return jsonify({"status": "fail", "error": "ログインが必要です"}, status_code=401)

    ceremony = get_passkey_registration_ceremony(request.session)
    if ceremony is None:
        return jsonify({"status": "fail", "error": "Passkey登録を最初からやり直してください"}, status_code=400)
    if passkey_ceremony_is_expired(ceremony):
        clear_passkey_session(request.session)
        return jsonify(
            {
                "status": "fail",
                "error": (
                    f"Passkey登録の有効期限が切れています。"
                    f"{PASSKEY_CHALLENGE_TTL_SECONDS // 60}分以内に再試行してください"
                ),
            },
            status_code=400,
        )

    data, error_response = await require_json_dict(request, status="fail")
    if error_response is not None:
        return error_response

    credential = data.get("credential")
    label = data.get("label")
    if not isinstance(credential, dict):
        return jsonify({"status": "fail", "error": "Passkeyの応答が不正です"}, status_code=400)

    try:
        verified = verify_registration_response(
            credential=credential,
            expected_challenge=base64url_to_bytes(ceremony["challenge"]),
            expected_rp_id=get_passkey_rp_id(request),
            expected_origin=get_passkey_origins(request),
            require_user_verification=True,
        )
        passkey = await run_blocking(
            create_passkey,
            user_id,
            bytes_to_base64url(verified.credential_id),
            bytes_to_base64url(verified.credential_public_key),
            int(verified.sign_count),
            aaguid=verified.aaguid,
            credential_device_type=str(verified.credential_device_type.value),
            credential_backed_up=bool(verified.credential_backed_up),
            label=str(label) if isinstance(label, str) else None,
        )
    except Exception:
        logger.exception("Passkey registration verification failed for user %s", user_id)
        clear_passkey_session(request.session)
        return jsonify({"status": "fail", "error": "Passkeyの登録に失敗しました"}, status_code=400)

    clear_passkey_session(request.session)
    return jsonify({"status": "success", "passkey": passkey})


@auth_bp.post("/api/passkeys/authenticate/options", name="auth.api_passkey_authenticate_options")
async def api_passkey_authenticate_options(request: Request):
    if (
        generate_authentication_options is None
        or options_to_json is None
        or UserVerificationRequirement is None
        or bytes_to_base64url is None
    ):
        return _passkey_unavailable_response()

    options = generate_authentication_options(
        rp_id=get_passkey_rp_id(request),
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    store_passkey_authentication_ceremony(
        request.session,
        bytes_to_base64url(options.challenge),
    )
    return jsonify(json.loads(options_to_json(options)))


@auth_bp.post("/api/passkeys/authenticate/verify", name="auth.api_passkey_authenticate_verify")
async def api_passkey_authenticate_verify(request: Request):
    if (
        verify_authentication_response is None
        or base64url_to_bytes is None
    ):
        return _passkey_unavailable_response()

    ceremony = get_passkey_authentication_ceremony(request.session)
    if ceremony is None:
        return jsonify({"status": "fail", "error": "Passkey認証を最初からやり直してください"}, status_code=400)
    if passkey_ceremony_is_expired(ceremony):
        clear_passkey_session(request.session)
        return jsonify(
            {
                "status": "fail",
                "error": (
                    f"Passkey認証の有効期限が切れています。"
                    f"{PASSKEY_CHALLENGE_TTL_SECONDS // 60}分以内に再試行してください"
                ),
            },
            status_code=400,
        )

    data, error_response = await require_json_dict(request, status="fail")
    if error_response is not None:
        return error_response

    credential = data.get("credential")
    if not isinstance(credential, dict):
        return jsonify({"status": "fail", "error": "Passkeyの応答が不正です"}, status_code=400)

    credential_id = get_credential_lookup_id(credential)
    if not isinstance(credential_id, str) or not credential_id:
        return jsonify({"status": "fail", "error": "PasskeyのIDが不正です"}, status_code=400)

    passkey = await run_blocking(get_passkey_by_credential_id, credential_id)
    if not passkey:
        clear_passkey_session(request.session)
        return jsonify({"status": "fail", "error": "Passkey認証に失敗しました"}, status_code=400)

    try:
        verified = verify_authentication_response(
            credential=credential,
            expected_challenge=base64url_to_bytes(ceremony["challenge"]),
            expected_rp_id=get_passkey_rp_id(request),
            expected_origin=get_passkey_origins(request),
            credential_public_key=base64url_to_bytes(passkey["public_key"]),
            credential_current_sign_count=int(passkey["sign_count"] or 0),
            require_user_verification=True,
        )
    except Exception:
        logger.exception("Passkey authentication verification failed.")
        clear_passkey_session(request.session)
        return jsonify({"status": "fail", "error": "Passkey認証に失敗しました"}, status_code=400)

    user = await run_blocking(get_user_by_id, passkey["user_id"])
    if not user or not user.get("is_verified"):
        clear_passkey_session(request.session)
        return jsonify({"status": "fail", "error": "ユーザーが存在しないか、認証されていません"}, status_code=400)

    establish_authenticated_session(request, int(passkey["user_id"]), user["email"])
    clear_passkey_session(request.session)

    try:
        await run_blocking(
            update_passkey_usage,
            int(passkey["id"]),
            int(verified.new_sign_count),
            credential_backed_up=bool(verified.credential_backed_up),
            credential_device_type=str(verified.credential_device_type.value),
        )
    except Exception:
        logger.exception(
            "Passkey authentication: failed to update credential usage for passkey %s",
            passkey["id"],
        )
    await _copy_default_tasks_after_login(
        int(passkey["user_id"]),
        context="Passkey authentication",
    )

    return jsonify({"status": "success", "message": "Passkeyでログインしました"})


@auth_bp.get("/google-login", name="auth.google_login")
async def google_login(request: Request):
    if Flow is None:
        logger.error(
            "Google login is unavailable because google-auth-oauthlib is not installed."
        )
        return _google_login_unavailable_response()
    configured_redirect_uri = (os.getenv("GOOGLE_REDIRECT_URI") or "").strip()
    redirect_uri = configured_redirect_uri or url_for(
        request, "auth.google_callback", _external=True
    )
    canonical_redirect = _build_google_login_host_redirect(request, configured_redirect_uri)
    if canonical_redirect is not None:
        return canonical_redirect
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
    logger.info(
        "Google OAuth login started. State: %s, Redirect URI: %s, Session ID: %s",
        state[:16] + "..." if state else "None",
        redirect_uri,
        request.scope.get("session_id", "unknown"),
    )
    return RedirectResponse(authorization_url, status_code=302)


@auth_bp.get("/google-callback", name="auth.google_callback")
async def google_callback(request: Request):
    session = request.session
    if Flow is None:
        return _redirect_to_login_after_google_failure(request, session)
    # Google 側でエラーが発生した場合（ユーザーがキャンセルした等）を先に処理
    # Handle Google-side errors first (e.g., user cancelled authorization).
    google_error = request.query_params.get("error")
    if google_error:
        logger.warning(
            "Google OAuth callback: authorization error from Google: %s",
            google_error,
        )
        return _redirect_to_login_after_google_failure(request, session)
    state = session.get("google_oauth_state")
    logger.info(
        "Google OAuth callback received. Session ID: %s, Has state: %s, Session keys: %s",
        request.scope.get("session_id", "unknown"),
        bool(state),
        list(session.keys()),
    )
    if not state:
        logger.warning(
            "Google OAuth callback: session state missing. "
            "Session keys: %s, Request host: %s",
            list(session.keys()),
            request.headers.get("host"),
        )
        return _redirect_to_login_after_google_failure(request, session)
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
        return _redirect_to_login_after_google_failure(
            request,
            session,
            redirect_uri=redirect_uri,
        )
    login_redirect_url = _google_callback_redirect_target(
        request,
        "/login",
        redirect_uri=redirect_uri,
    )
    success_redirect_url = _google_callback_redirect_target(
        request,
        "/",
        redirect_uri=redirect_uri,
    )
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
        return _redirect_to_login_after_google_failure(
            request,
            session,
            redirect_uri=redirect_uri,
        )
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
        _clear_google_oauth_session(session)
        return RedirectResponse(login_redirect_url, status_code=302)

    # トークン交換成功後にOAuthセッションをクリアする
    # Clear OAuth session after successful token exchange.
    _clear_google_oauth_session(session)

    credentials = flow.credentials
    access_token = getattr(credentials, "token", "")
    if not isinstance(access_token, str) or not access_token:
        logger.error("Google OAuth callback completed without an access token.")
        return RedirectResponse(login_redirect_url, status_code=302)

    try:
        user_info = await run_blocking(_fetch_google_user_info, access_token)
    except requests.RequestException:
        logger.exception("Failed to fetch Google user info.")
        return RedirectResponse(login_redirect_url, status_code=302)

    email = _clean_google_field(user_info, "email")
    # id (v2) または sub (OIDC) のいずれかを Google ID として使用する
    # Use 'id' (legacy) or 'sub' (standard OIDC) as Google provider identity.
    google_user_id = _clean_google_field(user_info, "id") or _clean_google_field(user_info, "sub")
    display_name = _clean_google_field(user_info, "name")
    picture = _clean_google_field(user_info, "picture")
    # verified_email (v2) または email_verified (OIDC) のいずれかで認証済みか判定する
    # Check if email is verified via 'verified_email' or 'email_verified' field.
    verified_email = bool(user_info.get("verified_email") or user_info.get("email_verified"))

    if not email or not google_user_id or not verified_email:
        missing = []
        if not email: missing.append("email")
        if not google_user_id: missing.append("google_user_id (id/sub)")
        if not verified_email: missing.append("verified_email/email_verified")
        logger.warning("Google OAuth callback: required fields missing: %s", ", ".join(missing))
        return RedirectResponse(login_redirect_url, status_code=302)

    # ユーザー検索・作成（クリティカル：失敗時はログインを中断する）
    # User lookup / creation — abort login on failure.
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
                    logger.warning(
                        "Google OAuth callback: conflicting google_user_id for email %s",
                        email,
                    )
                    return RedirectResponse(login_redirect_url, status_code=302)
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
                    return RedirectResponse(login_redirect_url, status_code=302)
    except Exception:
        logger.exception("Google OAuth callback: unexpected error during user lookup/creation.")
        return RedirectResponse(login_redirect_url, status_code=302)

    # セッション確立（最優先：以降の補助処理が失敗してもログインは成立させる）
    # Establish session first — non-critical helpers must not block login.
    establish_authenticated_session(request, int(user_id), email)

    # 補助処理（失敗してもログイン自体には影響させない）
    # Auxiliary operations — failures are logged but do not block login.
    try:
        await run_blocking(
            update_user_profile_from_google_if_unset,
            user_id,
            display_name or None,
            picture or None,
        )
    except Exception:
        logger.exception("Google OAuth callback: failed to sync profile for user %s", user_id)

    if should_mark_verified:
        try:
            await run_blocking(set_user_verified, user_id)
        except Exception:
            logger.exception("Google OAuth callback: failed to verify user %s", user_id)

    await _copy_default_tasks_after_login(user_id, context="Google OAuth callback")

    try:
        persisted_user = await run_blocking(get_user_by_id, user_id)
        if persisted_user:
            session["user_email"] = persisted_user["email"]
    except Exception:
        logger.exception("Google OAuth callback: failed to refresh email for user %s", user_id)

    return RedirectResponse(
        _append_query_params(success_redirect_url, auth="success"),
        status_code=302,
    )

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
    allowed, limit_error = consume_auth_email_send_limits(request, email)
    if not allowed:
        return jsonify({"status": "fail", "error": limit_error}, status_code=429)

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
        _clear_login_verification_session(session)
        return jsonify({"status": "fail", "error": "認証コードの有効期限が切れています。"}, status_code=400)
    if attempts >= LOGIN_VERIFICATION_CODE_MAX_ATTEMPTS:
        _clear_login_verification_session(session)
        return jsonify({"status": "fail", "error": "認証コードの試行回数が上限に達しました。"}, status_code=400)

    submitted_code = str(auth_code or "")
    if constant_time_compare(submitted_code, str(session_code)):
        user = await run_blocking(get_user_by_id, user_id)
        if not user or not user.get("is_verified"):
            _clear_login_verification_session(session)
            session.pop("user_id", None)
            session.pop("user_email", None)
            return jsonify(
                {"status": "fail", "error": "ユーザーが存在しないか、認証されていません"},
                status_code=400,
            )
        establish_authenticated_session(request, int(user_id), user["email"] if user else "")
        _clear_login_verification_session(session)
        await _copy_default_tasks_after_login(int(user_id), context="Email login verification")
        return jsonify({"status": "success", "message": "ログインに成功しました"})
    else:
        attempts += 1
        session["login_verification_code_attempts"] = attempts
        if attempts >= LOGIN_VERIFICATION_CODE_MAX_ATTEMPTS:
            _clear_login_verification_session(session)
            return jsonify({"status": "fail", "error": "認証コードの試行回数が上限に達しました。"}, status_code=400)
        return jsonify({"status": "fail", "error": "認証コードが一致しません。"}, status_code=400)
