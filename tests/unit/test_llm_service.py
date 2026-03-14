import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from services import llm


def _mock_openai_response(text):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=text))]
    )


def _mock_stream_chunk(text):
    return SimpleNamespace(
        choices=[SimpleNamespace(delta=SimpleNamespace(content=text))]
    )


class _MockStream(list):
    def __init__(self, *items):
        super().__init__(items)
        self.closed = False

    def close(self):
        self.closed = True


class LlmServiceTestCase(unittest.TestCase):
    def test_get_llm_response_routes_to_groq(self):
        mock_groq = MagicMock()
        mock_groq.chat.completions.create.return_value = _mock_openai_response("groq-ok")

        with patch.object(llm, "groq_client", mock_groq):
            response = llm.get_llm_response(
                [{"role": "user", "content": "hello"}],
                llm.GROQ_MODEL,
            )

        self.assertEqual(response, "groq-ok")
        mock_groq.chat.completions.create.assert_called_once()

    def test_get_llm_response_routes_to_gemini(self):
        mock_gemini = MagicMock()
        mock_gemini.chat.completions.create.return_value = _mock_openai_response(
            "gemini-ok"
        )

        with patch.object(llm, "gemini_client", mock_gemini):
            response = llm.get_llm_response(
                [{"role": "user", "content": "hello"}],
                "gemini-2.5-flash",
            )

        self.assertEqual(response, "gemini-ok")
        mock_gemini.chat.completions.create.assert_called_once()

    def test_get_llm_response_rejects_invalid_model(self):
        with self.assertRaises(llm.LlmInvalidModelError) as cm:
            llm.get_llm_response(
                [{"role": "user", "content": "hello"}],
                "invalid-model",
            )

        self.assertIn("無効なモデル", str(cm.exception))

    def test_get_groq_response_raises_configuration_error_without_api_key(self):
        with patch.object(llm, "groq_client", None):
            with self.assertRaises(llm.LlmConfigurationError):
                llm.get_groq_response(
                    [{"role": "user", "content": "hello"}],
                    llm.GROQ_MODEL,
                )

    def test_get_gemini_response_wraps_provider_error_as_exception(self):
        mock_gemini = MagicMock()
        mock_gemini.chat.completions.create.side_effect = RuntimeError("provider down")

        with patch.object(llm, "gemini_client", mock_gemini):
            with self.assertRaises(llm.LlmProviderError):
                llm.get_gemini_response(
                    [{"role": "user", "content": "hello"}],
                    "gemini-2.5-flash",
                )

    def test_get_gemini_response_stream_yields_chunks_and_closes_stream(self):
        mock_gemini = MagicMock()
        mock_stream = _MockStream(
            _mock_stream_chunk("gemini"),
            _mock_stream_chunk(None),
            _mock_stream_chunk("-stream"),
        )
        mock_gemini.chat.completions.create.return_value = mock_stream

        with patch.object(llm, "gemini_client", mock_gemini):
            response = list(
                llm.get_gemini_response_stream(
                    [{"role": "user", "content": "hello"}],
                    "gemini-2.5-flash",
                )
            )

        self.assertEqual(response, ["gemini", "-stream"])
        self.assertTrue(mock_stream.closed)
        self.assertTrue(mock_gemini.chat.completions.create.call_args.kwargs["stream"])

    def test_get_groq_response_stream_yields_chunks_and_closes_stream(self):
        mock_groq = MagicMock()
        mock_stream = _MockStream(
            _mock_stream_chunk("groq"),
            _mock_stream_chunk(None),
            _mock_stream_chunk("-stream"),
        )
        mock_groq.chat.completions.create.return_value = mock_stream

        with patch.object(llm, "groq_client", mock_groq):
            response = list(
                llm.get_groq_response_stream(
                    [{"role": "user", "content": "hello"}],
                    llm.GROQ_MODEL,
                )
            )

        self.assertEqual(response, ["groq", "-stream"])
        self.assertTrue(mock_stream.closed)
        self.assertTrue(mock_groq.chat.completions.create.call_args.kwargs["stream"])

    def test_get_llm_response_stream_routes_to_groq(self):
        with patch.object(
            llm,
            "get_groq_response_stream",
            return_value=iter(["groq", "-stream"]),
        ) as mock_stream:
            response = list(
                llm.get_llm_response_stream(
                    [{"role": "user", "content": "hello"}],
                    llm.GROQ_MODEL,
                )
            )

        self.assertEqual(response, ["groq", "-stream"])
        mock_stream.assert_called_once()


if __name__ == "__main__":
    unittest.main()
