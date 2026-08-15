#!/usr/bin/env bash
#
# vLLM launch wrapper.
#
# Every tunable lives here rather than being scattered across Helm values and
# compose files, so the serving configuration is reviewable as one artifact.
# The defaults are sized for a single 24 GB L4 running Qwen2.5-7B-Instruct at
# W4A16; see the KV-cache arithmetic below before changing them.

set -euo pipefail

MODEL_PATH="${MODEL_PATH:-/models/qwen2.5-7b-instruct-w4a16}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-qwen-support}"
PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"

# --- Context and memory ----------------------------------------------------
# 8192 covers a compiled system prompt (~600 tok) + 5 retrieved chunks
# (~2500 tok) + a long conversation + a 1024-token answer, with headroom.
# Raising it is not free: max_model_len bounds the KV cache allocation per
# sequence, so doubling it roughly halves how many conversations fit at once.
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"

# 0.90 leaves ~2.4 GB on a 24 GB card for CUDA context, fragmentation and the
# activation peak. Going to 0.95 buys ~1.2 GB of KV cache and risks OOM under a
# burst of long prefills — not a trade worth making on a user-facing path.
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.90}"

# --- Batching --------------------------------------------------------------
# KV cache arithmetic for Qwen2.5-7B (28 layers, 4 KV heads via GQA, head_dim 128):
#
#   per token = 2 (K+V) x 4 heads x 128 dim x 2 bytes x 28 layers = 57,344 B = 56 KiB
#
# On a 24 GB L4: 24.0 - 5.5 (W4A16 weights) - ~2.4 (reserved) = ~16 GB for KV
#   16 GiB / 56 KiB = ~292,000 tokens
#   at 8192 tokens each  -> ~35 fully-extended concurrent sequences
#   at a realistic ~4000 -> ~73
#
# Real support conversations are nowhere near max length, so 64 is a sensible
# starting ceiling: high enough to keep the GPU saturated, low enough that vLLM
# rarely has to preempt. Watch vllm:num_preemptions_total — sustained preemption
# means this is set above what the KV cache can actually hold.
MAX_NUM_SEQS="${MAX_NUM_SEQS:-64}"

# Tokens per scheduler step. With chunked prefill on, this caps how much prefill
# work can crowd out decode in a single iteration. Matching it to
# MAX_MODEL_LEN keeps a single long prompt from monopolising a step and spiking
# inter-token latency for everyone already streaming.
MAX_NUM_BATCHED_TOKENS="${MAX_NUM_BATCHED_TOKENS:-8192}"

# --- PagedAttention block size ---------------------------------------------
# PagedAttention is not a flag — it is how vLLM stores KV at all. Instead of one
# contiguous buffer per sequence sized for the worst case, KV lives in fixed-size
# blocks drawn from a shared pool, exactly like virtual memory pages. That is
# what removes the internal fragmentation that otherwise wastes most of the KV
# cache, and it is the precondition for both prefix caching (blocks are shared
# between sequences by reference) and continuous batching (sequences join and
# leave without compacting anything).
#
# The block size is the one knob it exposes, and it is stated here for the same
# reason as the flags below: the tuning surface should be visible in one place.
# 16 is vLLM's default and the right default here. Smaller blocks waste less on
# the last partial block of each sequence but cost more per-block bookkeeping;
# larger blocks reduce that overhead but round every sequence up further, and on
# short support turns that rounding is pure loss. Prefix-cache hits are also
# block-aligned, so a larger block means a longer shared prefix is needed before
# anything is reused at all.
BLOCK_SIZE="${BLOCK_SIZE:-16}"

# --- KV cache dtype --------------------------------------------------------
# 'auto' (fp16) by default, deliberately.
#
# L4 is Ada (sm_89) and does support fp8 KV, which would halve the per-token
# cost above and roughly double concurrency. But fp8 KV can drop you onto a
# slower attention kernel path, and on a latency-sensitive support workload that
# can cost more p95 TTFT than the extra concurrency wins back. load-test/k6
# benchmarks both; pin whichever actually wins on your hardware rather than
# trusting the spec sheet.
KV_CACHE_DTYPE="${KV_CACHE_DTYPE:-auto}"

# --- Observability ---------------------------------------------------------
# Request bodies contain customer PII. Logging them at engine level would spray
# it across cluster logs, outside the redaction the backend applies.
DISABLE_LOG_REQUESTS="${DISABLE_LOG_REQUESTS:-true}"

if [[ ! -d "${MODEL_PATH}" ]]; then
  echo "FATAL: model path ${MODEL_PATH} does not exist." >&2
  echo "Locally: run 'make quantize' first (it writes model/output/…)." >&2
  echo "In-cluster: the model initContainer did not stage weights." >&2
  exit 1
fi

if [[ -f "${MODEL_PATH}/compression_manifest.json" ]]; then
  echo "--- serving artifact ---"
  cat "${MODEL_PATH}/compression_manifest.json"
  echo "------------------------"
else
  echo "WARNING: no compression_manifest.json — cannot verify artifact provenance." >&2
fi

args=(
  --model "${MODEL_PATH}"
  --served-model-name "${SERVED_MODEL_NAME}"
  --host "${HOST}"
  --port "${PORT}"
  --quantization compressed-tensors
  --max-model-len "${MAX_MODEL_LEN}"
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION}"
  --max-num-seqs "${MAX_NUM_SEQS}"
  --max-num-batched-tokens "${MAX_NUM_BATCHED_TOKENS}"
  --kv-cache-dtype "${KV_CACHE_DTYPE}"
  # PagedAttention's page size. Always active; see BLOCK_SIZE above.
  --block-size "${BLOCK_SIZE}"
  # Stated explicitly even though the V1 engine defaults them on, so the full
  # tuning surface is visible in one place.
  --enable-prefix-caching
  --enable-chunked-prefill
)

if [[ "${DISABLE_LOG_REQUESTS}" == "true" ]]; then
  args+=(--disable-log-requests)
fi

# Optional bearer token. The service is cluster-internal and NetworkPolicy-
# restricted to backend pods, so this is defence in depth, not the only control.
if [[ -n "${VLLM_API_KEY:-}" ]]; then
  args+=(--api-key "${VLLM_API_KEY}")
fi

if [[ -n "${EXTRA_VLLM_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  args+=(${EXTRA_VLLM_ARGS})
fi

echo "starting vLLM: ${args[*]}"
exec vllm serve "${args[@]}"
