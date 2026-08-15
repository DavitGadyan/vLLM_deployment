"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertIcon, CheckIcon } from "@/components/ui/icons";
import { api, ApiError } from "@/lib/api";
import type { AnswerVariant, CompareResult } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Ask one question, get two answers, pick the better one.
 *
 * The strongest signal the product can collect. Asked to score a single answer
 * out of five people disagree wildly; asked which of two is better they largely
 * agree — and the result is a `(prompt, chosen, rejected)` triple, which is
 * exactly what preference training consumes.
 *
 * Both sides receive identical retrieved context, so the judgement is about the
 * model rather than about which candidate happened to be handed better
 * documents. Which variant is which is **not** shown until after the choice:
 * knowing that A is "the current settings" is enough to bias the answer toward
 * it, and a preference set with that bias baked in teaches the model to prefer
 * whatever it already does.
 */
export function ComparePanel({ conversationId }: { conversationId: string | null }) {
  const [question, setQuestion] = React.useState("");
  const [result, setResult] = React.useState<CompareResult | null>(null);
  const [chosen, setChosen] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function run() {
    const text = question.trim();
    if (!text || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setChosen(null);
    try {
      setResult(await api.compareAnswers(text, conversationId));
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "Could not generate the comparison.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function choose(winner: AnswerVariant) {
    if (!result || chosen) return;
    const loser = result.variants.find((v) => v.label !== winner.label);
    if (!loser) return;

    setChosen(winner.label);
    try {
      await api.submitFeedback({
        kind: "preference",
        conversation_id: result.conversation_id,
        question: result.question,
        chosen_answer: winner.content,
        rejected_answer: loser.content,
        chosen_variant: winner.label,
        variant_params: { chosen: winner.params, rejected: loser.params },
      });
    } catch (cause) {
      setChosen(null);
      setError(cause instanceof ApiError ? cause.message : "Could not record that choice.");
    }
  }

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold text-primary">Compare two answers</h2>
        <p className="text-xs leading-relaxed text-secondary">
          The same question answered twice, with identical retrieved context. Pick
          the better one — that judgement becomes a training example. Costs two
          generations, so this is an operator tool rather than the customer path.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="compare-question" className="sr-only">
          Question to compare
        </label>
        <input
          id="compare-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void run();
            }
          }}
          maxLength={8000}
          placeholder="Ask something a customer would ask…"
          className={cn(
            "h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-3",
            "text-sm text-primary placeholder:text-tertiary",
            "focus:border-accent focus:outline-none",
          )}
        />
        <Button onClick={() => void run()} disabled={loading || !question.trim()}>
          {loading ? "Generating both…" : "Generate two answers"}
        </Button>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger-subtle px-3 py-2">
          <AlertIcon className="mt-0.5 size-3.5 shrink-0 text-danger-text" />
          <p className="text-xs leading-relaxed text-danger-text">{error}</p>
        </div>
      ) : null}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {["A", "B"].map((label) => (
            <div key={label} className="space-y-2 rounded-lg border border-border p-3">
              <div className="skeleton h-3 w-16 rounded" />
              <div className="skeleton h-3 w-full rounded" />
              <div className="skeleton h-3 w-11/12 rounded" />
              <div className="skeleton h-3 w-4/5 rounded" />
            </div>
          ))}
        </div>
      ) : null}

      {result ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {result.variants.map((variant) => (
              <VariantCard
                key={variant.label}
                variant={variant}
                chosen={chosen}
                onChoose={() => void choose(variant)}
              />
            ))}
          </div>

          {chosen ? (
            <div className="flex items-start gap-2 rounded-md border border-success/40 bg-success-subtle px-3 py-2">
              <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success-text" />
              <p className="text-xs leading-relaxed text-success-text">
                Recorded as a preference pair. It exports straight into the next
                training run — and the sampling settings behind each answer are
                revealed above now that the choice cannot be biased by them.
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function VariantCard({
  variant,
  chosen,
  onChoose,
}: {
  variant: AnswerVariant;
  chosen: string | null;
  onChoose: () => void;
}) {
  const won = chosen === variant.label;
  const decided = chosen !== null;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3 transition-colors",
        won ? "border-success bg-success-subtle/30" : "border-border",
        decided && !won && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-primary">Answer {variant.label}</span>
        <div className="flex items-center gap-1.5">
          {variant.escalated ? <Badge variant="accent">escalated</Badge> : null}
          {/* Revealed only after the choice — see the component docstring. */}
          {decided && typeof variant.params.temperature === "number" ? (
            <Badge variant="neutral">temp {String(variant.params.temperature)}</Badge>
          ) : null}
        </div>
      </div>

      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-primary">
        {variant.content}
      </p>

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        {variant.total_ms != null ? (
          <span className="text-[10px] tabular-nums text-tertiary">{variant.total_ms} ms</span>
        ) : (
          <span />
        )}
        <Button
          size="sm"
          variant={won ? "primary" : "secondary"}
          onClick={onChoose}
          disabled={decided}
        >
          {won ? "✓ Chosen" : "This one is better"}
        </Button>
      </div>
    </div>
  );
}
