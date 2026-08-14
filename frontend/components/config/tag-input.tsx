"use client";

import * as React from "react";

import { Input } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/**
 * Editable list of short strings (languages, restricted topics).
 *
 * Entries commit on Enter or comma. Backspace on an empty field removes the
 * last one, which is the behaviour people expect from a tag field and is much
 * faster than reaching for a mouse.
 */
export function TagInput({
  id,
  value,
  onChange,
  placeholder,
  maxItems = 50,
  ariaLabel,
}: {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  maxItems?: number;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = React.useState("");

  function commit(raw: string) {
    const entry = raw.trim();
    // Case-insensitive dedupe: "English" and "english" are the same language,
    // and both in the prompt just wastes tokens.
    if (
      !entry ||
      value.length >= maxItems ||
      value.some((item) => item.toLowerCase() === entry.toLowerCase())
    ) {
      setDraft("");
      return;
    }
    onChange([...value, entry]);
    setDraft("");
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
      return;
    }
    if (event.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={ariaLabel}>
          {value.map((item, index) => (
            <li key={`${item}-${index}`}>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border border-border",
                  "bg-surface py-0.5 pl-2.5 pr-1 text-xs text-primary",
                )}
              >
                {item}
                <button
                  type="button"
                  onClick={() => onChange(value.filter((_, i) => i !== index))}
                  aria-label={`Remove ${item}`}
                  className="rounded-full p-0.5 text-tertiary transition-colors hover:bg-surface-active hover:text-primary"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="size-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    aria-hidden
                  >
                    <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <Input
        id={id}
        value={draft}
        placeholder={placeholder}
        disabled={value.length >= maxItems}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        // Commit whatever is typed when focus leaves, so a half-entered value
        // is not silently discarded on save.
        onBlur={() => commit(draft)}
      />
    </div>
  );
}
