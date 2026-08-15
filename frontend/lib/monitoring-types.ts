/** Mirrors `backend/app/schemas/dashboard.py`. */

export type DataSource = "live" | "demo";

export interface Point {
  t: string;
  v: number;
}

export interface Series {
  name: string;
  unit: string;
  points: Point[];
}

export interface Stat {
  key: string;
  label: string;
  value: number;
  unit: string;
  /** Which direction counts as an improvement. Drives the delta's colour. */
  better: "higher" | "lower" | "neutral";
  target?: number | null;
  delta?: number | null;
  hint?: string | null;
}

export interface Breakdown {
  label: string;
  value: number;
  tone?: "neutral" | "good" | "warning" | "bad";
}

export interface DashboardSection {
  source: DataSource;
  generated_at: string;
  stats: Stat[];
  series: Series[];
  breakdowns: Record<string, Breakdown[]>;
  notes: string[];
}

export interface AuditEvent {
  sequence: number;
  occurred_at: string;
  actor: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  outcome: string;
  severity: string;
  compliance_tags: string[];
  detail: Record<string, unknown>;
  hash: string;
  prev_hash: string | null;
}

export interface ChainStatus {
  valid: boolean;
  checked: number;
  broken_at_sequence?: number | null;
  reason?: string | null;
}

export interface AuditSection {
  source: DataSource;
  generated_at: string;
  chain: ChainStatus;
  events: AuditEvent[];
  /** Events per control framework — GDPR, SOC2, HIPAA. */
  coverage: Record<string, number>;
}
