"""Escalation decisions and citation parsing.

"The system will respond properly" is not a property you can prompt your way to.
It is four mechanisms, layered so that a failure of one is caught by the next:

1. **Compiled policy** — the operator's rules go into the system prompt
   (`prompt_compiler`).
2. **Pre-generation gate** — if retrieval found nothing that clears the score
   floor, we escalate without calling the model at all. A model handed weakly
   related text will find *something* plausible to say; not asking is more
   reliable than asking and hoping.
3. **Model sentinel** — the model emits `[[ESCALATE]]` when it cannot answer from
   context. We detect it in the stream, strip it, and return a structured
   handoff state instead of leaking the marker to the customer.
4. **Post-generation citation check** — an answer asserting specifics while
   citing nothing gets flagged for review.

Layer 2 is the one that matters most in practice, because it is deterministic.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from app.services.assembler import RetrievedChunk
from app.services.prompt_compiler import ESCALATION_SENTINEL


class EscalationReason(StrEnum):
    MODEL_SENTINEL = "model_sentinel"
    LOW_RETRIEVAL_CONFIDENCE = "low_retrieval_confidence"
    NO_DOCUMENTS = "no_documents"
    UPSTREAM_ERROR = "upstream_error"


# Tolerates the model wrapping the marker in bold, a heading, or a code fence.
_SENTINEL_PATTERN = re.compile(
    r"^\s*(?:[#*_`>\s]*)" + re.escape(ESCALATION_SENTINEL) + r"(?:[*_`]*)\s*:?\s*",
    re.IGNORECASE,
)
_SENTINEL_ANYWHERE = re.compile(re.escape(ESCALATION_SENTINEL), re.IGNORECASE)

_CITATION_MARKER = re.compile(r"\[(\d{1,2})\]")

# Claims that must be grounded. An answer containing one of these while citing
# nothing is the shape of a hallucinated policy detail.
_SPECIFIC_CLAIM = re.compile(
    r"(?:\b\d+\s*(?:day|week|month|year|hour|business day)s?\b"
    r"|[$£€]\s?\d"
    r"|\b\d+(?:\.\d+)?\s*%)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class PreflightDecision:
    """Whether to escalate before spending a GPU request."""

    escalate: bool
    reason: EscalationReason | None = None
    message: str | None = None


@dataclass(frozen=True)
class AnswerAnalysis:
    text: str
    escalated: bool
    reason: EscalationReason | None
    citations: list[dict[str, Any]]
    ungrounded_claim: bool


def preflight(
    chunks: list[RetrievedChunk],
    min_score: float,
    *,
    knowledge_base_empty: bool,
    company_name: str,
) -> PreflightDecision:
    """Decide whether to escalate before calling the model."""
    if knowledge_base_empty:
        return PreflightDecision(
            escalate=True,
            reason=EscalationReason.NO_DOCUMENTS,
            message=(
                f"I don't have any {company_name} documentation loaded yet, so I "
                "can't answer accurately. I'm connecting you with a member of the "
                "team."
            ),
        )

    if not chunks or chunks[0].score < min_score:
        return PreflightDecision(
            escalate=True,
            reason=EscalationReason.LOW_RETRIEVAL_CONFIDENCE,
            message=(
                "I couldn't find anything in our documentation that answers that "
                "reliably, and I don't want to guess. I'm passing you to a member "
                "of the team who can help."
            ),
        )

    return PreflightDecision(escalate=False)


def strip_sentinel(text: str) -> tuple[str, bool]:
    """Remove the escalation marker. Returns the clean text and whether it fired.

    Handles the marker appearing mid-text as well as at the start: models
    occasionally emit a sentence first. The customer must never see the raw
    marker either way.
    """
    stripped, count = _SENTINEL_PATTERN.subn("", text, count=1)
    if count:
        return stripped.lstrip(), True
    if _SENTINEL_ANYWHERE.search(text):
        return _SENTINEL_ANYWHERE.sub("", text).strip(), True
    return text, False


def extract_citations(text: str, chunks: list[RetrievedChunk]) -> list[dict[str, Any]]:
    """Resolve `[n]` markers to the chunks they refer to.

    Markers are 1-indexed against the order chunks were rendered into the
    context block. Out-of-range markers are dropped rather than guessed at — a
    citation chip that opens the wrong document is worse than no chip.
    """
    seen: set[int] = set()
    citations: list[dict[str, Any]] = []
    for match in _CITATION_MARKER.finditer(text):
        index = int(match.group(1))
        if index in seen or not (1 <= index <= len(chunks)):
            continue
        seen.add(index)
        chunk = chunks[index - 1]
        citations.append(
            {
                "marker": index,
                "chunk_id": chunk.chunk_id,
                "document_id": chunk.document_id,
                "document_title": chunk.document_title,
                "heading": chunk.heading,
                "score": round(chunk.score, 4),
            }
        )
    return citations


def analyse_answer(text: str, chunks: list[RetrievedChunk]) -> AnswerAnalysis:
    """Post-process a completed answer into its final, user-facing form."""
    cleaned, escalated = strip_sentinel(text)
    citations = extract_citations(cleaned, chunks)

    # A specific number with no citation behind it is the signature of an
    # invented policy detail. We surface rather than suppress it: the answer
    # still goes out, but it is flagged so the metric is visible on the
    # dashboard and reviewable in the transcript.
    ungrounded = bool(not escalated and not citations and _SPECIFIC_CLAIM.search(cleaned))

    return AnswerAnalysis(
        text=cleaned.strip(),
        escalated=escalated,
        reason=EscalationReason.MODEL_SENTINEL if escalated else None,
        citations=citations,
        ungrounded_claim=ungrounded,
    )
