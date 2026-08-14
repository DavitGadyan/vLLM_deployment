"""Token counting for context budgeting.

Uses tiktoken's `cl100k_base` rather than the real Qwen tokenizer, on purpose:
loading a `transformers` tokenizer would pull ~2 GB of dependencies into an API
pod that otherwise needs none, to improve an estimate that is only used for
budgeting.

The estimate runs a few percent off Qwen's BPE on English prose and further off
on CJK. Everything that consumes these counts applies `SAFETY_MARGIN`, and the
engine enforces the real limit anyway — a miscount costs a slightly smaller
context window, never a failed request.
"""

from __future__ import annotations

import functools

import tiktoken

# Budget 12% more tokens than we count, covering both tokenizer skew and the
# chat template's role headers and special tokens.
SAFETY_MARGIN = 1.12


@functools.lru_cache(maxsize=1)
def _encoder() -> tiktoken.Encoding:
    return tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    if not text:
        return 0
    return len(_encoder().encode(text, disallowed_special=()))


def budgeted_tokens(text: str) -> int:
    """Token count with the safety margin applied, for capacity decisions."""
    return int(count_tokens(text) * SAFETY_MARGIN)


def truncate_to_tokens(text: str, max_tokens: int) -> str:
    """Trim `text` to at most `max_tokens`, cutting at a whitespace boundary."""
    if max_tokens <= 0:
        return ""
    encoder = _encoder()
    tokens = encoder.encode(text, disallowed_special=())
    if len(tokens) <= max_tokens:
        return text
    truncated = encoder.decode(tokens[:max_tokens])
    # Cutting mid-word produces fragments that read as typos to the model; back
    # up to the last space when one is close enough to be the real boundary.
    last_space = truncated.rfind(" ")
    if last_space > len(truncated) * 0.8:
        truncated = truncated[:last_space]
    return truncated.rstrip()
