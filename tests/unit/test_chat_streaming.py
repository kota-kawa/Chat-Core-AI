import asyncio
import json
import threading
import unittest
from unittest.mock import patch

from starlette.responses import StreamingResponse

from blueprints.chat.messages import (
    chat,
    _iter_llm_stream_events,
    chat_generation_status,
    chat_generation_stream,
    get_chat_history,
)
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

    def test_generation_continues_after_disconnect_and_reopen_returns_completed_reply(self):
        stored_messages = []
        release_generation = threading.Event()
        generation_finished = threading.Event()
        session = {"user_id": 42}

        def save_message(room_id, message, sender):
            stored_messages.append((room_id, message, sender))
            if sender == "assistant":
                generation_finished.set()

        def get_messages(room_id):
            return [
                {
                    "role": "user" if sender == "user" else "assistant",
                    "content": message,
                }
                for stored_room_id, message, sender in stored_messages
                if stored_room_id == room_id
            ]

        def fetch_history(room_id):
            return [
                {
                    "message": message,
                    "sender": sender,
                    "timestamp": "2026-03-17 00:00:00",
                }
                for stored_room_id, message, sender in stored_messages
                if stored_room_id == room_id
            ]

        def delayed_stream(*_args, **_kwargs):
            yield "完"
            release_generation.wait(timeout=1.0)
            yield "了"

        request = make_request(
            {"message": "こんにちは", "chat_room_id": "room-1", "model": "openai/gpt-oss-20b"},
            session=session,
        )

        with patch("blueprints.chat.messages.cleanup_ephemeral_chats"):
            with patch("blueprints.chat.messages.validate_room_owner", return_value=(None, None)):
                with patch("blueprints.chat.messages.save_message_to_db", side_effect=save_message):
                    with patch("blueprints.chat.messages.get_chat_room_messages", side_effect=get_messages):
                        with patch("blueprints.chat.messages._fetch_chat_history", side_effect=fetch_history):
                            with patch(
                                "blueprints.chat.messages.consume_llm_daily_quota",
                                return_value=(True, 1, 300),
                            ):
                                with patch(
                                    "services.chat_generation.get_llm_response_stream",
                                    side_effect=delayed_stream,
                                ):
                                    response = asyncio.run(chat(request))
                                    self.assertIsInstance(response, StreamingResponse)

                                    generation_key = build_generation_key(chat_room_id="room-1", user_id=42)
                                    self.assertTrue(has_active_generation(generation_key))

                                    status_request = build_request(
                                        method="GET",
                                        path="/api/chat_generation_status",
                                        session=session,
                                        query_string=b"room_id=room-1",
                                    )
                                    status_response = asyncio.run(chat_generation_status(status_request))
                                    status_payload = json.loads(status_response.body.decode("utf-8"))
                                    self.assertTrue(status_payload["is_generating"])

                                    release_generation.set()
                                    self.assertTrue(generation_finished.wait(timeout=1.0))
                                    self.assertFalse(has_active_generation(generation_key))

                                    history_request = build_request(
                                        method="GET",
                                        path="/api/get_chat_history",
                                        session=session,
                                        query_string=b"room_id=room-1",
                                    )
                                    history_response = asyncio.run(get_chat_history(history_request))
                                    history_payload = json.loads(history_response.body.decode("utf-8"))

        self.assertEqual(
            [message["sender"] for message in history_payload["messages"]],
            ["user", "assistant"],
        )
        self.assertEqual(history_payload["messages"][-1]["message"], "完了")


    def test_chat_generation_status_includes_has_replayable_job(self):
        session = {"user_id": 99}

        with patch(
            "services.chat_generation.get_llm_response_stream",
            return_value=iter(["完了"]),
        ):
            job_key = build_generation_key(chat_room_id="room-status", user_id=99)
            job = start_generation_job(
                job_key,
                conversation_messages=[{"role": "user", "content": "test"}],
                model="openai/gpt-oss-20b",
                persist_response=lambda _: None,
            )
            # consume all events so the job finishes
            list(_iter_llm_stream_events(job))

        status_request = build_request(
            method="GET",
            path="/api/chat_generation_status",
            session=session,
            query_string=b"room_id=room-status",
        )
        with patch("blueprints.chat.messages.cleanup_ephemeral_chats"):
            with patch("blueprints.chat.messages.validate_room_owner", return_value=(None, None)):
                status_response = asyncio.run(chat_generation_status(status_request))

        payload = json.loads(status_response.body.decode("utf-8"))
        self.assertFalse(payload["is_generating"])
        self.assertTrue(payload["has_replayable_job"])

    def test_chat_generation_stream_replays_completed_job(self):
        session = {"user_id": 77}

        with patch(
            "services.chat_generation.get_llm_response_stream",
            return_value=iter(["再", "生"]),
        ):
            job_key = build_generation_key(chat_room_id="room-replay", user_id=77)
            job = start_generation_job(
                job_key,
                conversation_messages=[{"role": "user", "content": "test"}],
                model="openai/gpt-oss-20b",
                persist_response=lambda _: None,
            )
            # consume all events so the job finishes
            list(_iter_llm_stream_events(job))

        stream_request = build_request(
            method="GET",
            path="/api/chat_generation_stream",
            session=session,
            query_string=b"room_id=room-replay",
        )
        with patch("blueprints.chat.messages.cleanup_ephemeral_chats"):
            with patch("blueprints.chat.messages.validate_room_owner", return_value=(None, None)):
                stream_response = asyncio.run(chat_generation_stream(stream_request))

        self.assertIsInstance(stream_response, StreamingResponse)
        self.assertEqual(stream_response.media_type, "text/event-stream")

        async def _consume():
            chunks = []
            async for chunk in stream_response.body_iterator:
                chunks.append(chunk)
            return b"".join(chunks)

        body = asyncio.run(_consume()).decode("utf-8")
        self.assertIn("event: chunk", body)
        self.assertIn('"text": "再"', body)
        self.assertIn("event: done", body)
        self.assertIn('"response": "再生"', body)

    def test_chat_generation_stream_returns_404_when_no_job(self):
        session = {"user_id": 55}

        stream_request = build_request(
            method="GET",
            path="/api/chat_generation_stream",
            session=session,
            query_string=b"room_id=room-nonexistent",
        )
        with patch("blueprints.chat.messages.cleanup_ephemeral_chats"):
            with patch("blueprints.chat.messages.validate_room_owner", return_value=(None, None)):
                stream_response = asyncio.run(chat_generation_stream(stream_request))

        self.assertEqual(stream_response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
