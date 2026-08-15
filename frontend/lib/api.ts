import type {
  CompareResult,
  ConfigVersion,
  ConfigVersionSummary,
  DocumentChunk,
  FeedbackPayload,
  KnowledgeDocument,
  PromptPreview,
} from "@/lib/types";
import type { ConfigFormValues } from "@/lib/schemas";

/**
 * Browser-side client.
 *
 * Every call goes to a Next.js route handler under /api, never directly to the
 * backend. The browser therefore never learns the backend's address and never
 * holds a credential — the proxy layer is the only thing that does.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let detail: unknown;
    let message = `Request failed (${response.status})`;
    try {
      detail = await response.json();
      const parsed = detail as { detail?: unknown };
      if (typeof parsed.detail === "string") message = parsed.detail;
    } catch {
      // Non-JSON error body; keep the status-derived message.
    }
    throw new ApiError(message, response.status, detail);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  getConfig: () => request<ConfigVersion>("/api/config"),

  saveConfig: (values: ConfigFormValues) =>
    request<ConfigVersion>("/api/config", {
      method: "PUT",
      body: JSON.stringify(values),
    }),

  previewPrompt: (values: ConfigFormValues) =>
    request<PromptPreview>("/api/config/preview", {
      method: "POST",
      body: JSON.stringify(values),
    }),

  listVersions: () => request<ConfigVersionSummary[]>("/api/config/versions"),

  getVersion: (id: string) => request<ConfigVersion>(`/api/config/versions/${id}`),

  activateVersion: (id: string) =>
    request<ConfigVersion>(`/api/config/versions/${id}/activate`, { method: "POST" }),

  listDocuments: () => request<KnowledgeDocument[]>("/api/documents"),

  uploadDocument: (file: File, title?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (title) form.append("title", title);
    return request<{ document: KnowledgeDocument; created: boolean }>("/api/documents", {
      method: "POST",
      body: form,
    });
  },

  deleteDocument: (id: string) =>
    request<void>(`/api/documents/${id}`, { method: "DELETE" }),

  getChunk: (id: string) => request<DocumentChunk>(`/api/documents/chunks/${id}`),

  submitFeedback: (payload: FeedbackPayload) =>
    request<{ id: string; kind: string; created_at: string }>("/api/feedback", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  compareAnswers: (message: string, conversationId?: string | null) =>
    request<CompareResult>("/api/feedback/compare", {
      method: "POST",
      body: JSON.stringify({ message, conversation_id: conversationId ?? null }),
    }),
};
