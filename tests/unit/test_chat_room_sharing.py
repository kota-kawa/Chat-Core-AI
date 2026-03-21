import asyncio
import json
import unittest
from unittest.mock import patch

from blueprints.chat.rooms import share_chat_room, shared_chat_room
from tests.helpers.request_helpers import build_request


def make_share_request(json_body, session=None):
    return build_request(
        method="POST",
        path="/api/share_chat_room",
        json_body=json_body,
        session=session,
    )


def make_shared_read_request(token: str):
    return build_request(
        method="GET",
        path="/api/shared_chat_room",
        query_string=f"token={token}".encode("utf-8"),
        session={},
    )


class ChatRoomSharingTestCase(unittest.TestCase):
    def test_share_chat_room_requires_login(self):
        request = make_share_request({"room_id": "room-1"}, session={})

        with patch("blueprints.chat.rooms.cleanup_ephemeral_chats"):
            response = asyncio.run(share_chat_room(request))

        self.assertEqual(response.status_code, 403)
        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(payload["error"], "ログインが必要です")

    def test_share_chat_room_returns_403_when_not_owner(self):
        request = make_share_request({"room_id": "room-1"}, session={"user_id": 10})

        with patch("blueprints.chat.rooms.cleanup_ephemeral_chats"):
            with patch(
                "blueprints.chat.rooms.validate_room_owner",
                return_value=({"error": "他ユーザーのチャットルームは共有できません"}, 403),
            ):
                response = asyncio.run(share_chat_room(request))

        self.assertEqual(response.status_code, 403)
        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(payload["error"], "他ユーザーのチャットルームは共有できません")

    def test_share_chat_room_returns_share_url_on_success(self):
        request = make_share_request({"room_id": "room-42"}, session={"user_id": 3})

        with patch("blueprints.chat.rooms.cleanup_ephemeral_chats"):
            with patch("blueprints.chat.rooms.validate_room_owner", return_value=(None, None)):
                with patch(
                    "blueprints.chat.rooms.create_or_get_shared_chat_token",
                    return_value=("abc123token", None),
                ):
                    with patch(
                        "blueprints.chat.rooms.frontend_url",
                        return_value="https://chatcore-ai.com/shared/abc123token",
                    ):
                        response = asyncio.run(share_chat_room(request))

        self.assertEqual(response.status_code, 200)
        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(payload["share_token"], "abc123token")
        self.assertEqual(payload["share_url"], "https://chatcore-ai.com/shared/abc123token")

    def test_shared_chat_room_requires_token(self):
        request = build_request(
            method="GET",
            path="/api/shared_chat_room",
            query_string=b"",
            session={},
        )
        with patch("blueprints.chat.rooms.cleanup_ephemeral_chats"):
            response = asyncio.run(shared_chat_room(request))

        self.assertEqual(response.status_code, 400)
        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(payload["error"], "token is required")

    def test_shared_chat_room_returns_payload(self):
        request = make_shared_read_request("share-token-1")
        expected = (
            {
                "room": {
                    "id": "room-1",
                    "title": "共有テスト",
                    "created_at": "2026-03-21 12:00:00",
                },
                "messages": [
                    {
                        "message": "こんにちは",
                        "sender": "user",
                        "timestamp": "2026-03-21 12:00:01",
                    }
                ],
            },
            200,
        )

        with patch("blueprints.chat.rooms.cleanup_ephemeral_chats"):
            with patch(
                "blueprints.chat.rooms.get_shared_chat_room_payload",
                return_value=expected,
            ):
                response = asyncio.run(shared_chat_room(request))

        self.assertEqual(response.status_code, 200)
        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(payload["room"]["id"], "room-1")
        self.assertEqual(payload["messages"][0]["message"], "こんにちは")

    def test_shared_chat_room_returns_not_found(self):
        request = make_shared_read_request("missing")
        with patch("blueprints.chat.rooms.cleanup_ephemeral_chats"):
            with patch(
                "blueprints.chat.rooms.get_shared_chat_room_payload",
                return_value=({"error": "共有リンクが見つかりません"}, 404),
            ):
                response = asyncio.run(shared_chat_room(request))

        self.assertEqual(response.status_code, 404)
        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual(payload["error"], "共有リンクが見つかりません")


if __name__ == "__main__":
    unittest.main()
