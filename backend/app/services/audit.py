"""Append-only audit log with a verifiable hash chain.

The chain is the whole point. Any log can record what happened; a hash-chained log
can prove it has not been edited since. Each entry's digest covers its own content
plus the previous entry's digest, so removing or altering a historical row breaks
every digest after it and `verify_chain` reports exactly where.

That is what turns "we keep audit logs" into something an auditor can test, and it
is the difference between a claim and evidence.

Actions are named `domain.verb` and each carries the control it serves, so
producing evidence for a SOC 2 or GDPR request is a filter rather than a research
project.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import metrics
from app.core.logging import get_logger
from app.core.redaction import redact
from app.db.models import AuditEvent

log = get_logger(__name__)


class Action:
    """Audit action names, with the compliance controls each one evidences.

    Keeping the mapping here rather than at each call site means one place to
    update when a control framework changes, and no chance of the same action
    being tagged differently in two modules.
    """

    CONFIG_SAVED = "config.saved"
    CONFIG_ACTIVATED = "config.activated"
    DOCUMENT_UPLOADED = "document.uploaded"
    DOCUMENT_DELETED = "document.deleted"
    CHAT_ANSWERED = "chat.answered"
    CHAT_ESCALATED = "chat.escalated"
    INJECTION_DETECTED = "security.injection_detected"
    PII_REDACTED = "privacy.pii_redacted"
    FEEDBACK_RECORDED = "feedback.recorded"
    FEEDBACK_EXPORTED = "feedback.exported"

    # Not yet emitted anywhere. Authentication is out of scope for now (see the
    # README), so there is no code path that can fail one. Defined here, with
    # their control mapping, so that adding IAP or an OIDC proxy is a matter of
    # calling `record` rather than also designing the audit schema for it.
    AUTH_FAILED = "auth.failed"
    ACCESS_DENIED = "auth.access_denied"


COMPLIANCE_TAGS: dict[str, list[str]] = {
    # Change management and configuration integrity.
    Action.CONFIG_SAVED: ["SOC2.CC8.1", "GDPR.Art.30"],
    Action.CONFIG_ACTIVATED: ["SOC2.CC8.1", "SOC2.CC7.2", "GDPR.Art.30"],
    # Records of processing, and what the model was allowed to see.
    Action.DOCUMENT_UPLOADED: ["SOC2.CC6.1", "GDPR.Art.30", "HIPAA.164.312(b)"],
    Action.DOCUMENT_DELETED: ["GDPR.Art.17", "HIPAA.164.312(b)"],
    # Access logging — HIPAA requires it, SOC 2 monitors it.
    Action.CHAT_ANSWERED: ["HIPAA.164.312(b)", "SOC2.CC7.2"],
    Action.CHAT_ESCALATED: ["HIPAA.164.312(b)", "SOC2.CC7.2"],
    # Security monitoring and incident evidence.
    Action.INJECTION_DETECTED: ["SOC2.CC7.2", "SOC2.CC7.3"],
    Action.PII_REDACTED: ["GDPR.Art.5.1.c", "GDPR.Art.32", "HIPAA.164.312(a)(1)"],
    # Human judgements are what the model is trained on next, so they are a
    # change to the system in the same sense a config edit is — and an export is
    # personal data leaving the boundary, whether or not it is redacted first.
    Action.FEEDBACK_RECORDED: ["SOC2.CC7.2", "GDPR.Art.30"],
    Action.FEEDBACK_EXPORTED: ["SOC2.CC8.1", "GDPR.Art.30", "GDPR.Art.32"],
    Action.AUTH_FAILED: ["SOC2.CC6.1", "HIPAA.164.312(d)"],
    Action.ACCESS_DENIED: ["SOC2.CC6.3", "HIPAA.164.312(a)(1)"],
}

GENESIS_HASH: str | None = None


def compute_hash(
    *,
    sequence: int,
    occurred_at: datetime,
    actor: str | None,
    action: str,
    resource_type: str | None,
    resource_id: str | None,
    outcome: str,
    detail: dict[str, Any],
    prev_hash: str | None,
) -> str:
    """Digest over the entry's content and its predecessor's digest.

    Serialisation is canonical — sorted keys, no incidental whitespace — because a
    digest that depends on dict ordering would make verification fail on a
    perfectly intact log after a Python upgrade.
    """
    payload = json.dumps(
        {
            "sequence": sequence,
            "occurred_at": occurred_at.isoformat(),
            "actor": actor,
            "action": action,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "outcome": outcome,
            "detail": detail,
            "prev_hash": prev_hash,
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ChainVerification:
    valid: bool
    checked: int
    broken_at_sequence: int | None = None
    reason: str | None = None


class ChainLink(Protocol):
    """The fields verification needs — satisfied by the ORM row."""

    sequence: int
    occurred_at: datetime
    actor: str | None
    action: str
    resource_type: str | None
    resource_id: str | None
    outcome: str
    detail: dict[str, Any]
    prev_hash: str | None
    hash: str


def verify_events(events: Sequence[ChainLink]) -> ChainVerification:
    """Verify a chain of entries. Pure — no database, no I/O.

    Kept separate from the query so the algorithm can be tested against
    hand-built sequences, including deliberately corrupted ones. Verification
    logic that can only be exercised against a live Postgres tends not to be
    exercised at all.
    """
    if not events:
        return ChainVerification(valid=True, checked=0)

    expected_prev: str | None = GENESIS_HASH
    expected_sequence = events[0].sequence
    checked = 0

    for event in events:
        if event.sequence != expected_sequence:
            return ChainVerification(
                valid=False,
                checked=checked,
                broken_at_sequence=event.sequence,
                reason=(
                    f"sequence gap: expected {expected_sequence}, found {event.sequence} "
                    "— an entry was removed"
                ),
            )
        if event.prev_hash != expected_prev:
            return ChainVerification(
                valid=False,
                checked=checked,
                broken_at_sequence=event.sequence,
                reason="previous-hash mismatch: an earlier entry was altered or removed",
            )

        recomputed = compute_hash(
            sequence=event.sequence,
            occurred_at=event.occurred_at,
            actor=event.actor,
            action=event.action,
            resource_type=event.resource_type,
            resource_id=event.resource_id,
            outcome=event.outcome,
            detail=event.detail,
            prev_hash=event.prev_hash,
        )
        if recomputed != event.hash:
            return ChainVerification(
                valid=False,
                checked=checked,
                broken_at_sequence=event.sequence,
                reason="content hash mismatch: this entry was altered after it was written",
            )

        expected_prev = event.hash
        expected_sequence += 1
        checked += 1

    return ChainVerification(valid=True, checked=checked)


class AuditService:
    async def record(
        self,
        session: AsyncSession,
        *,
        action: str,
        actor: str | None = None,
        resource_type: str | None = None,
        resource_id: str | None = None,
        outcome: str = "success",
        severity: str = "info",
        detail: dict[str, Any] | None = None,
    ) -> AuditEvent:
        """Append one entry.

        The caller's transaction is *not* committed here. An audit entry and the
        thing it describes must land together — a config activation that succeeds
        while its audit entry is lost is precisely the gap an auditor looks for.
        """
        detail = _redact_detail(detail or {})

        # Lock the tail of the chain so two concurrent appends cannot both read
        # the same predecessor and produce a fork. Postgres serialises this;
        # without it the chain silently develops branches under load.
        tail = (
            await session.execute(
                select(AuditEvent).order_by(AuditEvent.sequence.desc()).limit(1).with_for_update()
            )
        ).scalar_one_or_none()

        sequence = (tail.sequence + 1) if tail else 1
        prev_hash = tail.hash if tail else GENESIS_HASH
        occurred_at = datetime.now(UTC)

        digest = compute_hash(
            sequence=sequence,
            occurred_at=occurred_at,
            actor=actor,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            outcome=outcome,
            detail=detail,
            prev_hash=prev_hash,
        )

        event = AuditEvent(
            id=uuid.uuid4(),
            sequence=sequence,
            occurred_at=occurred_at,
            actor=actor,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            outcome=outcome,
            severity=severity,
            compliance_tags=COMPLIANCE_TAGS.get(action, []),
            detail=detail,
            prev_hash=prev_hash,
            hash=digest,
        )
        session.add(event)
        await session.flush()

        metrics.audit_events_total.labels(action=action, outcome=outcome).inc()

        log.info(
            "audit",
            action=action,
            actor=actor,
            outcome=outcome,
            severity=severity,
            sequence=sequence,
        )
        return event

    async def list_events(
        self,
        session: AsyncSession,
        *,
        limit: int = 100,
        action: str | None = None,
        severity: str | None = None,
    ) -> list[AuditEvent]:
        query = select(AuditEvent).order_by(AuditEvent.sequence.desc()).limit(limit)
        if action:
            query = query.where(AuditEvent.action == action)
        if severity:
            query = query.where(AuditEvent.severity == severity)
        return list((await session.scalars(query)).all())

    async def verify_chain(
        self, session: AsyncSession, *, limit: int | None = None
    ) -> ChainVerification:
        """Fetch the chain and verify it.

        This is what makes the tamper-evidence claim testable rather than
        asserted: edit a row directly in the database, call this, and it names the
        sequence number where the chain breaks. The algorithm lives in
        `verify_events` so it can be tested without a database.
        """
        query = select(AuditEvent).order_by(AuditEvent.sequence.asc())
        if limit:
            query = query.limit(limit)
        events = list((await session.scalars(query)).all())
        return verify_events(events)


def _redact_detail(detail: dict[str, Any]) -> dict[str, Any]:
    """Redact PII from audit detail on the write path.

    An audit log full of customer emails and card numbers is a liability wearing a
    compliance badge. Redacting at write time means the raw value was never stored,
    rather than being filtered by a query someone can forget to write.
    """
    cleaned: dict[str, Any] = {}
    for key, value in detail.items():
        if isinstance(value, str):
            cleaned[key] = redact(value)
        elif isinstance(value, dict):
            cleaned[key] = _redact_detail(value)
        elif isinstance(value, list):
            cleaned[key] = [redact(v) if isinstance(v, str) else v for v in value]
        else:
            cleaned[key] = value
    return cleaned
