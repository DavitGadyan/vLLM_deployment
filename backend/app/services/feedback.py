"""Collecting human judgements, and exporting them as training data.

This is the alignment loop's input half. It is deliberately only the input half:
nothing here trains anything. What it does is turn scattered opinions about
answers into a dataset with the shape a training run actually needs, and keep
that dataset honest.

Three things it is strict about, each because getting it wrong is expensive
later rather than immediately:

**Redaction happens on write.** A customer's question is the `prompt` field of a
future training example. Personal data that reaches this table does not merely
sit in a database — it gets exported, copied to a training host, and then
memorised by a model, at which point it cannot be deleted in any meaningful
sense. This is the last point where removing it is cheap.

**Every judgement records the config version it was made under.** A preference
collected against an older system prompt is a statement about an assistant that
no longer exists. Training on a mixture of them without knowing which is which
drags a model toward its own past.

**Export marks what it took.** `exported_at` makes the export resumable and
stops the same preference being trained on twice, which would quietly
over-weight whatever the first batch happened to contain.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import metrics
from app.core.logging import get_logger
from app.core.redaction import redact
from app.db.models import FeedbackEvent
from app.schemas.feedback import (
    CommentFeedback,
    FeedbackSummary,
    PreferenceFeedback,
    RatingFeedback,
)
from app.services.audit import Action, AuditService

log = get_logger(__name__)

# How many recent comments the dashboard shows. Enough to read in one sitting;
# the free-text signal is for spotting a pattern, not for browsing.
RECENT_COMMENT_LIMIT = 8


class FeedbackService:
    def __init__(self, audit_service: AuditService) -> None:
        self._audit = audit_service

    async def record(
        self,
        session: AsyncSession,
        *,
        payload: RatingFeedback | CommentFeedback | PreferenceFeedback,
        config_version: int | None,
        actor: str | None = None,
    ) -> FeedbackEvent:
        """Store one judgement, with its audit entry, in one transaction."""
        event = FeedbackEvent(
            id=uuid.uuid4(),
            kind=payload.kind,
            config_version=config_version,
            comment=redact(payload.comment) if payload.comment else None,
        )

        if isinstance(payload, PreferenceFeedback):
            event.conversation_id = payload.conversation_id
            event.question = redact(payload.question)
            event.chosen_answer = redact(payload.chosen_answer)
            event.rejected_answer = redact(payload.rejected_answer)
            event.chosen_variant = payload.chosen_variant
            event.variant_params = payload.variant_params
            verdict = (payload.chosen_variant or "unknown").lower()
            metrics.feedback_preference_wins_total.labels(variant=verdict).inc()
        else:
            event.conversation_id = payload.conversation_id
            event.message_id = payload.message_id
            if isinstance(payload, RatingFeedback):
                event.rating = payload.rating
                verdict = "up" if payload.rating > 0 else "down"
            else:
                verdict = "none"

        metrics.feedback_total.labels(kind=payload.kind, verdict=verdict).inc()

        session.add(event)
        # Flush so the audit entry can reference a real id, while staying inside
        # the caller's transaction — the judgement and its audit record must
        # land together or not at all.
        await session.flush()

        await self._audit.record(
            session,
            action=Action.FEEDBACK_RECORDED,
            actor=actor,
            resource_type="feedback_event",
            resource_id=str(event.id),
            detail={
                "kind": payload.kind,
                "verdict": verdict,
                "config_version": config_version,
                "has_comment": event.comment is not None,
            },
        )

        log.info(
            "feedback_recorded",
            kind=payload.kind,
            verdict=verdict,
            config_version=config_version,
        )
        return event

    async def summarise(self, session: AsyncSession) -> FeedbackSummary:
        """Counts for the Monitoring tab."""
        totals = (
            await session.execute(
                select(
                    func.count(FeedbackEvent.id),
                    func.count(FeedbackEvent.id).filter(FeedbackEvent.rating == 1),
                    func.count(FeedbackEvent.id).filter(FeedbackEvent.rating == -1),
                    func.count(FeedbackEvent.id).filter(FeedbackEvent.kind == "comment"),
                    func.count(FeedbackEvent.id).filter(FeedbackEvent.kind == "preference"),
                    func.count(FeedbackEvent.id).filter(FeedbackEvent.exported_at.is_(None)),
                )
            )
        ).one()

        total, up, down, comments, preferences, pending = totals

        rated = up + down
        # None rather than 0.0 when nothing has been rated: an approval rate of
        # zero and no data at all mean opposite things, and a dashboard that
        # renders "0%" for "no data" invites exactly the wrong conclusion.
        approval = (up / rated) if rated else None

        wins = {
            str(variant): count
            for variant, count in (
                await session.execute(
                    select(FeedbackEvent.chosen_variant, func.count(FeedbackEvent.id))
                    .where(FeedbackEvent.kind == "preference")
                    .group_by(FeedbackEvent.chosen_variant)
                )
            ).all()
            if variant is not None
        }

        recent = (
            await session.execute(
                select(
                    FeedbackEvent.comment,
                    FeedbackEvent.rating,
                    FeedbackEvent.kind,
                    FeedbackEvent.created_at,
                )
                .where(FeedbackEvent.comment.is_not(None))
                .order_by(FeedbackEvent.created_at.desc())
                .limit(RECENT_COMMENT_LIMIT)
            )
        ).all()

        metrics.feedback_pending_export.set(pending)

        return FeedbackSummary(
            total=total,
            ratings_up=up,
            ratings_down=down,
            comments=comments,
            preferences=preferences,
            pending_export=pending,
            approval_rate=approval,
            variant_wins=wins,
            recent_comments=[
                {
                    "comment": comment,
                    "rating": rating,
                    "kind": kind,
                    "created_at": created_at.isoformat(),
                }
                for comment, rating, kind, created_at in recent
            ],
        )

    async def export_preferences(
        self,
        session: AsyncSession,
        *,
        limit: int = 1000,
        mark_exported: bool = True,
        actor: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        The un-exported preference pairs, in DPO's input format.

        Returns `{prompt, chosen, rejected}` records — the shape TRL's
        `DPOTrainer` reads directly, so the handoff to a training run is a file
        rather than a conversion script that can disagree with this schema.

        Ratings and comments are deliberately not exported here. A thumbs-down
        says an answer was wrong, not what the right answer was, so it is
        triage input rather than training input; turning it into one would mean
        inventing the preferred answer.
        """
        rows = (
            await session.execute(
                select(FeedbackEvent)
                .where(
                    FeedbackEvent.kind == "preference",
                    FeedbackEvent.exported_at.is_(None),
                )
                .order_by(FeedbackEvent.created_at)
                .limit(limit)
            )
        ).scalars().all()

        records = [
            {
                "prompt": row.question,
                "chosen": row.chosen_answer,
                "rejected": row.rejected_answer,
                "config_version": row.config_version,
                "collected_at": row.created_at.isoformat(),
            }
            for row in rows
        ]

        if rows and mark_exported:
            await session.execute(
                update(FeedbackEvent)
                .where(FeedbackEvent.id.in_([row.id for row in rows]))
                .values(exported_at=datetime.now(UTC))
            )
            await self._audit.record(
                session,
                action=Action.FEEDBACK_EXPORTED,
                actor=actor,
                resource_type="feedback_export",
                resource_id=f"{len(rows)} pairs",
                detail={"count": len(rows), "format": "dpo-jsonl"},
            )

        log.info("feedback_exported", count=len(records), marked=mark_exported)
        return records


async def to_jsonl(records: Sequence[dict[str, Any]]) -> AsyncIterator[str]:
    """Stream the export as JSON Lines, one record per line."""
    for record in records:
        yield json.dumps(record, ensure_ascii=False) + "\n"
