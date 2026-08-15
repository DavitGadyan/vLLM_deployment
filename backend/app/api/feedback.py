"""Feedback API — the collection half of the alignment loop.

Four routes: record a judgement, ask the same question two ways so a judgement
can be a comparison, summarise what has been collected, and export the result as
training data.

Nothing here trains a model. The export is the handoff point, and it is a
deliberate one — a fine-tune that fires automatically on collected preferences
is a way to ship a regression without anyone having read the data first.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from app.api.deps import (
    ChatServiceDep,
    ConfigServiceDep,
    FeedbackServiceDep,
    OperatorDep,
    SessionDep,
)
from app.core.logging import get_logger
from app.schemas.feedback import (
    CompareRequest,
    CompareResponse,
    FeedbackAccepted,
    FeedbackRequest,
    FeedbackSummary,
)
from app.services.feedback import to_jsonl
from app.services.llm_client import UpstreamError

router = APIRouter(prefix="/feedback", tags=["feedback"])
log = get_logger(__name__)


@router.post("", response_model=FeedbackAccepted, summary="Record a human judgement")
async def submit(
    payload: FeedbackRequest,
    session: SessionDep,
    service: FeedbackServiceDep,
    config_service: ConfigServiceDep,
    operator: OperatorDep,
) -> FeedbackAccepted:
    """Store one rating, comment or preference.

    The active config version is stamped on server-side rather than accepted
    from the client: a judgement is about the assistant as it was configured at
    that moment, and a client is in no position to be authoritative about that.
    """
    config = await config_service.get_active(session)

    event = await service.record(
        session,
        payload=payload,
        config_version=config.version,
        actor=operator,
    )
    await session.commit()

    return FeedbackAccepted(id=event.id, kind=event.kind, created_at=event.created_at)


@router.post(
    "/compare",
    response_model=CompareResponse,
    summary="Answer the same question two ways, for a side-by-side judgement",
)
async def compare(
    payload: CompareRequest,
    session: SessionDep,
    service: ChatServiceDep,
) -> CompareResponse:
    """Generate two candidate answers to one question.

    Costs two generations rather than one, which is why it is a separate route
    from `/v1/chat` and not the default path — building a preference set is an
    operator activity, not something to spend on every customer turn.
    """
    try:
        return await service.compare(
            session, message=payload.message, conversation_id=payload.conversation_id
        )
    except UpstreamError as exc:
        log.error("compare_upstream_error", error=str(exc))
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "The model or retrieval service is unavailable.",
        ) from exc


@router.get("/summary", response_model=FeedbackSummary, summary="Collected feedback at a glance")
async def summary(session: SessionDep, service: FeedbackServiceDep) -> FeedbackSummary:
    return await service.summarise(session)


@router.get("/export", summary="Preference pairs as DPO-format JSON Lines")
async def export(
    session: SessionDep,
    service: FeedbackServiceDep,
    operator: OperatorDep,
    limit: int = Query(default=1000, ge=1, le=10000),
    mark: bool = Query(
        default=True,
        description=(
            "Mark the exported rows as consumed. Set false to preview without "
            "claiming them."
        ),
    ),
) -> StreamingResponse:
    """
    Stream un-exported preference pairs as `{prompt, chosen, rejected}` records.

    JSON Lines because a training set is read a record at a time and can outgrow
    memory, and because it is what TRL's `DPOTrainer` reads without conversion.

    By default the exported rows are marked consumed, so a second call returns
    the next batch rather than the same one — training twice on the same
    preferences quietly over-weights them.
    """
    records = await service.export_preferences(
        session, limit=limit, mark_exported=mark, actor=operator
    )
    await session.commit()

    return StreamingResponse(
        to_jsonl(records),
        media_type="application/x-ndjson",
        headers={"Content-Disposition": 'attachment; filename="preferences.jsonl"'},
    )
