export type Tone =
  | "professional"
  | "friendly"
  | "concise"
  | "formal"
  | "empathetic";

export interface Policy {
  title: string;
  body: string;
}

export interface ConfigVersion {
  id: string;
  version: number;
  company_name: string;
  agent_name: string;
  support_email: string | null;
  support_url: string | null;
  tone: Tone;
  languages: string[];
  greeting: string | null;
  signature: string | null;
  policies: Policy[];
  escalation_rules: string | null;
  forbidden_topics: string[];
  custom_instructions: string | null;
  temperature: number | null;
  max_output_tokens: number | null;
  retrieval_top_k: number | null;
  retrieval_min_score: number | null;
  compiled_prompt: string;
  compiled_prompt_hash: string;
  compiled_prompt_tokens: number;
  change_note: string | null;
  created_by: string | null;
  created_at: string;
  is_active: boolean;
}

export interface ConfigVersionSummary {
  id: string;
  version: number;
  company_name: string;
  compiled_prompt_hash: string;
  compiled_prompt_tokens: number;
  change_note: string | null;
  created_by: string | null;
  created_at: string;
  is_active: boolean;
}

export interface PromptPreview {
  compiled_prompt: string;
  compiled_prompt_hash: string;
  compiled_prompt_tokens: number;
  /** True when saving would leave vLLM's prefix cache warm. */
  matches_active: boolean;
}

export type DocumentStatus = "pending" | "processing" | "ready" | "failed";

export interface KnowledgeDocument {
  id: string;
  title: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  status: DocumentStatus;
  error: string | null;
  chunk_count: number;
  created_at: string;
  indexed_at: string | null;
}

export interface DocumentChunk {
  id: string;
  document_id: string;
  ordinal: number;
  heading: string | null;
  text: string;
  token_count: number;
}

export interface Source {
  marker: number;
  chunk_id: string;
  document_id: string;
  document_title: string;
  heading: string | null;
  score: number;
}

export type EscalationReason =
  | "model_sentinel"
  | "low_retrieval_confidence"
  | "no_documents"
  | "upstream_error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: Source[];
  citations: Source[];
  escalated: boolean;
  escalationReason: EscalationReason | null;
  ungroundedClaim: boolean;
  streaming: boolean;
  error: string | null;
  stats: {
    ttftMs: number | null;
    totalMs: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    cachedPromptTokens: number | null;
  } | null;
}

/** Discriminated union matching `backend/app/schemas/chat.py`. */
export type StreamEvent =
  | { type: "start"; data: { conversation_id: string; config_version: number } }
  | { type: "delta"; data: { text: string } }
  | { type: "citations"; data: { sources: Source[] } }
  | { type: "escalation"; data: { reason: EscalationReason; message: string } }
  | {
      type: "done";
      data: {
        citations?: Source[];
        escalated?: boolean;
        reason?: EscalationReason;
        ungrounded_claim?: boolean;
        prompt_tokens?: number | null;
        completion_tokens?: number | null;
        cached_prompt_tokens?: number | null;
        ttft_ms?: number | null;
        total_ms?: number | null;
      };
    }
  | { type: "error"; data: { message: string; retryable?: boolean } };

/** Feedback payloads, mirroring `backend/app/schemas/feedback.py`. */
export type FeedbackPayload =
  | {
      kind: "rating";
      conversation_id: string;
      message_id?: string | null;
      rating: 1 | -1;
      comment?: string | null;
    }
  | {
      kind: "comment";
      conversation_id: string;
      message_id?: string | null;
      comment: string;
    }
  | {
      kind: "preference";
      conversation_id?: string | null;
      question: string;
      chosen_answer: string;
      rejected_answer: string;
      chosen_variant?: string | null;
      variant_params?: Record<string, unknown> | null;
      comment?: string | null;
    };

export interface AnswerVariant {
  label: "A" | "B";
  content: string;
  citations: Source[];
  escalated: boolean;
  params: Record<string, unknown>;
  total_ms: number | null;
}

export interface CompareResult {
  question: string;
  conversation_id: string | null;
  config_version: number | null;
  variants: AnswerVariant[];
}
