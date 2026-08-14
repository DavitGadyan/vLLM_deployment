# Model compression pipeline

Turns `Qwen/Qwen2.5-7B-Instruct` into an INT4 `compressed-tensors` checkpoint
that vLLM serves directly, and refuses to let a damaged artifact reach
production.

## Why W4A16

| | bf16 | **W4A16 (shipped)** | FP8 W8A8 |
|---|---|---|---|
| Weights | ~15.2 GB | **~5.5 GB** | ~8.0 GB |
| KV cache left on a 24 GB L4 | — (does not fit) | **~16 GB** | ~13 GB |
| Minimum GPU | A100 40 GB | **L4 24 GB** | L40S / H100 |

The memory freed by 4-bit weights is not the point in itself — it becomes KV
cache, and KV cache is what determines how many conversations vLLM can keep in
flight simultaneously. On an L4 that difference is roughly 35 concurrent
8K-context sequences versus not fitting at all.

On Ada (L4, `sm_89`) `compressed-tensors` W4A16 dispatches to Marlin kernels, so
the dequantization cost stays small at the batch sizes we serve.

## Running it

```bash
# 1. Build calibration data. Point --local-dir at your own policy docs if you
#    have them — those tokens appear in every production prompt, so calibrating
#    on them is the highest-leverage thing you can do here.
make calibration CALIB_SAMPLES=512
#    or: python calibration/build_dataset.py --samples 512 --local-dir ../docs/policies

# 2. Quantize (needs a CUDA GPU; ~30-60 min for a 7B on a single L4/A10)
make quantize

# 3. Gate it
make evaluate
```

The first `make evaluate` has no FP16 baseline to compare against. Create one
once — it is slow, so it is cached to `baseline/fp16.json` and reused:

```bash
cd model && python evaluate.py \
  --candidate output/qwen2.5-7b-instruct-w4a16 \
  --baseline-id Qwen/Qwen2.5-7B-Instruct
```

For fast iteration while tuning behaviour, skip the academic half:

```bash
cd model && python evaluate.py --candidate output/qwen2.5-7b-instruct-w4a16 --skip-academic
```

## The quality gate

`evaluate.py` measures two different things because they fail differently.

**Academic benchmarks** (`ifeval`, `arc_challenge`, `gsm8k`) catch general
capability damage from quantization, and are gated as a *delta* against FP16.
`ifeval` gets the tightest bound (1.5 points) because instruction-following is
what actually predicts whether the model will respect a company policy.

**The support behaviour suite** (`data/support_eval.jsonl`) is gated on
*absolute* floors, because some failures are unshippable regardless of what the
baseline did. It covers three behaviours:

- **grounding** — answers come from the supplied policy text, including when the
  correct answer is "no".
- **escalation** — when the context lacks the answer (pricing, account-specific
  billing, legal), the model emits `[[ESCALATE]]` instead of inventing facts.
  The backend turns that sentinel into a human handoff.
- **safety** — instructions embedded *inside* retrieved documents are treated as
  data, not commands. This is a real attack surface once customers can upload
  documents, so it is tested rather than assumed.

Scoring is assertion-based, not LLM-judged, and generation is greedy. A gate
that blocks releases has to give the same answer twice.

## Pruning (opt-in)

`recipes/w4a16_sparse24.yaml` adds SparseGPT 2:4 semi-structured sparsity under
the INT4 quantization.

```bash
make quantize-sparse
```

Be aware of what you are signing up for: one-shot 2:4 on a 7B reliably costs
real quality, and the losses land exactly where a support assistant can least
afford them — instruction following and faithfulness to retrieved text. Expect
the gate to fail, and plan on a recovery finetune (SFT with the sparsity mask
held fixed) before re-evaluating. The recipe is here so that path is ready when
you want to spend that budget; it is not the default for good reason.

## Artifact provenance

Every run writes `compression_manifest.json` next to the weights recording the
base model, the full recipe body, calibration source and sample count, and
artifact size. Quantized checkpoints are opaque — six months later this file is
the only thing that tells you how the weights on disk came to exist.
