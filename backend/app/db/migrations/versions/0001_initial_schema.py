"""Initial schema

Revision ID: 0001
Revises:
Create Date: 2026-08-14

"""

from __future__ import annotations

from collections.abc import Sequence

import pgvector.sqlalchemy
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMBEDDING_DIM = 384


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "config_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False, unique=True),
        sa.Column("company_name", sa.String(200), nullable=False),
        sa.Column("agent_name", sa.String(120), nullable=False, server_default="Support"),
        sa.Column("support_email", sa.String(320)),
        sa.Column("support_url", sa.String(500)),
        sa.Column("tone", sa.String(40), nullable=False, server_default="professional"),
        sa.Column("languages", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("greeting", sa.Text()),
        sa.Column("signature", sa.Text()),
        sa.Column("policies", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("escalation_rules", sa.Text()),
        sa.Column("forbidden_topics", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("custom_instructions", sa.Text()),
        sa.Column("temperature", sa.Float()),
        sa.Column("max_output_tokens", sa.Integer()),
        sa.Column("retrieval_top_k", sa.Integer()),
        sa.Column("retrieval_min_score", sa.Float()),
        sa.Column("compiled_prompt", sa.Text(), nullable=False),
        sa.Column("compiled_prompt_hash", sa.String(64), nullable=False),
        sa.Column("compiled_prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("change_note", sa.Text()),
        sa.Column("created_by", sa.String(200)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("version > 0", name="ck_config_version_positive"),
        sa.CheckConstraint(
            "temperature IS NULL OR (temperature >= 0 AND temperature <= 2)",
            name="ck_config_temperature_range",
        ),
    )
    op.create_index("ix_config_versions_created_at", "config_versions", ["created_at"])

    op.create_table(
        "active_config",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "config_version_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("config_versions.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "activated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("activated_by", sa.String(200)),
        sa.CheckConstraint("id = 1", name="ck_active_config_singleton"),
    )

    op.create_table(
        "documents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("filename", sa.String(500), nullable=False),
        sa.Column("content_type", sa.String(120), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("error", sa.Text()),
        sa.Column("chunk_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("indexed_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("content_hash", name="uq_documents_content_hash"),
        sa.CheckConstraint(
            "status IN ('pending', 'processing', 'ready', 'failed')", name="ck_documents_status"
        ),
    )
    op.create_index("ix_documents_status", "documents", ["status"])

    op.create_table(
        "chunks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "document_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False),
        sa.Column("heading", sa.String(500)),
        sa.Column("embedding", pgvector.sqlalchemy.Vector(EMBEDDING_DIM), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("document_id", "ordinal", name="uq_chunks_document_ordinal"),
    )

    # HNSW over cosine distance. Preferred to IVFFlat because it needs no
    # retraining as the corpus grows — a support KB is appended to one upload at
    # a time, and an index whose recall silently decays until somebody remembers
    # to REINDEX is an operational trap.
    op.execute(
        "CREATE INDEX ix_chunks_embedding_hnsw ON chunks "
        "USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)"
    )

    op.create_table(
        "conversations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "config_version_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("config_versions.id", ondelete="SET NULL"),
        ),
        sa.Column("channel", sa.String(40), nullable=False, server_default="web"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_conversations_created_at", "conversations", ["created_at"])

    op.create_table(
        "messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("escalated", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("escalation_reason", sa.String(60)),
        sa.Column("citations", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("prompt_tokens", sa.Integer()),
        sa.Column("completion_tokens", sa.Integer()),
        sa.Column("ttft_ms", sa.Integer()),
        sa.Column("total_ms", sa.Integer()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("role IN ('user', 'assistant', 'system')", name="ck_messages_role"),
    )
    op.create_index(
        "ix_messages_conversation_created", "messages", ["conversation_id", "created_at"]
    )
    op.create_index("ix_messages_escalated", "messages", ["escalated"])


def downgrade() -> None:
    op.drop_table("messages")
    op.drop_table("conversations")
    op.drop_index("ix_chunks_embedding_hnsw", table_name="chunks")
    op.drop_table("chunks")
    op.drop_table("documents")
    op.drop_table("active_config")
    op.drop_table("config_versions")
