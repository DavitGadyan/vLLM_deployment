"""Feedback events for the alignment loop

Revision ID: 0003
Revises: 0002
Create Date: 2026-08-15

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "feedback_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        # SET NULL, not CASCADE: retention deleting a conversation must not
        # delete the judgement made about it. The judgement is the asset.
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="SET NULL"),
        ),
        sa.Column(
            "message_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("messages.id", ondelete="SET NULL"),
        ),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("rating", sa.Integer()),
        sa.Column("comment", sa.Text()),
        # The (prompt, chosen, rejected) triple, denormalised so the exported
        # training set is exactly what the annotator saw.
        sa.Column("question", sa.Text()),
        sa.Column("chosen_answer", sa.Text()),
        sa.Column("rejected_answer", sa.Text()),
        sa.Column("chosen_variant", sa.String(20)),
        sa.Column("variant_params", postgresql.JSONB()),
        sa.Column("config_version", sa.Integer()),
        sa.Column("exported_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "kind IN ('rating', 'preference', 'comment')", name="ck_feedback_kind"
        ),
        sa.CheckConstraint("rating IS NULL OR rating IN (-1, 1)", name="ck_feedback_rating"),
        sa.CheckConstraint(
            "kind <> 'preference' OR ("
            "question IS NOT NULL AND chosen_answer IS NOT NULL "
            "AND rejected_answer IS NOT NULL)",
            name="ck_feedback_preference_complete",
        ),
    )

    op.create_index("ix_feedback_created_at", "feedback_events", ["created_at"])
    op.create_index("ix_feedback_kind_created", "feedback_events", ["kind", "created_at"])
    # Partial: the export path only scans un-exported rows, and that set stays
    # small while the table itself grows without bound.
    op.create_index(
        "ix_feedback_unexported",
        "feedback_events",
        ["created_at"],
        postgresql_where=sa.text("exported_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_feedback_unexported", table_name="feedback_events")
    op.drop_index("ix_feedback_kind_created", table_name="feedback_events")
    op.drop_index("ix_feedback_created_at", table_name="feedback_events")
    op.drop_table("feedback_events")
