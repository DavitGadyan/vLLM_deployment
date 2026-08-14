"""Shared FastAPI dependencies.

Long-lived clients (HTTP connection pools, the DB engine) are built once in the
lifespan handler and read off `app.state` here. Constructing them per request
would rebuild a TLS connection pool on every chat turn.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings, get_settings
from app.db.session import get_session
from app.services.chat_service import ChatService
from app.services.config_service import ConfigService
from app.services.embeddings import EmbeddingClient
from app.services.ingest import IngestService
from app.services.llm_client import LLMClient
from app.services.retriever import Retriever


def settings_dep() -> Settings:
    return get_settings()


def llm_client(request: Request) -> LLMClient:
    return request.app.state.llm_client  # type: ignore[no-any-return]


def embedding_client(request: Request) -> EmbeddingClient:
    return request.app.state.embedding_client  # type: ignore[no-any-return]


def retriever(request: Request) -> Retriever:
    return request.app.state.retriever  # type: ignore[no-any-return]


def config_service(request: Request) -> ConfigService:
    return request.app.state.config_service  # type: ignore[no-any-return]


def chat_service(request: Request) -> ChatService:
    return request.app.state.chat_service  # type: ignore[no-any-return]


def ingest_service(request: Request) -> IngestService:
    return request.app.state.ingest_service  # type: ignore[no-any-return]


def operator(request: Request) -> str | None:
    """Identity recorded on config versions.

    Authentication is not implemented — the console sits behind cluster ingress
    (see docs/operations.md). This reads a header so that when IAP or an OIDC
    proxy is added in front, attribution starts working without touching any
    call sites.
    """
    return request.headers.get("x-forwarded-email") or request.headers.get("x-operator")


SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(settings_dep)]
LLMDep = Annotated[LLMClient, Depends(llm_client)]
EmbeddingDep = Annotated[EmbeddingClient, Depends(embedding_client)]
RetrieverDep = Annotated[Retriever, Depends(retriever)]
ConfigServiceDep = Annotated[ConfigService, Depends(config_service)]
ChatServiceDep = Annotated[ChatService, Depends(chat_service)]
IngestServiceDep = Annotated[IngestService, Depends(ingest_service)]
OperatorDep = Annotated[str | None, Depends(operator)]
