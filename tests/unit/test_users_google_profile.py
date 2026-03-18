import unittest
from unittest.mock import patch

from services.users import update_user_profile_from_google_if_unset


class FakeCursor:
    def __init__(self, current_profile):
        self.current_profile = dict(current_profile)
        self.executed = []
        self._fetchone_result = None
        self.closed = False

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.executed.append((normalized, params))

        if "SELECT username, avatar_url FROM users WHERE id = %s" in normalized:
            self._fetchone_result = dict(self.current_profile)
            return

        if "UPDATE users SET username = %s, avatar_url = %s WHERE id = %s" in normalized:
            self.current_profile["username"] = params[0]
            self.current_profile["avatar_url"] = params[1]
            self._fetchone_result = None
            return

        self._fetchone_result = None

    def fetchone(self):
        result = self._fetchone_result
        self._fetchone_result = None
        return result

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.committed = False
        self.closed = False

    def cursor(self, *args, **kwargs):
        return self._cursor

    def commit(self):
        self.committed = True

    def close(self):
        self.closed = True


class GoogleProfileSyncTestCase(unittest.TestCase):
    def test_updates_default_username_and_avatar_from_google(self):
        fake_cursor = FakeCursor(
            {"username": "ユーザー", "avatar_url": "/static/user-icon.png"}
        )
        fake_conn = FakeConnection(fake_cursor)

        with patch("services.users.get_db_connection", return_value=fake_conn):
            update_user_profile_from_google_if_unset(
                7,
                name="Alice Example",
                picture="https://example.com/alice.png",
            )

        self.assertTrue(fake_conn.committed)
        self.assertTrue(fake_conn.closed)
        self.assertTrue(fake_cursor.closed)
        self.assertEqual(fake_cursor.current_profile["username"], "Alice Example")
        self.assertEqual(
            fake_cursor.current_profile["avatar_url"],
            "https://example.com/alice.png",
        )

    def test_preserves_existing_custom_profile_values(self):
        fake_cursor = FakeCursor(
            {"username": "Custom Name", "avatar_url": "/static/uploads/custom.png"}
        )
        fake_conn = FakeConnection(fake_cursor)

        with patch("services.users.get_db_connection", return_value=fake_conn):
            update_user_profile_from_google_if_unset(
                8,
                name="Google Name",
                picture="https://example.com/google.png",
            )

        self.assertTrue(fake_conn.committed)
        self.assertEqual(fake_cursor.current_profile["username"], "Custom Name")
        self.assertEqual(
            fake_cursor.current_profile["avatar_url"],
            "/static/uploads/custom.png",
        )


if __name__ == "__main__":
    unittest.main()
