"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ThemeToggle } from "@/components/theme-toggle";
import { ChartIcon, ChatIcon, GraphIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Three primary tabs.
 *
 * Product is the working demo — chat, plus Configuration and Knowledge Base as
 * sub-views, because those are part of the product rather than separate tools.
 * Architecture explains the system. Monitoring proves it works.
 *
 * `match` decides which tab is highlighted, so /config and /knowledge keep their
 * URLs and still light up Product.
 */
const NAV = [
  {
    href: "/",
    label: "Product",
    icon: ChatIcon,
    description: "Chat, configuration and knowledge base",
    match: ["/", "/config", "/knowledge"],
  },
  {
    href: "/architecture",
    label: "Architecture",
    icon: GraphIcon,
    description: "How it works, and what each part is worth",
    match: ["/architecture"],
  },
  {
    href: "/monitoring",
    label: "Monitoring",
    icon: ChartIcon,
    description: "Quality, performance, security and audit",
    match: ["/monitoring"],
  },
] as const;

const PRODUCT_ROUTES = [
  { href: "/", label: "Chat" },
  { href: "/config", label: "Configuration" },
  { href: "/knowledge", label: "Knowledge base" },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    /*
     * The shell owns the viewport; `main` is the only thing that scrolls.
     *
     * Previously each full-height view subtracted the header height itself
     * (`h-[calc(100dvh-3.5rem)]`). That is wrong the moment a view also has the
     * Product sub-nav above it — the chat composer was pushed exactly one
     * sub-nav below the fold. Making the chrome `shrink-0` and `main` a
     * `min-h-0` flex child means a full-height view is just `h-full`, and it
     * stays correct however the chrome changes.
     */
    <div className="flex h-dvh flex-col overflow-hidden">
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

      <header className="z-40 shrink-0 border-b border-border bg-surface/95 backdrop-blur">
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
              const active = item.match.some((path) =>
                path === "/" ? pathname === "/" : pathname.startsWith(path),
              );
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

      {/* Secondary nav for the Product tab's sub-views. Only rendered where it
          applies, so Architecture and Monitoring keep the full viewport — both
          are full-bleed views that a second bar would crowd. */}
      {PRODUCT_ROUTES.some((r) => (r.href === "/" ? pathname === "/" : pathname.startsWith(r.href))) ? (
        <div className="shrink-0 border-b border-border bg-surface-sunken">
          <nav
            aria-label="Product"
            className="mx-auto flex w-full max-w-7xl items-center gap-1 px-4 py-1.5 sm:px-6"
          >
            {PRODUCT_ROUTES.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs transition-colors",
                    active
                      ? "bg-surface-active font-medium text-primary"
                      : "text-secondary hover:text-primary",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      ) : null}

      <main id="main" className="min-h-0 flex-1 overflow-y-auto">
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
