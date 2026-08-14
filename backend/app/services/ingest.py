"""Document ingestion: parse -> chunk -> embed -> index."""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core import metrics
from app.core.logging import get_logger
from app.core.settings import Settings
from app.db.models import Chunk, Document
from app.services import chunking
from app.services.embeddings import EmbeddingClient

log = get_logger(__name__)

# Batch size for embedding calls. Large enough to amortise HTTP overhead, small
# enough that one oversized document cannot hold a CPU worker for minutes and
# stall other uploads.
EMBED_BATCH_SIZE = 32


class IngestService:
    def __init__(
        self,
        settings: Settings,
        embeddings: EmbeddingClient,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._settings = settings
        self._embeddings = embeddings
        self._session_factory = session_factory

    async def register(
        self,
        session: AsyncSession,
        *,
        filename: str,
        content_type: str,
        data: bytes,
        title: str | None,
    ) -> tuple[Document, bool]:
        """Create the document row. Returns `(document, is_new)`.

        Content-hash deduplication: re-uploading an unchanged file is a common
        accident, and silently doubling every chunk would skew retrieval toward
        whatever was uploaded twice.
        """
        content_hash = hashlib.sha256(data).hexdigest()

        existing = await session.scalar(
            select(Document).where(Document.content_hash == content_hash)
        )
        if existing is not None:
            return existing, False

        document = Document(
            id=uuid.uuid4(),
            title=(title or filename).strip()[:500],
            filename=filename[:500],
            content_type=content_type[:120],
            size_bytes=len(data),
            content_hash=content_hash,
            status="pending",
        )
        session.add(document)
        await session.commit()
        await session.refresh(document)
        return document, True

    async def process(self, document_id: uuid.UUID, data: bytes) -> None:
        """Parse, chunk, embed and index. Runs as a background task.

        Uses its own session rather than the request's: the HTTP response has
        already been returned by the time this runs, and the request session is
        closed. Failures are recorded on the document row so the console can show
        the operator what went wrong instead of leaving an upload stuck.
        """
        async with self._session_factory() as session:
            document = await session.get(Document, document_id)
            if document is None:
                log.error("ingest_document_missing", document_id=str(document_id))
                return

            document.status = "processing"
            await session.commit()

            try:
                text_content = chunking.parse(data, document.content_type, document.filename)
                chunks = chunking.chunk(
                    text_content,
                    chunk_tokens=self._settings.chunk_size_tokens,
                    overlap_tokens=self._settings.chunk_overlap_tokens,
                )
                if not chunks:
                    raise chunking.UnsupportedDocument("document produced no usable text")

                # Replace rather than append, so reprocessing is idempotent.
                await session.execute(delete(Chunk).where(Chunk.document_id == document.id))

                for start in range(0, len(chunks), EMBED_BATCH_SIZE):
                    batch = chunks[start : start + EMBED_BATCH_SIZE]
                    vectors = await self._embeddings.embed([item.embedding_text for item in batch])
                    for item, vector in zip(batch, vectors, strict=True):
                        session.add(
                            Chunk(
                                id=uuid.uuid4(),
                                document_id=document.id,
                                ordinal=item.ordinal,
                                text=item.text,
                                heading=item.heading,
                                token_count=item.token_count,
                                embedding=vector,
                            )
                        )
                    await session.flush()

                document.status = "ready"
                document.chunk_count = len(chunks)
                document.error = None
                document.indexed_at = datetime.now(UTC)
                await session.commit()

                metrics.documents_ingested_total.labels(status="ready").inc()
                metrics.chunks_indexed_total.inc(len(chunks))
                log.info(
                    "ingest_complete",
                    document_id=str(document.id),
                    title=document.title,
                    chunks=len(chunks),
                )

            except Exception as exc:
                await session.rollback()
                document = await session.get(Document, document_id)
                if document is not None:
                    document.status = "failed"
                    document.error = str(exc)[:2000]
                    await session.commit()
                metrics.documents_ingested_total.labels(status="failed").inc()
                log.exception("ingest_failed", document_id=str(document_id))

    async def delete(self, session: AsyncSession, document_id: uuid.UUID) -> bool:
        """Delete a document and its chunks (cascade handles the chunks)."""
        document = await session.get(Document, document_id)
        if document is None:
            return False
        await session.delete(document)
        await session.commit()
        log.info("document_deleted", document_id=str(document_id))
        return True
