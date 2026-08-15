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
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
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


class AuditEvent(Base):
    """Append-only, tamper-evident record of everything that mattered.

    Two properties make this useful to a compliance auditor rather than merely
    being another log table:

    **It is hash-chained.** Each row's `hash` covers its own content *and* the
    previous row's hash. Altering or deleting any historical row breaks every hash
    after it, so tampering is detectable rather than merely discouraged. This is
    the property compliance buyers actually ask about, and it costs one column.

    **Every event names the control it serves.** `compliance_tags` carries entries
    like `SOC2.CC7.2` or `GDPR.Art.30`, so producing evidence for an audit is a
    query rather than an archaeology project.

    Rows are never updated or deleted by the application. There is no code path
    that does either — enforce it in the database grant too, in a deployment where
    the auditor needs that assurance.
    """

    __tablename__ = "audit_events"

    id: Mapped[uuid.UUID] = _uuid_pk()

    # Monotonic position in the chain. Separate from the timestamp because two
    # events can share a timestamp, and the chain needs a total order.
    sequence: Mapped[int] = mapped_column(BigInteger, nullable=False, unique=True)

    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Null actor means the system acted on its own behalf (a scheduled job, a
    # startup bootstrap) rather than "we failed to record who did this".
    actor: Mapped[str | None] = mapped_column(String(200))
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    resource_type: Mapped[str | None] = mapped_column(String(60))
    resource_id: Mapped[str | None] = mapped_column(String(120))
    outcome: Mapped[str] = mapped_column(String(20), nullable=False, default="success")
    severity: Mapped[str] = mapped_column(String(20), nullable=False, default="info")

    compliance_tags: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    # Detail is PII-redacted before it gets here. An audit log that accumulates
    # customer data becomes the liability it was meant to protect against.
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)

    prev_hash: Mapped[str | None] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "outcome IN ('success', 'denied', 'failure', 'error')",
            name="ck_audit_outcome",
        ),
        CheckConstraint(
            "severity IN ('info', 'low', 'medium', 'high', 'critical')",
            name="ck_audit_severity",
        ),
        Index("ix_audit_events_sequence", "sequence"),
        Index("ix_audit_events_occurred_at", "occurred_at"),
        Index("ix_audit_events_action", "action"),
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


class FeedbackEvent(Base):
    """
    One human judgement about one answer. The training set for alignment.

    Three kinds, and the distinction matters because they are worth different
    things:

    - ``rating``     a thumbs up or down on a single answer. Cheap to give and
                     plentiful, but weak signal: people disagree about what a
                     "good" answer is in the abstract.
    - ``preference`` "this answer is better than that one" for the same
                     question. Far stronger, because a comparison sidesteps the
                     calibration problem entirely — and it is the native input
                     format for DPO and for reward-model training.
    - ``comment``    free text. Not directly trainable, but it is the only
                     signal that says *why*, and it is what tells you which
                     failure to go and fix.

    A ``preference`` row carries the full (prompt, chosen, rejected) triple
    denormalised onto it. Deliberate: the exported training set must be exactly
    what the annotator saw, and it must survive the conversation being deleted
    under retention. Recomputing it from message rows later would silently pick
    up whatever the prompt template had become in the meantime.

    Content here is PII-redacted on the way in, like `messages` — this table is
    an export surface, and an export is the easiest way for personal data to
    leave the building.
    """

    __tablename__ = "feedback_events"

    id: Mapped[uuid.UUID] = _uuid_pk()

    # SET NULL rather than CASCADE: a conversation aged out under retention must
    # not take the judgement with it. The judgement is the asset.
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="SET NULL")
    )
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("messages.id", ondelete="SET NULL")
    )

    kind: Mapped[str] = mapped_column(String(20), nullable=False)

    # rating only: +1 or -1. Not a 1-5 scale — those collapse to the extremes
    # and the middle carries no usable signal.
    rating: Mapped[int | None] = mapped_column(Integer)

    comment: Mapped[str | None] = mapped_column(Text)

    # preference only, and the reason this table is worth having.
    question: Mapped[str | None] = mapped_column(Text)
    chosen_answer: Mapped[str | None] = mapped_column(Text)
    rejected_answer: Mapped[str | None] = mapped_column(Text)
    # Which sampling settings produced each side, so a win rate can be
    # attributed to a change rather than to noise.
    chosen_variant: Mapped[str | None] = mapped_column(String(20))
    variant_params: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    # Which prompt was live when the judgement was made. Preferences collected
    # against an older system prompt describe an assistant that no longer
    # exists, and training on them drags the model backwards.
    config_version: Mapped[int | None] = mapped_column(Integer)

    # Set once a training run has consumed this row, so an export is resumable
    # and the same preference is not trained on twice.
    exported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "kind IN ('rating', 'preference', 'comment')", name="ck_feedback_kind"
        ),
        CheckConstraint(
            "rating IS NULL OR rating IN (-1, 1)", name="ck_feedback_rating"
        ),
        # A preference is only usable as training data if all three parts are
        # present. Enforced here rather than in the service, because a
        # half-written pair is worthless and would be found at training time.
        CheckConstraint(
            "kind <> 'preference' OR ("
            "question IS NOT NULL AND chosen_answer IS NOT NULL "
            "AND rejected_answer IS NOT NULL)",
            name="ck_feedback_preference_complete",
        ),
        Index("ix_feedback_created_at", "created_at"),
        Index("ix_feedback_kind_created", "kind", "created_at"),
        # Partial index: the export path only ever scans un-exported rows, and
        # that set stays small while the table grows without bound.
        Index(
            "ix_feedback_unexported",
            "created_at",
            postgresql_where=text("exported_at IS NULL"),
        ),
    )
