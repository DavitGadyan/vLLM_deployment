"""Vector retrieval over the knowledge base."""

from __future__ import annotations

import time

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import metrics
from app.core.logging import get_logger
from app.core.settings import Settings
from app.services.assembler import RetrievedChunk
from app.services.embeddings import EmbeddingClient

log = get_logger(__name__)

# Cosine distance ordering against the HNSW index. `1 - distance` converts to a
# similarity in [0, 1] so the score floor in settings reads the way an operator
# expects (higher is better).
_SEARCH_SQL = text(
    """
    SELECT
        c.id::text          AS chunk_id,
        c.document_id::text AS document_id,
        d.title             AS document_title,
        c.heading           AS heading,
        c.text              AS text,
        1 - (c.embedding <=> CAST(:query_embedding AS vector)) AS score
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.status = 'ready'
    ORDER BY c.embedding <=> CAST(:query_embedding AS vector)
    LIMIT :limit
    """
)


class Retriever:
    def __init__(self, settings: Settings, embeddings: EmbeddingClient) -> None:
        self._settings = settings
        self._embeddings = embeddings

    async def search(
        self, session: AsyncSession, query: str, *, top_k: int | None = None
    ) -> list[RetrievedChunk]:
        """Return chunks ranked by cosine similarity, best first."""
        limit = top_k or self._settings.retrieval_top_k
        started = time.perf_counter()

        embedding = await self._embeddings.embed_query(query)

        # HNSW trades recall for speed via ef_search. The default (40) is tuned
        # for large indexes; a support KB is small enough that we can afford
        # better recall, and missing the one chunk that answers the question is
        # far more costly here than a few milliseconds. Session-scoped so it
        # does not leak to other queries on a pooled connection.
        await session.execute(text("SET LOCAL hnsw.ef_search = 100"))

        result = await session.execute(
            _SEARCH_SQL,
            {"query_embedding": str(embedding), "limit": limit},
        )
        rows = result.mappings().all()

        chunks = [
            RetrievedChunk(
                chunk_id=row["chunk_id"],
                document_id=row["document_id"],
                document_title=row["document_title"],
                heading=row["heading"],
                text=row["text"],
                score=float(row["score"]),
            )
            for row in rows
        ]

        elapsed = time.perf_counter() - started
        metrics.retrieval_duration_seconds.observe(elapsed)
        metrics.retrieval_top_score.observe(chunks[0].score if chunks else 0.0)

        log.debug(
            "retrieval",
            results=len(chunks),
            top_score=round(chunks[0].score, 4) if chunks else None,
            duration_ms=round(elapsed * 1000, 1),
        )
        return chunks

    async def knowledge_base_empty(self, session: AsyncSession) -> bool:
        """True when nothing is indexed — drives the pre-generation escalation."""
        result = await session.execute(
            text("SELECT EXISTS (SELECT 1 FROM documents WHERE status = 'ready')")
        )
        return not bool(result.scalar())
