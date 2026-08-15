"""Feedback request/response schemas.

Three kinds arrive on one endpoint, discriminated on `kind`, because they are
one concept — a human judgement about an answer — and splitting them across
three routes would put the same auth, redaction and audit work in three places.

The variants are validated separately rather than with optional fields on a
single model: a preference without its rejected side is not a preference, and
catching that at the edge beats writing an unusable row and finding out at
training time.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

# Long enough for a considered explanation, short enough that the field is not
# a free-text upload channel into the training set.
CommentText = Annotated[str, Field(min_length=1, max_length=2000)]


class RatingFeedback(BaseModel):
    """Thumbs up or down on one answer."""

    kind: Literal["rating"] = "rating"
    conversation_id: uuid.UUID
    message_id: uuid.UUID | None = None
    # +1 or -1 only. A 1-5 scale collapses to its extremes in practice and the
    # middle carries no signal worth the extra decision it asks of the user.
    rating: Literal[-1, 1]
    comment: CommentText | None = None


class CommentFeedback(BaseModel):
    """Free text with no verdict attached."""

    kind: Literal["comment"] = "comment"
    conversation_id: uuid.UUID
    message_id: uuid.UUID | None = None
    comment: CommentText


class PreferenceFeedback(BaseModel):
    """
    "A is better than B" for the same question.

    The strongest signal of the three, and the only one that is directly
    trainable: (prompt, chosen, rejected) is exactly the triple DPO consumes,
    and a comparison sidesteps the calibration problem that makes absolute
    ratings noisy.
    """

    kind: Literal["preference"] = "preference"
    conversation_id: uuid.UUID | None = None
    question: Annotated[str, Field(min_length=1, max_length=8000)]
    chosen_answer: Annotated[str, Field(min_length=1, max_length=32000)]
    rejected_answer: Annotated[str, Field(min_length=1, max_length=32000)]
    chosen_variant: Annotated[str, Field(max_length=20)] | None = None
    variant_params: dict[str, Any] | None = None
    comment: CommentText | None = None


FeedbackRequest = Annotated[
    RatingFeedback | CommentFeedback | PreferenceFeedback,
    Field(discriminator="kind"),
]


class FeedbackAccepted(BaseModel):
    id: uuid.UUID
    kind: str
    created_at: datetime


class CompareRequest(BaseModel):
    """Ask the same question twice, under different sampling settings."""

    message: Annotated[str, Field(min_length=1, max_length=8000)]
    conversation_id: uuid.UUID | None = None


class AnswerVariant(BaseModel):
    label: Literal["A", "B"]
    content: str
    citations: list[dict[str, Any]] = []
    escalated: bool = False
    params: dict[str, Any] = {}
    total_ms: int | None = None


class CompareResponse(BaseModel):
    question: str
    conversation_id: uuid.UUID | None = None
    config_version: int | None = None
    variants: list[AnswerVariant]


class FeedbackSummary(BaseModel):
    """What the Monitoring tab shows about the alignment loop."""

    total: int
    ratings_up: int
    ratings_down: int
    comments: int
    preferences: int
    pending_export: int
    approval_rate: float | None = None
    variant_wins: dict[str, int] = {}
    recent_comments: list[dict[str, Any]] = []
