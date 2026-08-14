"use client";

import {
  useFieldArray,
  type Control,
  type FieldErrors,
  type UseFormRegister,
} from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/field";
import { PlusIcon, TrashIcon } from "@/components/ui/icons";
import type { ConfigFormValues } from "@/lib/schemas";

/**
 * Ordered list of company policies.
 *
 * Order is preserved into the compiled prompt, so it is meaningful: earlier
 * policies read as higher priority to the model. That is why entries can be
 * reordered rather than being an unordered set.
 */
export function PolicyEditor({
  control,
  register,
  errors,
}: {
  control: Control<ConfigFormValues>;
  register: UseFormRegister<ConfigFormValues>;
  errors: FieldErrors<ConfigFormValues>;
}) {
  const { fields, append, remove, move } = useFieldArray({ control, name: "policies" });

  return (
    <div className="space-y-3">
      {fields.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-xs text-secondary">
          No policies yet. Without them the assistant can only rely on uploaded
          documents, and has no rules about what it may or may not offer.
        </p>
      ) : null}

      {fields.map((field, index) => {
        const fieldErrors = errors.policies?.[index];
        return (
          <div key={field.id} className="rounded-md border border-border bg-surface p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded bg-surface-active text-[10px] font-semibold tabular-nums text-secondary">
                {index + 1}
              </span>

              <Label htmlFor={`policy-title-${index}`} className="sr-only">
                Policy {index + 1} title
              </Label>
              <Input
                id={`policy-title-${index}`}
                placeholder="Policy name, e.g. Refunds"
                aria-invalid={fieldErrors?.title ? true : undefined}
                {...register(`policies.${index}.title`)}
              />

              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                  aria-label={`Move ${field.title || `policy ${index + 1}`} up`}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
                    <path d="m18 15-6-6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={index === fields.length - 1}
                  onClick={() => move(index, index + 1)}
                  aria-label={`Move ${field.title || `policy ${index + 1}`} down`}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
                    <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 hover:text-danger-text"
                  onClick={() => remove(index)}
                  aria-label={`Remove ${field.title || `policy ${index + 1}`}`}
                >
                  <TrashIcon />
                </Button>
              </div>
            </div>

            {fieldErrors?.title ? (
              <p role="alert" className="mb-2 pl-7 text-xs font-medium text-danger-text">
                {fieldErrors.title.message}
              </p>
            ) : null}

            <Label htmlFor={`policy-body-${index}`} className="sr-only">
              Policy {index + 1} content
            </Label>
            <Textarea
              id={`policy-body-${index}`}
              rows={4}
              placeholder="Write the rule as you would tell a new support agent. Be specific about limits, timeframes and exceptions."
              aria-invalid={fieldErrors?.body ? true : undefined}
              {...register(`policies.${index}.body`)}
            />
            {fieldErrors?.body ? (
              <p role="alert" className="mt-1 text-xs font-medium text-danger-text">
                {fieldErrors.body.message}
              </p>
            ) : null}
          </div>
        );
      })}

      <Button
        variant="secondary"
        size="sm"
        onClick={() => append({ title: "", body: "" })}
        disabled={fields.length >= 50}
      >
        <PlusIcon />
        Add policy
      </Button>
    </div>
  );
}
