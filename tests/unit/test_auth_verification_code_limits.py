import asyncio
import json
import unittest
from unittest.mock import patch

from blueprints.auth import api_send_login_code, api_verify_login_code
from blueprints.verification import api_send_verification_email, api_verify_registration_code
from tests.helpers.request_helpers import build_request


def make_request(path, json_body, session=None):
    return build_request(method="POST", path=path, json_body=json_body, session=session)


class VerificationCodeLimitsTestCase(unittest.TestCase):
    def test_send_verification_email_stores_issued_at_and_attempts(self):
        session = {"_seed": True}
        request = make_request(
            "/api/send_verification_email",
            {"email": "new-user@example.com"},
            session=session,
        )

        with patch("blueprints.verification.consume_auth_email_daily_quota", return_value=(True, 1, 50)):
            with patch("blueprints.verification.get_user_by_email", return_value=None):
                with patch("blueprints.verification.create_user", return_value=10):
                    with patch("blueprints.verification.generate_verification_code", return_value="123456"):
                        with patch("blueprints.verification.time.time", return_value=1000):
                            with patch("blueprints.verification.send_email"):
                                response = asyncio.run(api_send_verification_email(request))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(session["verification_code"], "123456")
        self.assertEqual(session["verification_code_issued_at"], 1000)
        self.assertEqual(session["verification_code_attempts"], 0)

    def test_verify_registration_code_fails_when_expired_and_clears_session(self):
        session = {
            "verification_code": "111111",
            "temp_user_id": 7,
            "verification_code_issued_at": 1000,
            "verification_code_attempts": 0,
        }
        request = make_request(
            "/api/verify_registration_code",
            {"authCode": "111111"},
            session=session,
        )

        with patch("blueprints.verification.time.time", return_value=2000):
            response = asyncio.run(api_verify_registration_code(request))

        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(response.status_code, 400)
        self.assertIn("有効期限", payload["error"])
        self.assertNotIn("verification_code", session)
        self.assertNotIn("verification_code_issued_at", session)
        self.assertNotIn("verification_code_attempts", session)

    def test_verify_registration_code_blocks_when_attempt_limit_reached(self):
        session = {
            "verification_code": "111111",
            "temp_user_id": 7,
            "verification_code_issued_at": 1000,
            "verification_code_attempts": 4,
        }
        request = make_request(
            "/api/verify_registration_code",
            {"authCode": "000000"},
            session=session,
        )

        with patch("blueprints.verification.time.time", return_value=1001):
            response = asyncio.run(api_verify_registration_code(request))

        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(response.status_code, 400)
        self.assertIn("試行回数", payload["error"])
        self.assertNotIn("verification_code", session)
        self.assertNotIn("verification_code_issued_at", session)
        self.assertNotIn("verification_code_attempts", session)

    def test_send_login_code_stores_issued_at_and_attempts(self):
        session = {"_seed": True}
        request = make_request(
            "/api/send_login_code",
            {"email": "user@example.com"},
            session=session,
        )

        with patch(
            "blueprints.auth.get_user_by_email",
            return_value={"id": 1, "email": "user@example.com", "is_verified": True},
        ):
            with patch("blueprints.auth.consume_auth_email_daily_quota", return_value=(True, 1, 50)):
                with patch("blueprints.auth.generate_verification_code", return_value="654321"):
                    with patch("blueprints.auth.time.time", return_value=3000):
                        with patch("blueprints.auth.send_email"):
                            response = asyncio.run(api_send_login_code(request))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(session["login_verification_code"], "654321")
        self.assertEqual(session["login_verification_code_issued_at"], 3000)
        self.assertEqual(session["login_verification_code_attempts"], 0)

    def test_verify_login_code_fails_when_expired_and_clears_session(self):
        session = {
            "login_verification_code": "222222",
            "login_temp_user_id": 12,
            "login_verification_code_issued_at": 1000,
            "login_verification_code_attempts": 0,
        }
        request = make_request("/api/verify_login_code", {"authCode": "222222"}, session=session)

        with patch("blueprints.auth.time.time", return_value=2000):
            response = asyncio.run(api_verify_login_code(request))

        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(response.status_code, 400)
        self.assertIn("有効期限", payload["error"])
        self.assertNotIn("login_verification_code", session)
        self.assertNotIn("login_verification_code_issued_at", session)
        self.assertNotIn("login_verification_code_attempts", session)

    def test_verify_login_code_blocks_when_attempt_limit_reached(self):
        session = {
            "login_verification_code": "222222",
            "login_temp_user_id": 12,
            "login_verification_code_issued_at": 1000,
            "login_verification_code_attempts": 4,
        }
        request = make_request("/api/verify_login_code", {"authCode": "000000"}, session=session)

        with patch("blueprints.auth.time.time", return_value=1001):
            response = asyncio.run(api_verify_login_code(request))

        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(response.status_code, 400)
        self.assertIn("試行回数", payload["error"])
        self.assertNotIn("login_verification_code", session)
        self.assertNotIn("login_verification_code_issued_at", session)
        self.assertNotIn("login_verification_code_attempts", session)


if __name__ == "__main__":
    unittest.main()
