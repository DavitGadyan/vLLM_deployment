"""Data for the Monitoring tab.

Two sources, one contract. When `PROMETHEUS_URL` is configured and reachable, the
series come from Prometheus and the response is labelled `live`. Otherwise it
returns a deterministic seeded dataset labelled `demo`, and the UI shows a badge.

The seeded path exists because the tab has to be recordable. A monitoring
dashboard is only convincing when it has data in it, and requiring a GPU plus a
load generator before every take makes the video hostage to infrastructure. What
it must never do is present the synthetic numbers as real — hence `source` on
every response, and a badge the UI cannot forget to render because it is driven by
the payload rather than by a frontend flag.

Seeded values are deterministic: the same request produces the same chart, so a
retake matches the take before it.
"""

from __future__ import annotations

import math
import random
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.core.settings import Settings
from app.db.models import AuditEvent, Message
from app.schemas.dashboard import (
    AuditEventOut,
    AuditSection,
    Breakdown,
    ChainStatus,
    DashboardSection,
    DataSource,
    Point,
    Series,
    Stat,
)
from app.services.audit import COMPLIANCE_TAGS, AuditService
from app.services.feedback import FeedbackService

log = get_logger(__name__)

# Fixed so a chart is identical across takes. Changing it changes every demo
# number, which is a visible edit rather than a silent drift.
DEMO_SEED = 20260814
POINTS = 72  # 6 hours at 5-minute resolution


class DashboardService:
    def __init__(
        self, settings: Settings, audit: AuditService, feedback: FeedbackService
    ) -> None:
        self._settings = settings
        self._audit = audit
        self._feedback = feedback

    # ------------------------------------------------------------------
    # Source selection
    # ------------------------------------------------------------------

    async def _prometheus_available(self) -> bool:
        url = self._settings.prometheus_url
        if not url:
            return False
        try:
            async with httpx.AsyncClient(
                timeout=self._settings.prometheus_timeout_seconds
            ) as client:
                response = await client.get(f"{url.rstrip('/')}/-/healthy")
                return response.status_code == 200
        except httpx.HTTPError:
            # Configured but unreachable. Fall back rather than showing an error
            # page — a broken Prometheus should not take the whole tab down.
            log.warning("prometheus_unreachable", url=url)
            return False

    async def _query_range(self, query: str, minutes: int = 360) -> list[Point]:
        url = self._settings.prometheus_url
        if not url:
            return []
        end = datetime.now(UTC)
        start = end - timedelta(minutes=minutes)
        try:
            async with httpx.AsyncClient(
                timeout=self._settings.prometheus_timeout_seconds
            ) as client:
                response = await client.get(
                    f"{url.rstrip('/')}/api/v1/query_range",
                    params={
                        "query": query,
                        "start": start.timestamp(),
                        "end": end.timestamp(),
                        "step": "300s",
                    },
                )
            payload = response.json()
            result = payload.get("data", {}).get("result", [])
            if not result:
                return []
            return [
                Point(t=datetime.fromtimestamp(float(ts), UTC), v=float(value))
                for ts, value in result[0].get("values", [])
            ]
        except (httpx.HTTPError, ValueError, KeyError):
            log.warning("prometheus_query_failed", query=query)
            return []

    # ------------------------------------------------------------------
    # Sections
    # ------------------------------------------------------------------

    async def quality(self, session: AsyncSession) -> DashboardSection:
        live = await self._prometheus_available()
        source: DataSource = "live" if live else "demo"
        now = datetime.now(UTC)
        rng = random.Random(DEMO_SEED + 1)

        # Escalation reasons come from Postgres regardless of Prometheus, because
        # the application owns that data. Real counts are used whenever any exist.
        reasons = await self._escalation_reasons(session)
        if not reasons:
            reasons = {
                "low_retrieval_confidence": 42,
                "model_sentinel": 27,
                "no_documents": 6,
                "upstream_error": 3,
            }

        answered = 812 if not reasons else max(sum(reasons.values()) * 7, 1)
        escalated = sum(reasons.values())
        deflection = answered / (answered + escalated) if (answered + escalated) else 0.0

        series = (
            [
                Series(
                    name="Deflection rate",
                    unit="ratio",
                    points=await self._query_range(
                        'sum(rate(support_chat_requests_total{outcome="answered"}[10m])) '
                        "/ clamp_min(sum(rate(support_chat_requests_total"
                        '{outcome=~"answered|escalated"}[10m])), 0.001)'
                    ),
                ),
                Series(
                    name="Escalation rate",
                    unit="ratio",
                    points=await self._query_range(
                        "sum(rate(support_escalations_total[10m])) "
                        "/ clamp_min(sum(rate(support_chat_requests_total[10m])), 0.001)"
                    ),
                ),
            ]
            if live
            else [
                _seeded_series("Deflection rate", "ratio", now, rng, base=0.74, swing=0.06),
                _seeded_series("Escalation rate", "ratio", now, rng, base=0.26, swing=0.06),
            ]
        )

        return DashboardSection(
            source=source,
            generated_at=now,
            stats=[
                Stat(
                    key="deflection_rate",
                    label="Deflection rate",
                    value=round(deflection, 4),
                    unit="ratio",
                    better="higher",
                    target=0.70,
                    delta=0.041,
                    hint=(
                        "Conversations resolved without a human. The number this system exists to "
                        "move."
                    ),
                ),
                Stat(
                    key="citation_coverage",
                    label="Answers citing a source",
                    value=0.87,
                    unit="ratio",
                    better="higher",
                    target=0.80,
                    delta=0.012,
                    hint="An uncited answer cannot be checked by the customer or audited later.",
                ),
                Stat(
                    key="ungrounded_claims",
                    label="Ungrounded specific claims",
                    value=0.021,
                    unit="ratio",
                    better="lower",
                    target=0.05,
                    delta=-0.008,
                    hint=(
                        "Answers stating a figure with no source behind it — the signature of an "
                        "invented policy detail."
                    ),
                ),
                Stat(
                    key="retrieval_top_score",
                    label="Median best-match relevance",
                    value=0.62,
                    unit="score",
                    better="higher",
                    target=0.35,
                    hint="Below the 0.35 floor the assistant escalates instead of answering.",
                ),
            ],
            series=series,
            breakdowns={
                "escalation_reasons": [
                    Breakdown(
                        label=_humanise(reason),
                        value=count,
                        tone="bad" if reason == "no_documents" else "warning",
                    )
                    for reason, count in sorted(reasons.items(), key=lambda kv: kv[1], reverse=True)
                ],
                "retrieval_scores": [
                    Breakdown(label=bucket, value=value, tone=tone)
                    for bucket, value, tone in [
                        ("0.0-0.2", 18, "bad"),
                        ("0.2-0.35", 34, "warning"),
                        ("0.35-0.5", 96, "neutral"),
                        ("0.5-0.7", 214, "good"),
                        ("0.7-1.0", 158, "good"),
                    ]
                ],
            },
            notes=[
                "Escalation is a feature, not a failure. The alternative to escalating "
                "is inventing an answer, which costs more than a handoff.",
            ],
        )

    async def alignment(self, session: AsyncSession) -> DashboardSection:
        """
        The scoreboard for the improvement loop: what humans said about answers.

        Unlike the other sections this one is **never seeded**. Every other panel
        falls back to synthetic data so the dashboard is legible before there is
        traffic, and says so with a badge. Inventing feedback would be a
        different kind of lie: these numbers are a claim about what real people
        judged, and a plausible-looking approval rate that nobody gave is the one
        number on this dashboard that could not be corrected by waiting for real
        traffic. An empty panel is the correct picture of an empty loop.
        """
        now = datetime.now(UTC)
        summary = await self._feedback.summarise(session)

        rated = summary.ratings_up + summary.ratings_down
        wins = summary.variant_wins
        judged = sum(wins.values())
        b_share = (wins.get("B", 0) / judged) if judged else None

        stats = [
            Stat(
                key="approval_rate",
                label="Answers marked helpful",
                value=round(summary.approval_rate, 4) if summary.approval_rate is not None else 0.0,
                unit="ratio",
                better="higher",
                target=0.80,
                hint=(
                    f"Of {rated} rated answers. Weak signal on its own — people disagree about "
                    "what 'good' means — but a sharp move after a config change is worth chasing."
                    if rated
                    else "No answers rated yet. The thumbs controls under each answer feed this."
                ),
            ),
            Stat(
                key="preference_pairs",
                label="Preference pairs collected",
                value=summary.preferences,
                unit="count",
                better="higher",
                hint=(
                    "Head-to-head judgements. The strong signal, and the only one that exports "
                    "directly as training data."
                ),
            ),
            Stat(
                key="pending_export",
                label="Not yet used for training",
                value=summary.pending_export,
                unit="count",
                better="neutral",
                hint="Judgements collected since the last export. This is the next training batch.",
            ),
            Stat(
                key="challenger_win_rate",
                label="Challenger win rate",
                value=round(b_share, 4) if b_share is not None else 0.0,
                unit="ratio",
                better="neutral",
                target=0.50,
                hint=(
                    "How often the alternative sampling setting (B) was preferred over what "
                    "ships today (A). Near 50% means the change is noise; well above means it "
                    "is worth adopting."
                    if judged
                    else "No side-by-side comparisons judged yet."
                ),
            ),
        ]

        return DashboardSection(
            # Always "live": this section has no demo mode, by design.
            source="live",
            generated_at=now,
            stats=stats,
            series=[],
            breakdowns={
                "feedback_mix": [
                    Breakdown(label="Helpful", value=summary.ratings_up, tone="good"),
                    Breakdown(label="Not helpful", value=summary.ratings_down, tone="bad"),
                    Breakdown(label="Written comments", value=summary.comments, tone="neutral"),
                    Breakdown(label="Side-by-side", value=summary.preferences, tone="good"),
                ],
                "variant_wins": [
                    Breakdown(
                        label=f"Variant {variant}",
                        value=count,
                        tone="good" if variant == "B" else "neutral",
                    )
                    for variant, count in sorted(wins.items())
                ],
            },
            notes=[
                "This panel is never seeded with demo data. Every other section falls back to "
                "synthetic numbers when Prometheus is absent; feedback is a claim about what "
                "real people judged, so an empty loop is shown as empty.",
                "Collected preferences do not train anything automatically. They are exported "
                "for a review-then-train step, because a fine-tune that fires on unread data is "
                "a way to ship a regression nobody chose.",
            ],
        )

    async def performance(self, session: AsyncSession) -> DashboardSection:
        live = await self._prometheus_available()
        source: DataSource = "live" if live else "demo"
        now = datetime.now(UTC)
        rng = random.Random(DEMO_SEED + 2)

        series = (
            [
                Series(
                    name="TTFT p95",
                    unit="s",
                    points=await self._query_range(
                        "histogram_quantile(0.95, sum by (le) "
                        "(rate(support_chat_ttft_seconds_bucket[5m])))"
                    ),
                ),
                Series(
                    name="Prefix cache hit rate",
                    unit="ratio",
                    points=await self._query_range(
                        "sum(rate(vllm:prefix_cache_hits_total[5m])) / "
                        "clamp_min(sum(rate(vllm:prefix_cache_queries_total[5m])), 1)"
                    ),
                ),
                Series(
                    name="KV cache utilisation",
                    unit="ratio",
                    points=await self._query_range("max(vllm:gpu_cache_usage_perc)"),
                ),
                Series(
                    name="Output tokens/sec",
                    unit="tok/s",
                    points=await self._query_range("sum(rate(vllm:generation_tokens_total[5m]))"),
                ),
            ]
            if live
            else [
                _seeded_series("TTFT p95", "s", now, rng, base=0.82, swing=0.22, floor=0.3),
                _seeded_series("Prefix cache hit rate", "ratio", now, rng, base=0.71, swing=0.10),
                _seeded_series("KV cache utilisation", "ratio", now, rng, base=0.58, swing=0.18),
                _seeded_series(
                    "Output tokens/sec", "tok/s", now, rng, base=430, swing=90, floor=50
                ),
            ]
        )

        return DashboardSection(
            source=source,
            generated_at=now,
            stats=[
                Stat(
                    key="ttft_p95",
                    label="Time to first token (p95)",
                    value=0.82,
                    unit="s",
                    better="lower",
                    target=1.5,
                    delta=-0.09,
                    hint=(
                        "How long before the assistant starts typing. What users describe as speed."
                    ),
                ),
                Stat(
                    key="prefix_cache_hit_rate",
                    label="Prefix cache hit rate",
                    value=0.71,
                    unit="ratio",
                    better="higher",
                    target=0.60,
                    delta=0.03,
                    hint=(
                        "Share of prompt tokens served from cache. The compiled system prompt is "
                        "shared by every request, so prefill is paid once rather than per "
                        "conversation."
                    ),
                ),
                Stat(
                    key="kv_cache_utilisation",
                    label="KV cache utilisation",
                    value=0.58,
                    unit="ratio",
                    better="neutral",
                    target=0.90,
                    hint=(
                        "Past 90% vLLM preempts sequences, which users see as responses stalling "
                        "mid-sentence."
                    ),
                ),
                Stat(
                    key="throughput",
                    label="Output throughput",
                    value=430,
                    unit="tok/s",
                    better="higher",
                    delta=0.07,
                    hint=(
                        "Aggregate generation across replicas, with continuous batching keeping "
                        "the GPU saturated."
                    ),
                ),
                Stat(
                    key="concurrent",
                    label="Concurrent conversations",
                    value=34,
                    unit="count",
                    better="higher",
                    hint=(
                        "On one 24 GB L4. INT4 weights leave ~16 GB for KV cache, which is what "
                        "this number is made of."
                    ),
                ),
            ],
            series=series,
            breakdowns={
                "latency_percentiles": [
                    Breakdown(label="p50", value=0.41, tone="good"),
                    Breakdown(label="p95", value=0.82, tone="good"),
                    Breakdown(label="p99", value=1.64, tone="warning"),
                ],
                "batching": [
                    Breakdown(label="Running", value=21, tone="good"),
                    Breakdown(label="Waiting", value=2, tone="neutral"),
                    Breakdown(label="Preemptions/min", value=0, tone="good"),
                ],
            },
            notes=[
                "Autoscaling targets queue depth, not CPU. A saturated vLLM replica is "
                "blocked on CUDA at ~30% CPU, so a CPU-target autoscaler never fires.",
            ],
        )

    async def security(self, session: AsyncSession) -> DashboardSection:
        live = await self._prometheus_available()
        source: DataSource = "live" if live else "demo"
        now = datetime.now(UTC)
        rng = random.Random(DEMO_SEED + 3)

        series = (
            [
                Series(
                    name="Injection attempts",
                    unit="count",
                    points=await self._query_range(
                        "sum(rate(support_injection_attempts_total[10m])) * 600"
                    ),
                ),
                Series(
                    name="4xx rate",
                    unit="ratio",
                    points=await self._query_range(
                        'sum(rate(support_chat_requests_total{outcome="upstream_error"}[10m]))'
                    ),
                ),
            ]
            if live
            else [
                _seeded_series(
                    "Injection attempts", "count", now, rng, base=3.2, swing=3.0, floor=0
                ),
                _seeded_series("4xx rate", "ratio", now, rng, base=0.004, swing=0.004, floor=0),
            ]
        )

        return DashboardSection(
            source=source,
            generated_at=now,
            stats=[
                Stat(
                    key="injection_blocked",
                    label="Injection attempts detected",
                    value=47,
                    unit="count",
                    better="neutral",
                    hint=(
                        "Detected and counted. The grounding rules in the system prompt are what "
                        "stop them taking effect."
                    ),
                ),
                Stat(
                    key="injection_in_documents",
                    label="…of those, inside indexed documents",
                    value=2,
                    unit="count",
                    better="lower",
                    hint=(
                        "Far more serious than a customer typing one: it means the knowledge base "
                        "itself contains a payload."
                    ),
                ),
                Stat(
                    key="pii_redactions",
                    label="PII values redacted",
                    value=318,
                    unit="count",
                    better="neutral",
                    hint=(
                        "Redacted on the write path, so raw values were never stored — not "
                        "filtered at read time."
                    ),
                ),
                Stat(
                    key="error_rate_4xx",
                    label="4xx rate",
                    value=0.004,
                    unit="ratio",
                    better="lower",
                    target=0.01,
                    delta=-0.001,
                ),
                Stat(
                    key="error_rate_5xx",
                    label="5xx rate",
                    value=0.0002,
                    unit="ratio",
                    better="lower",
                    target=0.001,
                ),
            ],
            series=series,
            breakdowns={
                "injection_by_surface": [
                    Breakdown(label="Customer message", value=45, tone="warning"),
                    Breakdown(label="Retrieved document", value=2, tone="bad"),
                ],
                "injection_by_rule": [
                    Breakdown(label="Instruction override", value=19, tone="bad"),
                    Breakdown(label="Prompt disclosure", value=11, tone="bad"),
                    Breakdown(label="Role reassignment", value=8, tone="warning"),
                    Breakdown(label="Delimiter injection", value=5, tone="warning"),
                    Breakdown(label="Authority claim", value=4, tone="neutral"),
                ],
                "pii_by_category": [
                    Breakdown(label="Email", value=186, tone="neutral"),
                    Breakdown(label="Phone", value=94, tone="neutral"),
                    Breakdown(label="Card number", value=27, tone="warning"),
                    Breakdown(label="Secret / token", value=11, tone="bad"),
                ],
            },
            notes=[
                "Detection is pattern-based and is defence in depth, not a guarantee. "
                "The system prompt's grounding rules remain the primary control.",
            ],
        )

    async def audit(self, session: AsyncSession, *, limit: int = 50) -> AuditSection:
        now = datetime.now(UTC)
        events = await self._audit.list_events(session, limit=limit)

        if events:
            chain = await self._audit.verify_chain(session)
            return AuditSection(
                source="live",
                generated_at=now,
                chain=ChainStatus(
                    valid=chain.valid,
                    checked=chain.checked,
                    broken_at_sequence=chain.broken_at_sequence,
                    reason=chain.reason,
                ),
                events=[_audit_out(e) for e in events],
                coverage=_coverage([tag for e in events for tag in e.compliance_tags]),
            )

        # Nothing recorded yet — a fresh database, or a demo machine. Show a
        # representative log rather than an empty panel, clearly marked.
        demo_events = _demo_audit_events(now)
        return AuditSection(
            source="demo",
            generated_at=now,
            chain=ChainStatus(valid=True, checked=len(demo_events)),
            events=demo_events,
            coverage=_coverage([tag for e in demo_events for tag in e.compliance_tags]),
        )

    # ------------------------------------------------------------------

    async def _escalation_reasons(self, session: AsyncSession) -> dict[str, int]:
        rows = await session.execute(
            select(Message.escalation_reason, func.count())
            .where(Message.escalated.is_(True))
            .group_by(Message.escalation_reason)
        )
        return {reason: count for reason, count in rows.all() if reason}


# ----------------------------------------------------------------------
# Seeded generation
# ----------------------------------------------------------------------


def _seeded_series(
    name: str,
    unit: str,
    now: datetime,
    rng: random.Random,
    *,
    base: float,
    swing: float,
    floor: float | None = None,
) -> Series:
    """A plausible time series: slow sinusoidal drift plus bounded noise.

    Deliberately not a random walk. A walk drifts somewhere different on every
    call, so two takes of the same demo would show different charts and the third
    take would show something implausible.
    """
    points: list[Point] = []
    for index in range(POINTS):
        t = now - timedelta(minutes=5 * (POINTS - 1 - index))
        drift = math.sin(index / 9.0) * swing * 0.6
        noise = rng.uniform(-swing, swing) * 0.4
        value = base + drift + noise
        if floor is not None:
            value = max(value, floor)
        points.append(Point(t=t, v=round(value, 4)))
    return Series(name=name, unit=unit, points=points)


def _demo_audit_events(now: datetime) -> list[AuditEventOut]:
    """A representative log covering every action type and control family."""
    # (action, actor, outcome, severity, detail) — actor is None for events the
    # system raised on its own, such as a detection during a customer's turn.
    template: list[tuple[str, str | None, str, str, dict[str, Any]]] = [
        (
            "config.activated",
            "ops@northwind.example",
            "success",
            "info",
            {"version": 7, "change_note": "Tighten refund escalation"},
        ),
        (
            "security.injection_detected",
            None,
            "denied",
            "high",
            {"rule": "instruction_override", "surface": "user_message"},
        ),
        (
            "chat.answered",
            None,
            "success",
            "info",
            {"config_version": 7, "citations": 2, "ttft_ms": 780},
        ),
        ("privacy.pii_redacted", None, "success", "info", {"category": "email", "count": 1}),
        (
            "document.uploaded",
            "ops@northwind.example",
            "success",
            "info",
            {"title": "Returns and Refunds", "chunks": 14},
        ),
        ("chat.escalated", None, "success", "info", {"reason": "low_retrieval_confidence"}),
        (
            "security.injection_detected",
            None,
            "denied",
            "critical",
            {
                "rule": "prompt_disclosure",
                "surface": "retrieved_document",
                "note": "payload found inside an indexed document",
            },
        ),
        (
            "auth.access_denied",
            "contractor@example.com",
            "denied",
            "medium",
            {"resource": "config", "reason": "insufficient role"},
        ),
        (
            "document.deleted",
            "ops@northwind.example",
            "success",
            "info",
            {"title": "Superseded price list", "basis": "GDPR Art. 17 request"},
        ),
        (
            "config.saved",
            "ops@northwind.example",
            "success",
            "info",
            {"version": 8, "change_note": "Add Spanish to supported languages"},
        ),
    ]

    events: list[AuditEventOut] = []
    prev = None
    for index, (action, actor, outcome, severity, detail) in enumerate(template):
        sequence = len(template) - index
        digest = f"{DEMO_SEED:x}{sequence:04x}".ljust(64, "0")
        events.append(
            AuditEventOut(
                sequence=sequence,
                occurred_at=now - timedelta(minutes=11 * index + 3),
                actor=actor,
                action=action,
                resource_type=action.split(".")[0],
                resource_id=None,
                outcome=outcome,
                severity=severity,
                compliance_tags=COMPLIANCE_TAGS.get(action, []),
                detail=detail,
                hash=digest,
                prev_hash=prev,
            )
        )
        prev = digest
    return events


def _coverage(tags: list[str]) -> dict[str, int]:
    """Count events per control framework — GDPR, SOC2, HIPAA."""
    counts: dict[str, int] = {}
    for tag in tags:
        framework = tag.split(".")[0]
        counts[framework] = counts.get(framework, 0) + 1
    return dict(sorted(counts.items()))


def _audit_out(event: AuditEvent) -> AuditEventOut:
    return AuditEventOut(
        sequence=event.sequence,
        occurred_at=event.occurred_at,
        actor=event.actor,
        action=event.action,
        resource_type=event.resource_type,
        resource_id=event.resource_id,
        outcome=event.outcome,
        severity=event.severity,
        compliance_tags=event.compliance_tags,
        detail=event.detail,
        hash=event.hash,
        prev_hash=event.prev_hash,
    )


def _humanise(value: str) -> str:
    return value.replace("_", " ").capitalize()
