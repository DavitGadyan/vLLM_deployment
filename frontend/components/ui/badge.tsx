import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "bg-surface-hover text-secondary",
        accent: "bg-accent-subtle text-accent-text",
        success: "bg-success-subtle text-success-text",
        warning: "bg-warning-subtle text-warning-text",
        danger: "bg-danger-subtle text-danger-text",
        outline: "border border-border text-secondary",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** A coloured dot carries no meaning to a screen reader, so pair it with text. */
export function StatusDot({
  tone,
  className,
}: {
  tone: "success" | "warning" | "danger" | "neutral";
  className?: string;
}) {
  const colors = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    neutral: "bg-tertiary",
  } as const;

  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.5 rounded-full", colors[tone], className)}
    />
  );
}
