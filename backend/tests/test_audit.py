"""Tests for the audit hash chain.

The chain's only purpose is to make tampering detectable, so the tests that matter
are the ones that tamper. Each corruption below is something a real attacker or a
careless operator would actually do — edit a value, delete a row, splice in an
entry — and each must be caught.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from app.services.audit import COMPLIANCE_TAGS, Action, _redact_detail, compute_hash, verify_events


@dataclass
class Link:
    """Stand-in for an AuditEvent row, so the chain can be built without a database."""

    sequence: int
    occurred_at: datetime
    actor: str | None
    action: str
    resource_type: str | None
    resource_id: str | None
    outcome: str
    detail: dict[str, Any]
    prev_hash: str | None
    hash: str = ""


BASE_TIME = datetime(2026, 8, 14, 12, 0, tzinfo=UTC)


def build_chain(length: int = 5) -> list[Link]:
    links: list[Link] = []
    prev: str | None = None
    for index in range(1, length + 1):
        link = Link(
            sequence=index,
            occurred_at=BASE_TIME + timedelta(minutes=index),
            actor=f"operator{index}@example.com",
            action=Action.CONFIG_ACTIVATED,
            resource_type="config",
            resource_id=str(index),
            outcome="success",
            detail={"version": index},
            prev_hash=prev,
        )
        link.hash = compute_hash(
            sequence=link.sequence,
            occurred_at=link.occurred_at,
            actor=link.actor,
            action=link.action,
            resource_type=link.resource_type,
            resource_id=link.resource_id,
            outcome=link.outcome,
            detail=link.detail,
            prev_hash=link.prev_hash,
        )
        prev = link.hash
        links.append(link)
    return links


# ---------------------------------------------------------------------------
# The digest itself
# ---------------------------------------------------------------------------


def test_hash_is_deterministic() -> None:
    args: dict[str, Any] = {
        "sequence": 1,
        "occurred_at": BASE_TIME,
        "actor": "a@example.com",
        "action": "config.saved",
        "resource_type": "config",
        "resource_id": "1",
        "outcome": "success",
        "detail": {"version": 1},
        "prev_hash": None,
    }
    assert compute_hash(**args) == compute_hash(**args)


def test_hash_does_not_depend_on_dict_ordering() -> None:
    """Otherwise an intact log could fail verification after an unrelated change."""
    a = compute_hash(
        sequence=1,
        occurred_at=BASE_TIME,
        actor=None,
        action="x",
        resource_type=None,
        resource_id=None,
        outcome="success",
        detail={"alpha": 1, "beta": 2},
        prev_hash=None,
    )
    b = compute_hash(
        sequence=1,
        occurred_at=BASE_TIME,
        actor=None,
        action="x",
        resource_type=None,
        resource_id=None,
        outcome="success",
        detail={"beta": 2, "alpha": 1},
        prev_hash=None,
    )
    assert a == b


def test_every_field_is_covered_by_the_hash() -> None:
    """A field outside the digest is a field an attacker can rewrite freely."""
    base: dict[str, Any] = {
        "sequence": 1,
        "occurred_at": BASE_TIME,
        "actor": "a@example.com",
        "action": "config.saved",
        "resource_type": "config",
        "resource_id": "1",
        "outcome": "success",
        "detail": {"version": 1},
        "prev_hash": "abc",
    }
    original = compute_hash(**base)

    mutations: list[dict[str, Any]] = [
        {"sequence": 2},
        {"occurred_at": BASE_TIME + timedelta(seconds=1)},
        {"actor": "b@example.com"},
        {"action": "config.activated"},
        {"resource_type": "document"},
        {"resource_id": "2"},
        {"outcome": "denied"},
        {"detail": {"version": 2}},
        {"prev_hash": "def"},
    ]
    for mutation in mutations:
        assert compute_hash(**{**base, **mutation}) != original, f"not covered: {mutation}"


# ---------------------------------------------------------------------------
# Chain verification
# ---------------------------------------------------------------------------


def test_intact_chain_verifies() -> None:
    result = verify_events(build_chain())
    assert result.valid
    assert result.checked == 5


def test_empty_chain_is_valid() -> None:
    assert verify_events([]).valid


def test_altering_an_entry_breaks_the_chain() -> None:
    chain = build_chain()
    # An operator quietly changing who performed an action.
    chain[2].actor = "someone-else@example.com"

    result = verify_events(chain)
    assert not result.valid
    assert result.broken_at_sequence == 3
    assert "altered" in (result.reason or "")


def test_altering_detail_breaks_the_chain() -> None:
    chain = build_chain()
    chain[1].detail = {"version": 999}

    result = verify_events(chain)
    assert not result.valid
    assert result.broken_at_sequence == 2


def test_deleting_an_entry_breaks_the_chain() -> None:
    """Removing an inconvenient record is the most likely tampering of all."""
    chain = build_chain()
    del chain[2]

    result = verify_events(chain)
    assert not result.valid
    assert result.broken_at_sequence == 4
    assert "removed" in (result.reason or "")


def test_recomputing_the_hash_after_tampering_still_fails() -> None:
    """The sophisticated attempt: edit the row *and* fix up its own digest.

    This is what makes chaining worth more than a per-row checksum. The forged
    entry is internally consistent, but the entry after it still points at the
    original digest, so the break simply moves one position later.
    """
    chain = build_chain()
    chain[2].actor = "attacker@example.com"
    chain[2].hash = compute_hash(
        sequence=chain[2].sequence,
        occurred_at=chain[2].occurred_at,
        actor=chain[2].actor,
        action=chain[2].action,
        resource_type=chain[2].resource_type,
        resource_id=chain[2].resource_id,
        outcome=chain[2].outcome,
        detail=chain[2].detail,
        prev_hash=chain[2].prev_hash,
    )

    result = verify_events(chain)
    assert not result.valid
    assert result.broken_at_sequence == 4
    assert "previous-hash mismatch" in (result.reason or "")


def test_verification_reports_how_far_it_got() -> None:
    chain = build_chain(10)
    chain[6].outcome = "denied"

    result = verify_events(chain)
    assert not result.valid
    assert result.checked == 6


# ---------------------------------------------------------------------------
# Redaction and compliance mapping
# ---------------------------------------------------------------------------


def test_detail_is_redacted_before_storage() -> None:
    """An audit log full of customer PII is the liability it was meant to prevent."""
    cleaned = _redact_detail(
        {
            "query": "please refund me at jane@example.com",
            "nested": {"phone": "call me on 555-123-4567"},
            "list": ["contact bob@example.com"],
            "count": 3,
        }
    )
    assert "jane@example.com" not in cleaned["query"]
    assert "[REDACTED_EMAIL]" in cleaned["query"]
    assert "[REDACTED_PHONE]" in cleaned["nested"]["phone"]
    assert "[REDACTED_EMAIL]" in cleaned["list"][0]
    # Non-string values pass through untouched.
    assert cleaned["count"] == 3


def test_security_and_privacy_actions_carry_compliance_tags() -> None:
    """A tag is how an auditor finds the evidence for a control."""
    for action in (
        Action.INJECTION_DETECTED,
        Action.PII_REDACTED,
        Action.CONFIG_ACTIVATED,
        Action.DOCUMENT_DELETED,
        Action.AUTH_FAILED,
    ):
        assert COMPLIANCE_TAGS.get(action), f"{action} has no compliance mapping"


def test_erasure_is_mapped_to_the_gdpr_article_that_requires_it() -> None:
    assert "GDPR.Art.17" in COMPLIANCE_TAGS[Action.DOCUMENT_DELETED]
