"""Build the calibration set used by GPTQ/SparseGPT.

Calibration data is not a formality. GPTQ chooses quantization scales by
minimising layer-wise error *on the tokens it sees*, so calibrating on generic
web text and then serving customer-support conversations leaves accuracy on the
table. This script assembles a calibration corpus that matches what the model
will actually be asked to do:

  1. Real customer-support dialogue (the dominant share).
  2. General instruction-following, so we do not over-narrow the model.
  3. Optionally, the operator's own policy documents — the highest-value source,
     because those tokens appear in every single production prompt via the
     system prompt and retrieved context.

Records are written as JSONL with a single ``messages`` field in OpenAI chat
format; ``compress.py`` applies the model's chat template so calibration tokens
are laid out exactly as they will be at serving time.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

SUPPORT_DATASET = "bitext/Bitext-customer-support-llm-chatbot-training-dataset"
GENERAL_DATASET = "HuggingFaceH4/ultrachat_200k"

# Roughly 3:1 support-to-general. Enough general data to preserve instruction
# following, enough support data to bias the scales toward our real workload.
DEFAULT_SUPPORT_FRACTION = 0.75


def _load_support(n: int, seed: int) -> list[dict[str, Any]]:
    from datasets import load_dataset

    ds = load_dataset(SUPPORT_DATASET, split="train")
    ds = ds.shuffle(seed=seed).select(range(min(n, len(ds))))
    out = []
    for row in ds:
        instruction = (row.get("instruction") or "").strip()
        response = (row.get("response") or "").strip()
        if not instruction or not response:
            continue
        out.append(
            {
                "messages": [
                    {"role": "user", "content": instruction},
                    {"role": "assistant", "content": response},
                ],
                "source": "support",
            }
        )
    return out


def _load_general(n: int, seed: int) -> list[dict[str, Any]]:
    from datasets import load_dataset

    ds = load_dataset(GENERAL_DATASET, split="train_sft")
    ds = ds.shuffle(seed=seed).select(range(min(n, len(ds))))
    out = []
    for row in ds:
        messages = row.get("messages") or []
        # Keep the first exchange only; long multi-turn tails waste calibration
        # budget on tokens that do not resemble a support turn.
        trimmed = [
            {"role": m["role"], "content": m["content"]}
            for m in messages[:2]
            if m.get("content")
        ]
        if len(trimmed) == 2:
            out.append({"messages": trimmed, "source": "general"})
    return out


def _iter_local_files(local_dir: Path) -> Iterator[str]:
    """Yield text from the operator's own documents."""
    suffixes = {".txt", ".md", ".markdown", ".rst"}
    for path in sorted(local_dir.rglob("*")):
        if path.is_file() and path.suffix.lower() in suffixes:
            text = path.read_text(encoding="utf-8", errors="ignore").strip()
            if text:
                yield text


def _load_local(local_dir: Path, chunk_chars: int) -> list[dict[str, Any]]:
    """Turn policy documents into question-shaped calibration records.

    We wrap each chunk the same way the retriever will present it at serving
    time, so the calibration tokens include the delimiters and framing the model
    will really see.
    """
    out: list[dict[str, Any]] = []
    for text in _iter_local_files(local_dir):
        for start in range(0, len(text), chunk_chars):
            chunk = text[start : start + chunk_chars].strip()
            if len(chunk) < 200:
                continue
            out.append(
                {
                    "messages": [
                        {
                            "role": "user",
                            "content": (
                                "Use the following support documentation to answer "
                                f"customer questions.\n\n<context>\n{chunk}\n</context>\n\n"
                                "Summarise the policy above for a customer."
                            ),
                        },
                        {"role": "assistant", "content": chunk[:600]},
                    ],
                    "source": "local",
                }
            )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=512, help="Total calibration records")
    parser.add_argument("--out", type=Path, default=Path("data/calibration.jsonl"))
    parser.add_argument("--seed", type=int, default=1337)
    parser.add_argument(
        "--support-fraction",
        type=float,
        default=DEFAULT_SUPPORT_FRACTION,
        help="Share of records drawn from the customer-support corpus",
    )
    parser.add_argument(
        "--local-dir",
        type=Path,
        default=None,
        help="Directory of your own .md/.txt policy docs. Strongly recommended: "
        "these tokens appear in every production prompt.",
    )
    parser.add_argument("--local-chunk-chars", type=int, default=2000)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    records: list[dict[str, Any]] = []

    if args.local_dir:
        if not args.local_dir.is_dir():
            print(f"error: --local-dir {args.local_dir} is not a directory", file=sys.stderr)
            return 2
        local = _load_local(args.local_dir, args.local_chunk_chars)
        # Cap local docs at a third of the budget so a small policy corpus is
        # not repeated until it dominates the Hessian estimates.
        keep = min(len(local), args.samples // 3)
        rng.shuffle(local)
        records.extend(local[:keep])
        print(f"local documents: {keep} records (from {len(local)} chunks)")

    remaining = max(args.samples - len(records), 0)
    n_support = int(remaining * args.support_fraction)
    n_general = remaining - n_support

    if n_support:
        support = _load_support(n_support * 2, args.seed)
        records.extend(support[:n_support])
        print(f"support corpus: {min(len(support), n_support)} records")

    if n_general:
        general = _load_general(n_general * 2, args.seed)
        records.extend(general[:n_general])
        print(f"general corpus: {min(len(general), n_general)} records")

    rng.shuffle(records)
    records = records[: args.samples]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as fh:
        for record in records:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    print(f"\nwrote {len(records)} calibration records to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
