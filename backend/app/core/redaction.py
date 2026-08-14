"""PII redaction applied before conversations are persisted.

Customers paste card numbers, order emails and phone numbers into support chat
constantly. Storing those verbatim turns a transcript table into a compliance
liability, so redaction happens on the write path — not as a reporting-time
filter that a future query can forget to apply.

This is pattern-based and therefore best-effort. It is a meaningful reduction in
stored PII, not a guarantee of its absence, and it is deliberately not the only
control: see the retention policy in docs/operations.md.
"""

from __future__ import annotations

import re
from typing import Final

_EMAIL: Final = re.compile(r"\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b")

# 13-19 digits with optional separators — covers the major card ranges.
_CARD: Final = re.compile(r"\b(?:\d[ -]*?){13,19}\b")

# International-ish phone numbers. Requires either a leading + or at least one
# separator, so bare integers (order numbers, quantities) are left alone.
_PHONE: Final = re.compile(
    r"(?<!\w)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}(?!\w)"
)

_SSN: Final = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_IBAN: Final = re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b")

# Long random-looking strings: API keys, session tokens, bearer credentials.
_SECRET: Final = re.compile(
    r"\b(?:sk|pk|api|key|token|bearer)[-_]?[A-Za-z0-9_-]{16,}\b", re.IGNORECASE
)


def _luhn_ok(digits: str) -> bool:
    """Card check so we do not redact every long order number."""
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def _redact_cards(text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        digits = re.sub(r"\D", "", match.group(0))
        if 13 <= len(digits) <= 19 and _luhn_ok(digits):
            return "[REDACTED_CARD]"
        return match.group(0)

    return _CARD.sub(replace, text)


def redact(text: str) -> str:
    """Return `text` with recognised PII replaced by stable placeholders.

    Placeholders keep the surrounding sentence readable, so a support lead
    reviewing a transcript can still follow the conversation.
    """
    if not text:
        return text
    redacted = _SECRET.sub("[REDACTED_SECRET]", text)
    redacted = _EMAIL.sub("[REDACTED_EMAIL]", redacted)
    redacted = _IBAN.sub("[REDACTED_IBAN]", redacted)
    redacted = _SSN.sub("[REDACTED_SSN]", redacted)
    redacted = _redact_cards(redacted)
    redacted = _PHONE.sub("[REDACTED_PHONE]", redacted)
    return redacted


def contains_pii(text: str) -> bool:
    return redact(text) != text
