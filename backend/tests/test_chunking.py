"""Tests for document parsing and chunking."""

from __future__ import annotations

import pytest

from app.services.chunking import UnsupportedDocument, chunk, parse

MARKDOWN = """\
# Warranty

All hardware carries a 2-year limited warranty.

## Exclusions

Water damage is not covered. Accidental damage is not covered.

## Claims

Customers need their order number. Assessment takes 5-7 business days.
"""


def test_heading_trail_is_captured() -> None:
    """A chunk reading "not covered" is meaningless without its heading."""
    chunks = chunk(MARKDOWN, chunk_tokens=64, overlap_tokens=8)
    headings = {c.heading for c in chunks}
    assert "Warranty > Exclusions" in headings
    assert "Warranty > Claims" in headings


def test_heading_is_included_in_embedded_text() -> None:
    chunks = chunk(MARKDOWN, chunk_tokens=64, overlap_tokens=8)
    exclusions = next(c for c in chunks if c.heading == "Warranty > Exclusions")
    assert exclusions.embedding_text.startswith("Warranty > Exclusions")
    # Stored text stays clean — the heading is shown separately in the citation.
    assert not exclusions.text.startswith("Warranty > Exclusions")


def test_chunks_do_not_split_mid_sentence() -> None:
    """A truncated fact is how a grounded assistant states a wrong number."""
    text = " ".join(f"Sentence number {i} contains some policy detail." for i in range(60))
    for item in chunk(text, chunk_tokens=48, overlap_tokens=8):
        assert item.text.rstrip().endswith(".")


def _sentences(text: str) -> set[str]:
    return {part.strip().rstrip(".") for part in text.split(". ") if part.strip()}


def test_overlap_repeats_whole_sentences() -> None:
    """A fact straddling a boundary must be complete in at least one chunk."""
    text = " ".join(f"Fact {i} is important and must be retained." for i in range(40))
    chunks = chunk(text, chunk_tokens=48, overlap_tokens=16)
    assert len(chunks) > 1
    shared = _sentences(chunks[0].text) & _sentences(chunks[1].text)
    assert shared, "expected overlapping content between consecutive chunks"
    # Overlap is whole sentences, not truncated fragments.
    for sentence in shared:
        assert sentence.startswith("Fact ")
        assert sentence.endswith("retained")


def test_oversized_sentence_is_emitted_rather_than_dropped() -> None:
    """Dense legal prose and tables must not vanish from the index."""
    long_sentence = "word " * 400 + "."
    chunks = chunk(long_sentence, chunk_tokens=64, overlap_tokens=8)
    assert len(chunks) == 1
    assert chunks[0].token_count > 64


def test_list_items_stay_separate() -> None:
    text = "# Steps\n\n- Open settings\n- Choose account\n- Confirm deletion\n"
    chunks = chunk(text, chunk_tokens=512, overlap_tokens=0)
    assert "Open settings" in chunks[0].text
    assert "Confirm deletion" in chunks[0].text


def test_ordinals_are_contiguous() -> None:
    chunks = chunk(MARKDOWN, chunk_tokens=32, overlap_tokens=4)
    assert [c.ordinal for c in chunks] == list(range(len(chunks)))


def test_plain_text_parses() -> None:
    assert "hello" in parse(b"hello world", "text/plain", "notes.txt")


def test_html_strips_navigation_and_scripts() -> None:
    html = b"""
    <html><body>
      <nav>Home About Contact</nav>
      <script>console.log('tracking')</script>
      <h1>Refunds</h1>
      <p>Full refund within 30 days.</p>
      <footer>Copyright 2026</footer>
    </body></html>
    """
    text = parse(html, "text/html", "policy.html")
    assert "Full refund within 30 days." in text
    assert "# Refunds" in text
    assert "tracking" not in text
    assert "Home About Contact" not in text


def test_unsupported_type_is_rejected_with_a_useful_message() -> None:
    with pytest.raises(UnsupportedDocument, match="Supported: PDF"):
        parse(b"\x00\x01", "application/vnd.ms-excel", "sheet.xls")
