"""Assembles the final message list sent to vLLM.

## The prefix-cache contract

vLLM caches KV blocks by *token prefix*: two requests share cached computation
for exactly as long as their token sequences are identical, and diverge
permanently at the first differing token. Everything after the first difference
must be prefilled from scratch.

That single fact dictates the ordering below:

    1. compiled system prompt   identical for every request      -> always hits
    2. retrieved context        varies per question               -> diverges here
    3. conversation history     varies per conversation
    4. current user turn        most volatile, always last

The compiled system prompt is ~600 tokens that every concurrent conversation
shares. Under load that is the difference between prefilling 600 tokens per
request and prefilling zero.

The tempting mistakes both cost the entire cache:

  * Putting retrieved context before the system prompt. Divergence then starts
    at token ~1 and no request ever shares a prefix with another.
  * Injecting anything per-request into the system prompt — a timestamp, the
    customer's name, a session id. One variable token at the front invalidates
    everything behind it.

`tests/test_assembler.py` asserts this ordering, so a well-meaning refactor
cannot quietly reverse it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.services.tokens import budgeted_tokens, truncate_to_tokens


@dataclass(frozen=True)
class RetrievedChunk:
    chunk_id: str
    document_id: str
    document_title: str
    heading: str | None
    text: str
    score: float


@dataclass(frozen=True)
class AssembledPrompt:
    messages: list[dict[str, str]]
    prefix_tokens: int
    total_tokens: int
    used_chunks: list[RetrievedChunk]


def format_context_block(chunks: list[RetrievedChunk]) -> str:
    """Render retrieved chunks with the numbered markers the model cites.

    Each source is delimited and numbered so `[1]` in an answer resolves to a
    specific chunk id, which is what lets the UI render a citation chip that
    opens the actual source text. Without stable markers, "citations" would be
    decorative.
    """
    parts: list[str] = []
    for index, chunk in enumerate(chunks, start=1):
        label = chunk.document_title
        if chunk.heading:
            label = f"{label} — {chunk.heading}"
        parts.append(f"[{index}] {label}\n{chunk.text.strip()}")
    return "\n\n".join(parts)


def select_chunks(
    chunks: list[RetrievedChunk], min_score: float, max_context_tokens: int
) -> list[RetrievedChunk]:
    """Filter by relevance, then fit within the context budget.

    Chunks arrive ranked. We drop everything below the score floor — weakly
    related text is worse than no text, because it gives the model something
    plausible to pattern-match against instead of escalating — and then take from
    the top until the budget is spent.
    """
    selected: list[RetrievedChunk] = []
    used = 0
    for chunk in chunks:
        if chunk.score < min_score:
            break  # ranked order: everything after this is worse
        cost = budgeted_tokens(chunk.text) + 24  # marker, title, separators
        if used + cost > max_context_tokens:
            break
        selected.append(chunk)
        used += cost
    return selected


def build_user_message(question: str, chunks: list[RetrievedChunk]) -> str:
    if not chunks:
        return (
            "<context>\n(no relevant company documentation was found for this "
            "question)\n</context>\n\n"
            f"Customer question: {question}"
        )
    return f"<context>\n{format_context_block(chunks)}\n</context>\n\nCustomer question: {question}"


def assemble(
    *,
    compiled_prompt: str,
    compiled_prompt_tokens: int,
    question: str,
    chunks: list[RetrievedChunk],
    history: list[dict[str, Any]],
    min_score: float,
    max_context_tokens: int,
    max_model_len: int,
    max_output_tokens: int,
    history_turns: int,
) -> AssembledPrompt:
    """Build the message list. See the module docstring before reordering."""
    selected = select_chunks(chunks, min_score, max_context_tokens)

    # 1. Stable prefix.
    messages: list[dict[str, str]] = [{"role": "system", "content": compiled_prompt}]

    # 2 + 3. History, oldest first, capped by turn count.
    #
    # Trimmed by dropping whole turns rather than summarising: a summary would
    # be regenerated on every turn, changing the tokens between the system
    # prompt and the question each time, so nothing after the system prompt
    # would ever hit the cache.
    trimmed = history[-(history_turns * 2) :] if history_turns > 0 else []
    for entry in trimmed:
        role = entry.get("role")
        content = entry.get("content")
        if role in {"user", "assistant"} and content:
            messages.append({"role": str(role), "content": str(content)})

    # 4. Current turn, with its retrieved context.
    user_content = build_user_message(question, selected)
    messages.append({"role": "user", "content": user_content})

    # Reserve room for the answer. If the assembled prompt would leave too
    # little, drop history turns from the oldest end — never the question, and
    # never the system prompt, which would break both grounding and the cache.
    budget = max_model_len - max_output_tokens
    total = _total_tokens(messages)
    while total > budget and len(messages) > 2:
        del messages[1]  # oldest history turn
        total = _total_tokens(messages)

    # Last resort: the question plus its context alone exceeds the window.
    # Truncate the context, never the customer's question.
    if total > budget:
        overflow = total - budget
        trimmed_context = truncate_to_tokens(
            user_content, max(budgeted_tokens(user_content) - overflow, 256)
        )
        messages[-1] = {"role": "user", "content": trimmed_context}
        total = _total_tokens(messages)

    return AssembledPrompt(
        messages=messages,
        prefix_tokens=compiled_prompt_tokens,
        total_tokens=total,
        used_chunks=selected,
    )


def _total_tokens(messages: list[dict[str, str]]) -> int:
    return sum(budgeted_tokens(message["content"]) for message in messages)
