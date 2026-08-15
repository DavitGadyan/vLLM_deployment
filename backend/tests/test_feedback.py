"""Feedback schema and export-format tests.

These cover the parts of the alignment loop that are easy to get quietly wrong:
the shape of a preference pair, and what leaves the building in an export.

A malformed preference is not a crash — it is a row that looks fine until a
training run consumes it, at which point the damage is a model, not a stack
trace. So the constraints are asserted here rather than trusted.
"""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from app.schemas.feedback import (
    CommentFeedback,
    PreferenceFeedback,
    RatingFeedback,
)
from app.services.feedback import to_jsonl


def test_rating_accepts_only_thumbs() -> None:
    """A 1-5 scale would collapse to its extremes; the schema refuses one."""
    assert RatingFeedback(conversation_id=_id(), rating=1).rating == 1
    assert RatingFeedback(conversation_id=_id(), rating=-1).rating == -1

    for invalid in (0, 3, 5, -2):
        with pytest.raises(ValidationError):
            RatingFeedback(conversation_id=_id(), rating=invalid)  # type: ignore[arg-type]


def test_preference_requires_both_sides() -> None:
    """
    A preference with nothing to compare against is not a preference.

    Caught at the edge because the alternative is discovering it when a training
    run reads `rejected: null` and either crashes or, worse, trains anyway.
    """
    with pytest.raises(ValidationError):
        PreferenceFeedback(question="q", chosen_answer="a")  # type: ignore[call-arg]

    with pytest.raises(ValidationError):
        PreferenceFeedback(question="q", rejected_answer="b")  # type: ignore[call-arg]

    pair = PreferenceFeedback(question="q", chosen_answer="a", rejected_answer="b")
    assert pair.kind == "preference"


def test_empty_strings_are_rejected() -> None:
    """Whitespace-only feedback is noise that would dilute the training set."""
    with pytest.raises(ValidationError):
        CommentFeedback(conversation_id=_id(), comment="")

    with pytest.raises(ValidationError):
        PreferenceFeedback(question="", chosen_answer="a", rejected_answer="b")


def test_comment_length_is_bounded() -> None:
    """The comment box is a feedback field, not an upload channel."""
    with pytest.raises(ValidationError):
        CommentFeedback(conversation_id=_id(), comment="x" * 2001)

    assert CommentFeedback(conversation_id=_id(), comment="x" * 2000)


@pytest.mark.anyio
async def test_export_is_dpo_shaped_jsonl() -> None:
    """
    One JSON object per line, carrying exactly the keys DPO reads.

    Asserted because the value of this format is that it needs no conversion
    step — and a conversion step is precisely where a schema drifts out of sync
    with the trainer that consumes it.
    """
    records = [
        {
            "prompt": "How long do I have to return something?",
            "chosen": "30 days.",
            "rejected": "Maybe.",
        },
        {"prompt": "Is shipping free?", "chosen": "Over £50.", "rejected": "Yes, always."},
    ]

    lines = [line async for line in to_jsonl(records)]
    assert len(lines) == len(records)

    for line, expected in zip(lines, records, strict=True):
        assert line.endswith("\n")
        parsed = json.loads(line)
        assert set(parsed) >= {"prompt", "chosen", "rejected"}
        assert parsed["chosen"] == expected["chosen"]
        assert parsed["rejected"] == expected["rejected"]


@pytest.mark.anyio
async def test_export_keeps_non_ascii_readable() -> None:
    """
    Unicode is written through, not escaped.

    Support traffic is multilingual and Qwen's strength is that it handles it.
    A training file full of \\u00e9 escapes still parses, but it is unreadable
    to the person who has to review the data before it is trained on.
    """
    lines = [
        record
        async for record in to_jsonl(
            [{"prompt": "Où est ma commande ?", "chosen": "Elle arrive.", "rejected": "?"}]
        )
    ]
    line = lines[0]

    assert "Où est ma commande" in line
    assert json.loads(line)["prompt"] == "Où est ma commande ?"


def _id() -> str:
    return "00000000-0000-0000-0000-000000000001"
