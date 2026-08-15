"""Config version lifecycle: create, activate, roll back.

Nothing here mutates a saved version. Every save inserts a new row and the
active pointer moves; rollback is the same operation aimed at an older row. The
cost is a monotonically growing table of small rows, and what it buys is the
ability to answer "what prompt produced this answer, and can I put it back?" —
which is the difference between a config page and a config *console*.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import metrics
from app.core.logging import get_logger
from app.db.models import ActiveConfig, ConfigVersion
from app.schemas.config import ConfigPayload
from app.services.audit import Action, AuditService
from app.services.prompt_compiler import CompiledPrompt, compile_prompt

log = get_logger(__name__)

# Bootstrap config, inserted on first start so the service is usable
# immediately. Deliberately generic: the console's job is to replace it.
DEFAULT_CONFIG = ConfigPayload(
    company_name="Your Company",
    agent_name="Support",
    tone="professional",
    languages=["English"],
    policies=[],
    change_note="Initial configuration",
)


class _CompilerView:
    """Adapts a `ConfigPayload` to the shape `compile_prompt` expects.

    Lets the console preview an unsaved draft through the exact same compiler
    that runs on save — there is only one implementation, so preview cannot
    drift from what actually ships.
    """

    def __init__(self, payload: ConfigPayload) -> None:
        self.company_name = payload.company_name
        self.agent_name = payload.agent_name
        self.support_email = payload.support_email
        self.support_url = payload.support_url
        self.tone: str = payload.tone
        self.languages = payload.languages
        self.greeting = payload.greeting
        self.signature = payload.signature
        self.policies = [{"title": p.title, "body": p.body} for p in payload.policies]
        self.escalation_rules = payload.escalation_rules
        self.forbidden_topics = payload.forbidden_topics
        self.custom_instructions = payload.custom_instructions


def compile_payload(payload: ConfigPayload) -> CompiledPrompt:
    return compile_prompt(_CompilerView(payload))


class ConfigService:
    def __init__(self, audit: AuditService | None = None) -> None:
        # Optional so existing tests can construct this without an audit service.
        # In the running application it is always provided — see main.py.
        self._audit = audit or AuditService()

    async def get_active(self, session: AsyncSession) -> ConfigVersion:
        """Return the live config, bootstrapping a default if none exists."""
        pointer = await session.get(ActiveConfig, 1)
        if pointer is not None:
            version = await session.get(ConfigVersion, pointer.config_version_id)
            if version is not None:
                return version

        log.info("config_bootstrap", reason="no active config")
        return await self.create_version(
            session, DEFAULT_CONFIG, created_by="system", activate=True
        )

    async def create_version(
        self,
        session: AsyncSession,
        payload: ConfigPayload,
        *,
        created_by: str | None,
        activate: bool = True,
    ) -> ConfigVersion:
        compiled = compile_payload(payload)

        next_version = (
            await session.scalar(select(func.coalesce(func.max(ConfigVersion.version), 0)))
        ) or 0
        next_version += 1

        version = ConfigVersion(
            id=uuid.uuid4(),
            version=next_version,
            company_name=payload.company_name,
            agent_name=payload.agent_name,
            support_email=payload.support_email,
            support_url=payload.support_url,
            tone=payload.tone,
            languages=payload.languages,
            greeting=payload.greeting,
            signature=payload.signature,
            policies=[{"title": p.title, "body": p.body} for p in payload.policies],
            escalation_rules=payload.escalation_rules,
            forbidden_topics=payload.forbidden_topics,
            custom_instructions=payload.custom_instructions,
            temperature=payload.temperature,
            max_output_tokens=payload.max_output_tokens,
            retrieval_top_k=payload.retrieval_top_k,
            retrieval_min_score=payload.retrieval_min_score,
            compiled_prompt=compiled.text,
            compiled_prompt_hash=compiled.hash,
            compiled_prompt_tokens=compiled.token_count,
            change_note=payload.change_note,
            created_by=created_by,
        )
        session.add(version)
        await session.flush()

        # Audited before the commit, deliberately: the version row and its audit
        # entry land in the same transaction, so a saved configuration with no
        # record of who saved it is not a state this system can reach.
        await self._audit.record(
            session,
            action=Action.CONFIG_SAVED,
            actor=created_by,
            resource_type="config_version",
            resource_id=str(version.id),
            detail={
                "version": version.version,
                "company_name": version.company_name,
                "change_note": version.change_note,
                "prompt_hash": version.compiled_prompt_hash,
                "prompt_tokens": version.compiled_prompt_tokens,
            },
        )

        if activate:
            await self._set_active(session, version, activated_by=created_by)
            await self._audit.record(
                session,
                action=Action.CONFIG_ACTIVATED,
                actor=created_by,
                resource_type="config_version",
                resource_id=str(version.id),
                detail={"version": version.version, "via": "save"},
            )

        await session.commit()
        await session.refresh(version)

        log.info(
            "config_version_created",
            version=version.version,
            prompt_tokens=version.compiled_prompt_tokens,
            prompt_hash=version.compiled_prompt_hash[:12],
            activated=activate,
        )
        return version

    async def activate(
        self, session: AsyncSession, version_id: uuid.UUID, *, activated_by: str | None
    ) -> ConfigVersion | None:
        """Point the live config at an existing version (forward or rollback)."""
        version = await session.get(ConfigVersion, version_id)
        if version is None:
            return None

        await self._set_active(session, version, activated_by=activated_by)

        # A rollback is an activation of an older version, so it is the same
        # event. `via` distinguishes them, which is what makes "how often do we
        # roll back?" answerable from the log.
        await self._audit.record(
            session,
            action=Action.CONFIG_ACTIVATED,
            actor=activated_by,
            resource_type="config_version",
            resource_id=str(version.id),
            detail={"version": version.version, "via": "manual_activation"},
        )
        await session.commit()

        log.info("config_activated", version=version.version, by=activated_by)
        return version

    async def _set_active(
        self, session: AsyncSession, version: ConfigVersion, *, activated_by: str | None
    ) -> None:
        pointer = await session.get(ActiveConfig, 1)
        if pointer is None:
            session.add(ActiveConfig(id=1, config_version_id=version.id, activated_by=activated_by))
        else:
            pointer.config_version_id = version.id
            pointer.activated_by = activated_by

        metrics.config_activations_total.inc()
        metrics.active_config_version.set(version.version)
        # The compiled prompt is the cacheable prefix; publishing its length
        # alongside vLLM's prefix-cache hit rate is what makes a drop in that
        # rate attributable to a config change rather than a traffic shift.
        metrics.prompt_prefix_tokens.set(version.compiled_prompt_tokens)

    async def list_versions(
        self, session: AsyncSession, *, limit: int = 50
    ) -> tuple[list[ConfigVersion], uuid.UUID | None]:
        versions = list(
            (
                await session.scalars(
                    select(ConfigVersion).order_by(ConfigVersion.version.desc()).limit(limit)
                )
            ).all()
        )
        pointer = await session.get(ActiveConfig, 1)
        return versions, pointer.config_version_id if pointer else None

    async def get_version(
        self, session: AsyncSession, version_id: uuid.UUID
    ) -> ConfigVersion | None:
        return await session.get(ConfigVersion, version_id)
