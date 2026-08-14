"""Chat orchestration: retrieve, assemble, stream, analyse, persist.

This is where the four guardrail layers, the prefix-cache contract and the
metrics all meet. The sequence for one turn:

    retrieve -> preflight gate -> assemble -> stream -> analyse -> persist

The preflight gate can short-circuit before the model is called at all, which is
both the most reliable guardrail and the cheapest.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core import metrics
from app.core.logging import get_logger
from app.core.redaction import redact
from app.core.settings import Settings
from app.db.models import Conversation, Message
from app.schemas.chat import StreamEvent
from app.services import guardrails
from app.services.assembler import RetrievedChunk, assemble
from app.services.config_service import ConfigService
from app.services.guardrails import EscalationReason
from app.services.llm_client import LLMClient, StreamUsage, UpstreamError
from app.services.prompt_compiler import ESCALATION_SENTINEL
from app.services.retriever import Retriever

log = get_logger(__name__)

# How many characters to withhold before deciding whether a response is an
# escalation. Long enough to contain the sentinel plus any markdown the model
# wraps it in, short enough that a normal answer's first token reaches the user
# within one or two stream chunks.
_SENTINEL_HOLD_CHARS = len(ESCALATION_SENTINEL) + 8


class ChatService:
    def __init__(
        self,
        settings: Settings,
        llm: LLMClient,
        retriever: Retriever,
        config_service: ConfigService,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._settings = settings
        self._llm = llm
        self._retriever = retriever
        self._config = config_service
        self._session_factory = session_factory

    async def stream(
        self, session: AsyncSession, *, message: str, conversation_id: uuid.UUID | None
    ) -> AsyncIterator[StreamEvent]:
        settings = self._settings
        started = time.perf_counter()

        config = await self._config.get_active(session)
        conversation = await self._load_or_create_conversation(session, conversation_id, config.id)
        history = await self._load_history(session, conversation.id)

        yield StreamEvent(
            type="start",
            data={
                "conversation_id": str(conversation.id),
                "config_version": config.version,
            },
        )

        top_k = config.retrieval_top_k or settings.retrieval_top_k
        min_score = (
            config.retrieval_min_score
            if config.retrieval_min_score is not None
            else settings.retrieval_min_score
        )

        chunks = await self._retriever.search(session, message, top_k=top_k)
        kb_empty = await self._retriever.knowledge_base_empty(session)

        # --- Guardrail layer 2: escalate without calling the model -----------
        decision = guardrails.preflight(
            chunks, min_score, knowledge_base_empty=kb_empty, company_name=config.company_name
        )
        if decision.escalate:
            assert decision.reason is not None and decision.message is not None
            async for event in self._emit_escalation(
                session,
                conversation=conversation,
                question=message,
                answer=decision.message,
                reason=decision.reason,
                started=started,
            ):
                yield event
            return

        assembled = assemble(
            compiled_prompt=config.compiled_prompt,
            compiled_prompt_tokens=config.compiled_prompt_tokens,
            question=message,
            chunks=chunks,
            history=history,
            min_score=min_score,
            max_context_tokens=settings.max_context_tokens,
            max_model_len=settings.max_model_len,
            max_output_tokens=config.max_output_tokens or settings.max_output_tokens,
            history_turns=settings.history_turns,
        )
        metrics.prompt_total_tokens.observe(assembled.total_tokens)
        metrics.retrieval_chunks_used.observe(len(assembled.used_chunks))

        # Sources go out before the answer so the UI can render citation chips
        # as placeholders and fill them in as markers appear, rather than
        # reflowing the message once generation completes.
        sources = [
            self._source(index, chunk) for index, chunk in enumerate(assembled.used_chunks, start=1)
        ]
        yield StreamEvent(type="citations", data={"sources": sources})

        buffer: list[str] = []
        usage: StreamUsage | None = None
        ttft: float | None = None

        # The sentinel arrives at the very start of an escalating response, so
        # we withhold the opening characters until we know which kind of
        # response this is. Once escalating, we keep consuming the stream —
        # abandoning it would leave vLLM generating into a sequence nobody
        # reads — but stop forwarding deltas, and emit a structured handoff at
        # the end instead. The customer never sees the raw marker.
        holding = True
        hold_buffer = ""
        escalating = False

        try:
            async for delta, chunk_usage in self._llm.stream_chat(
                assembled.messages,
                temperature=config.temperature,
                max_tokens=config.max_output_tokens,
            ):
                if chunk_usage is not None:
                    usage = chunk_usage
                    continue
                if not delta:
                    continue

                if ttft is None:
                    ttft = time.perf_counter() - started
                    metrics.chat_ttft_seconds.observe(ttft)

                buffer.append(delta)

                if escalating:
                    continue

                if holding:
                    hold_buffer += delta
                    if len(hold_buffer) < _SENTINEL_HOLD_CHARS:
                        continue
                    holding = False
                    cleaned, escalating = guardrails.strip_sentinel(hold_buffer)
                    if not escalating:
                        yield StreamEvent(type="delta", data={"text": cleaned})
                    continue

                yield StreamEvent(type="delta", data={"text": delta})

            if holding and hold_buffer:
                # Whole response was shorter than the hold window.
                cleaned, escalating = guardrails.strip_sentinel(hold_buffer)
                if not escalating:
                    yield StreamEvent(type="delta", data={"text": cleaned})

        except asyncio.CancelledError:
            # The browser went away. httpx closes the upstream stream when this
            # propagates, which lets vLLM abort the sequence and free its KV
            # blocks instead of generating into a void.
            metrics.chat_requests_total.labels(outcome="client_cancelled").inc()
            log.info("chat_cancelled", conversation_id=str(conversation.id))
            raise

        except UpstreamError as exc:
            metrics.chat_requests_total.labels(outcome="upstream_error").inc()
            metrics.escalations_total.labels(reason=EscalationReason.UPSTREAM_ERROR).inc()
            log.error("chat_upstream_error", error=str(exc))
            yield StreamEvent(
                type="error",
                data={
                    "message": "The assistant is temporarily unavailable. "
                    "Please try again, or contact the team directly.",
                    "retryable": True,
                },
            )
            return

        if escalating:
            answer, _ = guardrails.strip_sentinel("".join(buffer))
            async for event in self._emit_escalation(
                session,
                conversation=conversation,
                question=message,
                answer=answer.strip(),
                reason=EscalationReason.MODEL_SENTINEL,
                started=started,
                usage=usage,
            ):
                yield event
            return

        analysis = guardrails.analyse_answer("".join(buffer), assembled.used_chunks)
        elapsed = time.perf_counter() - started
        metrics.chat_duration_seconds.observe(elapsed)
        metrics.chat_requests_total.labels(outcome="answered").inc()
        if analysis.citations:
            metrics.answers_with_citations_total.inc()
        if usage:
            metrics.chat_tokens_total.labels(direction="prompt").inc(usage.prompt_tokens)
            metrics.chat_tokens_total.labels(direction="completion").inc(usage.completion_tokens)

        await self._persist(
            session,
            conversation=conversation,
            question=message,
            answer=analysis.text,
            escalated=False,
            reason=None,
            citations=analysis.citations,
            usage=usage,
            ttft=ttft,
            elapsed=elapsed,
        )

        if analysis.ungrounded_claim:
            log.warning(
                "ungrounded_claim",
                conversation_id=str(conversation.id),
                config_version=config.version,
            )

        yield StreamEvent(
            type="done",
            data={
                "citations": analysis.citations,
                "ungrounded_claim": analysis.ungrounded_claim,
                "prompt_tokens": usage.prompt_tokens if usage else None,
                "completion_tokens": usage.completion_tokens if usage else None,
                "cached_prompt_tokens": usage.cached_tokens if usage else None,
                "ttft_ms": round(ttft * 1000) if ttft else None,
                "total_ms": round(elapsed * 1000),
            },
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _source(self, index: int, chunk: RetrievedChunk) -> dict[str, Any]:
        return {
            "marker": index,
            "chunk_id": chunk.chunk_id,
            "document_id": chunk.document_id,
            "document_title": chunk.document_title,
            "heading": chunk.heading,
            "score": round(chunk.score, 4),
        }

    async def _emit_escalation(
        self,
        session: AsyncSession,
        *,
        conversation: Conversation,
        question: str,
        answer: str,
        reason: EscalationReason,
        started: float,
        usage: StreamUsage | None = None,
    ) -> AsyncIterator[StreamEvent]:
        elapsed = time.perf_counter() - started
        metrics.chat_requests_total.labels(outcome="escalated").inc()
        metrics.escalations_total.labels(reason=reason.value).inc()
        metrics.chat_duration_seconds.observe(elapsed)

        await self._persist(
            session,
            conversation=conversation,
            question=question,
            answer=answer,
            escalated=True,
            reason=reason.value,
            citations=[],
            usage=usage,
            ttft=None,
            elapsed=elapsed,
        )

        log.info(
            "chat_escalated",
            conversation_id=str(conversation.id),
            reason=reason.value,
            duration_ms=round(elapsed * 1000),
        )

        yield StreamEvent(type="delta", data={"text": answer})
        yield StreamEvent(
            type="escalation",
            data={"reason": reason.value, "message": answer},
        )
        yield StreamEvent(
            type="done",
            data={"escalated": True, "reason": reason.value, "total_ms": round(elapsed * 1000)},
        )

    async def _load_or_create_conversation(
        self, session: AsyncSession, conversation_id: uuid.UUID | None, config_version_id: uuid.UUID
    ) -> Conversation:
        if conversation_id is not None:
            existing = await session.get(Conversation, conversation_id)
            if existing is not None:
                return existing

        conversation = Conversation(
            id=uuid.uuid4(), config_version_id=config_version_id, channel="web"
        )
        session.add(conversation)
        await session.commit()
        await session.refresh(conversation)
        return conversation

    async def _load_history(
        self, session: AsyncSession, conversation_id: uuid.UUID
    ) -> list[dict[str, Any]]:
        conversation = await session.get(Conversation, conversation_id)
        if conversation is None:
            return []
        await session.refresh(conversation, ["messages"])
        return [
            {"role": message.role, "content": message.content}
            for message in conversation.messages
            if message.role in {"user", "assistant"}
        ]

    async def _persist(
        self,
        session: AsyncSession,
        *,
        conversation: Conversation,
        question: str,
        answer: str,
        escalated: bool,
        reason: str | None,
        citations: list[dict[str, Any]],
        usage: StreamUsage | None,
        ttft: float | None,
        elapsed: float,
    ) -> None:
        """Write the turn. Redaction happens here, on the write path.

        Applying it at read time instead would mean the raw PII is already in
        the database — a filter someone can forget, rather than data that was
        never stored.
        """
        session.add(
            Message(
                id=uuid.uuid4(),
                conversation_id=conversation.id,
                role="user",
                content=redact(question),
            )
        )
        session.add(
            Message(
                id=uuid.uuid4(),
                conversation_id=conversation.id,
                role="assistant",
                content=redact(answer),
                escalated=escalated,
                escalation_reason=reason,
                citations=citations,
                prompt_tokens=usage.prompt_tokens if usage else None,
                completion_tokens=usage.completion_tokens if usage else None,
                ttft_ms=round(ttft * 1000) if ttft else None,
                total_ms=round(elapsed * 1000),
            )
        )
        await session.commit()
