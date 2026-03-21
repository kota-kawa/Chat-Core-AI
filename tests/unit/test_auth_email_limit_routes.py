import asyncio
import json
import unittest
from unittest.mock import patch

from blueprints.auth import api_send_login_code
from blueprints.verification import api_send_verification_email
from tests.helpers.request_helpers import build_request


def make_request(path, json_body, session=None):
    return build_request(
        method="POST",
        path=path,
        json_body=json_body,
        session=session,
    )


class AuthEmailLimitRoutesTestCase(unittest.TestCase):
    def test_send_login_code_returns_429_when_per_email_limit_exceeded(self):
        request = make_request("/api/send_login_code", {"email": "user@example.com"})

        with patch(
            "blueprints.auth.consume_auth_email_send_limits",
            return_value=(False, "too many attempts"),
        ):
            with patch("blueprints.auth.send_email") as mock_send_email:
                response = asyncio.run(api_send_login_code(request))

        self.assertEqual(response.status_code, 429)
        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(payload["status"], "fail")
        self.assertEqual(payload["error"], "too many attempts")
        mock_send_email.assert_not_called()

    def test_send_login_code_returns_429_when_daily_limit_exceeded(self):
        request = make_request("/api/send_login_code", {"email": "user@example.com"})

        with patch(
            "blueprints.auth.consume_auth_email_send_limits",
            return_value=(True, None),
        ):
            with patch(
            "blueprints.auth.get_user_by_email",
            return_value={"id": 1, "email": "user@example.com", "is_verified": True},
            ):
                with patch(
                    "blueprints.auth.consume_auth_email_daily_quota",
                    return_value=(False, 0, 50),
                ):
                    with patch("blueprints.auth.send_email") as mock_send_email:
                        response = asyncio.run(api_send_login_code(request))

        self.assertEqual(response.status_code, 429)
        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(payload["status"], "fail")
        self.assertIn("上限", payload["error"])
        mock_send_email.assert_not_called()

    def test_send_verification_email_returns_429_when_per_email_limit_exceeded(self):
        request = make_request("/api/send_verification_email", {"email": "new-user@example.com"})

        with patch(
            "blueprints.verification.consume_auth_email_send_limits",
            return_value=(False, "too many attempts"),
        ):
            with patch("blueprints.verification.send_email") as mock_send_email:
                response = asyncio.run(api_send_verification_email(request))

        self.assertEqual(response.status_code, 429)
        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(payload["status"], "fail")
        self.assertEqual(payload["error"], "too many attempts")
        mock_send_email.assert_not_called()

    def test_send_verification_email_returns_429_when_daily_limit_exceeded(self):
        request = make_request("/api/send_verification_email", {"email": "new-user@example.com"})

        with patch(
            "blueprints.verification.consume_auth_email_send_limits",
            return_value=(True, None),
        ):
            with patch(
                "blueprints.verification.consume_auth_email_daily_quota",
                return_value=(False, 0, 50),
            ):
                with patch("blueprints.verification.send_email") as mock_send_email:
                    response = asyncio.run(api_send_verification_email(request))

        self.assertEqual(response.status_code, 429)
        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(payload["status"], "fail")
        self.assertIn("上限", payload["error"])
        mock_send_email.assert_not_called()


if __name__ == "__main__":
    unittest.main()
