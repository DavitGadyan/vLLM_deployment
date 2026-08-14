"""Compress the base model to INT4 W4A16 (optionally with 2:4 sparsity).

Produces a ``compressed-tensors`` checkpoint that vLLM loads directly with
``--quantization compressed-tensors``.

    python compress.py \
        --model Qwen/Qwen2.5-7B-Instruct \
        --recipe recipes/w4a16.yaml \
        --calibration data/calibration.jsonl \
        --output output/qwen2.5-7b-instruct-w4a16

Requires a CUDA GPU. A 7B at W4A16 calibrates comfortably on a single 24 GB
card; GPTQ is sequential over layers, so peak memory tracks the largest layer
rather than the whole model.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

try:  # llm-compressor >= 0.6 exposes oneshot at the package root
    from llmcompressor import oneshot
except ImportError:  # pragma: no cover - older layout
    from llmcompressor.transformers import oneshot  # type: ignore[no-redef]


def load_calibration(path: Path, tokenizer: Any, max_seq_length: int) -> Any:
    """Load JSONL calibration records and render them with the chat template.

    Applying the real chat template matters: the special tokens and role headers
    are a meaningful share of every production prompt, and GPTQ should see them
    with the same frequency it will at serving time.
    """
    from datasets import Dataset

    if not path.exists():
        raise SystemExit(
            f"calibration file {path} not found — run `make calibration` first"
        )

    texts: list[str] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            texts.append(
                tokenizer.apply_chat_template(
                    record["messages"], tokenize=False, add_generation_prompt=False
                )
            )

    if not texts:
        raise SystemExit(f"calibration file {path} is empty")

    ds = Dataset.from_dict({"text": texts})

    def _tokenize(batch: dict[str, list[str]]) -> dict[str, Any]:
        return tokenizer(
            batch["text"],
            padding=False,
            truncation=True,
            max_length=max_seq_length,
            add_special_tokens=False,
        )

    return ds.map(_tokenize, batched=True, remove_columns=["text"])


def write_manifest(output: Path, meta: dict[str, Any]) -> None:
    """Record how this artifact was produced.

    A quantized checkpoint is opaque — six months later nobody can tell which
    recipe or calibration set produced it. The manifest travels with the weights
    and is what the eval gate and the serving image report.
    """
    (output / "compression_manifest.json").write_text(
        json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def directory_size_gb(path: Path) -> float:
    total = sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
    return total / (1024**3)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Base model id or local path")
    parser.add_argument("--recipe", type=Path, default=Path("recipes/w4a16.yaml"))
    parser.add_argument("--calibration", type=Path, default=Path("data/calibration.jsonl"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-seq-length", type=int, default=2048)
    parser.add_argument("--num-calibration-samples", type=int, default=512)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    if not torch.cuda.is_available():
        print(
            "error: no CUDA device visible. GPTQ calibration needs a GPU — run "
            "this on your GPU box, not on a laptop.",
            file=sys.stderr,
        )
        return 2

    if not args.recipe.exists():
        print(f"error: recipe {args.recipe} not found", file=sys.stderr)
        return 2

    if args.output.exists():
        if not args.overwrite:
            print(
                f"error: {args.output} already exists (pass --overwrite to replace)",
                file=sys.stderr,
            )
            return 2
        shutil.rmtree(args.output)

    print(f"loading base model: {args.model}")
    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype="auto",
        device_map="auto",
        trust_remote_code=True,
    )

    print(f"loading calibration data: {args.calibration}")
    dataset = load_calibration(args.calibration, tokenizer, args.max_seq_length)
    n_samples = min(args.num_calibration_samples, len(dataset))
    print(f"calibrating on {n_samples} samples @ {args.max_seq_length} tokens")

    started = time.time()
    oneshot(
        model=model,
        dataset=dataset,
        recipe=str(args.recipe),
        max_seq_length=args.max_seq_length,
        num_calibration_samples=n_samples,
        output_dir=str(args.output),
    )
    elapsed = time.time() - started

    tokenizer.save_pretrained(args.output)

    size_gb = directory_size_gb(args.output)
    write_manifest(
        args.output,
        {
            "base_model": args.model,
            "recipe": args.recipe.name,
            "recipe_body": args.recipe.read_text(encoding="utf-8"),
            "calibration_file": str(args.calibration),
            "calibration_samples": n_samples,
            "max_seq_length": args.max_seq_length,
            "artifact_size_gb": round(size_gb, 2),
            "compression_seconds": round(elapsed, 1),
            "torch_version": torch.__version__,
        },
    )

    print(f"\ncompressed in {elapsed / 60:.1f} min")
    print(f"artifact: {args.output} ({size_gb:.2f} GB)")
    print("\nNext: `make evaluate` — the artifact must pass the quality gate before it ships.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
