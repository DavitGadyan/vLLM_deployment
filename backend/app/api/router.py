from fastapi import APIRouter

from app.api import chat, config, documents

api_router = APIRouter(prefix="/v1")
api_router.include_router(config.router)
api_router.include_router(documents.router)
api_router.include_router(chat.router)

__all__ = ["api_router"]
