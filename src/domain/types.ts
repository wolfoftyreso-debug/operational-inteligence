// Central domain types for the normalized business model.

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export const SEVERITY_ORDER: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];
export function severityAtLeast(s: Severity, min: Severity): boolean {
  return SEVERITY_ORDER.indexOf(s) >= SEVERITY_ORDER.indexOf(min);
}

// Epistemic status — a core product principle. Every claim the system makes
// is labeled with how it knows it.
export type Epistemic = 'fact' | 'derived' | 'inference' | 'forecast' | 'recommendation';

export type Role =
  | 'technician'
  | 'team_manager'
  | 'department_manager'
  | 'facility_manager'
  | 'executive'
  | 'admin';

export interface EvidenceItem {
  kind: 'fact' | 'derived';
  label: string;
  value?: string;
  period?: string;
  source_label?: string;
  calculation?: string;
  data?: unknown;
}

export interface FindingDraft {
  fingerprint: string;
  severity: Severity;
  category: string;
  epistemic: Epistemic;
  title: string;
  description: string;
  confidence: number; // 0..1
  affected_entities?: { type: string; id?: string; name: string }[];
  recommended_actions?: string[];
  expected_effect?: string;
  period_start?: string;
  period_end?: string;
  evidence: EvidenceItem[];
}

export interface FindingRow {
  id: string;
  org_id: string;
  run_id: string | null;
  fingerprint: string;
  severity: Severity;
  category: string;
  epistemic: Epistemic;
  title: string;
  description: string;
  confidence: number;
  affected_entities_json: string | null;
  recommended_actions_json: string | null;
  expected_effect: string | null;
  period_start: string | null;
  period_end: string | null;
  detected_at: string;
  updated_at: string;
  status: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  resolved_at: string | null;
}

export type OverallStatus = 'stable' | 'attention' | 'action_needed' | 'critical';

export interface MonthPoint { period: string; value: number }

export interface MetricPack {
  months: string[];                       // covered months, ascending
  revenueByMonth: MonthPoint[];
  costsByMonth: MonthPoint[];
  resultByMonth: MonthPoint[];
  revenueByUnit: { unit: string; unitId: string | null; months: MonthPoint[] }[];
  costByCategory: { category: string; months: MonthPoint[] }[];
  receivables: {
    openTotal: number; openCount: number;
    overdueTotal: number; overdueCount: number;
    dsoDays: number | null;
    topDebtors: { name: string; open: number; overdue: number }[];
  };
  payables: { openTotal: number; overdueTotal: number };
  customerConcentration: { name: string; share: number; revenue: number }[]; // last 3 months
  dataCoverage: {
    sources: { id: string; name: string; connector: string }[];
    firstDate: string | null; lastDate: string | null;
    txCount: number; invoiceCount: number;
    monthsOfHistory: number;
  };
}

export interface LiquidityWeek {
  weekStart: string;
  inflow: number;
  outflow: number;
  balance: number;
  notes: string[];
}

export interface LiquidityForecast {
  startBalance: number | null;         // null when no cash position is known
  startBalanceSource: string;          // e.g. "Manuell uppgift (verksamhetsprofil)"
  bufferTarget: number | null;
  weeks: LiquidityWeek[];
  minBalance: number | null;
  minWeek: string | null;
  riskLevel: 'unknown' | 'low' | 'medium' | 'high' | 'critical';
  assumptions: string[];
}
