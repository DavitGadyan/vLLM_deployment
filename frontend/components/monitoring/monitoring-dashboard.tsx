"use client";

import * as React from "react";

import {
  BarBreakdown,
  LineChart,
  SourceBadge,
  StatTile,
} from "@/components/monitoring/charts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertIcon, CheckIcon } from "@/components/ui/icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  AuditSection,
  Breakdown,
  DashboardSection,
} from "@/lib/monitoring-types";
import { cn, formatDateTime, formatRelative } from "@/lib/utils";

/**
 * Monitoring tab: quality, performance, security, audit.
 *
 * Four sections rather than one because they answer different questions and can
 * disagree. A deployment can be green on every serving metric and useless — an
 * empty knowledge base produces a fast, idle GPU and an assistant that escalates
 * everything. Only the quality section shows that.
 */

const SECTIONS = ["quality", "performance", "security", "alignment"] as const;
type SectionKey = (typeof SECTIONS)[number];

const LABELS: Record<string, string> = {
  escalation_reasons: "Escalations by reason",
  retrieval_scores: "Best-match relevance distribution",
  latency_percentiles: "Latency percentiles",
  batching: "Continuous batching",
  injection_by_surface: "Injection attempts by surface",
  injection_by_rule: "Injection attempts by pattern",
  pii_by_category: "PII redactions by category",
  feedback_mix: "What people told us",
  variant_wins: "Head-to-head wins by variant",
};

export function MonitoringDashboard() {
  const [sections, setSections] = React.useState<Record<string, DashboardSection>>({});
  const [audit, setAudit] = React.useState<AuditSection | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [quality, performance, security, alignment, auditData] = await Promise.all(
          [
            "/api/dashboard/quality",
            "/api/dashboard/performance",
            "/api/dashboard/security",
            "/api/dashboard/alignment",
            "/api/dashboard/audit",
          ].map(async (url) => {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`${url} → ${response.status}`);
            return response.json();
          }),
        );
        if (cancelled) return;
        setSections({ quality, performance, security, alignment });
        setAudit(auditData as AuditSection);
        setError(null);
      } catch {
        if (!cancelled) {
          setError(
            "Could not reach the backend. The Architecture tab works without it — this one does not.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <LoadingState />;

  if (error) {
    return (
      <div className="flex items-start gap-2.5 rounded-md border border-danger/40 bg-danger-subtle px-4 py-3">
        <AlertIcon className="mt-0.5 size-4 shrink-0 text-danger-text" />
        <p className="text-sm text-danger-text">{error}</p>
      </div>
    );
  }

  return (
    <Tabs defaultValue="quality">
      <TabsList>
        <TabsTrigger value="quality">Quality</TabsTrigger>
        <TabsTrigger value="performance">Performance</TabsTrigger>
        <TabsTrigger value="security">Security</TabsTrigger>
        <TabsTrigger value="alignment">Improvement</TabsTrigger>
        <TabsTrigger value="audit">
          Audit
          {audit && !audit.chain.valid ? (
            <Badge variant="danger" className="ml-1.5">
              !
            </Badge>
          ) : null}
        </TabsTrigger>
      </TabsList>

      {SECTIONS.map((key) => (
        <TabsContent key={key} value={key}>
          {sections[key] ? <Section data={sections[key]!} sectionKey={key} /> : null}
        </TabsContent>
      ))}

      <TabsContent value="audit">
        {audit ? <AuditView data={audit} /> : null}
      </TabsContent>
    </Tabs>
  );
}

function Section({
  data,
  sectionKey,
}: {
  data: DashboardSection;
  sectionKey: SectionKey;
}) {
  const chartTitle =
    sectionKey === "quality"
      ? "Deflection and escalation over time"
      : sectionKey === "performance"
        ? "Latency, cache and throughput"
        : sectionKey === "alignment"
          ? "Feedback over time"
          : "Attempts and errors over time";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SourceBadge source={data.source} />
        <span className="text-xs text-tertiary">
          Updated {formatRelative(data.generated_at)}
        </span>
      </div>

      {/* Auto-fit rather than a fixed column count. The sections carry
          different numbers of stats — four here, six there — and a fixed
          three-column grid left whichever section had four with a lone tile
          stranded on its own row. */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))]">
        {data.stats.map((stat) => (
          <StatTile key={stat.key} stat={stat} />
        ))}
      </div>

      {/* A section with no series renders no chart. An empty axis reads as a
          data-loading failure rather than as a panel that has no time series to
          show — which is the Improvement tab's normal state before anyone has
          given feedback. */}
      {data.series.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{chartTitle}</CardTitle>
            <CardDescription>Last six hours, five-minute resolution.</CardDescription>
          </CardHeader>
          <CardContent>
            <LineChart series={data.series} />
          </CardContent>
        </Card>
      ) : null}

      {Object.keys(data.breakdowns).length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Object.entries(data.breakdowns).map(([key, items]) => (
            <Card key={key}>
              <CardHeader>
                <CardTitle>{LABELS[key] ?? key}</CardTitle>
              </CardHeader>
              <CardContent>
                <BarBreakdown items={items as Breakdown[]} />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {data.notes.length > 0 ? (
        <div className="space-y-2">
          {data.notes.map((note) => (
            <p
              key={note}
              className="border-l-2 border-accent pl-3 text-xs leading-relaxed text-secondary"
            >
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AuditView({ data }: { data: AuditSection }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SourceBadge source={data.source} />
        <span className="text-xs text-tertiary">
          Updated {formatRelative(data.generated_at)}
        </span>
      </div>

      {/* Chain status is the headline. It is the claim that makes the log
          evidence rather than assurance, so it gets the most prominent slot. */}
      <div
        className={cn(
          "flex items-start gap-3 rounded-lg border p-4",
          data.chain.valid
            ? "border-success/40 bg-success-subtle"
            : "border-danger/50 bg-danger-subtle",
        )}
      >
        {data.chain.valid ? (
          <CheckIcon className="mt-0.5 size-5 shrink-0 text-success-text" />
        ) : (
          <AlertIcon className="mt-0.5 size-5 shrink-0 text-danger-text" />
        )}
        <div className="min-w-0">
          <p
            className={cn(
              "text-sm font-semibold",
              data.chain.valid ? "text-success-text" : "text-danger-text",
            )}
          >
            {data.chain.valid
              ? `Hash chain intact — ${data.chain.checked} entries verified`
              : `Tampering detected at entry ${data.chain.broken_at_sequence}`}
          </p>
          <p
            className={cn(
              "mt-1 text-xs leading-relaxed",
              data.chain.valid ? "text-success-text/90" : "text-danger-text/90",
            )}
          >
            {data.chain.reason ??
              "Every entry's digest covers its own content and the previous entry's digest. Altering or deleting any historical row breaks every digest after it."}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {Object.entries(data.coverage).map(([framework, count]) => (
          <div key={framework} className="rounded-lg border border-border bg-surface-raised p-4">
            <p className="text-xs font-medium text-secondary">{framework}</p>
            <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-primary">
              {count}
            </p>
            <p className="mt-0.5 text-[11px] text-tertiary">
              events evidencing this framework&apos;s controls
            </p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Event log</CardTitle>
          <CardDescription>
            Append-only. The database rejects updates and deletes on this table, so
            tampering requires a deliberate schema change rather than an UPDATE.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Audit events, newest first</caption>
              <thead>
                <tr className="border-b border-border text-left">
                  {["#", "When", "Action", "Actor", "Outcome", "Controls"].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="whitespace-nowrap px-4 py-2 text-xs font-medium text-secondary"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.events.map((event) => (
                  <tr key={event.sequence}>
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-tertiary">
                      {event.sequence}
                    </td>
                    <td
                      className="whitespace-nowrap px-4 py-2.5 text-xs text-secondary"
                      title={formatDateTime(event.occurred_at)}
                    >
                      {formatRelative(event.occurred_at)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="font-mono text-xs text-primary">{event.action}</span>
                      {event.severity !== "info" ? (
                        <Badge
                          variant={
                            event.severity === "critical" || event.severity === "high"
                              ? "danger"
                              : "warning"
                          }
                          className="ml-2"
                        >
                          {event.severity}
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-secondary">
                      {event.actor ?? <span className="text-tertiary">system</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={cn(
                          "text-xs",
                          event.outcome === "success"
                            ? "text-secondary"
                            : "font-medium text-danger-text",
                        )}
                      >
                        {event.outcome}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {event.compliance_tags.map((tag) => (
                          <Badge key={tag} variant="outline">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6" aria-live="polite">
      <span className="sr-only">Loading monitoring data</span>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton h-28 rounded-lg" />
        ))}
      </div>
      <div className="skeleton h-56 rounded-lg" />
    </div>
  );
}
