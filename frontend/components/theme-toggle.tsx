"use client";

import { useSyncExternalStore } from "react";

import { MoonIcon, SunIcon } from "@/components/ui/icons";
import {
  getServerSnapshot,
  getSnapshot,
  setTheme,
  subscribe,
  type Theme,
} from "@/lib/theme-store";
import { cn } from "@/lib/utils";

const OPTIONS: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: "light", label: "Light", icon: <SunIcon className="size-3.5" /> },
  { value: "dark", label: "Dark", icon: <MoonIcon className="size-3.5" /> },
  { value: "system", label: "Match system", icon: <span className="text-[10px]">Auto</span> },
];

/**
 * Three-state theme control.
 *
 * "System" is a real, selectable option rather than an initial guess that
 * silently hardens into an explicit choice the first time someone clicks.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-border p-0.5",
        className,
      )}
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={theme === option.value}
          aria-label={option.label}
          onClick={() => setTheme(option.value)}
          className={cn(
            "flex h-6 min-w-6 items-center justify-center rounded px-1.5 transition-colors",
            theme === option.value
              ? "bg-surface-active text-primary"
              : "text-tertiary hover:text-primary",
          )}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}
