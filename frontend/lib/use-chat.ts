"use client";

import { useCallback, useRef, useState } from "react";

import type { ChatMessage, Source, StreamEvent } from "@/lib/types";

/**
 * Chat state and SSE consumption.
 *
 * Uses `fetch` with a manual stream reader rather than `EventSource`, because
 * EventSource cannot issue a POST and cannot be aborted cleanly. Aborting
 * matters: the AbortSignal propagates to the backend, which drops the upstream
 * vLLM request, which frees KV cache blocks. A stop button that only hides the
 * output would keep burning GPU time on tokens nobody reads.
 */

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function emptyAssistant(): ChatMessage {
  return {
    id: newId(),
    role: "assistant",
    content: "",
    sources: [],
    citations: [],
    escalated: false,
    escalationReason: null,
    ungroundedClaim: false,
    streaming: true,
    error: null,
    stats: null,
  };
}

export interface UseChatResult {
  messages: ChatMessage[];
  isStreaming: boolean;
  /**
   * The server-assigned conversation id, once one exists.
   *
   * Exposed because feedback is attached to a conversation, and the id only
   * arrives on the `start` frame of the first exchange — a caller that guessed
   * it would silently record judgements against nothing.
   */
  conversationId: string | null;
  send: (text: string) => Promise<void>;
  stop: () => void;
  retryLast: () => Promise<void>;
  reset: () => void;
}

export function useChat(): UseChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  // Kept in both a ref and state on purpose: `run` reads the ref synchronously
  // while building the next request body, and consumers need the state to
  // re-render once an id exists.
  const conversationId = useRef<string | null>(null);
  const [conversationIdValue, setConversationIdValue] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastQuestion = useRef<string | null>(null);

  const patchLast = useCallback((patch: Partial<ChatMessage>) => {
    setMessages((current) => {
      if (current.length === 0) return current;
      const next = [...current];
      const last = next[next.length - 1];
      if (!last || last.role !== "assistant") return current;
      next[next.length - 1] = { ...last, ...patch };
      return next;
    });
  }, []);

  const appendDelta = useCallback((text: string) => {
    setMessages((current) => {
      if (current.length === 0) return current;
      const next = [...current];
      const last = next[next.length - 1];
      if (!last || last.role !== "assistant") return current;
      next[next.length - 1] = { ...last, content: last.content + text };
      return next;
    });
  }, []);

  const run = useCallback(
    async (text: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      lastQuestion.current = text;
      setIsStreaming(true);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            conversation_id: conversationId.current,
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          patchLast({
            streaming: false,
            error: "The assistant is unavailable right now. Please try again.",
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line. A frame may arrive split
          // across chunks, so anything after the last separator stays buffered.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const dataLine = frame
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (!dataLine) continue;

            let event: StreamEvent;
            try {
              event = JSON.parse(dataLine.slice(6)) as StreamEvent;
            } catch {
              continue;
            }

            switch (event.type) {
              case "start":
                conversationId.current = event.data.conversation_id;
                setConversationIdValue(event.data.conversation_id);
                break;
              case "citations":
                patchLast({ sources: event.data.sources });
                break;
              case "delta":
                appendDelta(event.data.text);
                break;
              case "escalation":
                patchLast({
                  escalated: true,
                  escalationReason: event.data.reason,
                });
                break;
              case "done":
                patchLast({
                  streaming: false,
                  citations: (event.data.citations ?? []) as Source[],
                  escalated: event.data.escalated ?? false,
                  escalationReason: event.data.reason ?? null,
                  ungroundedClaim: event.data.ungrounded_claim ?? false,
                  stats: {
                    ttftMs: event.data.ttft_ms ?? null,
                    totalMs: event.data.total_ms ?? null,
                    promptTokens: event.data.prompt_tokens ?? null,
                    completionTokens: event.data.completion_tokens ?? null,
                    cachedPromptTokens: event.data.cached_prompt_tokens ?? null,
                  },
                });
                break;
              case "error":
                patchLast({ streaming: false, error: event.data.message });
                break;
            }
          }
        }

        // Server closed without a terminal event (pod restart, proxy timeout).
        patchLast({ streaming: false });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // User pressed stop. Keep the partial answer — it is often useful —
          // and mark it as no longer streaming.
          patchLast({ streaming: false });
        } else {
          patchLast({
            streaming: false,
            error: "Lost connection while generating the response.",
          });
        }
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
      }
    },
    [appendDelta, patchLast],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || abortRef.current) return;

      setMessages((current) => [
        ...current,
        {
          id: newId(),
          role: "user",
          content: trimmed,
          sources: [],
          citations: [],
          escalated: false,
          escalationReason: null,
          ungroundedClaim: false,
          streaming: false,
          error: null,
          stats: null,
        },
        emptyAssistant(),
      ]);

      await run(trimmed);
    },
    [run],
  );

  const retryLast = useCallback(async () => {
    const question = lastQuestion.current;
    if (!question || abortRef.current) return;

    // Replace the failed assistant turn rather than appending a second one.
    setMessages((current) => {
      const next = [...current];
      if (next[next.length - 1]?.role === "assistant") next.pop();
      return [...next, emptyAssistant()];
    });

    await run(question);
  }, [run]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    conversationId.current = null;
    setConversationIdValue(null);
    lastQuestion.current = null;
    setMessages([]);
  }, []);

  return {
    messages,
    isStreaming,
    conversationId: conversationIdValue,
    send,
    stop,
    retryLast,
    reset,
  };
}
