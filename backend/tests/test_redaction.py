"""Tests for PII redaction on the conversation write path."""

from __future__ import annotations

import pytest

from app.core.redaction import contains_pii, redact, redact_counted


@pytest.mark.parametrize(
    ("raw", "placeholder"),
    [
        ("Contact me at jane.doe@example.com", "[REDACTED_EMAIL]"),
        ("My card is 4111 1111 1111 1111", "[REDACTED_CARD]"),
        ("SSN 123-45-6789", "[REDACTED_SSN]"),
        ("Call +1 (555) 123-4567 please", "[REDACTED_PHONE]"),
        ("Token sk_live_abcdefghijklmnop123", "[REDACTED_SECRET]"),
    ],
)
def test_pii_is_replaced(raw: str, placeholder: str) -> None:
    assert placeholder in redact(raw)


def test_surrounding_text_survives() -> None:
    """Transcripts must stay readable for a support lead reviewing them."""
    result = redact("Please refund my order to jane@example.com as soon as possible")
    assert result.startswith("Please refund my order to ")
    assert result.endswith(" as soon as possible")


def test_order_numbers_are_not_mistaken_for_cards() -> None:
    """Luhn check keeps ordinary long numbers intact."""
    assert redact("Order 1234567890123456789") == "Order 1234567890123456789"


def test_short_numbers_are_left_alone() -> None:
    assert redact("I ordered 3 units for $45") == "I ordered 3 units for $45"


def test_clean_text_is_unchanged() -> None:
    text = "How long does express shipping take?"
    assert redact(text) == text
    assert not contains_pii(text)


def test_multiple_items_in_one_message() -> None:
    result = redact("Email jane@example.com or call 555-123-4567")
    assert "[REDACTED_EMAIL]" in result
    assert "[REDACTED_PHONE]" in result


def test_empty_input() -> None:
    assert redact("") == ""


# ---------------------------------------------------------------------------
# Counting — the security dashboard and the audit log depend on these numbers
# ---------------------------------------------------------------------------


def test_counts_each_category_found() -> None:
    text, counts = redact_counted(
        "Email jane@example.com or call 555-123-4567, card 4111 1111 1111 1111"
    )
    assert counts == {"email": 1, "phone": 1, "card": 1}
    assert "jane@example.com" not in text


def test_counts_repeated_values() -> None:
    """A message listing three emails is three redactions, not one."""
    _, counts = redact_counted("a@x.com, b@y.com and c@z.com")
    assert counts["email"] == 3


def test_clean_text_counts_nothing() -> None:
    """A zero here must mean "no PII present", never "the regex broke"."""
    text, counts = redact_counted("How long does express shipping take?")
    assert counts == {}
    assert text == "How long does express shipping take?"


def test_counted_and_uncounted_redaction_agree() -> None:
    """`redact` delegates to `redact_counted`, so the two can never diverge."""
    sample = "Reach me at jane@example.com or 555-123-4567"
    assert redact(sample) == redact_counted(sample)[0]
