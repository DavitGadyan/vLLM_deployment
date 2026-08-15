"""Prometheus instrumentation.

vLLM already exports the engine-level truth (queue depth, KV-cache utilisation,
per-token timing). This module deliberately does not duplicate that. It measures
what only the gateway can see: how long a *user* waited end to end, whether
retrieval actually found anything, and how often the assistant handed off to a
human — the numbers that say whether the product works, as opposed to whether
the GPU is busy.

Histogram buckets are chosen against a support-chat latency budget, not the
client-library defaults, which are far too coarse to see a p95 TTFT regression.
"""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

# --- Latency ---------------------------------------------------------------

# Time to first token as the user experiences it: includes retrieval, prompt
# assembly and queueing, not just the engine's own prefill.
chat_ttft_seconds = Histogram(
    "support_chat_ttft_seconds",
    "Time from request arrival to first streamed token, including retrieval",
    buckets=(0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0),
)

chat_duration_seconds = Histogram(
    "support_chat_duration_seconds",
    "Total time to complete a chat response",
    buckets=(0.5, 1.0, 2.0, 3.0, 5.0, 8.0, 12.0, 20.0, 30.0, 60.0),
)

retrieval_duration_seconds = Histogram(
    "support_retrieval_duration_seconds",
    "Embedding + pgvector search latency",
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0),
)

# --- Throughput ------------------------------------------------------------

chat_requests_total = Counter(
    "support_chat_requests_total",
    "Chat requests by terminal outcome",
    ["outcome"],  # answered | escalated | client_cancelled | upstream_error
)

chat_tokens_total = Counter(
    "support_chat_tokens_total",
    "Tokens processed by the gateway",
    ["direction"],  # prompt | completion
)

# --- Product KPIs ----------------------------------------------------------
# Deflection rate is derived in Grafana as
#   answered / (answered + escalated)
# rather than being tracked here, so the definition lives in one place and can
# be changed without a redeploy.

escalations_total = Counter(
    "support_escalations_total",
    "Handoffs to a human, by what triggered them",
    ["reason"],  # model_sentinel | low_retrieval_confidence | no_documents | upstream_error
)

retrieval_top_score = Histogram(
    "support_retrieval_top_score",
    "Cosine similarity of the best-matching chunk",
    buckets=(0.0, 0.1, 0.2, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0),
)

retrieval_chunks_used = Histogram(
    "support_retrieval_chunks_used",
    "Chunks that cleared the score floor and entered the prompt",
    buckets=(0, 1, 2, 3, 4, 5, 8, 10),
)

answers_with_citations_total = Counter(
    "support_answers_with_citations_total",
    "Answers that cited at least one source chunk",
)

# --- Prompt cache ----------------------------------------------------------
# The stable prefix is what vLLM's prefix cache keys on. If this gauge moves
# often, cache hit rate on the serving side will fall — the two dashboards are
# meant to be read together.

prompt_prefix_tokens = Gauge(
    "support_prompt_prefix_tokens",
    "Token length of the compiled system prompt (the shared, cacheable prefix)",
)

prompt_total_tokens = Histogram(
    "support_prompt_total_tokens",
    "Total assembled prompt length",
    buckets=(256, 512, 1024, 2048, 3072, 4096, 6144, 8192),
)

config_activations_total = Counter(
    "support_config_activations_total",
    "Config version activations (including rollbacks)",
)

active_config_version = Gauge(
    "support_active_config_version",
    "Monotonic version number of the currently active configuration",
)

# --- Ingestion -------------------------------------------------------------

# --- Security ---------------------------------------------------------------
# The prompt compiler defends against injection; these make the defence visible.
# Without them the security dashboard could only assert that a control exists.

injection_attempts_total = Counter(
    "support_injection_attempts_total",
    "Prompt-injection patterns detected, by where they arrived and how severe",
    # surface: user_message | retrieved_document
    # A hit on retrieved_document is materially worse than one on user_message:
    # it means an indexed company document contains an injection payload.
    ["surface", "severity", "rule"],
)

pii_redactions_total = Counter(
    "support_pii_redactions_total",
    "PII values replaced before persistence, by category",
    ["category"],
)

auth_events_total = Counter(
    "support_auth_events_total",
    "Authentication and authorization outcomes",
    ["event", "outcome"],
)

audit_events_total = Counter(
    "support_audit_events_total",
    "Audit entries appended, by action and outcome",
    ["action", "outcome"],
)

documents_ingested_total = Counter(
    "support_documents_ingested_total",
    "Document ingestion attempts by outcome",
    ["status"],  # ready | failed
)

chunks_indexed_total = Counter(
    "support_chunks_indexed_total",
    "Chunks embedded and written to the vector index",
)

# --- Alignment feedback -----------------------------------------------------
# The signal the next model version is trained on. Measured here as well as
# stored, because the useful question during a rollout is a rate over time
# ("did the thumbs-down rate move after we shipped v12?"), and that is a
# time-series question rather than a database one.

feedback_total = Counter(
    "support_feedback_total",
    "Human judgements received, by kind and verdict",
    # kind: rating | preference | comment
    # verdict: up | down | a | b | none
    ["kind", "verdict"],
)

feedback_preference_wins_total = Counter(
    "support_feedback_preference_wins_total",
    "Head-to-head wins by variant, for A/B answer comparisons",
    ["variant"],
)

feedback_pending_export = Gauge(
    "support_feedback_pending_export",
    "Judgements collected but not yet consumed by a training run",
)
