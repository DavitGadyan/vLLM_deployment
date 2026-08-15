"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { AlertIcon, CheckIcon } from "@/components/ui/icons";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Thumbs and a note, under a finished answer.
 *
 * Placed here rather than in a survey afterwards because this is the one moment
 * the judgement is free: the reader has just finished the answer and already has
 * an opinion. Ask an hour later and you get recall instead.
 *
 * The comment box only appears after a verdict. Asking "why?" before anyone has
 * said whether it was good is a form with no context, and the extra step is what
 * makes the thumbs cheap enough to actually be pressed.
 *
 * A failed submission is shown, never swallowed. Feedback silently dropped is
 * worse than feedback not offered — the person believes they have corrected
 * something that was in fact discarded.
 */
export function FeedbackBar({
  conversationId,
  messageId,
}: {
  conversationId: string | null;
  messageId?: string | null;
}) {
  const [rating, setRating] = React.useState<1 | -1 | null>(null);
  const [comment, setComment] = React.useState("");
  const [commentSent, setCommentSent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // No conversation id yet means the backend never acknowledged the exchange,
  // so there is nothing to attach a judgement to.
  if (!conversationId) return null;

  async function rate(value: 1 | -1) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const previous = rating;
    // Optimistic: the control is the acknowledgement, and a spinner on a thumb
    // makes a one-click action feel like a form submission.
    setRating(value);
    try {
      await api.submitFeedback({
        kind: "rating",
        conversation_id: conversationId!,
        message_id: messageId ?? null,
        rating: value,
      });
    } catch (cause) {
      setRating(previous);
      setError(cause instanceof ApiError ? cause.message : "Could not send that.");
    } finally {
      setBusy(false);
    }
  }

  async function sendComment() {
    const text = comment.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.submitFeedback({
        kind: "comment",
        conversation_id: conversationId!,
        message_id: messageId ?? null,
        comment: text,
      });
      setCommentSent(true);
      setComment("");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not send that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 pt-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-tertiary">Was this helpful?</span>

        <ThumbButton
          direction="up"
          active={rating === 1}
          disabled={busy}
          onClick={() => rate(1)}
        />
        <ThumbButton
          direction="down"
          active={rating === -1}
          disabled={busy}
          onClick={() => rate(-1)}
        />

        {rating !== null && !commentSent ? (
          <span className="ml-1 inline-flex items-center gap-1 text-xs text-success-text">
            <CheckIcon className="size-3" />
            Thanks
          </span>
        ) : null}
      </div>

      {rating !== null && !commentSent ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <label htmlFor={`note-${messageId ?? conversationId}`} className="sr-only">
            What could have been better?
          </label>
          <input
            id={`note-${messageId ?? conversationId}`}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void sendComment();
              }
            }}
            maxLength={2000}
            placeholder={
              rating === 1 ? "What worked well? (optional)" : "What should it have said?"
            }
            className={cn(
              "h-7 min-w-0 flex-1 rounded-md border border-border bg-surface px-2",
              "text-xs text-primary placeholder:text-tertiary",
              "focus:border-accent focus:outline-none",
            )}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void sendComment()}
            disabled={busy || comment.trim().length === 0}
          >
            Send
          </Button>
        </div>
      ) : null}

      {commentSent ? (
        <p className="inline-flex items-center gap-1 text-xs text-success-text">
          <CheckIcon className="size-3" />
          Note recorded — it goes into the next training set.
        </p>
      ) : null}

      {error ? (
        <p className="inline-flex items-center gap-1 text-xs text-danger-text">
          <AlertIcon className="size-3" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ThumbButton({
  direction,
  active,
  disabled,
  onClick,
}: {
  direction: "up" | "down";
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = direction === "up" ? "Helpful" : "Not helpful";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md transition-colors",
        "text-tertiary hover:bg-surface-active hover:text-secondary",
        "disabled:pointer-events-none disabled:opacity-50",
        active && direction === "up" && "bg-success-subtle text-success-text",
        active && direction === "down" && "bg-danger-subtle text-danger-text",
      )}
    >
      <svg
        viewBox="0 0 24 24"
        className={cn("size-3.5", direction === "down" && "rotate-180")}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M7 22H4a1 1 0 0 1-1-1V12a1 1 0 0 1 1-1h3" />
        <path d="M7 11l4-8a2.5 2.5 0 0 1 2.5 3.2L12.8 10H19a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 17.6 21H7" />
      </svg>
    </button>
  );
}
