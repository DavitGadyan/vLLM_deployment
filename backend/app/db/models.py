"""Database schema.

Two decisions shape everything here.

**Config versions are immutable.** Saving never mutates a row; it inserts a new
version and repoints `active_config`. The compiled system prompt *is* the
product — when an answer goes wrong, the first question is always "what was the
prompt at the time?", and that is only answerable if history is preserved.
Rollback becomes a single-row update, and every conversation records which
version answered it.

**The compiled prompt is materialised, not computed on read.** It is stored on
the version row alongside a hash. That gives cheap diffs between versions, lets
the console preview exactly what the model will receive, and means a code change
to the compiler cannot silently alter the behaviour of already-shipped versions.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class ConfigVersion(Base):
    """An immutable snapshot of the company configuration."""

    __tablename__ = "config_versions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    version: Mapped[int] = mapped_column(Integer, nullable=False, unique=True)

    # --- Identity ---------------------------------------------------------
    company_name: Mapped[str] = mapped_column(String(200), nullable=False)
    agent_name: Mapped[str] = mapped_column(String(120), nullable=False, default="Support")
    support_email: Mapped[str | None] = mapped_column(String(320))
    support_url: Mapped[str | None] = mapped_column(String(500))

    # --- Voice ------------------------------------------------------------
    tone: Mapped[str] = mapped_column(String(40), nullable=False, default="professional")
    languages: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    greeting: Mapped[str | None] = mapped_column(Text)
    signature: Mapped[str | None] = mapped_column(Text)

    # --- Behaviour --------------------------------------------------------
    # [{"title": "Refunds", "body": "..."}] — ordered; order is preserved into
    # the compiled prompt so operators control emphasis.
    policies: Mapped[list[dict[str, str]]] = mapped_column(JSONB, nullable=False, default=list)
    escalation_rules: Mapped[str | None] = mapped_column(Text)
    forbidden_topics: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    custom_instructions: Mapped[str | None] = mapped_column(Text)

    # --- Generation / retrieval overrides ---------------------------------
    temperature: Mapped[float | None] = mapped_column()
    max_output_tokens: Mapped[int | None] = mapped_column(Integer)
    retrieval_top_k: Mapped[int | None] = mapped_column(Integer)
    retrieval_min_score: Mapped[float | None] = mapped_column()

    # --- Materialised output ----------------------------------------------
    compiled_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    # sha256 of compiled_prompt. Equal hashes across versions mean vLLM's prefix
    # cache stays warm through the change — useful signal when reviewing a save.
    compiled_prompt_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    compiled_prompt_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    change_note: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint("version > 0", name="ck_config_version_positive"),
        CheckConstraint(
            "temperature IS NULL OR (temperature >= 0 AND temperature <= 2)",
            name="ck_config_temperature_range",
        ),
        Index("ix_config_versions_created_at", "created_at"),
    )


class ActiveConfig(Base):
    """Single-row pointer to the live config version.

    A pointer table rather than an `is_active` flag: activation is one UPDATE
    that cannot transiently leave zero or two rows active, and rollback is the
    same operation as a forward change.
    """

    __tablename__ = "active_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    config_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("config_versions.id", ondelete="RESTRICT"), nullable=False
    )
    activated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    activated_by: Mapped[str | None] = mapped_column(String(200))

    config_version: Mapped[ConfigVersion] = relationship(lazy="joined")

    __table_args__ = (CheckConstraint("id = 1", name="ck_active_config_singleton"),)


class Document(Base):
    """An uploaded knowledge-base source."""

    __tablename__ = "documents"

    id: Mapped[uuid.UUID] = _uuid_pk()
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    # Content hash — re-uploading an unchanged file should not duplicate chunks.
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    error: Mapped[str | None] = mapped_column(Text)
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    indexed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    chunks: Mapped[list[Chunk]] = relationship(
        back_populates="document", cascade="all, delete-orphan", passive_deletes=True
    )

    __table_args__ = (
        UniqueConstraint("content_hash", name="uq_documents_content_hash"),
        CheckConstraint(
            "status IN ('pending', 'processing', 'ready', 'failed')",
            name="ck_documents_status",
        ),
        Index("ix_documents_status", "status"),
    )


class Chunk(Base):
    """A retrievable passage with its embedding."""

    __tablename__ = "chunks"

    id: Mapped[uuid.UUID] = _uuid_pk()
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    token_count: Mapped[int] = mapped_column(Integer, nullable=False)
    # Heading trail ("Refunds > International orders") — shown in the citation
    # chip so a user can see where an answer came from without opening the file.
    heading: Mapped[str | None] = mapped_column(String(500))

    # Dimension must match settings.embeddings_dim; bge-small-en-v1.5 is 384.
    embedding: Mapped[Any] = mapped_column(Vector(384), nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    document: Mapped[Document] = relationship(back_populates="chunks")

    __table_args__ = (
        UniqueConstraint("document_id", "ordinal", name="uq_chunks_document_ordinal"),
        # HNSW over cosine distance. Chosen over IVFFlat because it needs no
        # retraining as documents are added — support KBs grow one upload at a
        # time, and an index that degrades until someone remembers to REINDEX is
        # an operational trap.
        Index(
            "ix_chunks_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = _uuid_pk()
    # Which config answered. Without this, comparing quality across config
    # versions is guesswork.
    config_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("config_versions.id", ondelete="SET NULL")
    )
    channel: Mapped[str] = mapped_column(String(40), nullable=False, default="web")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    messages: Mapped[list[Message]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="Message.created_at",
    )

    __table_args__ = (Index("ix_conversations_created_at", "created_at"),)


class Message(Base):
    """A single turn. Content is PII-redacted before it reaches this table."""

    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = _uuid_pk()
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)

    escalated: Mapped[bool] = mapped_column(default=False, nullable=False)
    escalation_reason: Mapped[str | None] = mapped_column(String(60))
    # [{"chunk_id": ..., "document_id": ..., "title": ..., "score": ...}]
    citations: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)

    prompt_tokens: Mapped[int | None] = mapped_column(Integer)
    completion_tokens: Mapped[int | None] = mapped_column(Integer)
    ttft_ms: Mapped[int | None] = mapped_column(Integer)
    total_ms: Mapped[int | None] = mapped_column(Integer)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    conversation: Mapped[Conversation] = relationship(back_populates="messages")

    __table_args__ = (
        CheckConstraint("role IN ('user', 'assistant', 'system')", name="ck_messages_role"),
        Index("ix_messages_conversation_created", "conversation_id", "created_at"),
        Index("ix_messages_escalated", "escalated"),
    )
