"""Chat API — SSE streaming."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app.api.deps import ChatServiceDep, SessionDep
from app.core.logging import get_logger
from app.db.models import Conversation, Message
from app.schemas.chat import ChatRequest, ConversationOut, MessageOut, StreamEvent

router = APIRouter(prefix="/chat", tags=["chat"])
log = get_logger(__name__)


def _sse(event: StreamEvent) -> str:
    return f"event: {event.type}\ndata: {event.model_dump_json()}\n\n"


@router.post("", summary="Send a message and stream the response")
async def chat(
    payload: ChatRequest,
    request: Request,
    session: SessionDep,
    service: ChatServiceDep,
) -> StreamingResponse:
    """Stream a reply as Server-Sent Events.

    SSE rather than WebSockets: the traffic is one-directional and request-scoped,
    so SSE gives us the same streaming behaviour over plain HTTP — which means
    ordinary load balancers, ordinary retries, and no connection state to manage
    across pod restarts.
    """

    async def generate() -> AsyncIterator[str]:
        try:
            async for event in service.stream(
                session, message=payload.message, conversation_id=payload.conversation_id
            ):
                # Stop as soon as the client is gone. Without this the generator
                # keeps pulling tokens from vLLM for a browser tab that closed —
                # GPU time spent on output nobody will read.
                if await request.is_disconnected():
                    raise asyncio.CancelledError
                yield _sse(event)
        except asyncio.CancelledError:
            log.info("chat_stream_cancelled")
            raise
        except Exception:
            log.exception("chat_stream_failed")
            yield _sse(
                StreamEvent(
                    type="error",
                    data={
                        "message": "Something went wrong generating a response.",
                        "retryable": True,
                    },
                )
            )

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Without this, nginx-family proxies buffer the whole response and
            # the user sees nothing until generation finishes — which looks
            # exactly like the server hanging.
            "X-Accel-Buffering": "no",
        },
    )


@router.get(
    "/conversations/{conversation_id}",
    response_model=ConversationOut,
    summary="Fetch a stored conversation",
)
async def get_conversation(conversation_id: uuid.UUID, session: SessionDep) -> ConversationOut:
    conversation = await session.get(Conversation, conversation_id)
    if conversation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "conversation not found")

    messages = list(
        (
            await session.scalars(
                select(Message)
                .where(Message.conversation_id == conversation_id)
                .order_by(Message.created_at)
            )
        ).all()
    )

    config_version: int | None = None
    if conversation.config_version_id:
        from app.db.models import ConfigVersion

        version = await session.get(ConfigVersion, conversation.config_version_id)
        config_version = version.version if version else None

    return ConversationOut(
        id=conversation.id,
        created_at=conversation.created_at,
        config_version=config_version,
        messages=[
            MessageOut(
                id=message.id,
                role=message.role,
                content=message.content,
                escalated=message.escalated,
                escalation_reason=message.escalation_reason,
                citations=message.citations,
                created_at=message.created_at,
            )
            for message in messages
        ],
    )
