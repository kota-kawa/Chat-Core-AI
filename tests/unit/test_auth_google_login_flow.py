import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from blueprints.auth import google_callback
from tests.helpers.request_helpers import build_request


class FakeFlow:
    def __init__(self):
        self.credentials = SimpleNamespace(token="google-access-token")
        self.authorization_responses = []

    def fetch_token(self, *, authorization_response):
        self.authorization_responses.append(authorization_response)


async def immediate_run_blocking(func, *args, **kwargs):
    return func(*args, **kwargs)


def make_request():
    return build_request(
        method="GET",
        path="/google-callback",
        query_string=b"code=abc&state=google-state",
        session={
            "google_oauth_state": "google-state",
            "google_redirect_uri": "https://chatcore-ai.com/google-callback",
        },
    )


class GoogleLoginFlowTestCase(unittest.TestCase):
    def test_new_google_user_is_created_with_profile_fields(self):
        request = make_request()
        fake_flow = FakeFlow()
        fake_flow_class = Mock()
        fake_flow_class.from_client_config.return_value = fake_flow

        with patch("blueprints.auth.Flow", fake_flow_class):
            with patch("blueprints.auth.run_blocking", new=immediate_run_blocking):
                with patch(
                    "blueprints.auth._fetch_google_user_info",
                    return_value={
                        "id": "google-user-123",
                        "email": "user@example.com",
                        "verified_email": True,
                        "name": "Alice Example",
                        "picture": "https://example.com/alice.png",
                    },
                ):
                    with patch("blueprints.auth.get_user_by_google_id", return_value=None):
                        with patch("blueprints.auth.get_user_by_email", return_value=None):
                            with patch("blueprints.auth.create_user", return_value=42) as mock_create:
                                with patch("blueprints.auth.link_google_account") as mock_link:
                                    with patch(
                                        "blueprints.auth.update_user_profile_from_google_if_unset"
                                    ) as mock_profile_sync:
                                        with patch("blueprints.auth.set_user_verified") as mock_verify:
                                            with patch(
                                                "blueprints.auth.copy_default_tasks_for_user"
                                            ) as mock_copy_tasks:
                                                with patch(
                                                    "blueprints.auth.get_user_by_id",
                                                    return_value={
                                                        "id": 42,
                                                        "email": "user@example.com",
                                                    },
                                                ):
                                                    with patch(
                                                        "blueprints.auth.frontend_url",
                                                        return_value="http://frontend/",
                                                    ):
                                                        response = asyncio.run(
                                                            google_callback(request)
                                                        )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], "http://frontend/")
        self.assertEqual(request.session["user_id"], 42)
        self.assertEqual(request.session["user_email"], "user@example.com")
        self.assertNotIn("google_oauth_state", request.session)
        self.assertNotIn("google_redirect_uri", request.session)
        self.assertEqual(
            fake_flow.authorization_responses,
            ["https://chatcore-ai.com/google-callback?code=abc&state=google-state"],
        )
        mock_create.assert_called_once_with(
            "user@example.com",
            username="Alice Example",
            avatar_url="https://example.com/alice.png",
            auth_provider="google",
            provider_user_id="google-user-123",
            provider_email="user@example.com",
            is_verified=True,
        )
        mock_link.assert_not_called()
        mock_profile_sync.assert_called_once_with(
            42,
            "Alice Example",
            "https://example.com/alice.png",
        )
        mock_verify.assert_not_called()
        mock_copy_tasks.assert_called_once_with(42)

    def test_existing_email_user_is_linked_and_verified(self):
        request = make_request()
        fake_flow = FakeFlow()
        fake_flow_class = Mock()
        fake_flow_class.from_client_config.return_value = fake_flow
        existing_user = {
            "id": 7,
            "email": "user@example.com",
            "is_verified": False,
            "provider_user_id": None,
            "username": "Custom Name",
            "avatar_url": "/static/uploads/custom.png",
        }

        with patch("blueprints.auth.Flow", fake_flow_class):
            with patch("blueprints.auth.run_blocking", new=immediate_run_blocking):
                with patch(
                    "blueprints.auth._fetch_google_user_info",
                    return_value={
                        "id": "google-user-123",
                        "email": "user@example.com",
                        "verified_email": True,
                        "name": "Alice Example",
                        "picture": "https://example.com/alice.png",
                    },
                ):
                    with patch("blueprints.auth.get_user_by_google_id", return_value=None):
                        with patch(
                            "blueprints.auth.get_user_by_email",
                            return_value=existing_user,
                        ):
                            with patch("blueprints.auth.create_user") as mock_create:
                                with patch("blueprints.auth.link_google_account") as mock_link:
                                    with patch(
                                        "blueprints.auth.update_user_profile_from_google_if_unset"
                                    ) as mock_profile_sync:
                                        with patch(
                                            "blueprints.auth.set_user_verified"
                                        ) as mock_verify:
                                            with patch(
                                                "blueprints.auth.copy_default_tasks_for_user"
                                            ) as mock_copy_tasks:
                                                with patch(
                                                    "blueprints.auth.get_user_by_id",
                                                    return_value={
                                                        "id": 7,
                                                        "email": "user@example.com",
                                                    },
                                                ):
                                                    with patch(
                                                        "blueprints.auth.frontend_url",
                                                        return_value="http://frontend/",
                                                    ):
                                                        response = asyncio.run(
                                                            google_callback(request)
                                                        )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(request.session["user_id"], 7)
        mock_create.assert_not_called()
        mock_link.assert_called_once_with(7, "google-user-123", "user@example.com")
        mock_profile_sync.assert_called_once_with(
            7,
            "Alice Example",
            "https://example.com/alice.png",
        )
        mock_verify.assert_called_once_with(7)
        mock_copy_tasks.assert_called_once_with(7)

    def test_rejects_google_login_when_email_is_not_verified(self):
        request = make_request()
        fake_flow = FakeFlow()
        fake_flow_class = Mock()
        fake_flow_class.from_client_config.return_value = fake_flow

        with patch("blueprints.auth.Flow", fake_flow_class):
            with patch("blueprints.auth.run_blocking", new=immediate_run_blocking):
                with patch(
                    "blueprints.auth._fetch_google_user_info",
                    return_value={
                        "id": "google-user-123",
                        "email": "user@example.com",
                        "verified_email": False,
                    },
                ):
                    with patch(
                        "blueprints.auth.frontend_login_url",
                        return_value="http://frontend/login",
                    ):
                        with patch("blueprints.auth.create_user") as mock_create:
                            response = asyncio.run(google_callback(request))

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], "http://frontend/login")
        mock_create.assert_not_called()
        self.assertNotIn("user_id", request.session)


if __name__ == "__main__":
    unittest.main()
