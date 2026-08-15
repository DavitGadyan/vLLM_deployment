"use client";

import * as React from "react";
import dynamic from "next/dynamic";

import { DetailPanel } from "@/components/architecture/detail-panel";
import type { Graph3DHandle } from "@/components/architecture/graph-3d";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ancestorsOf,
  hasChildren,
  NODE_BY_ID,
  TIERS,
  TOUR,
  type TierId,
} from "@/lib/architecture-data";
import { cn } from "@/lib/utils";

/**
 * Architecture tab.
 *
 * Three.js needs `window`, so the graph is loaded client-side only. The loading
 * state is a real skeleton rather than a spinner because the WebGL context takes
 * a moment to come up and a blank rectangle mid-recording looks like a failure.
 *
 * Everything on this tab is static data. It renders with the backend stopped,
 * which is deliberate: a demo must never fail because a GPU is cold.
 */
const Graph3D = dynamic(
  () => import("@/components/architecture/graph-3d").then((m) => m.Graph3D),
  {
    ssr: false,
    loading: () => (
      <div className="flex size-full items-center justify-center bg-surface-sunken">
        <div className="text-center">
          <div className="skeleton mx-auto size-10 rounded-full" />
          <p className="mt-3 text-xs text-tertiary">Preparing the 3D scene…</p>
        </div>
      </div>
    ),
  },
);

const AUTOPLAY_MS = 9000;

export function ArchitectureExplorer() {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tourIndex, setTourIndex] = React.useState<number | null>(null);
  const [autoplay, setAutoplay] = React.useState(false);
  const [requestPathOnly, setRequestPathOnly] = React.useState(false);
  const [isolatedId, setIsolatedId] = React.useState<string | null>(null);
  const [visibleTiers, setVisibleTiers] = React.useState<Set<TierId>>(
    () => new Set(TIERS.map((t) => t.id)),
  );
  const handleRef = React.useRef<Graph3DHandle | null>(null);

  const onReady = React.useCallback((handle: Graph3DHandle) => {
    handleRef.current = handle;
  }, []);

  const inTour = tourIndex !== null;
  const stop = inTour ? TOUR[tourIndex] : undefined;
  const selected = selectedId ? (NODE_BY_ID.get(selectedId) ?? null) : null;

  const goToStop = React.useCallback((index: number) => {
    const next = ((index % TOUR.length) + TOUR.length) % TOUR.length;
    const target = TOUR[next]!.nodeId;

    // Open every group between the root and the target before selecting it.
    // Without this the tour would fly the camera at a node still folded inside
    // a collapsed parent, and land on nothing.
    for (const ancestor of ancestorsOf(target).reverse()) {
      handleRef.current?.expand(ancestor);
    }
    if (hasChildren(target)) handleRef.current?.expand(target);

    setTourIndex(next);
    setSelectedId(target);
  }, []);

  const startTour = React.useCallback(() => {
    // Reveal every tier — a filtered graph mid-tour would hide the node the
    // narration is about.
    setVisibleTiers(new Set(TIERS.map((t) => t.id)));
    setRequestPathOnly(false);
    goToStop(0);
  }, [goToStop]);

  const endTour = React.useCallback(() => {
    setTourIndex(null);
    setAutoplay(false);
    setSelectedId(null);
    // Fold back to the seven groups so the next take starts from the same view.
    handleRef.current?.collapseAll();
    handleRef.current?.reset();
  }, []);

  React.useEffect(() => {
    if (!autoplay || tourIndex === null) return;
    const timer = window.setTimeout(() => goToStop(tourIndex + 1), AUTOPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [autoplay, tourIndex, goToStop]);

  // Arrow keys drive the tour, so the presenter can advance without finding a
  // button while talking.
  React.useEffect(() => {
    if (tourIndex === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        goToStop(tourIndex + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToStop(tourIndex - 1);
      } else if (event.key === "Escape") {
        endTour();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tourIndex, goToStop, endTour]);

  function toggleTier(id: TierId) {
    setVisibleTiers((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        // Never let the last tier be switched off — an empty scene reads as a
        // crash rather than as a filter.
        if (next.size > 1) next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 sm:px-6">
        {inTour ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => goToStop(tourIndex - 1)}>
              ← Back
            </Button>
            <span className="min-w-16 text-center font-mono text-xs tabular-nums text-secondary">
              {tourIndex + 1} / {TOUR.length}
            </span>
            <Button size="sm" onClick={() => goToStop(tourIndex + 1)}>
              Next →
            </Button>
            <Button
              variant={autoplay ? "primary" : "secondary"}
              size="sm"
              onClick={() => setAutoplay((v) => !v)}
              aria-pressed={autoplay}
            >
              {autoplay ? "Pause" : "Autoplay"}
            </Button>
            <Button variant="ghost" size="sm" onClick={endTour}>
              Exit tour
            </Button>
          </div>
        ) : (
          <Button size="sm" onClick={startTour}>
            ▶ Guided tour
          </Button>
        )}

        <div className="mx-1 h-5 w-px bg-border" aria-hidden />

        <Button
          variant={requestPathOnly ? "primary" : "secondary"}
          size="sm"
          onClick={() => setRequestPathOnly((v) => !v)}
          aria-pressed={requestPathOnly}
        >
          Request path only
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => handleRef.current?.expandAll()}
        >
          Expand all
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSelectedId(null);
            handleRef.current?.collapseAll();
            handleRef.current?.reset();
          }}
        >
          Collapse
        </Button>

        {/* Isolating hides the rest of the diagram, so the way back has to be
            stated rather than left to the click that got you here. */}
        {isolatedId ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              handleRef.current?.collapseAll();
              handleRef.current?.reset();
            }}
          >
            ← Back to full network
          </Button>
        ) : null}

      </div>

      {/* Stage filters.
          Their own row rather than pushed right on the actions row. Nine of
          them plus five buttons no longer fit on one line at any normal width,
          and the result was a ragged wrap with a gap down the middle. They are
          also a different kind of control — what is shown, not what to do — so
          separating them is the honest layout as well as the tidier one. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2 sm:px-6">
        <span className="text-[11px] font-medium uppercase tracking-wider text-tertiary">
          Stages
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {TIERS.map((tier) => {
            const on = visibleTiers.has(tier.id);
            return (
              <button
                key={tier.id}
                type="button"
                onClick={() => toggleTier(tier.id)}
                aria-pressed={on}
                title={tier.blurb}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                  on
                    ? "bg-surface-active text-primary"
                    : "text-tertiary hover:text-secondary",
                )}
              >
                <span
                  aria-hidden
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: tier.color, opacity: on ? 1 : 0.35 }}
                />
                {tier.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Stage */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_420px]">
        <div className="relative min-h-64">
          <Graph3D
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              // Clicking away from the script ends the tour rather than leaving
              // the narration pointing at a different node than the camera.
              if (id !== stop?.nodeId) {
                setTourIndex(null);
                setAutoplay(false);
              }
            }}
            visibleTiers={visibleTiers}
            showRequestPathOnly={requestPathOnly}
            onReady={onReady}
            onIsolatedChange={setIsolatedId}
          />

          {inTour && stop ? (
            <div className="pointer-events-none absolute inset-x-4 bottom-8 sm:inset-x-6">
              <div className="mx-auto max-w-2xl rounded-lg border border-border bg-surface-raised/95 px-5 py-4 shadow-panel backdrop-blur">
                <Badge variant="accent">{stop.chapter}</Badge>
                <p className="mt-2 text-sm leading-relaxed text-primary">{stop.say}</p>
              </div>
            </div>
          ) : null}

          <p className="pointer-events-none absolute left-4 top-3 text-[11px] text-tertiary sm:left-6">
            {isolatedId
              ? `Showing ${NODE_BY_ID.get(isolatedId)?.label ?? "this card"} on its own · click it again, or press Esc, to go back`
              : "Drag to rotate · right-drag to pan · drag a node to move it · click a card to open it on its own"}
          </p>
        </div>

        {/* Generous padding, and more of it at the bottom. The panel is the
            thing being read on a recording; letting it run into the window edge
            makes the whole view look like it was cropped rather than composed. */}
        <div className="min-h-0 border-t border-border px-4 pb-6 pt-4 lg:border-l lg:border-t-0 lg:px-5 lg:pb-8">
          <DetailPanel
            node={selected}
            onClose={() => {
              setSelectedId(null);
              setTourIndex(null);
              handleRef.current?.reset();
            }}
            tourNote={inTour ? stop?.say : undefined}
          />
        </div>
      </div>
    </div>
  );
}
