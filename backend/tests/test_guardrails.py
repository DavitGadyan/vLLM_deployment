"""Tests for escalation and citation handling."""

from __future__ import annotations

import pytest

from app.services.assembler import RetrievedChunk
from app.services.guardrails import (
    EscalationReason,
    analyse_answer,
    extract_citations,
    preflight,
    strip_sentinel,
)
from app.services.prompt_compiler import ESCALATION_SENTINEL


def _chunk(chunk_id: str = "c1", score: float = 0.8) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id,
        document_id="d1",
        document_title="Refund Policy",
        heading="Refunds",
        text="Full refund within 30 days.",
        score=score,
    )


# ---------------------------------------------------------------------------
# Preflight: escalate before spending a GPU request
# ---------------------------------------------------------------------------


def test_empty_knowledge_base_escalates() -> None:
    decision = preflight([], 0.35, knowledge_base_empty=True, company_name="Acme")
    assert decision.escalate
    assert decision.reason is EscalationReason.NO_DOCUMENTS
    assert "Acme" in (decision.message or "")


def test_no_results_escalates() -> None:
    decision = preflight([], 0.35, knowledge_base_empty=False, company_name="Acme")
    assert decision.escalate
    assert decision.reason is EscalationReason.LOW_RETRIEVAL_CONFIDENCE


def test_weak_match_escalates_rather_than_guessing() -> None:
    """A weakly related chunk is worse than none — it gives the model something
    plausible to pattern-match instead of admitting it does not know."""
    decision = preflight([_chunk(score=0.2)], 0.35, knowledge_base_empty=False, company_name="Acme")
    assert decision.escalate
    assert decision.reason is EscalationReason.LOW_RETRIEVAL_CONFIDENCE


def test_good_match_proceeds() -> None:
    decision = preflight([_chunk(score=0.8)], 0.35, knowledge_base_empty=False, company_name="Acme")
    assert not decision.escalate
    assert decision.reason is None


# ---------------------------------------------------------------------------
# Sentinel handling
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        f"{ESCALATION_SENTINEL}\nA colleague will follow up.",
        f"{ESCALATION_SENTINEL} A colleague will follow up.",
        f"**{ESCALATION_SENTINEL}**\nA colleague will follow up.",
        f"  {ESCALATION_SENTINEL}: A colleague will follow up.",
        f"`{ESCALATION_SENTINEL}`\nA colleague will follow up.",
    ],
)
def test_sentinel_detected_across_formatting_variants(raw: str) -> None:
    """Models wrap the marker in markdown; the customer must never see it."""
    cleaned, fired = strip_sentinel(raw)
    assert fired
    assert ESCALATION_SENTINEL not in cleaned
    assert "A colleague will follow up." in cleaned


def test_sentinel_detected_mid_response() -> None:
    cleaned, fired = strip_sentinel(f"Let me check. {ESCALATION_SENTINEL} A human will help.")
    assert fired
    assert ESCALATION_SENTINEL not in cleaned


def test_normal_answer_is_untouched() -> None:
    answer = "You can request a refund within 30 days of delivery. [1]"
    cleaned, fired = strip_sentinel(answer)
    assert not fired
    assert cleaned == answer


# ---------------------------------------------------------------------------
# Citations
# ---------------------------------------------------------------------------


def test_citations_resolve_to_chunks() -> None:
    chunks = [_chunk("a"), _chunk("b")]
    citations = extract_citations("Refunds take 30 days [1] and shipping is fast [2].", chunks)
    assert [c["chunk_id"] for c in citations] == ["a", "b"]
    assert citations[0]["marker"] == 1


def test_out_of_range_markers_are_dropped() -> None:
    """A chip that opens the wrong document is worse than no chip."""
    citations = extract_citations("See [1] and [7].", [_chunk("a")])
    assert [c["chunk_id"] for c in citations] == ["a"]


def test_duplicate_markers_are_deduplicated() -> None:
    citations = extract_citations("As [1] says, and again [1].", [_chunk("a")])
    assert len(citations) == 1


# ---------------------------------------------------------------------------
# Whole-answer analysis
# ---------------------------------------------------------------------------


def test_analysis_flags_specific_claims_without_citations() -> None:
    """An uncited number is the signature of an invented policy detail."""
    analysis = analyse_answer("You will be refunded within 14 business days.", [_chunk("a")])
    assert analysis.ungrounded_claim
    assert not analysis.escalated


def test_cited_specific_claim_is_not_flagged() -> None:
    analysis = analyse_answer("You will be refunded within 14 business days. [1]", [_chunk("a")])
    assert not analysis.ungrounded_claim
    assert len(analysis.citations) == 1


def test_qualitative_answer_without_citation_is_not_flagged() -> None:
    """Only concrete claims are gated; general guidance is fine uncited."""
    analysis = analyse_answer("Returns are handled by our support team.", [_chunk("a")])
    assert not analysis.ungrounded_claim


def test_escalating_answer_is_not_flagged_as_ungrounded() -> None:
    analysis = analyse_answer(
        f"{ESCALATION_SENTINEL}\nA colleague will follow up within 2 business days.",
        [_chunk("a")],
    )
    assert analysis.escalated
    assert analysis.reason is EscalationReason.MODEL_SENTINEL
    assert not analysis.ungrounded_claim
