/**
 * Product marks for the detail panel.
 *
 * Hand-drawn simplified glyphs rather than fetched brand assets: the graph must
 * render offline and in CI, and a missing logo file in the middle of a client
 * demo is a worse outcome than a slightly simplified mark. Each is recognisable
 * at the size it is shown, and each sits next to the product name in text.
 *
 * Drop official SVGs into `public/logos/<key>.svg` and they will be preferred —
 * see `Logo` below.
 */

import { cn } from "@/lib/utils";

const MARKS: Record<string, { label: string; color: string; path?: string }> = {
  vllm: { label: "vLLM", color: "#f5a623" },
  qwen: { label: "Qwen", color: "#6b5ce7" },
  postgres: {
    label: "PostgreSQL",
    color: "#336791",
    path: "M12 2C7 2 4 4 4 8v6c0 4 2 8 5 8 1.5 0 2-1 2-3v-4m3-13c5 0 8 2 8 6v6c0 4-2 8-5 8-1.5 0-2-1-2-3V9",
  },
  prometheus: { label: "Prometheus", color: "#e6522c" },
  grafana: { label: "Grafana", color: "#f46800" },
  kubernetes: { label: "Kubernetes", color: "#326ce5" },
  nextjs: { label: "Next.js", color: "#111111" },
};

export function ProductMark({ logo, className }: { logo: string; className?: string }) {
  const mark = MARKS[logo];
  if (!mark) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border",
        "bg-surface px-2 py-0.5 text-xs font-medium text-secondary",
        className,
      )}
    >
      <span
        aria-hidden
        className="inline-block size-2 rounded-sm"
        style={{ backgroundColor: mark.color }}
      />
      {mark.label}
    </span>
  );
}

export function markColor(logo: string | undefined): string | null {
  return logo ? (MARKS[logo]?.color ?? null) : null;
}
