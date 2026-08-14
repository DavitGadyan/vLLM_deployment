"""Knowledge-base document API."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select

from app.api.deps import IngestServiceDep, SessionDep, SettingsDep
from app.db.models import Chunk, Document
from app.schemas.documents import ChunkOut, DocumentOut, UploadResponse

router = APIRouter(prefix="/documents", tags=["documents"])


@router.get("", response_model=list[DocumentOut], summary="List knowledge-base documents")
async def list_documents(session: SessionDep) -> list[Document]:
    result = await session.scalars(select(Document).order_by(Document.created_at.desc()))
    return list(result.all())


@router.post(
    "",
    response_model=UploadResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Upload a document",
)
async def upload(
    session: SessionDep,
    ingest: IngestServiceDep,
    settings: SettingsDep,
    background: BackgroundTasks,
    file: UploadFile = File(...),
    title: str | None = Form(None),
) -> UploadResponse:
    """Accept a document and index it asynchronously.

    Returns 202 immediately rather than blocking on embedding: a 200-page PDF is
    hundreds of embedding calls, and holding an HTTP request open for that long
    means the operator's browser times out on exactly the uploads that matter
    most. The console polls document status instead.
    """
    data = await file.read()
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "uploaded file is empty")
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"file exceeds the {settings.max_upload_bytes // (1024 * 1024)} MB limit",
        )

    document, created = await ingest.register(
        session,
        filename=file.filename or "upload",
        content_type=file.content_type or "application/octet-stream",
        data=data,
        title=title,
    )

    if created:
        background.add_task(ingest.process, document.id, data)

    return UploadResponse(document=DocumentOut.model_validate(document), created=created)


@router.post(
    "/{document_id}/reindex",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Re-run ingestion for a document",
)
async def reindex(
    document_id: uuid.UUID,
    session: SessionDep,
    ingest: IngestServiceDep,
    background: BackgroundTasks,
    file: UploadFile = File(...),
) -> dict[str, str]:
    """Re-ingest with a fresh copy of the file.

    The original bytes are not retained — only the extracted chunks — so a
    reindex (after a chunking-parameter change, or to retry a failure) needs the
    file supplied again. Storing every original upload would put customer
    documents in a second place that has to be secured and retained.
    """
    document = await session.get(Document, document_id)
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")

    data = await file.read()
    background.add_task(ingest.process, document.id, data)
    return {"status": "reindexing", "document_id": str(document.id)}


@router.get(
    "/{document_id}/chunks",
    response_model=list[ChunkOut],
    summary="List a document's chunks",
)
async def list_chunks(document_id: uuid.UUID, session: SessionDep) -> list[Chunk]:
    result = await session.scalars(
        select(Chunk).where(Chunk.document_id == document_id).order_by(Chunk.ordinal)
    )
    return list(result.all())


@router.get(
    "/chunks/{chunk_id}",
    response_model=ChunkOut,
    summary="Get one chunk (backs the citation drawer)",
)
async def get_chunk(chunk_id: uuid.UUID, session: SessionDep) -> Chunk:
    chunk = await session.get(Chunk, chunk_id)
    if chunk is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "chunk not found")
    return chunk


@router.delete(
    "/{document_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a document"
)
async def delete_document(
    document_id: uuid.UUID, session: SessionDep, ingest: IngestServiceDep
) -> None:
    if not await ingest.delete(session, document_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
