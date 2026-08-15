"""Monitoring dashboard payloads.

Every response carries `source`, which the UI renders as a badge. That field is
the honesty mechanism for the whole tab: a dashboard that silently shows plausible
synthetic numbers during a sales demo is a lie with a chart on it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel

DataSource = Literal["live", "demo"]


class Point(BaseModel):
    t: datetime
    v: float


class Series(BaseModel):
    name: str
    unit: str
    points: list[Point]


class Stat(BaseModel):
    """A headline number with enough context to be judged, not just displayed."""

    key: str
    label: str
    value: float
    unit: str
    # Which direction is good. A dashboard that colours "escalation rate up" green
    # because the number went up is worse than no colour at all.
    better: Literal["higher", "lower", "neutral"] = "neutral"
    target: float | None = None
    # Percentage change against the preceding window, when one is available.
    delta: float | None = None
    hint: str | None = None


class Breakdown(BaseModel):
    label: str
    value: float
    tone: Literal["neutral", "good", "warning", "bad"] = "neutral"


class DashboardSection(BaseModel):
    source: DataSource
    generated_at: datetime
    stats: list[Stat]
    series: list[Series]
    breakdowns: dict[str, list[Breakdown]] = {}
    notes: list[str] = []


class AuditEventOut(BaseModel):
    sequence: int
    occurred_at: datetime
    actor: str | None
    action: str
    resource_type: str | None
    resource_id: str | None
    outcome: str
    severity: str
    compliance_tags: list[str]
    detail: dict[str, Any]
    hash: str
    prev_hash: str | None


class ChainStatus(BaseModel):
    valid: bool
    checked: int
    broken_at_sequence: int | None = None
    reason: str | None = None


class AuditSection(BaseModel):
    source: DataSource
    generated_at: datetime
    chain: ChainStatus
    events: list[AuditEventOut]
    # How many events evidence each control framework — the number an auditor
    # asks for first.
    coverage: dict[str, int]
