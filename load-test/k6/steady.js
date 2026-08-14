import { sleep } from "k6";

import { chat, describeRun, pickQuestion } from "./lib/chat.js";

/**
 * Steady-state load: find the throughput/latency knee.
 *
 * Ramps concurrency in steps and holds each level long enough for queueing to
 * stabilise. The point is to find where p95 TTFT starts climbing steeply —
 * that inflection is the real capacity of a replica, and it is what
 * `--max-num-seqs` should be tuned against.
 *
 * Run:
 *   k6 run load-test/k6/steady.js
 *   BASE_URL=https://support.example.com k6 run load-test/k6/steady.js
 *
 * Watch the serving dashboard while this runs. The moment
 * vllm:num_requests_waiting starts rising is the moment the replica is full;
 * everything after that is queueing, not throughput.
 */

export const options = {
  scenarios: {
    steady: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        // Warm-up. The first requests after a cold start pay for CUDA graph
        // capture and an empty prefix cache; including them would skew every
        // percentile that follows.
        { duration: "1m", target: 4 },

        { duration: "3m", target: 8 },
        { duration: "3m", target: 16 },
        { duration: "3m", target: 32 },
        { duration: "3m", target: 48 },
        { duration: "2m", target: 0 },
      ],
      gracefulRampDown: "60s",
    },
  },

  thresholds: {
    // A support assistant that takes over 3s to start answering reads as
    // broken, regardless of how fast it finishes.
    "ttft_ms{}": ["p(95)<3000"],
    chat_success: ["rate>0.99"],
    stream_errors: ["count<10"],
  },

  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup() {
  console.log(describeRun("Steady-state ramp"));
}

export default function () {
  chat(pickQuestion());

  // Think time. Back-to-back requests with zero gap produce a load pattern no
  // real conversation generates, and understate how well the scheduler
  // interleaves prefill with decode.
  sleep(Math.random() * 3 + 1);
}
