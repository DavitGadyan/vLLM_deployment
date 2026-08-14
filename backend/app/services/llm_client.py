"""Streaming client for the vLLM OpenAI-compatible endpoint."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential_jitter

from app.core.logging import get_logger
from app.core.settings import Settings

log = get_logger(__name__)


class UpstreamError(RuntimeError):
    """The serving layer failed in a way the caller should surface."""


@dataclass
class StreamUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    # vLLM reports cached prefill tokens when prefix caching hits. Surfacing it
    # per-request is what lets us attribute a latency win to the prefix cache
    # rather than inferring it from aggregate dashboards.
    cached_tokens: int = 0
    extra: dict[str, Any] = field(default_factory=dict)


class LLMClient:
    """Thin async wrapper over vLLM's chat completions endpoint.

    Deliberately not the `openai` SDK: we need per-chunk control for
    first-token timing, sentinel detection mid-stream, and prompt abandonment on
    client disconnect. The SDK's abstractions are in the way of all three.
    """

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self._settings = settings
        self._client = client or httpx.AsyncClient(
            base_url=settings.vllm_base_url.rstrip("/"),
            timeout=httpx.Timeout(
                settings.request_timeout_seconds,
                # A long read timeout would let a wedged engine hold a request
                # open indefinitely; between-token gaps are what we actually
                # need to tolerate, and those are short.
                connect=5.0,
                read=settings.request_timeout_seconds,
            ),
            headers={"Authorization": f"Bearer {settings.vllm_api_key}"},
            limits=httpx.Limits(max_connections=200, max_keepalive_connections=50),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    @retry(
        retry=retry_if_exception_type(httpx.ConnectError),
        stop=stop_after_attempt(3),
        wait=wait_exponential_jitter(initial=0.2, max=2.0),
        reraise=True,
    )
    async def health(self) -> bool:
        response = await self._client.get("/models", timeout=5.0)
        return response.status_code == 200

    async def stream_chat(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        stop: list[str] | None = None,
    ) -> AsyncIterator[tuple[str, StreamUsage | None]]:
        """Yield `(text_delta, usage)` pairs.

        `usage` is None for content deltas and populated exactly once, on the
        final chunk. Retries are intentionally absent here: once tokens have
        been streamed to the user, replaying the request would duplicate output.
        Connection-establishment failures are retried in `health`, not mid-stream.
        """
        settings = self._settings
        payload: dict[str, Any] = {
            "model": settings.served_model_name,
            "messages": messages,
            "temperature": settings.temperature if temperature is None else temperature,
            "top_p": settings.top_p,
            "max_tokens": max_tokens or settings.max_output_tokens,
            "stream": True,
            # Ask vLLM to append a usage-bearing final chunk so token accounting
            # comes from the engine rather than being re-estimated here.
            "stream_options": {"include_usage": True},
        }
        if stop:
            payload["stop"] = stop

        try:
            async with self._client.stream("POST", "/chat/completions", json=payload) as response:
                if response.status_code >= 400:
                    body = (await response.aread()).decode("utf-8", errors="replace")[:500]
                    log.error("vllm_error", status=response.status_code, body=body)
                    raise UpstreamError(f"vLLM returned {response.status_code}: {body}")

                async for line in response.aiter_lines():
                    if not line or not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    if data == "[DONE]":
                        break

                    try:
                        event = json.loads(data)
                    except json.JSONDecodeError:
                        log.warning("vllm_bad_chunk", chunk=data[:200])
                        continue

                    if usage := event.get("usage"):
                        details = usage.get("prompt_tokens_details") or {}
                        yield (
                            "",
                            StreamUsage(
                                prompt_tokens=usage.get("prompt_tokens", 0),
                                completion_tokens=usage.get("completion_tokens", 0),
                                cached_tokens=details.get("cached_tokens", 0),
                                extra=usage,
                            ),
                        )
                        continue

                    for choice in event.get("choices", []):
                        delta = (choice.get("delta") or {}).get("content")
                        if delta:
                            yield delta, None

        except httpx.TimeoutException as exc:
            raise UpstreamError("vLLM request timed out") from exc
        except httpx.HTTPError as exc:
            raise UpstreamError(f"vLLM transport error: {exc}") from exc
