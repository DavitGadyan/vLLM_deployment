"""Seed a demo configuration and knowledge base.

    python -m app.scripts.seed

Gives you something answerable within a minute of `make dev`, so the first
end-to-end check does not depend on writing policy documents first. Safe to
re-run: the config becomes a new version, and documents deduplicate on content
hash.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from app.core.logging import configure_logging, get_logger
from app.core.settings import get_settings
from app.db.session import dispose_engine, get_session_factory
from app.schemas.config import ConfigPayload, PolicyItem
from app.services.config_service import ConfigService
from app.services.embeddings import EmbeddingClient
from app.services.ingest import IngestService

log = get_logger(__name__)

SAMPLE_KB = Path(__file__).parent / "sample_kb"

DEMO_CONFIG = ConfigPayload(
    company_name="Northwind Supply",
    agent_name="Ada",
    support_email="help@northwind.example",
    support_url="https://help.northwind.example",
    tone="professional",
    languages=["English", "Spanish"],
    signature="— Ada, Northwind Supply",
    policies=[
        PolicyItem(
            title="Refunds",
            body=(
                "Customers may request a full refund within 30 days of delivery. "
                "Items must be unused and in original packaging. Refunds are issued "
                "to the original payment method within 5-7 business days. "
                "Never offer an exception to the 30-day window — escalate instead."
            ),
        ),
        PolicyItem(
            title="Shipping",
            body=(
                "Standard delivery is 3-5 business days within the continental US. "
                "Express delivery is 1-2 business days. We do not ship to PO boxes "
                "or outside the US."
            ),
        ),
        PolicyItem(
            title="Warranty",
            body=(
                "All hardware carries a 2-year limited warranty covering "
                "manufacturing defects. Accidental damage, water damage, and normal "
                "wear are not covered."
            ),
        ),
    ],
    escalation_rules=(
        "Always escalate billing disputes, chargebacks, and any request to modify "
        "an order that has already shipped."
    ),
    forbidden_topics=[
        "Legal advice or interpretation of our terms of service",
        "Medical advice",
        "Competitor products or pricing comparisons",
    ],
    change_note="Demo seed data",
)


async def seed() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, "console")

    session_factory = get_session_factory()
    embeddings = EmbeddingClient(settings)
    ingest = IngestService(settings, embeddings, session_factory)
    config_service = ConfigService()

    try:
        async with session_factory() as session:
            version = await config_service.create_version(
                session, DEMO_CONFIG, created_by="seed", activate=True
            )
            log.info(
                "seeded_config",
                version=version.version,
                company=version.company_name,
                prompt_tokens=version.compiled_prompt_tokens,
            )

        if not await embeddings.health():
            log.warning(
                "embeddings_unavailable",
                detail="config seeded, knowledge base skipped — start the "
                "embeddings service and re-run to index the sample documents",
            )
            return

        for path in sorted(SAMPLE_KB.glob("*.md")):
            data = path.read_bytes()
            async with session_factory() as session:
                document, created = await ingest.register(
                    session,
                    filename=path.name,
                    content_type="text/markdown",
                    data=data,
                    title=path.stem.replace("-", " ").title(),
                )
            if not created:
                log.info("document_exists", title=document.title)
                continue
            await ingest.process(document.id, data)
            log.info("seeded_document", title=document.title)

        log.info("seed_complete")

    finally:
        await embeddings.aclose()
        await dispose_engine()


if __name__ == "__main__":
    asyncio.run(seed())
