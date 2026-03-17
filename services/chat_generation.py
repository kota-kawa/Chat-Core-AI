from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

from .llm import LlmServiceError, get_llm_response_stream

logger = logging.getLogger(__name__)

JOB_RETENTION_SECONDS = 300


class ChatGenerationAlreadyRunningError(RuntimeError):
    pass


@dataclass(frozen=True)
class ChatGenerationEvent:
    event: str
    payload: dict[str, Any]


class ChatGenerationJob:
    def __init__(
        self,
        *,
        conversation_messages: list[dict[str, str]],
        model: str,
        persist_response: Callable[[str], None],
    ) -> None:
        self._conversation_messages = [dict(message) for message in conversation_messages]
        self._model = model
        self._persist_response = persist_response
        self._events: list[ChatGenerationEvent] = []
        self._condition = threading.Condition()
        self._thread: threading.Thread | None = None
        self.response = ""
        self.error_message: str | None = None
        self.started_at = time.monotonic()
        self.finished_at: float | None = None
        self.is_done = False

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def wait(self, timeout: float | None = None) -> bool:
        thread = self._thread
        if thread is None:
            return self.is_done
        thread.join(timeout)
        return self.is_done

    def iter_events(self) -> Iterator[ChatGenerationEvent]:
        cursor = 0
        while True:
            with self._condition:
                while cursor >= len(self._events) and not self.is_done:
                    self._condition.wait(timeout=0.5)

                if cursor < len(self._events):
                    event = self._events[cursor]
                    cursor += 1
                elif self.is_done:
                    break
                else:
                    continue

            yield event

    def _publish(self, event: str, payload: dict[str, Any], *, done: bool = False) -> None:
        with self._condition:
            self._events.append(ChatGenerationEvent(event=event, payload=payload))
            if done:
                self.is_done = True
                self.finished_at = time.monotonic()
            self._condition.notify_all()

    def _run(self) -> None:
        chunks: list[str] = []
        try:
            for chunk in get_llm_response_stream(self._conversation_messages, self._model):
                if not chunk:
                    continue
                chunks.append(chunk)
                self._publish("chunk", {"text": chunk})
        except LlmServiceError:
            self.error_message = "内部エラーが発生しました。"
            self._publish("error", {"message": self.error_message}, done=True)
            return

        bot_reply = "".join(chunks)
        self.response = bot_reply

        try:
            self._persist_response(bot_reply)
        except Exception:
            logger.exception("Failed to persist background chat response.")
            self.error_message = "応答は生成されましたが、履歴保存に失敗しました。"
            self._publish("error", {"message": self.error_message}, done=True)
            return

        self._publish("done", {"response": bot_reply}, done=True)


_jobs: dict[str, ChatGenerationJob] = {}
_jobs_lock = threading.Lock()


def build_generation_key(*, chat_room_id: str, user_id: int | None = None, sid: str | None = None) -> str:
    if user_id is not None:
        return f"user:{user_id}:{chat_room_id}"
    if sid is not None:
        return f"guest:{sid}:{chat_room_id}"
    raise ValueError("Either user_id or sid is required to build a generation key.")


def _cleanup_expired_jobs(now: float | None = None) -> None:
    current_time = time.monotonic() if now is None else now
    expired_keys: list[str] = []

    with _jobs_lock:
        for key, job in _jobs.items():
            if not job.is_done or job.finished_at is None:
                continue
            if current_time - job.finished_at >= JOB_RETENTION_SECONDS:
                expired_keys.append(key)

        for key in expired_keys:
            _jobs.pop(key, None)


def has_active_generation(job_key: str) -> bool:
    _cleanup_expired_jobs()
    with _jobs_lock:
        job = _jobs.get(job_key)
        return job is not None and not job.is_done


def get_generation_job(job_key: str) -> ChatGenerationJob | None:
    _cleanup_expired_jobs()
    with _jobs_lock:
        return _jobs.get(job_key)


def start_generation_job(
    job_key: str,
    *,
    conversation_messages: list[dict[str, str]],
    model: str,
    persist_response: Callable[[str], None],
) -> ChatGenerationJob:
    _cleanup_expired_jobs()

    with _jobs_lock:
        existing_job = _jobs.get(job_key)
        if existing_job is not None and not existing_job.is_done:
            raise ChatGenerationAlreadyRunningError(job_key)

        job = ChatGenerationJob(
            conversation_messages=conversation_messages,
            model=model,
            persist_response=persist_response,
        )
        _jobs[job_key] = job

    job.start()
    return job
