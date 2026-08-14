import { sleep } from "k6";

import { chat, describeRun, pickQuestion } from "./lib/chat.js";

/**
 * Burst test: does autoscaling actually work?
 *
 * A sudden jump from near-idle to heavy load, held long enough for the HPA to
 * notice, add replicas, and for those replicas to become ready. This is the
 * scenario the queue-depth HPA exists for, and the one a CPU-target HPA fails
 * silently.
 *
 * Run:
 *   k6 run load-test/k6/burst.js
 *
 * What to watch, in order:
 *   1. vllm:num_requests_waiting spikes within seconds of the burst.
 *   2. `kubectl get hpa support-vllm -w` — the metric must show a number, not
 *      <unknown>. <unknown> means prometheus-adapter is not wired up and no
 *      scaling will happen at all.
 *   3. New pods appear and reach Ready. This takes minutes: image pull, weight
 *      load, CUDA graph capture.
 *   4. p95 TTFT recovers once they are serving.
 *
 * The gap between (1) and (4) is the real cost of a cold GPU replica, and it is
 * why prod keeps a warm minimum rather than scaling to zero.
 */

export const options = {
  scenarios: {
    burst: {
      executor: "ramping-arrival-rate",
      startRate: 2,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 300,
      stages: [
        { duration: "2m", target: 2 },   // quiet baseline
        { duration: "10s", target: 30 }, // the burst
        { duration: "8m", target: 30 },  // hold — long enough for pods to arrive
        { duration: "2m", target: 2 },   // recovery
      ],
    },
  },

  thresholds: {
    // Deliberately looser than steady.js: the burst is expected to degrade
    // latency until capacity arrives. The test is whether it recovers, not
    // whether it never degrades.
    "ttft_ms{}": ["p(95)<15000"],
    chat_success: ["rate>0.95"],
  },

  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup() {
  console.log(describeRun("Burst — autoscaling validation"));
}

export default function () {
  chat(pickQuestion());
  sleep(1);
}
