"""Monitoring dashboard API.

Four sections, one per sub-tab in the console. Each response carries `source`
(`live` or `demo`) so the UI renders an honest badge — see
`services/dashboard.py` for why that field exists.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.api.deps import DashboardServiceDep, SessionDep
from app.schemas.dashboard import AuditSection, DashboardSection

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/quality", response_model=DashboardSection, summary="Answer quality")
async def quality(session: SessionDep, service: DashboardServiceDep) -> DashboardSection:
    """Is the assistant useful — deflection, citations, grounding, retrieval fit."""
    return await service.quality(session)


@router.get("/performance", response_model=DashboardSection, summary="Model performance")
async def performance(session: SessionDep, service: DashboardServiceDep) -> DashboardSection:
    """Is the serving layer healthy — latency, throughput, KV and prefix cache."""
    return await service.performance(session)


@router.get("/alignment", response_model=DashboardSection, summary="Improvement loop")
async def alignment(session: SessionDep, service: DashboardServiceDep) -> DashboardSection:
    """Is the assistant getting better — human judgements, and the training set they form."""
    return await service.alignment(session)


@router.get("/security", response_model=DashboardSection, summary="Security posture")
async def security(session: SessionDep, service: DashboardServiceDep) -> DashboardSection:
    """What was attempted and what was caught — injection, PII, auth, errors."""
    return await service.security(session)


@router.get("/audit", response_model=AuditSection, summary="Audit log and chain status")
async def audit(
    session: SessionDep,
    service: DashboardServiceDep,
    limit: int = Query(default=50, ge=1, le=500),
) -> AuditSection:
    """Append-only event log, with hash-chain verification and control coverage.

    `chain.valid` is recomputed on every request rather than cached. Verification
    is the whole value of the chain, and a cached verdict verifies nothing.
    """
    return await service.audit(session, limit=limit)
