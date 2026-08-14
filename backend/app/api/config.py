"""Configuration console API."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, status

from app.api.deps import ConfigServiceDep, OperatorDep, SessionDep
from app.schemas.config import (
    ConfigPayload,
    ConfigVersionOut,
    ConfigVersionSummary,
    PromptPreview,
)
from app.services.config_service import compile_payload

router = APIRouter(prefix="/config", tags=["config"])


def _to_out(version: object, active_id: uuid.UUID | None) -> ConfigVersionOut:
    out = ConfigVersionOut.model_validate(version)
    out.is_active = out.id == active_id
    return out


@router.get("", response_model=ConfigVersionOut, summary="Get the active configuration")
async def get_active(session: SessionDep, config: ConfigServiceDep) -> ConfigVersionOut:
    version = await config.get_active(session)
    return _to_out(version, version.id)


@router.put("", response_model=ConfigVersionOut, summary="Save a new configuration version")
async def save(
    payload: ConfigPayload,
    session: SessionDep,
    config: ConfigServiceDep,
    operator: OperatorDep,
) -> ConfigVersionOut:
    """Create a new immutable version and make it live.

    A save is always an insert. To undo one, activate the previous version —
    the console's rollback button does exactly that.
    """
    version = await config.create_version(session, payload, created_by=operator, activate=True)
    return _to_out(version, version.id)


@router.post(
    "/preview",
    response_model=PromptPreview,
    summary="Compile a draft without saving it",
)
async def preview(
    payload: ConfigPayload, session: SessionDep, config: ConfigServiceDep
) -> PromptPreview:
    """Show the operator exactly what the model will receive.

    This is what makes the config page inspectable rather than a black box: the
    same compiler that runs on save produces this text, so there is no gap
    between preview and reality.
    """
    compiled = compile_payload(payload)
    active = await config.get_active(session)
    return PromptPreview(
        compiled_prompt=compiled.text,
        compiled_prompt_hash=compiled.hash,
        compiled_prompt_tokens=compiled.token_count,
        matches_active=compiled.hash == active.compiled_prompt_hash,
    )


@router.get(
    "/versions",
    response_model=list[ConfigVersionSummary],
    summary="List configuration history",
)
async def list_versions(
    session: SessionDep, config: ConfigServiceDep, limit: int = 50
) -> list[ConfigVersionSummary]:
    versions, active_id = await config.list_versions(session, limit=min(limit, 200))
    summaries = []
    for version in versions:
        summary = ConfigVersionSummary.model_validate(version)
        summary.is_active = version.id == active_id
        summaries.append(summary)
    return summaries


@router.get(
    "/versions/{version_id}",
    response_model=ConfigVersionOut,
    summary="Get one configuration version",
)
async def get_version(
    version_id: uuid.UUID, session: SessionDep, config: ConfigServiceDep
) -> ConfigVersionOut:
    version = await config.get_version(session, version_id)
    if version is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "configuration version not found")
    _, active_id = await config.list_versions(session, limit=1)
    return _to_out(version, active_id)


@router.post(
    "/versions/{version_id}/activate",
    response_model=ConfigVersionOut,
    summary="Activate a version (roll forward or back)",
)
async def activate(
    version_id: uuid.UUID,
    session: SessionDep,
    config: ConfigServiceDep,
    operator: OperatorDep,
) -> ConfigVersionOut:
    version = await config.activate(session, version_id, activated_by=operator)
    if version is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "configuration version not found")
    return _to_out(version, version.id)
