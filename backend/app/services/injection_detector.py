"""Prompt-injection detection.

The prompt compiler already *defends* against injection — it tells the model that
content inside `<context>` is data and never instructions. That defence is
necessary but invisible: nothing counts how often it is exercised, so the security
dashboard would have nothing to show but a claim.

This module makes the attack surface measurable. It scans two places:

* **The customer's message.** Someone typing "ignore your instructions" into a
  support chat.
* **Retrieved document chunks.** The more serious case. Once customers can upload
  documents, text inside a PDF instructing the model to change its behaviour is a
  working attack that arrives through a trusted-looking channel.

Detection is pattern-based, which means it is a *signal*, not a guarantee. A
determined attacker will phrase something this misses. It is deployed as
defence-in-depth alongside the prompt-level instruction and the grounding rules —
not as the only thing standing between a customer and the system prompt.

Nothing here blocks a request on its own. Detection annotates and counts; the
decision to refuse belongs to the caller, so that a false positive degrades into a
logged event rather than a refused customer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Final


class Severity(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class Surface(StrEnum):
    """Where the suspicious text arrived from."""

    USER_MESSAGE = "user_message"
    RETRIEVED_DOCUMENT = "retrieved_document"


@dataclass(frozen=True)
class Rule:
    name: str
    severity: Severity
    pattern: re.Pattern[str]
    explanation: str


def _rule(name: str, severity: Severity, pattern: str, explanation: str) -> Rule:
    return Rule(name, severity, re.compile(pattern, re.IGNORECASE), explanation)


# Ordered by how strongly each indicates deliberate manipulation rather than an
# unusual but innocent phrasing.
RULES: Final[tuple[Rule, ...]] = (
    _rule(
        "instruction_override",
        Severity.HIGH,
        r"\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}?"
        r"\b(?:previous|prior|above|earlier|all|your)\b[^.\n]{0,20}?"
        r"\b(?:instruction|prompt|rule|direction|guideline)s?\b",
        "Attempts to cancel the system prompt.",
    ),
    _rule(
        "role_reassignment",
        Severity.HIGH,
        r"\byou\s+are\s+now\b|\bact\s+as\s+(?:a|an|the)\b|\bpretend\s+(?:to\s+be|you)\b"
        r"|\bfrom\s+now\s+on\s+you\b|\bnew\s+(?:role|persona|identity)\b",
        "Attempts to replace the assistant's role.",
    ),
    _rule(
        "prompt_disclosure",
        Severity.HIGH,
        r"\b(?:reveal|show|print|repeat|output|display|tell\s+me)\b[^.\n]{0,30}?"
        r"\b(?:system\s+prompt|initial\s+instruction|your\s+instruction|prompt\s+above)\b"
        r"|\bwhat\s+(?:are|were)\s+your\s+instructions\b",
        "Attempts to extract the system prompt.",
    ),
    _rule(
        "guardrail_bypass",
        Severity.HIGH,
        r"\b(?:developer|debug|admin|god|jailbreak|DAN)\s+mode\b"
        r"|\bwithout\s+(?:any\s+)?(?:restriction|filter|limitation|guardrail)s?\b"
        r"|\bunrestricted\s+(?:assistant|mode|version)\b",
        "Attempts to disable safety behaviour.",
    ),
    _rule(
        "policy_override",
        Severity.MEDIUM,
        r"\b(?:ignore|override|bypass|disregard)\b[^.\n]{0,30}?"
        r"\b(?:compan(?:y|ies)|refund|return|warranty|escalation)\s+polic(?:y|ies)\b"
        r"|\bapprove\s+(?:this|the|my)\b[^.\n]{0,20}?\bregardless\b",
        "Attempts to make the assistant contradict configured policy.",
    ),
    _rule(
        "delimiter_injection",
        Severity.MEDIUM,
        r"</?(?:context|system|instruction)s?>"
        r"|\[/?INST\]|<\|(?:im_start|im_end|system|endoftext)\|>"
        r"|^\s*###\s*(?:system|instruction)",
        "Forged structural markers, trying to escape the context block.",
    ),
    _rule(
        "authority_claim",
        Severity.LOW,
        r"\b(?:this\s+is|I\s+am)\s+(?:the|your)\s+(?:developer|administrator|owner|creator)\b"
        r"|\bauthori[sz]ed\s+by\s+(?:the\s+)?(?:developer|admin|management)\b",
        "Claims privileged identity to justify an exception.",
    ),
    _rule(
        "encoded_payload",
        Severity.LOW,
        r"\b(?:base64|rot13|hex)\s*(?:decode|encoded?)\b"
        r"|\bdecode\s+(?:this|the\s+following)\b",
        "Attempts to smuggle instructions past literal matching.",
    ),
)

_SEVERITY_ORDER: Final[dict[Severity, int]] = {
    Severity.LOW: 0,
    Severity.MEDIUM: 1,
    Severity.HIGH: 2,
}


@dataclass(frozen=True)
class Finding:
    rule: str
    severity: Severity
    surface: Surface
    explanation: str
    excerpt: str
    source_id: str | None = None


@dataclass(frozen=True)
class ScanResult:
    findings: list[Finding]

    @property
    def detected(self) -> bool:
        return bool(self.findings)

    @property
    def max_severity(self) -> Severity | None:
        if not self.findings:
            return None
        return max((f.severity for f in self.findings), key=lambda s: _SEVERITY_ORDER[s])


# Excerpts are stored in audit records, so they are capped. A long injected
# payload should not be reproduced in full in a log that people read.
_EXCERPT_CHARS = 160


def _excerpt(text: str, match: re.Match[str]) -> str:
    start = max(match.start() - 30, 0)
    end = min(match.end() + 30, len(text))
    snippet = text[start:end].replace("\n", " ").strip()
    if len(snippet) > _EXCERPT_CHARS:
        snippet = snippet[:_EXCERPT_CHARS] + "…"
    return ("…" if start > 0 else "") + snippet


def scan(text: str, surface: Surface, *, source_id: str | None = None) -> ScanResult:
    """Scan one piece of text. Reports every rule that fires, not just the first."""
    if not text:
        return ScanResult(findings=[])

    findings: list[Finding] = []
    for rule in RULES:
        match = rule.pattern.search(text)
        if match:
            findings.append(
                Finding(
                    rule=rule.name,
                    severity=rule.severity,
                    surface=surface,
                    explanation=rule.explanation,
                    excerpt=_excerpt(text, match),
                    source_id=source_id,
                )
            )
    return ScanResult(findings=findings)


def scan_turn(message: str, chunks: list[tuple[str, str]] | None = None) -> ScanResult:
    """Scan a whole turn: the customer's message plus every retrieved chunk.

    `chunks` is a list of `(chunk_id, text)`. Retrieved content is scanned
    separately from user input because the two mean different things: a customer
    trying an injection is noise, while an injection sitting inside an indexed
    company document means the knowledge base itself has been poisoned — a far
    more serious finding that should be investigated rather than shrugged off.
    """
    findings = list(scan(message, Surface.USER_MESSAGE).findings)
    for chunk_id, chunk_text in chunks or []:
        findings.extend(scan(chunk_text, Surface.RETRIEVED_DOCUMENT, source_id=chunk_id).findings)
    return ScanResult(findings=findings)
