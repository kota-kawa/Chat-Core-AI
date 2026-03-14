"""LLM service module using OpenAI client for multiple providers."""

import logging
import os
from collections.abc import Iterator

from openai import OpenAI


def _get_positive_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default

GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")
GEMINI_DEFAULT_MODEL = os.environ.get("GEMINI_DEFAULT_MODEL", "gemini-2.5-flash")
LLM_MAX_TOKENS = _get_positive_int_env("LLM_MAX_TOKENS", 4096)

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"

# Valid model names
VALID_GEMINI_MODELS = {
    "gemini-2.5-flash",
}
VALID_GROQ_MODELS = {GROQ_MODEL}

groq_api_key = os.environ.get("GROQ_API_KEY", "")
gemini_api_key = os.environ.get("Gemini_API_KEY", "")

groq_client = (
    OpenAI(api_key=groq_api_key, base_url=GROQ_BASE_URL)
    if groq_api_key
    else None
)
gemini_client = (
    OpenAI(api_key=gemini_api_key, base_url=GEMINI_BASE_URL)
    if gemini_api_key
    else None
)
logger = logging.getLogger(__name__)
ConversationMessages = list[dict[str, str]]


class LlmServiceError(RuntimeError):
    # LLM連携で発生する例外の基底クラス
    # Base exception class for LLM integration failures.
    pass


class LlmConfigurationError(LlmServiceError):
    # APIキー未設定など、設定不備に関する例外
    # Configuration-related exception (e.g., missing API key).
    pass


class LlmProviderError(LlmServiceError):
    # 外部プロバイダ呼び出し失敗に関する例外
    # Provider-call failure exception.
    pass


class LlmInvalidModelError(LlmServiceError):
    # 未サポートモデル指定時の例外
    # Unsupported model selection exception.
    pass


def _raise_invalid_model_error(model_name: str) -> None:
    valid_models = sorted(VALID_GEMINI_MODELS | VALID_GROQ_MODELS)
    logger.warning(
        "Invalid model requested: %s. Valid models: %s",
        model_name,
        valid_models,
    )
    raise LlmInvalidModelError(
        f"無効なモデル '{model_name}' が指定されました。"
        f"有効なモデル: {', '.join(valid_models)}"
    )


def get_groq_response(
    conversation_messages: ConversationMessages, model_name: str
) -> str | None:
    # Groq 向けクライアントを使ってチャット補完を実行する
    # Run chat completion through the Groq client.
    """Groq API呼び出し (via OpenAI client)"""
    if groq_client is None:
        raise LlmConfigurationError("GROQ_API_KEY が未設定です。")

    try:
        response = groq_client.chat.completions.create(
            model=model_name,
            messages=conversation_messages,
            max_tokens=LLM_MAX_TOKENS,
        )
        return response.choices[0].message.content
    except Exception as exc:
        logger.exception("Groq API call failed.")
        raise LlmProviderError("Groq API call failed.") from exc


def _get_openai_compatible_response_stream(
    *,
    client: OpenAI | None,
    conversation_messages: ConversationMessages,
    model_name: str,
    missing_key_message: str,
    provider_error_message: str,
) -> Iterator[str]:
    # OpenAI互換APIのストリーム断片を順次返し、最後に確実に close する
    # Yield OpenAI-compatible stream deltas and always close the stream.
    if client is None:
        raise LlmConfigurationError(missing_key_message)

    stream = None
    try:
        stream = client.chat.completions.create(
            model=model_name,
            messages=conversation_messages,
            max_tokens=LLM_MAX_TOKENS,
            stream=True,
        )
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = getattr(chunk.choices[0], "delta", None)
            content = getattr(delta, "content", None)
            if content:
                yield content
    except Exception as exc:
        logger.exception(provider_error_message)
        raise LlmProviderError(provider_error_message) from exc
    finally:
        close = getattr(stream, "close", None)
        if callable(close):
            close()


def get_groq_response_stream(
    conversation_messages: ConversationMessages, model_name: str
) -> Iterator[str]:
    # Groq のストリーム応答を逐次テキスト片として返す
    # Yield Groq response chunks incrementally.
    return _get_openai_compatible_response_stream(
        client=groq_client,
        conversation_messages=conversation_messages,
        model_name=model_name,
        missing_key_message="GROQ_API_KEY が未設定です。",
        provider_error_message="Groq streaming API call failed.",
    )


def get_gemini_response(
    conversation_messages: ConversationMessages, model_name: str
) -> str | None:
    # Gemini 向けクライアントを使ってチャット補完を実行する
    # Run chat completion through the Gemini client.
    """Google Gemini API呼び出し (via OpenAI client)"""
    if gemini_client is None:
        raise LlmConfigurationError("Gemini_API_KEY が未設定です。")

    try:
        response = gemini_client.chat.completions.create(
            model=model_name,
            messages=conversation_messages,
            max_tokens=LLM_MAX_TOKENS,
        )
        return response.choices[0].message.content
    except Exception as exc:
        logger.exception("Google Gemini API call failed.")
        raise LlmProviderError("Google Gemini API call failed.") from exc


def get_gemini_response_stream(
    conversation_messages: ConversationMessages, model_name: str
) -> Iterator[str]:
    # Gemini のストリーム応答を逐次テキスト片として返す
    # Yield Gemini response chunks incrementally.
    return _get_openai_compatible_response_stream(
        client=gemini_client,
        conversation_messages=conversation_messages,
        model_name=model_name,
        missing_key_message="Gemini_API_KEY が未設定です。",
        provider_error_message="Google Gemini streaming API call failed.",
    )


def is_gemini_model(model_name: str) -> bool:
    # モデル名が Gemini 系かを判定する
    # Check whether the selected model belongs to Gemini.
    return model_name in VALID_GEMINI_MODELS


def is_groq_model(model_name: str) -> bool:
    # モデル名が Groq 系かを判定する
    # Check whether the selected model belongs to Groq.
    return model_name in VALID_GROQ_MODELS


def is_streaming_model(model_name: str) -> bool:
    # 現在SSE配信に対応しているモデルかを判定する
    # Check whether the selected model supports SSE streaming in this app.
    return is_gemini_model(model_name) or is_groq_model(model_name)


def get_llm_response(
    conversation_messages: ConversationMessages, model_name: str
) -> str | None:
    # 指定モデル名でプロバイダを振り分け、不正モデルは例外として扱う
    # Route provider by model name and raise on invalid models.
    if is_gemini_model(model_name):
        return get_gemini_response(conversation_messages, model_name)
    if is_groq_model(model_name):
        return get_groq_response(conversation_messages, model_name)

    _raise_invalid_model_error(model_name)


def get_llm_response_stream(
    conversation_messages: ConversationMessages, model_name: str
) -> Iterator[str]:
    # 指定モデル名でストリーム可能なプロバイダを振り分ける
    # Route streaming providers by model name and raise on invalid models.
    if is_gemini_model(model_name):
        return get_gemini_response_stream(conversation_messages, model_name)
    if is_groq_model(model_name):
        return get_groq_response_stream(conversation_messages, model_name)

    _raise_invalid_model_error(model_name)
