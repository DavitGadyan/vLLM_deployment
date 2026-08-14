"""Chat request/response schemas.

The streaming protocol is a small typed SSE envelope rather than raw text
deltas. Escalation, citations and errors all need to be *distinguishable* from
answer content on the client — a UI that has to string-match its way to
"was this an escalation?" will get it wrong eventually.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: Annotated[str, Field(min_length=1, max_length=8000)]
    conversation_id: uuid.UUID | None = None


class Citation(BaseModel):
    marker: int
    chunk_id: str
    document_id: str
    document_title: str
    heading: str | None = None
    score: float


class StreamEvent(BaseModel):
    """One SSE frame. `type` discriminates on the client."""

    type: Literal["start", "delta", "citations", "escalation", "done", "error"]
    data: dict[str, Any] = Field(default_factory=dict)


class MessageOut(BaseModel):
    id: uuid.UUID
    role: str
    content: str
    escalated: bool
    escalation_reason: str | None
    citations: list[dict[str, Any]]
    created_at: datetime


class ConversationOut(BaseModel):
    id: uuid.UUID
    created_at: datetime
    config_version: int | None
    messages: list[MessageOut]
