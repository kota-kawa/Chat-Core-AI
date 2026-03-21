from __future__ import annotations

from fastapi import Request

from services.session_middleware import rotate_session_identifier
from services.web import set_session_permanent


def establish_authenticated_session(request: Request, user_id: int, email: str) -> None:
    # Reissue the session identifier and persist the authenticated user context.
    rotate_session_identifier(request)
    session = request.session
    session["user_id"] = int(user_id)
    session["user_email"] = email
    set_session_permanent(session, True)
