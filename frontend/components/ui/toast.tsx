"use client";

import * as React from "react";

import { AlertIcon, CheckIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Minimal toast system.
 *
 * The region is an `aria-live` polite landmark so "Configuration saved" is
 * announced rather than only shown — a save confirmation nobody perceives is
 * the same as no confirmation.
 */

type ToastTone = "success" | "error" | "info";

interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastContextValue {
  toast: (toast: Omit<Toast, "id">) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

const DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const dismiss = React.useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = React.useCallback(
    (input: Omit<Toast, "id">) => {
      const id = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
      setToasts((current) => [...current, { ...input, id }]);
      window.setTimeout(() => dismiss(id), DISMISS_MS);
    },
    [dismiss],
  );

  const value = React.useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="region"
        aria-live="polite"
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((item) => (
          <div
            key={item.id}
            className={cn(
              "pointer-events-auto flex items-start gap-2.5 rounded-md border px-3.5 py-3",
              "bg-surface-raised shadow-panel",
              item.tone === "error" ? "border-danger/40" : "border-border",
            )}
          >
            {item.tone === "success" ? (
              <CheckIcon className="mt-0.5 size-4 shrink-0 text-success-text" />
            ) : item.tone === "error" ? (
              <AlertIcon className="mt-0.5 size-4 shrink-0 text-danger-text" />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-primary">{item.title}</p>
              {item.description ? (
                <p className="mt-0.5 text-xs leading-relaxed text-secondary">
                  {item.description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              className="rounded-sm p-0.5 text-tertiary transition-colors hover:text-primary"
              aria-label="Dismiss notification"
            >
              <svg
                viewBox="0 0 24 24"
                className="size-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within a ToastProvider");
  return context;
}
