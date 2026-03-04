import asyncio
import json
import unittest
from unittest.mock import patch

from blueprints.admin import views as admin_views
from services.security import hash_password
from tests.helpers.request_helpers import build_request


def make_request(method="GET", path="/admin/api/dashboard", json_body=None, session=None, query_string=b""):
    return build_request(
        method=method,
        path=path,
        json_body=json_body,
        session=session,
        query_string=query_string,
    )


class AdminApiTestCase(unittest.TestCase):
    def test_dashboard_requires_admin(self):
        request = make_request(session={})
        response = asyncio.run(admin_views.api_dashboard(request))
        self.assertEqual(response.status_code, 401)
        payload = json.loads(response.body.decode())
        self.assertEqual(payload["status"], "fail")

    def test_login_success(self):
        password = "admin-test-password"
        request = make_request(
            method="POST",
            path="/admin/api/login",
            json_body={"password": password, "next": "/admin"},
        )
        with patch.object(admin_views, "ADMIN_PASSWORD_HASH", hash_password(password)):
            response = asyncio.run(admin_views.api_login(request))
        self.assertEqual(response.status_code, 200)
        payload = json.loads(response.body.decode())
        self.assertEqual(payload["status"], "success")


    def test_login_rejects_external_next_url(self):
        password = "admin-test-password"
        external_next_values = ["https://evil.com", "http://evil.com", "//evil.com"]

        with patch.object(admin_views, "ADMIN_PASSWORD_HASH", hash_password(password)):
            for external_next in external_next_values:
                with self.subTest(next=external_next):
                    request = make_request(
                        method="POST",
                        path="/admin/api/login",
                        json_body={"password": password, "next": external_next},
                    )
                    response = asyncio.run(admin_views.api_login(request))
                    payload = json.loads(response.body.decode())
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(payload["status"], "success")
                    self.assertEqual(payload["redirect"], "http://localhost:3000/admin")

    def test_login_fails_with_wrong_password(self):
        request = make_request(
            method="POST",
            path="/admin/api/login",
            json_body={"password": "wrong-password", "next": "/admin"},
        )
        with patch.object(admin_views, "ADMIN_PASSWORD_HASH", hash_password("correct-password")):
            response = asyncio.run(admin_views.api_login(request))

        self.assertEqual(response.status_code, 401)
        payload = json.loads(response.body.decode())
        self.assertEqual(payload["status"], "fail")

    def test_dashboard_returns_tables(self):
        class DummyCursor:
            def close(self):
                return None

        class DummyConnection:
            def cursor(self):
                return DummyCursor()

            def close(self):
                return None

        request = make_request(session={"is_admin": True}, query_string=b"table=users")

        with patch("blueprints.admin.views.get_db_connection", return_value=DummyConnection()):
            with patch("blueprints.admin.views._fetch_tables", return_value=["users"]):
                with patch(
                    "blueprints.admin.views._fetch_table_preview",
                    return_value=(["id"], [(1,)]),
                ):
                    with patch(
                        "blueprints.admin.views._fetch_table_columns",
                        return_value=[
                            {
                                "name": "id",
                                "type": "int",
                                "nullable": False,
                                "key": "PRI",
                                "default": None,
                                "extra": "",
                            }
                        ],
                    ):
                        response = asyncio.run(admin_views.api_dashboard(request))

        self.assertEqual(response.status_code, 200)
        payload = json.loads(response.body.decode())
        self.assertEqual(payload["selected_table"], "users")
        self.assertEqual(payload["column_names"], ["id"])


if __name__ == "__main__":
    unittest.main()
