"""Application entrypoint and wiring."""

from __future__ import annotations

import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from app.api.health import router as health_router
from app.api.router import api_router
from app.core import metrics
from app.core.logging import configure_logging, get_logger, request_id_var
from app.core.settings import get_settings
from app.db.session import dispose_engine, get_session_factory
from app.services.audit import AuditService
from app.services.chat_service import ChatService
from app.services.config_service import ConfigService
from app.services.dashboard import DashboardService
from app.services.embeddings import EmbeddingClient
from app.services.feedback import FeedbackService
from app.services.ingest import IngestService
from app.services.llm_client import LLMClient
from app.services.retriever import Retriever

log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_format)

    session_factory = get_session_factory()
    embedding_client = EmbeddingClient(settings)
    llm_client = LLMClient(settings)
    retriever = Retriever(settings, embedding_client)
    audit_service = AuditService()
    config_service = ConfigService(audit_service)

    app.state.settings = settings
    app.state.embedding_client = embedding_client
    app.state.llm_client = llm_client
    app.state.retriever = retriever
    app.state.config_service = config_service
    app.state.audit_service = audit_service
    feedback_service = FeedbackService(audit_service)
    app.state.feedback_service = feedback_service
    app.state.dashboard_service = DashboardService(settings, audit_service, feedback_service)
    app.state.ingest_service = IngestService(
        settings, embedding_client, session_factory, audit_service
    )
    app.state.chat_service = ChatService(
        settings, llm_client, retriever, config_service, session_factory, audit_service
    )

    # Publish the active config's prompt length at startup so the prefix-token
    # gauge is populated before the first save, not just after one.
    async with session_factory() as session:
        try:
            active = await config_service.get_active(session)
            metrics.active_config_version.set(active.version)
            metrics.prompt_prefix_tokens.set(active.compiled_prompt_tokens)
            log.info(
                "startup_config",
                version=active.version,
                company=active.company_name,
                prompt_tokens=active.compiled_prompt_tokens,
            )
        except Exception:
            log.exception("startup_config_failed")

    log.info("startup_complete", vllm=settings.vllm_base_url, model=settings.served_model_name)

    try:
        yield
    finally:
        await llm_client.aclose()
        await embedding_client.aclose()
        await dispose_engine()
        log.info("shutdown_complete")


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_format)

    app = FastAPI(
        title="Support Assistant API",
        version="0.1.0",
        summary="Gateway between the support console and the vLLM serving layer",
        lifespan=lifespan,
        docs_url="/docs",
        openapi_url="/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allow_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):  # type: ignore[no-untyped-def]
        """Attach a request id and log one structured line per request.

        The id is echoed in `X-Request-ID`, so a user reporting "the assistant
        gave me a strange answer at 14:32" maps to an exact log entry.
        """
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        try:
            response: Response = await call_next(request)
        finally:
            request_id_var.reset(token)
        duration = time.perf_counter() - started
        response.headers["X-Request-ID"] = request_id
        if request.url.path not in {"/healthz", "/readyz", "/metrics"}:
            log.info(
                "request",
                method=request.method,
                path=request.url.path,
                status=response.status_code,
                duration_ms=round(duration * 1000, 1),
                request_id=request_id,
            )
        return response

    @app.get("/metrics", include_in_schema=False)
    async def prometheus_metrics() -> Response:
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    app.include_router(health_router)
    app.include_router(api_router)
    return app


app = create_app()
