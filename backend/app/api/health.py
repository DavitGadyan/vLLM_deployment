"""Health and readiness probes.

Liveness and readiness answer different questions and must not share an
implementation. `/healthz` says "this process is not wedged"; `/readyz` says
"this pod can serve traffic". Wiring readiness into liveness is how a brief vLLM
restart turns into a cascade of backend pod kills.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Response, status
from sqlalchemy import text

from app.api.deps import EmbeddingDep, LLMDep, SessionDep

router = APIRouter(tags=["health"])


@router.get("/healthz", summary="Liveness")
async def healthz() -> dict[str, str]:
    """Process-level liveness. No dependency checks, by design."""
    return {"status": "ok"}


@router.get("/readyz", summary="Readiness")
async def readyz(
    session: SessionDep, llm: LLMDep, embeddings: EmbeddingDep, response: Response
) -> dict[str, object]:
    """Dependency readiness. Kubernetes removes the pod from the Service on 503."""

    async def check_db() -> bool:
        try:
            await session.execute(text("SELECT 1"))
            return True
        except Exception:
            return False

    async def check_llm() -> bool:
        try:
            return await llm.health()
        except Exception:
            return False

    db_ok, llm_ok, embed_ok = await asyncio.gather(check_db(), check_llm(), embeddings.health())

    checks = {"database": db_ok, "vllm": llm_ok, "embeddings": embed_ok}
    ready = all(checks.values())
    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"ready": ready, "checks": checks}
