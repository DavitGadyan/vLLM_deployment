"""Config console request/response schemas.

The validation rules here are mirrored by a Zod schema in
`frontend/lib/schemas.ts`. Client-side validation exists for the immediate
feedback; this is the one that actually enforces.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Tone = Literal["professional", "friendly", "concise", "formal", "empathetic"]


class PolicyItem(BaseModel):
    title: Annotated[str, Field(min_length=1, max_length=120)]
    body: Annotated[str, Field(min_length=1, max_length=8000)]

    @field_validator("title", "body")
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()


class ConfigPayload(BaseModel):
    """A proposed configuration. Saving one creates a new immutable version."""

    model_config = ConfigDict(str_strip_whitespace=True)

    company_name: Annotated[str, Field(min_length=1, max_length=200)]
    agent_name: Annotated[str, Field(min_length=1, max_length=120)] = "Support"
    support_email: Annotated[str | None, Field(max_length=320)] = None
    support_url: Annotated[str | None, Field(max_length=500)] = None

    tone: Tone = "professional"
    languages: Annotated[list[str], Field(max_length=20)] = Field(
        default_factory=lambda: ["English"]
    )
    greeting: Annotated[str | None, Field(max_length=500)] = None
    signature: Annotated[str | None, Field(max_length=500)] = None

    policies: Annotated[list[PolicyItem], Field(max_length=50)] = Field(default_factory=list)
    escalation_rules: Annotated[str | None, Field(max_length=4000)] = None
    forbidden_topics: Annotated[list[str], Field(max_length=50)] = Field(default_factory=list)
    custom_instructions: Annotated[str | None, Field(max_length=4000)] = None

    temperature: Annotated[float | None, Field(ge=0.0, le=2.0)] = None
    max_output_tokens: Annotated[int | None, Field(ge=64, le=4096)] = None
    retrieval_top_k: Annotated[int | None, Field(ge=1, le=20)] = None
    retrieval_min_score: Annotated[float | None, Field(ge=0.0, le=1.0)] = None

    change_note: Annotated[str | None, Field(max_length=500)] = None

    @field_validator("languages", "forbidden_topics")
    @classmethod
    def _clean_list(cls, value: list[str]) -> list[str]:
        return [item.strip() for item in value if item and item.strip()]

    @field_validator("support_email")
    @classmethod
    def _validate_email(cls, value: str | None) -> str | None:
        if value and "@" not in value:
            raise ValueError("support_email must be an email address")
        return value


class ConfigVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    version: int
    company_name: str
    agent_name: str
    support_email: str | None
    support_url: str | None
    tone: str
    languages: list[str]
    greeting: str | None
    signature: str | None
    policies: list[dict[str, str]]
    escalation_rules: str | None
    forbidden_topics: list[str]
    custom_instructions: str | None
    temperature: float | None
    max_output_tokens: int | None
    retrieval_top_k: int | None
    retrieval_min_score: float | None
    compiled_prompt: str
    compiled_prompt_hash: str
    compiled_prompt_tokens: int
    change_note: str | None
    created_by: str | None
    created_at: datetime
    is_active: bool = False


class ConfigVersionSummary(BaseModel):
    """Row in the version-history list — no prompt body, so the list stays light."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    version: int
    company_name: str
    compiled_prompt_hash: str
    compiled_prompt_tokens: int
    change_note: str | None
    created_by: str | None
    created_at: datetime
    is_active: bool = False


class PromptPreview(BaseModel):
    """Compiled prompt for an unsaved draft.

    Produced by the same compiler that runs on save, so what the operator sees
    in the preview pane is exactly what the model will receive.
    """

    compiled_prompt: str
    compiled_prompt_hash: str
    compiled_prompt_tokens: int
    # True when the draft compiles to the same prompt as the active version,
    # which means saving it will not disturb vLLM's prefix cache.
    matches_active: bool


class ActivateRequest(BaseModel):
    version_id: uuid.UUID
