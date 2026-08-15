"use client";

import type { Breakdown, Series, Stat } from "@/lib/monitoring-types";
import { cn } from "@/lib/utils";

/**
 * Hand-built SVG charts.
 *
 * No charting library: this dashboard needs four shapes, and a library would
 * bring its own visual language — its own type scale, colours and spacing —
 * which would then need overriding to match the rest of the console. Four small
 * components using the existing design tokens is less code and looks like it
 * belongs.
 *
 * Colour is never the only channel. Every series is labelled, every stat states
 * its own direction of good, and tone is paired with text.
 */

const SERIES_COLORS = ["var(--accent)", "var(--warning)", "var(--success)", "var(--danger)"];

export function StatTile({ stat }: { stat: Stat }) {
  const good =
    stat.delta == null || stat.better === "neutral"
      ? null
      : stat.better === "higher"
        ? stat.delta > 0
        : stat.delta < 0;

  return (
    <div className="rounded-lg border border-border bg-surface-raised p-4">
      <p className="text-xs font-medium text-secondary">{stat.label}</p>
      <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-primary">
        {formatValue(stat.value, stat.unit)}
      </p>

      <div className="mt-1 flex flex-wrap items-center gap-2">
        {stat.delta != null && good !== null ? (
          <span
            className={cn(
              "font-mono text-xs tabular-nums",
              good ? "text-success-text" : "text-danger-text",
            )}
          >
            {stat.delta > 0 ? "▲" : "▼"} {formatValue(Math.abs(stat.delta), stat.unit)}
          </span>
        ) : null}
        {stat.target != null ? (
          <span className="text-xs text-tertiary">
            target {stat.better === "lower" ? "≤" : "≥"}{" "}
            {formatValue(stat.target, stat.unit)}
          </span>
        ) : null}
      </div>

      {stat.hint ? (
        <p className="mt-2 border-t border-border pt-2 text-[11px] leading-relaxed text-tertiary">
          {stat.hint}
        </p>
      ) : null}
    </div>
  );
}

export function LineChart({
  series,
  height = 180,
}: {
  series: Series[];
  height?: number;
}) {
  const withData = series.filter((s) => s.points.length > 1);

  if (withData.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-md border border-dashed border-border"
      >
        <p className="text-xs text-tertiary">
          No data in this window — nothing has been recorded yet.
        </p>
      </div>
    );
  }

  const width = 800;
  const pad = { top: 12, right: 12, bottom: 22, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const allValues = withData.flatMap((s) => s.points.map((p) => p.v));
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  // Pad the range so a flat series does not render as a line glued to an axis.
  const span = max - min || Math.abs(max) || 1;
  const lo = min - span * 0.15;
  const hi = max + span * 0.15;

  const count = Math.max(...withData.map((s) => s.points.length));
  const x = (i: number) => pad.left + (i / (count - 1)) * innerW;
  const y = (v: number) => pad.top + innerH - ((v - lo) / (hi - lo)) * innerH;

  const ticks = [lo, (lo + hi) / 2, hi];
  const first = withData[0]!.points[0];
  const last = withData[0]!.points[withData[0]!.points.length - 1];

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={`Time series: ${withData.map((s) => s.name).join(", ")}`}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={pad.left - 8}
              y={y(t) + 3.5}
              textAnchor="end"
              className="fill-[var(--text-tertiary)] font-mono text-[9px] tabular-nums"
            >
              {formatValue(t, withData[0]!.unit)}
            </text>
          </g>
        ))}

        {withData.map((s, si) => {
          const color = SERIES_COLORS[si % SERIES_COLORS.length]!;
          const d = s.points
            .map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`)
            .join("");
          return (
            <path
              key={s.name}
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}

        {first && last ? (
          <>
            <text
              x={pad.left}
              y={height - 6}
              className="fill-[var(--text-tertiary)] font-mono text-[9px]"
            >
              {formatTime(first.t)}
            </text>
            <text
              x={width - pad.right}
              y={height - 6}
              textAnchor="end"
              className="fill-[var(--text-tertiary)] font-mono text-[9px]"
            >
              {formatTime(last.t)}
            </text>
          </>
        ) : null}
      </svg>

      <figcaption className="mt-2 flex flex-wrap gap-4">
        {withData.map((s, si) => (
          <span key={s.name} className="flex items-center gap-1.5 text-xs text-secondary">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4 rounded"
              style={{ backgroundColor: SERIES_COLORS[si % SERIES_COLORS.length] }}
            />
            {s.name}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

const TONE_CLASS: Record<NonNullable<Breakdown["tone"]>, string> = {
  neutral: "bg-accent",
  good: "bg-success",
  warning: "bg-warning",
  bad: "bg-danger",
};

export function BarBreakdown({
  items,
  unit = "count",
}: {
  items: Breakdown[];
  unit?: string;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-tertiary">Nothing recorded.</p>;
  }
  const max = Math.max(...items.map((i) => i.value)) || 1;

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.label} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
          <span className="truncate text-xs text-primary">{item.label}</span>
          <span className="font-mono text-xs tabular-nums text-secondary">
            {formatValue(item.value, unit)}
          </span>
          <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-surface-hover">
            <span
              className={cn("block h-full rounded-full", TONE_CLASS[item.tone ?? "neutral"])}
              style={{ width: `${Math.max((item.value / max) * 100, 2)}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The badge that keeps the tab honest about where its numbers came from. */
export function SourceBadge({ source }: { source: "live" | "demo" }) {
  if (source === "live") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-success-subtle px-2.5 py-1 text-xs font-medium text-success-text">
        <span aria-hidden className="inline-block size-1.5 rounded-full bg-success" />
        Live data
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-warning-subtle px-2.5 py-1 text-xs font-medium text-warning-text"
      title="No Prometheus configured — these are representative sample figures, not measurements."
    >
      <span aria-hidden className="inline-block size-1.5 rounded-full bg-warning" />
      Demo data
    </span>
  );
}

function formatValue(value: number, unit: string): string {
  switch (unit) {
    case "ratio":
      return `${(value * 100).toFixed(1)}%`;
    case "s":
      return value < 1 ? `${(value * 1000).toFixed(0)} ms` : `${value.toFixed(2)} s`;
    case "count":
      return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value)}`;
    case "tok/s":
      return `${Math.round(value)}`;
    default:
      return value >= 100 ? value.toFixed(0) : value.toFixed(2);
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
