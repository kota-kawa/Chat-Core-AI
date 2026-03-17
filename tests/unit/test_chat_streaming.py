import asyncio
import threading
import unittest
from unittest.mock import patch

from starlette.responses import StreamingResponse

from blueprints.chat.messages import chat, _iter_llm_stream_events
from services.chat_generation import (
    ChatGenerationAlreadyRunningError,
    build_generation_key,
    has_active_generation,
    start_generation_job,
)
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

    def test_background_generation_job_persists_final_reply_for_guest(self):
        persisted_messages = []

        with patch(
            "services.chat_generation.get_llm_response_stream",
            return_value=iter(["こん", "にちは"]),
        ):
            job = start_generation_job(
                "guest:sid-1:default",
                conversation_messages=[{"role": "user", "content": "こんにちは"}],
                model="openai/gpt-oss-20b",
                persist_response=lambda response: persisted_messages.append(
                    ("sid-1", "default", "assistant", response)
                ),
            )

            body = b"".join(_iter_llm_stream_events(job)).decode("utf-8")

        self.assertIn("event: chunk", body)
        self.assertIn('"text": "こん"', body)
        self.assertIn("event: done", body)
        self.assertIn('"response": "こんにちは"', body)
        self.assertEqual(
            persisted_messages,
            [("sid-1", "default", "assistant", "こんにちは")],
        )

    def test_has_active_generation_is_false_after_job_completion(self):
        release_generation = threading.Event()

        def delayed_stream(*_args, **_kwargs):
            release_generation.wait(timeout=1.0)
            yield "ok"

        with patch(
            "services.chat_generation.get_llm_response_stream",
            side_effect=delayed_stream,
        ):
            job_key = build_generation_key(chat_room_id="default", user_id=1)
            job = start_generation_job(
                job_key,
                conversation_messages=[{"role": "user", "content": "こんにちは"}],
                model="openai/gpt-oss-20b",
                persist_response=lambda _: None,
            )

            self.assertTrue(has_active_generation(job_key))
            release_generation.set()
            self.assertTrue(job.wait(timeout=1.0))
            self.assertFalse(has_active_generation(job_key))

    def test_start_generation_job_rejects_duplicate_active_job(self):
        release_generation = threading.Event()

        def delayed_stream(*_args, **_kwargs):
            release_generation.wait(timeout=1.0)
            yield "done"

        with patch("services.chat_generation.get_llm_response_stream", side_effect=delayed_stream):
            job_key = build_generation_key(chat_room_id="default", user_id=7)
            start_generation_job(
                job_key,
                conversation_messages=[{"role": "user", "content": "こんにちは"}],
                model="openai/gpt-oss-20b",
                persist_response=lambda _: None,
            )

            with self.assertRaises(ChatGenerationAlreadyRunningError):
                start_generation_job(
                    job_key,
                    conversation_messages=[{"role": "user", "content": "再送"}],
                    model="openai/gpt-oss-20b",
                    persist_response=lambda _: None,
                )

            release_generation.set()


if __name__ == "__main__":
    unittest.main()
