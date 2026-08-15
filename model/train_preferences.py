"""Fine-tune on collected preferences with DPO over a LoRA adapter.

The training half of the improvement loop. Its input is the file
`GET /v1/feedback/export` produces — JSON Lines of `{prompt, chosen, rejected}` —
and its output is a LoRA adapter that must then pass `evaluate.py` before it can
serve anything.

**This is run deliberately, not on a schedule.** Nothing triggers it
automatically, and that is the design: a fine-tune that fires whenever enough
preferences accumulate is a way to ship a regression that nobody read the data
for. Someone looks at the pairs, decides they represent a real pattern, and runs
this.

Why DPO rather than classic RLHF (reward model + PPO): DPO optimises directly on
preference pairs with no separate reward model and no policy-gradient loop. That
is dramatically less machinery to get wrong for the same signal, and on a dataset
of a few thousand support preferences the reward model would be the weakest part
of the pipeline anyway.

Why LoRA rather than a full fine-tune:

  * An adapter is a few hundred MB against ~15 GB of weights, so it trains on the
    same class of GPU that serves, in hours rather than days.
  * vLLM loads LoRA adapters at runtime, so promoting one is loading a file and
    rolling back is unloading it — no reconverting, no requantizing, no redeploy.
  * It constrains how far the model can move. Full fine-tuning on a narrow
    preference set is an efficient way to make a model worse at everything else,
    and the low-rank constraint is a meaningful guard against that.

Usage:

    # 1. Export the preferences the console collected
    curl -s "$BACKEND/v1/feedback/export?limit=5000" > preferences.jsonl

    # 2. Read them. Genuinely — this is the step that catches a poisoned or
    #    lopsided set before it becomes a model.

    # 3. Train
    python train_preferences.py \\
        --base output/qwen2.5-7b-instruct-w4a16 \\
        --preferences preferences.jsonl \\
        --output output/adapters/support-dpo-v3

    # 4. Gate it. Serve the candidate, then:
    python evaluate.py --candidate output/adapters/support-dpo-v3 \\
        --baseline-file baseline/production.json \\
        --benchmark-target http://localhost:8000
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Below this, DPO overfits the handful of examples it has and the result is a
# model with strong opinions about six questions. Not a hard stop — an operator
# can override — but the default is to refuse.
MIN_PAIRS = 200


def load_pairs(path: Path) -> list[dict[str, str]]:
    """Read the export, keeping only rows usable as training examples."""
    pairs: list[dict[str, str]] = []
    skipped = 0

    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record: dict[str, Any] = json.loads(line)
        prompt = (record.get("prompt") or "").strip()
        chosen = (record.get("chosen") or "").strip()
        rejected = (record.get("rejected") or "").strip()

        # A pair whose sides are identical carries no gradient — it says the two
        # answers were the same, not that one was better. Training on it is
        # noise, and enough of it drowns the real signal.
        if not (prompt and chosen and rejected) or chosen == rejected:
            skipped += 1
            continue

        pairs.append({"prompt": prompt, "chosen": chosen, "rejected": rejected})

    if skipped:
        print(f"skipped {skipped} unusable rows (incomplete or identical sides)")
    return pairs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="Model to adapt")
    parser.add_argument("--preferences", type=Path, required=True, help="JSONL from the export")
    parser.add_argument("--output", type=Path, required=True, help="Where to write the adapter")
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--learning-rate", type=float, default=5e-6)
    parser.add_argument(
        "--beta",
        type=float,
        default=0.1,
        help=(
            "How hard DPO is allowed to pull away from the reference model. "
            "Lower moves further and forgets more; 0.1 is the usual starting point."
        ),
    )
    parser.add_argument("--lora-rank", type=int, default=16)
    parser.add_argument(
        "--min-pairs",
        type=int,
        default=MIN_PAIRS,
        help=f"Refuse to train on fewer than this many pairs (default: {MIN_PAIRS})",
    )
    args = parser.parse_args()

    pairs = load_pairs(args.preferences)
    print(f"loaded {len(pairs)} preference pairs from {args.preferences}")

    if len(pairs) < args.min_pairs:
        print(
            f"\nREFUSING TO TRAIN: {len(pairs)} pairs is below the {args.min_pairs} floor.\n"
            "DPO on a set this small produces a model with strong opinions about a "
            "handful of questions and worse behaviour everywhere else. Collect more, "
            "or pass --min-pairs if you know why this is an exception.",
            file=sys.stderr,
        )
        return 1

    # Imported here rather than at module scope so `--help` works on a machine
    # without a GPU stack installed.
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import DPOConfig, DPOTrainer

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    model = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype="auto", device_map="auto")

    trainer = DPOTrainer(
        model=model,
        # No explicit reference model: with LoRA, disabling the adapter recovers
        # the base model, so the reference is the same weights with the adapter
        # switched off. Halves the memory a DPO run needs.
        ref_model=None,
        args=DPOConfig(
            output_dir=str(args.output),
            num_train_epochs=args.epochs,
            learning_rate=args.learning_rate,
            beta=args.beta,
            per_device_train_batch_size=2,
            gradient_accumulation_steps=8,
            gradient_checkpointing=True,
            bf16=True,
            logging_steps=10,
            save_strategy="epoch",
            report_to=[],
        ),
        train_dataset=Dataset.from_list(pairs),
        processing_class=tokenizer,
        peft_config=LoraConfig(
            r=args.lora_rank,
            lora_alpha=args.lora_rank * 2,
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
            # Attention projections only. Adapting the MLP as well moves the
            # model further per step and forgets more of what it already knew,
            # which is the failure mode this whole setup is guarding against.
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        ),
    )

    trainer.train()
    trainer.save_model(str(args.output))

    # Provenance travels with the adapter. Six months later the only question
    # that matters about a model in production is what it was trained on.
    (args.output / "training_manifest.json").write_text(
        json.dumps(
            {
                "base_model": args.base,
                "pairs": len(pairs),
                "source": str(args.preferences),
                "epochs": args.epochs,
                "learning_rate": args.learning_rate,
                "beta": args.beta,
                "lora_rank": args.lora_rank,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"\nadapter written to {args.output}")
    print(
        "\nNOT YET SHIPPABLE. Run evaluate.py against it, with --benchmark-target "
        "pointed at a server hosting it, and promote only if the gate passes."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
