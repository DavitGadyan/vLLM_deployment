# Load testing

Three scenarios, each answering a different question. Run them against a real
deployment — the numbers in the README should be measured, not estimated.

```bash
make load-test            # steady.js       — find the throughput/latency knee
make load-test-burst      # burst.js        — does autoscaling actually work?
make bench-prefix-cache   # prefix-cache.js — what is the prefix cache worth?

BASE_URL=https://support.example.com k6 run load-test/k6/steady.js
```

## Measure TTFT, not request duration

Total request duration cannot distinguish between an assistant that starts
answering in 400ms and finishes in 8s, and one that pauses 4s and then dumps
the whole answer at once. Users experience those as "responsive" and "broken"
respectively. Every scenario therefore reports `ttft_ms` as the primary metric
and treats total duration as secondary.

## What each scenario is for

**`steady.js`** ramps concurrency in steps and holds each level long enough for
queueing to settle. Watch `vllm:num_requests_waiting` on the serving dashboard:
the level at which it starts rising is the real capacity of a replica. Set
`--max-num-seqs` from that measurement, not from the arithmetic in
`serving/entrypoint.sh` — the arithmetic gives you a starting point, the load
test gives you the answer.

**`burst.js`** jumps from idle to heavy load and holds. This is the scenario the
queue-depth HPA exists for. Watch, in order: queue depth spikes, the HPA metric
shows a number (not `<unknown>`), new pods appear, pods become Ready, p95 TTFT
recovers. The gap between the spike and the recovery is the true cost of a cold
GPU replica — it is why production keeps a warm minimum instead of scaling to
zero.

**`prefix-cache.js`** compares cold and warm phases to quantify what the shared
system prompt is saving. `cached_prompt_tokens` in the warm phase should
approach the compiled prompt length. If it does not, something per-request has
leaked into the system message and the ordering contract in
`backend/app/services/assembler.py` is broken.

## Tuning procedure

Run these in order. Each one answers a question the next depends on.

1. **`--max-num-seqs`.** Run `steady.js`. Find where p95 TTFT starts climbing
   steeply and where `vllm:num_preemptions_total` first becomes non-zero. Set
   the value just below the preemption point — preemption means the GPU is
   redoing work it already did.

2. **`--kv-cache-dtype`.** Run `steady.js` twice, once with `auto` and once with
   `fp8`, and compare p95 TTFT at the same concurrency. fp8 roughly doubles KV
   capacity but can drop onto a slower attention kernel. Pin whichever wins on
   your hardware; do not assume.

3. **`--max-num-batched-tokens`.** Raise it if prefill is starving decode
   (inter-token latency spiky while TTFT is fine); lower it if a single long
   prompt is visibly stalling everyone else.

4. **HPA `targetQueueDepth`.** Run `burst.js`. If replicas arrive after latency
   has already degraded badly, lower the target. If they arrive during noise
   that would have passed on its own, raise it.

Re-run after any change to the compiled prompt, `retrieval_top_k`, or
`max_model_len` — all three change prompt length, and prompt length is what
prefill cost scales with.

## Interpreting results honestly

- **Discard the warm-up.** The first requests after a cold start pay for CUDA
  graph capture and an empty prefix cache. `steady.js` ramps through a warm-up
  stage for exactly this reason.

- **A single repeated question overstates the prefix cache.** `steady.js` and
  `burst.js` use a rotating question set for this reason;
  `prefix-cache.js` deliberately repeats one to isolate the effect.

- **Think time matters.** Back-to-back requests with no gap produce a load
  pattern no real conversation generates and understate how well continuous
  batching interleaves prefill with decode.

- **Compare against the dashboards.** k6 measures from the client, through the
  load balancer and the Next.js proxy. vLLM's own
  `vllm:time_to_first_token_seconds` measures from the engine. A large gap
  between the two is proxy buffering, not model latency — check that
  `X-Accel-Buffering: no` is surviving the whole path.

## Results

Record measured numbers here as you take them, with the configuration they came
from. An untethered latency figure is not useful six months later.

| Date | Config | Concurrency | p95 TTFT | Tokens/s | Notes |
|------|--------|-------------|----------|----------|-------|
| _pending first run_ | | | | | |
