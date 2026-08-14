"use client";

import * as React from "react";

import { CitationChip } from "@/components/chat/citation-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertIcon, CheckIcon, CopyIcon, RetryIcon, UserIcon } from "@/components/ui/icons";
import type { ChatMessage, Source } from "@/lib/types";
import { cn, segmentAnswer } from "@/lib/utils";

const ESCALATION_COPY: Record<string, string> = {
  model_sentinel: "The assistant could not answer this from the documentation.",
  low_retrieval_confidence: "No document matched this question closely enough.",
  no_documents: "No documentation has been indexed yet.",
  upstream_error: "The assistant is temporarily unavailable.",
};

export function MessageBubble({
  message,
  onRetry,
}: {
  message: ChatMessage;
  onRetry?: () => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[85%] items-start gap-3">
          <div className="rounded-lg rounded-tr-sm bg-surface-active px-3.5 py-2.5">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-primary">
              {message.content}
            </p>
          </div>
          <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-tertiary">
            <UserIcon className="size-3.5" />
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-w-[92%] flex-col gap-2">
      <AssistantBody message={message} />

      {message.escalated ? (
        <EscalationNotice reason={message.escalationReason} />
      ) : null}

      {message.ungroundedClaim ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2">
          <AlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning-text" />
          <p className="text-xs leading-relaxed text-warning-text">
            This answer states specific figures without citing a source. Verify it
            before relying on it.
          </p>
        </div>
      ) : null}

      {message.error ? (
        <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger-subtle px-3 py-2">
          <AlertIcon className="mt-0.5 size-3.5 shrink-0 text-danger-text" />
          <div className="flex-1 space-y-2">
            <p className="text-xs leading-relaxed text-danger-text">{message.error}</p>
            {onRetry ? (
              <Button variant="secondary" size="sm" onClick={onRetry}>
                <RetryIcon />
                Try again
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {!message.streaming && message.content ? (
        <MessageFooter message={message} />
      ) : null}
    </div>
  );
}

function AssistantBody({ message }: { message: ChatMessage }) {
  const { sources } = message;
  const sourceByMarker = React.useMemo(() => {
    const map = new Map<number, Source>();
    for (const source of sources) map.set(source.marker, source);
    return map;
  }, [sources]);

  if (!message.content && message.streaming) {
    return (
      <p className="text-sm text-tertiary" aria-live="polite">
        <span className="sr-only">Assistant is thinking</span>
        <span aria-hidden>Thinking</span>
        <span className="caret-blink" aria-hidden />
      </p>
    );
  }

  const segments = segmentAnswer(message.content);

  return (
    <div
      className={cn(
        "text-sm leading-relaxed text-primary",
        message.streaming && "caret-blink",
      )}
    >
      {/* Paragraph breaks are preserved; markers become interactive chips. */}
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index} className="whitespace-pre-wrap">
            {segment.value}
          </span>
        ) : (
          <CitationChip
            key={index}
            marker={segment.marker}
            source={sourceByMarker.get(segment.marker)}
          />
        ),
      )}
    </div>
  );
}

function EscalationNotice({ reason }: { reason: string | null }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-md border border-accent/30 bg-accent-subtle px-3 py-2.5"
    >
      <AlertIcon className="mt-0.5 size-4 shrink-0 text-accent-text" />
      <div className="space-y-0.5">
        <p className="text-xs font-semibold text-accent-text">Handed off to a person</p>
        <p className="text-xs leading-relaxed text-accent-text/90">
          {ESCALATION_COPY[reason ?? ""] ??
            "This question needs a human."}{" "}
          A team member will pick this up.
        </p>
      </div>
    </div>
  );
}

function MessageFooter({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pt-0.5">
      <Button variant="ghost" size="sm" onClick={copy} aria-label="Copy answer">
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy"}
      </Button>

      {message.citations.length > 0 ? (
        <Badge variant="neutral">
          {message.citations.length} source
          {message.citations.length === 1 ? "" : "s"} cited
        </Badge>
      ) : null}

      {message.stats?.ttftMs != null ? (
        <span className="text-xs tabular-nums text-tertiary">
          {message.stats.ttftMs} ms to first token
          {message.stats.totalMs != null ? ` · ${message.stats.totalMs} ms total` : ""}
        </span>
      ) : null}

      {/* Surfacing cached prefill tokens makes the prefix cache observable from
          the product side, not only on the Grafana dashboard. */}
      {message.stats?.cachedPromptTokens ? (
        <Badge variant="success">
          {message.stats.cachedPromptTokens} prompt tokens cached
        </Badge>
      ) : null}
    </div>
  );
}
