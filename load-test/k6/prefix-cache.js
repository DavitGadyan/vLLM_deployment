import { sleep } from "k6";

import { BASE_URL, cachedPromptTokens, chat, promptTokens, ttft } from "./lib/chat.js";

/**
 * Quantify what the prefix cache is actually worth.
 *
 * The whole prompt-assembly design — stable system prompt first, retrieved
 * context after, nothing per-request in the prefix — exists to make vLLM's
 * prefix cache hit. This measures whether that pays off, rather than assuming
 * it does.
 *
 * Two phases against the same deployment:
 *
 *   cold  — a single request after the cache has been left to age out, or
 *           immediately after a config save invalidated the shared prefix
 *   warm  — sustained traffic sharing the same compiled system prompt
 *
 * The interesting output is `cached_prompt_tokens`, reported by vLLM per
 * request. In the warm phase it should approach the compiled system prompt
 * length (visible as support_prompt_prefix_tokens on the product dashboard).
 * If it stays near zero while the prompt is unchanged, something per-request
 * has leaked into the system message and the ordering contract in
 * backend/app/services/assembler.py has been broken.
 *
 * Run:
 *   k6 run load-test/k6/prefix-cache.js
 *
 * To measure a genuine cold start, restart the vLLM pods first:
 *   kubectl rollout restart deploy/support-vllm -n support
 */

export const options = {
  scenarios: {
    cold: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 5,
      exec: "cold",
      startTime: "0s",
      tags: { phase: "cold" },
    },
    warm: {
      executor: "constant-vus",
      vus: 8,
      duration: "4m",
      exec: "warm",
      // Starts after the cold phase has populated the cache.
      startTime: "45s",
      tags: { phase: "warm" },
    },
  },

  thresholds: {
    // Reported per phase so the two are directly comparable in the summary.
    "ttft_ms{phase:cold}": ["p(95)<10000"],
    "ttft_ms{phase:warm}": ["p(95)<3000"],
    "cached_prompt_tokens{phase:warm}": ["avg>100"],
  },

  summaryTrendStats: ["avg", "med", "p(95)", "max"],
};

// Deliberately varied so each cold request diverges early and shares little.
const COLD_QUESTIONS = [
  "What is the process for an international warranty claim on a discontinued model?",
  "If my order is split across two shipments, when does the refund window start?",
  "Does the assessment fee apply if the repair turns out to be covered?",
  "How does the grace period interact with a pending refund?",
  "What happens to a warranty if I sell the device?",
];

// A single repeated question maximises prefix sharing, which isolates the
// cache effect from question-to-question variation.
const WARM_QUESTION = "How long do I have to return something?";

export function cold() {
  const question = COLD_QUESTIONS[__ITER % COLD_QUESTIONS.length];
  chat(question);
  sleep(5);
}

export function warm() {
  chat(WARM_QUESTION);
  sleep(1);
}

export function handleSummary(data) {
  const metric = (name) => data.metrics[name]?.values ?? {};

  const cold = metric("ttft_ms{phase:cold}");
  const warm = metric("ttft_ms{phase:warm}");
  const cached = metric("cached_prompt_tokens");
  const prompt = metric("prompt_tokens");

  const cachedShare =
    prompt.avg > 0 ? ((cached.avg || 0) / prompt.avg) * 100 : 0;

  const report = `
Prefix cache measurement — ${BASE_URL}
${"=".repeat(60)}

  TTFT p95, cold prefix : ${fmt(cold["p(95)"])} ms
  TTFT p95, warm prefix : ${fmt(warm["p(95)"])} ms
  Improvement           : ${
    cold["p(95)"] && warm["p(95)"]
      ? `${(((cold["p(95)"] - warm["p(95)"]) / cold["p(95)"]) * 100).toFixed(1)}%`
      : "n/a"
  }

  Avg prompt tokens     : ${fmt(prompt.avg)}
  Avg cached tokens     : ${fmt(cached.avg)}
  Prefill skipped       : ${cachedShare.toFixed(1)}%

Cached tokens near zero on a warm cache means the shared prefix is being
invalidated every request — check that nothing per-request (a timestamp, a
customer name, a session id) has entered the system message.
`;

  return {
    stdout: report,
    "load-test/results/prefix-cache.json": JSON.stringify(data, null, 2),
  };
}

function fmt(value) {
  return value == null ? "n/a" : value.toFixed(0);
}
