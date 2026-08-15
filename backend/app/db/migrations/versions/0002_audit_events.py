"""Audit events with hash chain

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-14

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "audit_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        # BigInteger, not Integer: an audit log is append-only forever and a
        # 32-bit counter is a problem that arrives silently, years later.
        sa.Column("sequence", sa.BigInteger(), nullable=False, unique=True),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("actor", sa.String(200)),
        sa.Column("action", sa.String(80), nullable=False),
        sa.Column("resource_type", sa.String(60)),
        sa.Column("resource_id", sa.String(120)),
        sa.Column("outcome", sa.String(20), nullable=False, server_default="success"),
        sa.Column("severity", sa.String(20), nullable=False, server_default="info"),
        sa.Column("compliance_tags", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("detail", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("prev_hash", sa.String(64)),
        sa.Column("hash", sa.String(64), nullable=False),
        sa.CheckConstraint(
            "outcome IN ('success', 'denied', 'failure', 'error')", name="ck_audit_outcome"
        ),
        sa.CheckConstraint(
            "severity IN ('info', 'low', 'medium', 'high', 'critical')",
            name="ck_audit_severity",
        ),
    )

    op.create_index("ix_audit_events_sequence", "audit_events", ["sequence"])
    op.create_index("ix_audit_events_occurred_at", "audit_events", ["occurred_at"])
    op.create_index("ix_audit_events_action", "audit_events", ["action"])

    # Enforce append-only in the database, not only in application code.
    #
    # The application has no code path that updates or deletes an audit row, but
    # "we checked and there isn't one" is a weaker assurance than "the database
    # refuses". This makes tampering require a deliberate, privileged schema
    # change — which is itself a far more visible act.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION audit_events_append_only()
        RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_events_no_update_delete
        BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS audit_events_no_update_delete ON audit_events")
    op.execute("DROP FUNCTION IF EXISTS audit_events_append_only()")
    op.drop_index("ix_audit_events_action", table_name="audit_events")
    op.drop_index("ix_audit_events_occurred_at", table_name="audit_events")
    op.drop_index("ix_audit_events_sequence", table_name="audit_events")
    op.drop_table("audit_events")
