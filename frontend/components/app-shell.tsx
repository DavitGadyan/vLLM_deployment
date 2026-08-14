"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ThemeToggle } from "@/components/theme-toggle";
import { ChatIcon, LibraryIcon, SettingsIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Chat", icon: ChatIcon, description: "Test the assistant" },
  {
    href: "/config",
    label: "Configuration",
    icon: SettingsIcon,
    description: "Company, voice and policies",
  },
  {
    href: "/knowledge",
    label: "Knowledge base",
    icon: LibraryIcon,
    description: "Documents the assistant can cite",
  },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Skip link — the first tabbable element, so keyboard users are not
          forced through the whole nav on every page. */}
      <a
        href="#main"
        className={cn(
          "sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50",
          "focus:rounded-md focus:bg-action focus:px-3 focus:py-2",
          "focus:text-sm focus:text-action-text",
        )}
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2 rounded-sm">
            <span className="flex size-6 items-center justify-center rounded bg-action text-[11px] font-semibold text-action-text">
              S
            </span>
            <span className="text-sm font-semibold tracking-tight text-primary">
              Support Console
            </span>
          </Link>

          <nav aria-label="Primary" className="flex items-center gap-1">
            {NAV.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-surface-active font-medium text-primary"
                      : "text-secondary hover:bg-surface-hover hover:text-primary",
                  )}
                >
                  <item.icon className="size-4" />
                  <span className="hidden sm:inline">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 pb-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-primary">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-sm leading-relaxed text-secondary">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
