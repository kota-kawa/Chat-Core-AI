import asyncio
import unittest
from unittest.mock import call, patch

from starlette.responses import StreamingResponse

from blueprints.chat.messages import chat, _iter_llm_stream_events
from tests.helpers.request_helpers import build_request


def make_request(json_body, session=None):
    return build_request(
        method="POST",
        path="/api/chat",
        json_body=json_body,
        session=session,
    )


class ChatStreamingTestCase(unittest.TestCase):
    def test_chat_returns_streaming_response_for_gemini(self):
        request = make_request(
            {"message": "こんにちは", "chat_room_id": "default", "model": "gemini-2.5-flash"},
            session={},
        )

        with patch("blueprints.chat.messages.cleanup_ephemeral_chats"):
            with patch("blueprints.chat.messages.ephemeral_store.room_exists", return_value=True):
                with patch(
                    "blueprints.chat.messages.ephemeral_store.get_messages",
                    return_value=[{"role": "user", "content": "こんにちは"}],
                ):
                    with patch("blueprints.chat.messages.ephemeral_store.append_message"):
                        with patch(
                            "blueprints.chat.messages.consume_llm_daily_quota",
                            return_value=(True, 1, 300),
                        ):
                            response = asyncio.run(chat(request))

        self.assertIsInstance(response, StreamingResponse)
        self.assertEqual(response.media_type, "text/event-stream")

    def test_chat_returns_streaming_response_for_groq(self):
        request = make_request(
            {"message": "こんにちは", "chat_room_id": "default", "model": "openai/gpt-oss-20b"},
            session={},
        )

        with patch("blueprints.chat.messages.cleanup_ephemeral_chats"):
            with patch("blueprints.chat.messages.ephemeral_store.room_exists", return_value=True):
                with patch(
                    "blueprints.chat.messages.ephemeral_store.get_messages",
                    return_value=[{"role": "user", "content": "こんにちは"}],
                ):
                    with patch("blueprints.chat.messages.ephemeral_store.append_message"):
                        with patch(
                            "blueprints.chat.messages.consume_llm_daily_quota",
                            return_value=(True, 1, 300),
                        ):
                            response = asyncio.run(chat(request))

        self.assertIsInstance(response, StreamingResponse)
        self.assertEqual(response.media_type, "text/event-stream")

    def test_iter_llm_stream_events_persists_final_reply_for_guest(self):
        with patch(
            "blueprints.chat.messages.get_llm_response_stream",
            return_value=iter(["こん", "にちは"]),
        ):
            with patch("blueprints.chat.messages.ephemeral_store.append_message") as mock_append:
                body = b"".join(
                    _iter_llm_stream_events(
                        [{"role": "user", "content": "こんにちは"}],
                        "openai/gpt-oss-20b",
                        chat_room_id="default",
                        is_authenticated=False,
                        sid="sid-1",
                    )
                ).decode("utf-8")

        self.assertIn("event: chunk", body)
        self.assertIn('"text": "こん"', body)
        self.assertIn("event: done", body)
        self.assertIn('"response": "こんにちは"', body)
        self.assertEqual(
            mock_append.call_args_list,
            [call("sid-1", "default", "assistant", "こんにちは")],
        )


if __name__ == "__main__":
    unittest.main()
