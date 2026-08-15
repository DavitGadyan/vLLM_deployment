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
from app.core.redaction import redact_counted
from app.core.settings import Settings
from app.db.models import Conversation, Message
from app.schemas.chat import StreamEvent
from app.schemas.feedback import AnswerVariant, CompareResponse
from app.services import guardrails, injection_detector
from app.services.assembler import RetrievedChunk, assemble
from app.services.audit import Action, AuditService
from app.services.config_service import ConfigService
from app.services.embeddings import EmbeddingError
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

# Sampling settings for the two sides of an A/B comparison.
#
# Only temperature varies, and only one step. The comparison is meant to produce
# a usable preference pair, which requires two answers that are genuinely
# different but both plausible — two samples at the same temperature are often
# near-identical (nothing to choose between), while a wide spread makes the
# choice obvious and teaches the model nothing it did not already know.
#
# "A" is always the shipped configuration, so a win rate for B is directly
# readable as "would this change be an improvement".
_COMPARE_VARIANTS: tuple[tuple[str, float | None], ...] = (
    ("A", None),
    ("B", 0.65),
)


class ChatService:
    def __init__(
        self,
        settings: Settings,
        llm: LLMClient,
        retriever: Retriever,
        config_service: ConfigService,
        session_factory: async_sessionmaker[AsyncSession],
        audit_service: AuditService,
    ) -> None:
        self._settings = settings
        self._llm = llm
        self._retriever = retriever
        self._config = config_service
        self._session_factory = session_factory
        self._audit = audit_service

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

        # Retrieval runs before the model, and it has its own upstream: the
        # embedding service. If that is unreachable the question cannot be
        # grounded, which is the same situation as the model being unreachable
        # and deserves the same answer — hand off to a person.
        #
        # Without this the exception escaped `stream` entirely and the customer
        # got a bare "something went wrong", with no escalation recorded and
        # nothing on the security or quality dashboards to say why.
        try:
            chunks = await self._retriever.search(session, message, top_k=top_k)
        except EmbeddingError as exc:
            metrics.chat_requests_total.labels(outcome="upstream_error").inc()
            log.error("chat_retrieval_failed", error=str(exc))
            async for event in self._emit_escalation(
                session,
                conversation=conversation,
                question=message,
                answer=guardrails.UPSTREAM_ERROR_MESSAGE,
                reason=EscalationReason.UPSTREAM_ERROR,
                started=started,
            ):
                yield event
            return

        kb_empty = await self._retriever.knowledge_base_empty(session)

        # Scan the customer's message and every retrieved chunk. This does not
        # block the request — the grounding rules in the compiled prompt are the
        # control that stops an injection taking effect. What this adds is
        # visibility: without it the security dashboard could only assert that a
        # defence exists, never show it being exercised.
        await self._scan_for_injection(session, message, chunks)

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

    async def _scan_for_injection(
        self, session: AsyncSession, message: str, chunks: list[RetrievedChunk]
    ) -> None:
        """Detect, count and audit injection attempts. Never blocks."""
        result = injection_detector.scan_turn(
            message, [(chunk.chunk_id, chunk.text) for chunk in chunks]
        )
        if not result.detected:
            return

        for finding in result.findings:
            metrics.injection_attempts_total.labels(
                surface=finding.surface.value,
                severity=finding.severity.value,
                rule=finding.rule,
            ).inc()

            # A payload found inside an indexed document is a different problem
            # from a customer typing one: it means the knowledge base has been
            # poisoned, and somebody needs to look at the source file. Escalate
            # the audit severity accordingly.
            in_document = finding.surface is injection_detector.Surface.RETRIEVED_DOCUMENT
            await self._audit.record(
                session,
                action=Action.INJECTION_DETECTED,
                outcome="denied",
                severity="critical" if in_document else finding.severity.value,
                resource_type="chunk" if in_document else "message",
                resource_id=finding.source_id,
                detail={
                    "rule": finding.rule,
                    "surface": finding.surface.value,
                    "explanation": finding.explanation,
                    "excerpt": finding.excerpt,
                },
            )

        log.warning(
            "injection_detected",
            findings=len(result.findings),
            max_severity=result.max_severity.value if result.max_severity else None,
        )

    async def compare(
        self, session: AsyncSession, *, message: str, conversation_id: uuid.UUID | None
    ) -> CompareResponse:
        """
        Answer the same question twice, under different sampling settings.

        This is how preference pairs are collected: a person reads two candidate
        answers to one question and says which is better, which is a far more
        reliable judgement than rating a single answer in isolation, and is the
        exact `(prompt, chosen, rejected)` triple DPO trains on.

        Retrieval and prompt assembly run **once** and are shared by both sides.
        That is the whole point — with identical context, the only difference
        between A and B is generation, so the preference is attributable to the
        sampling change rather than to one side having been handed better
        documents.

        Not free: this spends two generations on one question, so it is an
        operator-facing tool for building a training set, not the customer path.
        Neither candidate is written to the conversation — they are proposals,
        and only the chosen one is worth keeping, on the preference record.
        """
        settings = self._settings
        started = time.perf_counter()

        config = await self._config.get_active(session)
        top_k = config.retrieval_top_k or settings.retrieval_top_k
        min_score = (
            config.retrieval_min_score
            if config.retrieval_min_score is not None
            else settings.retrieval_min_score
        )

        try:
            chunks = await self._retriever.search(session, message, top_k=top_k)
        except EmbeddingError as exc:
            raise UpstreamError(f"retrieval unavailable: {exc}") from exc

        kb_empty = await self._retriever.knowledge_base_empty(session)
        await self._scan_for_injection(session, message, chunks)

        decision = guardrails.preflight(
            chunks, min_score, knowledge_base_empty=kb_empty, company_name=config.company_name
        )
        if decision.escalate:
            # Nothing to compare: both sides would be the same handoff, and a
            # preference between two identical answers is not a signal.
            assert decision.message is not None
            await session.commit()
            return CompareResponse(
                question=message,
                conversation_id=conversation_id,
                config_version=config.version,
                variants=[
                    AnswerVariant(
                        label=label,
                        content=decision.message,
                        escalated=True,
                        params={"temperature": temperature},
                    )
                    for label, temperature in _COMPARE_VARIANTS
                ],
            )

        assembled = assemble(
            compiled_prompt=config.compiled_prompt,
            compiled_prompt_tokens=config.compiled_prompt_tokens,
            question=message,
            chunks=chunks,
            history=[],
            min_score=min_score,
            max_context_tokens=settings.max_context_tokens,
            max_model_len=settings.max_model_len,
            max_output_tokens=config.max_output_tokens or settings.max_output_tokens,
            history_turns=settings.history_turns,
        )
        sources = [
            self._source(index, chunk) for index, chunk in enumerate(assembled.used_chunks, start=1)
        ]

        async def generate(label: str, temperature: float | None) -> AnswerVariant:
            effective = config.temperature if temperature is None else temperature
            parts: list[str] = []
            async for delta, chunk_usage in self._llm.stream_chat(
                assembled.messages,
                temperature=effective,
                max_tokens=config.max_output_tokens,
            ):
                if chunk_usage is None and delta:
                    parts.append(delta)

            text, escalating = guardrails.strip_sentinel("".join(parts))
            return AnswerVariant(
                label=label,
                content=text,
                citations=sources,
                escalated=escalating,
                params={"temperature": effective},
                total_ms=round((time.perf_counter() - started) * 1000),
            )

        # Concurrent, so the operator waits for the slower of the two rather
        # than for their sum. Continuous batching means both land in the same
        # running batch on the GPU, so this costs little more wall-clock than one.
        variants = await asyncio.gather(
            *(generate(label, temperature) for label, temperature in _COMPARE_VARIANTS)
        )

        await session.commit()
        log.info("chat_compared", variants=len(variants), config_version=config.version)

        return CompareResponse(
            question=message,
            conversation_id=conversation_id,
            config_version=config.version,
            variants=list(variants),
        )

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
        clean_question, question_pii = redact_counted(question)
        clean_answer, answer_pii = redact_counted(answer)

        session.add(
            Message(
                id=uuid.uuid4(),
                conversation_id=conversation.id,
                role="user",
                content=clean_question,
            )
        )
        session.add(
            Message(
                id=uuid.uuid4(),
                conversation_id=conversation.id,
                role="assistant",
                content=clean_answer,
                escalated=escalated,
                escalation_reason=reason,
                citations=citations,
                prompt_tokens=usage.prompt_tokens if usage else None,
                completion_tokens=usage.completion_tokens if usage else None,
                ttft_ms=round(ttft * 1000) if ttft else None,
                total_ms=round(elapsed * 1000),
            )
        )

        # Count what was redacted, and audit it. Redaction that nobody can see
        # operating is indistinguishable from redaction that silently stopped
        # working after a regex change.
        redactions: dict[str, int] = {}
        for category, count in (*question_pii.items(), *answer_pii.items()):
            redactions[category] = redactions.get(category, 0) + count

        for category, count in redactions.items():
            metrics.pii_redactions_total.labels(category=category).inc(count)

        if redactions:
            await self._audit.record(
                session,
                action=Action.PII_REDACTED,
                resource_type="conversation",
                resource_id=str(conversation.id),
                # Categories and counts only. Recording the values themselves
                # would move the PII rather than remove it.
                detail={"categories": redactions},
            )

        # The access-log entry HIPAA 164.312(b) asks for. No message content —
        # the transcript lives in `messages`, already redacted; this records that
        # an interaction happened, under which configuration, and how it ended.
        await self._audit.record(
            session,
            action=Action.CHAT_ESCALATED if escalated else Action.CHAT_ANSWERED,
            resource_type="conversation",
            resource_id=str(conversation.id),
            detail={
                "escalated": escalated,
                "reason": reason,
                "citations": len(citations),
                "prompt_tokens": usage.prompt_tokens if usage else None,
                "completion_tokens": usage.completion_tokens if usage else None,
                "total_ms": round(elapsed * 1000),
            },
        )
        await session.commit()
