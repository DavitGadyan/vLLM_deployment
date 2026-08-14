"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PromptPreview as PromptPreviewData } from "@/lib/types";

/**
 * Live view of the compiled system prompt.
 *
 * This pane is what makes the configuration page inspectable instead of a black
 * box. The text shown here is produced by the same compiler that runs on save,
 * so an operator can see precisely how their wording becomes model behaviour —
 * and notice when a change did nothing.
 */
export function PromptPreview({
  preview,
  pending,
}: {
  preview: PromptPreviewData | null;
  pending: boolean;
}) {
  return (
    <Card className="sticky top-20 flex max-h-[calc(100dvh-6rem)] flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Compiled system prompt</CardTitle>
          {preview ? (
            <Badge variant="neutral">
              ~{preview.compiled_prompt_tokens.toLocaleString()} tokens
            </Badge>
          ) : null}
        </div>
        <CardDescription>
          Exactly what the model receives before every question. Rebuilt as you
          type.
        </CardDescription>

        {preview ? <CacheNotice matches={preview.matches_active} /> : null}
      </CardHeader>

      <CardContent className="flex-1 overflow-y-auto p-0">
        {pending && !preview ? (
          <div className="space-y-2 p-5" aria-live="polite">
            <span className="sr-only">Compiling prompt</span>
            <div className="skeleton h-3 w-3/4 rounded" />
            <div className="skeleton h-3 w-full rounded" />
            <div className="skeleton h-3 w-5/6 rounded" />
          </div>
        ) : preview ? (
          <pre className="whitespace-pre-wrap px-5 py-4 font-mono text-xs leading-relaxed text-secondary">
            {preview.compiled_prompt}
          </pre>
        ) : (
          <p className="p-5 text-xs text-tertiary">
            Fix the errors in the form to see the compiled prompt.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Whether saving will disturb vLLM's prefix cache.
 *
 * The compiled prompt is the token prefix every concurrent request shares.
 * Changing it invalidates cached prefill for all of them, so the first requests
 * after a save are slower. That is a normal cost of a real change — worth
 * surfacing so it is not mistaken for a regression, and so a cosmetic edit that
 * changes nothing can be recognised as free.
 */
function CacheNotice({ matches }: { matches: boolean }) {
  if (matches) {
    return (
      <p className="mt-2 text-xs text-secondary">
        Identical to the live prompt — saving will not affect response latency.
      </p>
    );
  }
  return (
    <p className="mt-2 text-xs text-secondary">
      Differs from the live prompt. Saving invalidates the shared prefix cache;
      expect briefly slower first responses while it refills.
    </p>
  );
}
