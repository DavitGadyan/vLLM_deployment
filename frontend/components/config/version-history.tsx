"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RollbackIcon } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import type { ConfigVersion, ConfigVersionSummary } from "@/lib/types";
import { cn, formatRelative } from "@/lib/utils";

/**
 * Configuration history with a prompt diff and one-click rollback.
 *
 * Versions are immutable server-side, so "rolling back" activates an older row
 * rather than reconstructing it — there is nothing to reconstruct, and the exact
 * prompt that was live before is still on disk.
 */
export function VersionHistory({
  versions,
  activePrompt,
  onActivated,
}: {
  versions: ConfigVersionSummary[];
  activePrompt: string;
  onActivated: (version: ConfigVersion) => void;
}) {
  const { toast } = useToast();
  const [selected, setSelected] = React.useState<ConfigVersion | null>(null);
  const [loadingId, setLoadingId] = React.useState<string | null>(null);
  const [activating, setActivating] = React.useState(false);

  async function open(summary: ConfigVersionSummary) {
    setLoadingId(summary.id);
    try {
      setSelected(await api.getVersion(summary.id));
    } catch {
      toast({ tone: "error", title: "Could not load that version" });
    } finally {
      setLoadingId(null);
    }
  }

  async function activate(version: ConfigVersion) {
    setActivating(true);
    try {
      const activated = await api.activateVersion(version.id);
      onActivated(activated);
      setSelected(null);
      toast({
        tone: "success",
        title: `Version ${activated.version} is live`,
        description: "New conversations use this configuration immediately.",
      });
    } catch {
      toast({ tone: "error", title: "Could not activate that version" });
    } finally {
      setActivating(false);
    }
  }

  if (versions.length === 0) {
    return <p className="text-xs text-tertiary">No saved versions yet.</p>;
  }

  return (
    <>
      <ol className="divide-y divide-border">
        {versions.map((version) => (
          <li
            key={version.id}
            className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium tabular-nums text-primary">
                  v{version.version}
                </span>
                {version.is_active ? <Badge variant="success">Live</Badge> : null}
                <span className="text-xs text-tertiary">
                  {formatRelative(version.created_at)}
                  {version.created_by ? ` · ${version.created_by}` : ""}
                </span>
              </div>
              <p
                className={cn(
                  "truncate text-xs",
                  version.change_note ? "text-secondary" : "text-tertiary italic",
                )}
              >
                {version.change_note ?? "No change note"}
              </p>
            </div>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => open(version)}
              disabled={loadingId === version.id}
            >
              {loadingId === version.id ? "Loading…" : "View"}
            </Button>
          </li>
        ))}
      </ol>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent size="xl">
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  Version {selected.version}
                  {selected.is_active ? " (live)" : ""}
                </DialogTitle>
                <DialogDescription>
                  {selected.change_note ?? "No change note"} ·{" "}
                  {selected.compiled_prompt_tokens.toLocaleString()} prompt tokens
                </DialogDescription>
              </DialogHeader>

              <DialogBody className="p-0">
                <PromptDiff
                  current={activePrompt}
                  candidate={selected.compiled_prompt}
                />
              </DialogBody>

              <DialogFooter>
                <Button variant="secondary" onClick={() => setSelected(null)}>
                  Close
                </Button>
                {!selected.is_active ? (
                  <Button onClick={() => activate(selected)} disabled={activating}>
                    <RollbackIcon />
                    {activating ? "Activating…" : "Make this version live"}
                  </Button>
                ) : null}
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Line-level diff of two compiled prompts.
 *
 * A longest-common-subsequence diff over lines — small enough to not warrant a
 * dependency, and the prompts are a few hundred lines at most. Showing the
 * prompt diff rather than a field-by-field diff is deliberate: the prompt is
 * what the model actually sees, so it is the thing worth reviewing.
 */
function PromptDiff({ current, candidate }: { current: string; candidate: string }) {
  const rows = React.useMemo(() => diffLines(current, candidate), [current, candidate]);
  const changed = rows.some((row) => row.kind !== "same");

  if (!changed) {
    return (
      <p className="px-5 py-4 text-xs text-secondary">
        This version compiles to exactly the same prompt as the live one.
      </p>
    );
  }

  return (
    <div className="font-mono text-xs leading-relaxed">
      <div className="sticky top-0 flex gap-4 border-b border-border bg-surface-raised px-5 py-2 font-sans text-xs text-secondary">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2 rounded-sm bg-danger/40" />
          Live
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2 rounded-sm bg-success/40" />
          This version
        </span>
      </div>
      <div className="px-2 py-2">
        {rows.map((row, index) => (
          <div
            key={index}
            className={cn(
              "flex gap-2 whitespace-pre-wrap px-3 py-0.5",
              row.kind === "added" && "bg-success-subtle text-success-text",
              row.kind === "removed" && "bg-danger-subtle text-danger-text",
              row.kind === "same" && "text-tertiary",
            )}
          >
            <span aria-hidden className="w-3 shrink-0 select-none">
              {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}
            </span>
            <span className="min-w-0 flex-1">{row.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type DiffRow = { kind: "same" | "added" | "removed"; text: string };

export function diffLines(before: string, after: string): DiffRow[] {
  const a = before.split("\n");
  const b = after.split("\n");

  // LCS table. O(n*m) is fine at prompt scale (hundreds of lines).
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ kind: "removed", text: a[i]! });
      i++;
    } else {
      rows.push({ kind: "added", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) rows.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) rows.push({ kind: "added", text: b[j++]! });

  return rows;
}
