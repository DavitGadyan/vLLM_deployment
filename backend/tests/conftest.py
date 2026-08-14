from __future__ import annotations

import pytest

from app.schemas.config import ConfigPayload, PolicyItem
from app.services.assembler import RetrievedChunk
from app.services.config_service import _CompilerView


@pytest.fixture
def minimal_config() -> _CompilerView:
    return _CompilerView(ConfigPayload(company_name="Acme"))


@pytest.fixture
def full_config() -> _CompilerView:
    """Exercises every optional section of the compiler."""
    return _CompilerView(
        ConfigPayload(
            company_name="Northwind Supply",
            agent_name="Ada",
            support_email="help@northwind.example",
            support_url="https://help.northwind.example",
            tone="friendly",
            languages=["English", "Spanish"],
            greeting="Thanks for getting in touch.",
            signature="— Ada, Northwind Supply",
            policies=[
                PolicyItem(title="Refunds", body="Full refund within 30 days of delivery."),
                PolicyItem(title="Shipping", body="Standard delivery is 3-5 business days."),
            ],
            escalation_rules="Always escalate billing disputes and chargebacks.",
            forbidden_topics=["Legal advice", "Medical advice"],
            custom_instructions="Mention the loyalty programme when relevant.",
            change_note="test fixture",
        )
    )


def make_chunk(
    *,
    chunk_id: str = "chunk-1",
    document_id: str = "doc-1",
    title: str = "Refund Policy",
    heading: str | None = "Refunds",
    text: str = "Customers may request a full refund within 30 days of delivery.",
    score: float = 0.82,
) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id,
        document_id=document_id,
        document_title=title,
        heading=heading,
        text=text,
        score=score,
    )


@pytest.fixture
def chunk_factory():  # type: ignore[no-untyped-def]
    return make_chunk
