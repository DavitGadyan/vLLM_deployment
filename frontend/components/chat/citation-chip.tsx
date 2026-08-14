"use client";

import * as React from "react";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { DocumentChunk, Source } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * An inline `[n]` marker rendered as a chip that opens the exact source text.
 *
 * This is what separates a citation from decoration. The chip resolves to the
 * specific chunk the retriever supplied, so a user can check the claim against
 * the document rather than taking the model's word for it.
 */
export function CitationChip({ marker, source }: { marker: number; source?: Source }) {
  const [open, setOpen] = React.useState(false);
  const [chunk, setChunk] = React.useState<DocumentChunk | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Unresolved marker: the model cited a source that was not in its context.
  // Render as plain text rather than a chip that would open nothing.
  if (!source) {
    return <span className="text-tertiary">[{marker}]</span>;
  }

  async function load() {
    if (chunk || !source) return;
    setLoading(true);
    setError(null);
    try {
      setChunk(await api.getChunk(source.chunk_id));
    } catch {
      setError("This source is no longer available — the document may have been removed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          void load();
        }}
        aria-label={`Source ${marker}: ${source.document_title}`}
        className={cn(
          "mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded px-1",
          "align-super text-[10px] font-semibold leading-none",
          "bg-accent-subtle text-accent-text transition-colors hover:bg-accent hover:text-white",
        )}
      >
        {marker}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{source.document_title}</DialogTitle>
            <DialogDescription>
              {source.heading ? `${source.heading} · ` : ""}
              Relevance {(source.score * 100).toFixed(0)}%
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {loading ? (
              <div className="space-y-2" aria-live="polite">
                <span className="sr-only">Loading source</span>
                <div className="skeleton h-3 w-full rounded" />
                <div className="skeleton h-3 w-11/12 rounded" />
                <div className="skeleton h-3 w-4/5 rounded" />
              </div>
            ) : error ? (
              <p className="text-sm text-danger-text">{error}</p>
            ) : chunk ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-primary">
                {chunk.text}
              </p>
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
