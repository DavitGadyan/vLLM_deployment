"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "@/lib/utils";

/**
 * Form field primitives.
 *
 * The `Field` wrapper exists so label, description and error are wired to the
 * control by id every time. Doing that by hand at each call site is how inputs
 * end up with a label that is not actually associated with them and an error
 * message a screen reader never announces.
 */

export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn("text-sm font-medium text-primary", className)}
    {...props}
  />
));
Label.displayName = "Label";

const inputStyles = cn(
  "w-full rounded-md border border-border bg-surface px-3 text-sm text-primary",
  "placeholder:text-tertiary transition-colors",
  "hover:border-border-strong",
  "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-60",
  "aria-[invalid=true]:border-danger",
);

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(inputStyles, "h-9", className)} {...props} />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(inputStyles, "min-h-20 resize-y py-2 leading-relaxed", className)}
    {...props}
  />
));
Textarea.displayName = "Textarea";

interface FieldProps {
  label: string;
  htmlFor: string;
  description?: string;
  error?: string;
  optional?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Field({
  label,
  htmlFor,
  description,
  error,
  optional,
  children,
  className,
}: FieldProps) {
  const descriptionId = description ? `${htmlFor}-description` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={htmlFor}>{label}</Label>
        {optional ? (
          <span className="text-xs text-tertiary">Optional</span>
        ) : null}
      </div>

      {description ? (
        <p id={descriptionId} className="text-xs leading-relaxed text-secondary">
          {description}
        </p>
      ) : null}

      {/* Clone rather than expecting each call site to remember the wiring. */}
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            id: htmlFor,
            "aria-invalid": error ? true : undefined,
            "aria-describedby":
              [descriptionId, errorId].filter(Boolean).join(" ") || undefined,
          })
        : children}

      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
