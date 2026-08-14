"""Tests for the prefix-cache contract.

The ordering asserted here is the single biggest latency lever in the system.
These tests exist so a refactor that reorders messages fails loudly instead of
quietly costing every request a full prefill.
"""

from __future__ import annotations

from app.services.assembler import (
    RetrievedChunk,
    assemble,
    build_user_message,
    format_context_block,
    select_chunks,
)

PROMPT = "## Role\nYou are Ada, a support assistant for Acme.\n"


def _assemble(**overrides: object) -> object:
    kwargs: dict[str, object] = {
        "compiled_prompt": PROMPT,
        "compiled_prompt_tokens": 20,
        "question": "Can I get a refund?",
        "chunks": [],
        "history": [],
        "min_score": 0.35,
        "max_context_tokens": 3000,
        "max_model_len": 8192,
        "max_output_tokens": 1024,
        "history_turns": 6,
    }
    kwargs.update(overrides)
    return assemble(**kwargs)  # type: ignore[arg-type]


def test_system_prompt_is_always_first(chunk_factory) -> None:  # type: ignore[no-untyped-def]
    """The stable prefix must lead, or nothing ever hits the prefix cache."""
    result = _assemble(
        chunks=[chunk_factory()],
        history=[{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}],
    )
    assert result.messages[0]["role"] == "system"  # type: ignore[attr-defined]
    assert result.messages[0]["content"] == PROMPT  # type: ignore[attr-defined]


def test_system_prompt_is_byte_identical_across_requests(chunk_factory) -> None:  # type: ignore[no-untyped-def]
    """Nothing per-request may leak into the system message.

    A timestamp, session id or customer name injected here would change the
    leading tokens and invalidate the cache for every concurrent conversation.
    """
    first = _assemble(question="Where is my order?", chunks=[chunk_factory()])
    second = _assemble(question="How do I return this?", chunks=[chunk_factory(chunk_id="c2")])
    assert first.messages[0] == second.messages[0]  # type: ignore[attr-defined]


def test_current_question_is_last(chunk_factory) -> None:  # type: ignore[no-untyped-def]
    result = _assemble(
        question="Can I get a refund?",
        chunks=[chunk_factory()],
        history=[{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}],
    )
    last = result.messages[-1]  # type: ignore[attr-defined]
    assert last["role"] == "user"
    assert "Can I get a refund?" in last["content"]


def test_retrieved_context_rides_with_the_question_not_the_system_prompt(chunk_factory) -> None:  # type: ignore[no-untyped-def]
    """Context varies per request, so it must sit after the stable prefix."""
    result = _assemble(chunks=[chunk_factory()])
    assert "<context>" not in result.messages[0]["content"]  # type: ignore[attr-defined]
    assert "<context>" in result.messages[-1]["content"]  # type: ignore[attr-defined]


def test_history_is_ordered_oldest_first(chunk_factory) -> None:  # type: ignore[no-untyped-def]
    history = [
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "second question"},
        {"role": "assistant", "content": "second answer"},
    ]
    result = _assemble(chunks=[chunk_factory()], history=history)
    contents = [m["content"] for m in result.messages]  # type: ignore[attr-defined]
    assert contents.index("first question") < contents.index("second question")


def test_history_is_capped_by_turn_count(chunk_factory) -> None:  # type: ignore[no-untyped-def]
    history = [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"message {i}"}
        for i in range(20)
    ]
    result = _assemble(chunks=[chunk_factory()], history=history, history_turns=2)
    # system + 4 history messages + current question
    assert len(result.messages) == 6  # type: ignore[attr-defined]
    assert "message 0" not in [m["content"] for m in result.messages]  # type: ignore[attr-defined]


def test_overflow_drops_history_not_the_question() -> None:
    """When the window is tight, the customer's question always survives."""
    long_history = [
        {"role": "user" if i % 2 == 0 else "assistant", "content": "word " * 400} for i in range(10)
    ]
    result = _assemble(
        history=long_history, max_model_len=2048, max_output_tokens=512, history_turns=6
    )
    assert result.messages[0]["content"] == PROMPT  # type: ignore[attr-defined]
    assert "Can I get a refund?" in result.messages[-1]["content"]  # type: ignore[attr-defined]
    assert result.total_tokens <= 2048  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Chunk selection
# ---------------------------------------------------------------------------


def _chunk(score: float, text: str = "some policy text", chunk_id: str = "c") -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id,
        document_id="d",
        document_title="Doc",
        heading=None,
        text=text,
        score=score,
    )


def test_chunks_below_the_score_floor_are_dropped() -> None:
    chunks = [_chunk(0.8, chunk_id="a"), _chunk(0.5, chunk_id="b"), _chunk(0.2, chunk_id="c")]
    selected = select_chunks(chunks, min_score=0.35, max_context_tokens=3000)
    assert [c.chunk_id for c in selected] == ["a", "b"]


def test_selection_stops_at_the_first_low_score() -> None:
    """Input is ranked, so the first sub-threshold chunk ends the scan."""
    chunks = [_chunk(0.8, chunk_id="a"), _chunk(0.1, chunk_id="b"), _chunk(0.9, chunk_id="c")]
    selected = select_chunks(chunks, min_score=0.35, max_context_tokens=3000)
    assert [c.chunk_id for c in selected] == ["a"]


def test_selection_respects_the_context_budget() -> None:
    chunks = [_chunk(0.9, text="word " * 300, chunk_id=str(i)) for i in range(10)]
    selected = select_chunks(chunks, min_score=0.35, max_context_tokens=500)
    assert 0 < len(selected) < 10


def test_context_block_markers_are_one_indexed() -> None:
    block = format_context_block([_chunk(0.9, chunk_id="a"), _chunk(0.8, chunk_id="b")])
    assert block.startswith("[1] ")
    assert "\n\n[2] " in block


def test_empty_context_is_stated_explicitly() -> None:
    """The model is told retrieval found nothing, rather than shown a void.

    An empty <context> block reads as "no constraint" and invites the model to
    answer from memory; an explicit statement pushes it toward escalating.
    """
    message = build_user_message("Where is my order?", [])
    assert "no relevant company documentation was found" in message
