"""Knowledge-base document schemas."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    filename: str
    content_type: str
    size_bytes: int
    status: str
    error: str | None
    chunk_count: int
    created_at: datetime
    indexed_at: datetime | None


class UploadResponse(BaseModel):
    document: DocumentOut
    # False when the content hash matched an existing document. The console
    # tells the operator rather than silently doing nothing.
    created: bool


class ChunkOut(BaseModel):
    """A single chunk, for the citation drawer."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    document_id: uuid.UUID
    ordinal: int
    heading: str | None
    text: str
    token_count: int
