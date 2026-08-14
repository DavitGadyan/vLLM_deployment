"""Client for the OpenAI-compatible embedding service."""

from __future__ import annotations

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential_jitter

from app.core.logging import get_logger
from app.core.settings import Settings

log = get_logger(__name__)


class EmbeddingError(RuntimeError):
    pass


class EmbeddingClient:
    """Embeds text via a separate CPU service.

    Kept off the GPU deliberately. Ingesting a 200-page policy PDF is a burst of
    hundreds of embedding calls; running those on the serving GPU would evict KV
    cache blocks and spike latency for every customer mid-conversation. A small
    encoder on CPU is fast enough and completely isolates the two workloads.
    """

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self._settings = settings
        self._client = client or httpx.AsyncClient(
            base_url=settings.embeddings_base_url.rstrip("/"),
            timeout=httpx.Timeout(60.0, connect=5.0),
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=10),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def health(self) -> bool:
        try:
            response = await self._client.get("/models", timeout=5.0)
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    @retry(
        retry=retry_if_exception_type((httpx.ConnectError, httpx.ReadTimeout)),
        stop=stop_after_attempt(3),
        wait=wait_exponential_jitter(initial=0.3, max=3.0),
        reraise=True,
    )
    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch. Order of results matches order of inputs."""
        if not texts:
            return []

        try:
            response = await self._client.post(
                "/embeddings",
                json={"model": self._settings.embeddings_model, "input": texts},
            )
        except httpx.HTTPError as exc:
            raise EmbeddingError(f"embedding transport error: {exc}") from exc

        if response.status_code >= 400:
            raise EmbeddingError(
                f"embedding service returned {response.status_code}: {response.text[:300]}"
            )

        payload = response.json()
        # Sort by index rather than trusting response order — the OpenAI schema
        # permits reordering and batching servers sometimes do.
        items = sorted(payload["data"], key=lambda item: item["index"])
        vectors = [item["embedding"] for item in items]

        expected = self._settings.embeddings_dim
        for vector in vectors:
            if len(vector) != expected:
                raise EmbeddingError(
                    f"embedding dimension mismatch: got {len(vector)}, schema expects "
                    f"{expected}. The chunks.embedding column is fixed-width — changing "
                    "the embedding model requires a migration and a full re-index."
                )
        return vectors

    async def embed_one(self, text: str) -> list[float]:
        vectors = await self.embed([text])
        return vectors[0]

    async def embed_query(self, text: str) -> list[float]:
        """Embed a search query.

        BGE models are trained with an asymmetric objective: queries carry a
        retrieval instruction prefix and passages do not. Skipping the prefix
        measurably degrades recall, and it is an easy thing to get silently
        wrong, so it lives here rather than at the call site.
        """
        if "bge" in self._settings.embeddings_model.lower():
            text = f"Represent this sentence for searching relevant passages: {text}"
        return await self.embed_one(text)
