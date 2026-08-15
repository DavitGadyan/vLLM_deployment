"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { SendIcon, StopIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

const MAX_LENGTH = 8000;

export function Composer({
  onSend,
  onStop,
  isStreaming,
  disabled,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Grow with content up to a ceiling, then scroll. A fixed one-line input
  // hides what the user typed; an unbounded one pushes the conversation off
  // screen.
  React.useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [value]);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || isStreaming || disabled) return;
    onSend(trimmed);
    setValue("");
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter is a newline — the convention every chat
    // interface uses, so deviating from it costs users a mis-sent message.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  const overLimit = value.length > MAX_LENGTH;

  return (
    /* No top border: the controls row directly above already carries one, and
       two rules two rows apart reads as a rendering fault.
       Weighted toward the bottom, because the composer is the last thing on the
       page and sitting flush against the window edge makes it look clipped. */
    <div className="bg-surface px-4 pb-6 pt-3 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={cn(
            "flex items-end gap-2 rounded-lg border border-border bg-surface-raised p-2",
            "transition-colors focus-within:border-border-strong",
            overLimit && "border-danger",
          )}
        >
          <label htmlFor="composer" className="sr-only">
            Message
          </label>
          <textarea
            id="composer"
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a customer support question…"
            aria-invalid={overLimit || undefined}
            aria-describedby={overLimit ? "composer-limit" : undefined}
            className={cn(
              "max-h-[200px] flex-1 resize-none bg-transparent px-1.5 py-1.5",
              "text-sm leading-relaxed text-primary outline-none",
              "placeholder:text-tertiary disabled:opacity-60",
            )}
          />

          {isStreaming ? (
            <Button variant="secondary" size="icon" onClick={onStop} aria-label="Stop generating">
              <StopIcon />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={submit}
              disabled={!value.trim() || overLimit || disabled}
              aria-label="Send message"
            >
              <SendIcon />
            </Button>
          )}
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-3 px-1">
          <p className="text-xs text-tertiary">
            <kbd className="font-sans font-medium">Enter</kbd> to send ·{" "}
            <kbd className="font-sans font-medium">Shift+Enter</kbd> for a new line
          </p>
          {value.length > MAX_LENGTH * 0.8 ? (
            <p
              id="composer-limit"
              className={cn(
                "text-xs tabular-nums",
                overLimit ? "font-medium text-danger-text" : "text-tertiary",
              )}
            >
              {value.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
