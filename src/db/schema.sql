-- Operational Intelligence — normalized internal data model.
-- Every business table carries org_id for tenant isolation.

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT DEFAULT 'general',
  rss_token TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'executive', -- technician|team_manager|department_manager|facility_manager|executive|admin
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

-- Manual business profile: key/value, always labeled as manual source.
CREATE TABLE IF NOT EXISTS business_profile (
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (org_id, key)
);

CREATE TABLE IF NOT EXISTS business_units (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT DEFAULT 'unit'
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  external_id TEXT,
  name TEXT NOT NULL,
  source_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_ext ON customers(org_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  external_id TEXT,
  name TEXT NOT NULL,
  source_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_ext ON suppliers(org_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  external_id TEXT,
  name TEXT NOT NULL,
  unit_id TEXT,
  role TEXT,
  source_id TEXT
);

-- Canonical financial facts.
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  external_id TEXT,
  date TEXT NOT NULL,          -- YYYY-MM-DD
  description TEXT,
  amount REAL NOT NULL,        -- positive numbers; kind determines direction
  kind TEXT NOT NULL,          -- revenue|cost
  category TEXT,               -- e.g. material, salaries, rent, parts...
  unit_id TEXT,
  account TEXT,
  currency TEXT DEFAULT 'SEK',
  source_id TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_ext ON transactions(org_id, source_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(org_id, date);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  external_id TEXT,
  kind TEXT NOT NULL,          -- customer|supplier
  counterparty_id TEXT,        -- customers.id or suppliers.id
  counterparty_name TEXT,
  issue_date TEXT,
  due_date TEXT,
  paid_date TEXT,
  amount REAL NOT NULL,
  balance REAL NOT NULL,       -- remaining open amount
  currency TEXT DEFAULT 'SEK',
  status TEXT NOT NULL,        -- open|paid|overdue|cancelled
  unit_id TEXT,
  source_id TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_ext ON invoices(org_id, source_id, kind, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inv_due ON invoices(org_id, kind, status, due_date);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,           -- e.g. monthly_revenue
  label TEXT NOT NULL,
  target_value REAL NOT NULL,
  period TEXT DEFAULT 'monthly',
  unit_id TEXT,
  created_at TEXT NOT NULL
);

-- Data sources / connector instances.
CREATE TABLE IF NOT EXISTS data_sources (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  connector_key TEXT NOT NULL,   -- fortnox|visma|csv|excel|generic-api|manual
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'configured', -- configured|connected|error|disconnected
  config_encrypted TEXT,          -- AES-256-GCM blob, never exposed to clients
  last_sync_at TEXT,
  last_sync_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  disconnected_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,          -- running|ok|error
  stats_json TEXT,
  error TEXT
);

-- Raw provenance layer: exactly what a connector delivered, pre-normalization.
CREATE TABLE IF NOT EXISTS raw_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  external_id TEXT,
  payload_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_src ON raw_records(org_id, source_id, dataset);

-- Manual observations from management.
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  date TEXT NOT NULL,
  category TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  overall_status TEXT,           -- stable|attention|action_needed|critical
  summary TEXT,                  -- deterministic summary
  narrative TEXT,                -- reasoning engine narrative (if available)
  narrative_model TEXT,          -- which model produced the narrative
  metrics_json TEXT              -- metric pack snapshot for explainability
);

-- Findings: structured output of the analysis pipeline.
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  run_id TEXT,
  fingerprint TEXT NOT NULL,     -- stable identity for recurrence/memory
  severity TEXT NOT NULL,        -- info|low|medium|high|critical
  category TEXT NOT NULL,        -- liquidity|revenue|costs|receivables|concentration|follow_up|stability|...
  epistemic TEXT NOT NULL,       -- fact|derived|inference|forecast|recommendation
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  confidence REAL NOT NULL,      -- 0..1
  affected_entities_json TEXT,
  recommended_actions_json TEXT,
  expected_effect TEXT,
  period_start TEXT,
  period_end TEXT,
  detected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',  -- open|acknowledged|resolved|dismissed
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_fp ON findings(org_id, fingerprint, detected_at);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(org_id, status, severity);

-- Evidence chain: every important finding can show its underlying data.
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  finding_id TEXT NOT NULL REFERENCES findings(id),
  kind TEXT NOT NULL,            -- fact|derived
  label TEXT NOT NULL,
  value TEXT,
  period TEXT,
  source_label TEXT,             -- human-readable data source ("Fortnox", "CSV-import: fakturor.csv", "Manuell uppgift")
  calculation TEXT,              -- how a derived value was computed
  data_json TEXT                 -- underlying datapoints
);
CREATE INDEX IF NOT EXISTS idx_evidence_finding ON evidence(finding_id);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  finding_id TEXT,
  title TEXT NOT NULL,
  owner TEXT,
  priority TEXT DEFAULT 'medium',
  due_date TEXT,
  expected_effect TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open|in_progress|done|cancelled
  created_at TEXT NOT NULL,
  completed_at TEXT,
  observed_effect TEXT,
  effect_verified TEXT                    -- pending|effective|ineffective (set by analysis)
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  finding_id TEXT,
  title TEXT NOT NULL,
  rationale TEXT,
  owner TEXT,
  decided_at TEXT NOT NULL,
  expected_result TEXT,
  actual_result TEXT,
  status TEXT NOT NULL DEFAULT 'active'  -- active|fulfilled|failed|superseded
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  finding_id TEXT,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS alert_prefs (
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,          -- in_app|email|sms|push
  min_severity TEXT NOT NULL DEFAULT 'high',
  enabled INTEGER NOT NULL DEFAULT 1,
  destination TEXT,               -- phone number / email override
  PRIMARY KEY (user_id, channel)
);

-- Every outbound notification attempt is recorded here (delivery audit).
CREATE TABLE IF NOT EXISTS notifications_outbox (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  alert_id TEXT,
  user_id TEXT,
  channel TEXT NOT NULL,
  destination TEXT,
  title TEXT,
  body TEXT,
  status TEXT NOT NULL,           -- queued|sent|failed|no_provider
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL,             -- daily_brief|weekly_review|financial|operational|risk|management|custom
  title TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  evidence_json TEXT,
  model TEXT,
  asked_at TEXT NOT NULL
);

-- Operational granularity: work orders and per-person/day time entries.
-- Principle: store data at the highest useful granularity available;
-- present at the lowest cognitive complexity the role requires.
CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  external_id TEXT,
  title TEXT,
  category TEXT,
  status TEXT DEFAULT 'open',      -- open|closed|cancelled
  unit_id TEXT,
  customer_name TEXT,
  opened_date TEXT,
  closed_date TEXT,
  source_id TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wo_ext ON work_orders(org_id, source_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  external_id TEXT,
  date TEXT NOT NULL,              -- YYYY-MM-DD
  employee_id TEXT,
  employee_name TEXT,
  unit_id TEXT,
  work_order_ref TEXT,
  hours_worked REAL NOT NULL,
  hours_billed REAL,
  source_id TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_te_ext ON time_entries(org_id, source_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_te_date ON time_entries(org_id, date);

-- Hierarchical configuration: org defaults + user overrides.
-- Resolution order: user → org → system default (in code).
CREATE TABLE IF NOT EXISTS settings (
  org_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'org',   -- org|user (unit/role prepared for later)
  scope_id TEXT NOT NULL DEFAULT '',   -- user id when scope='user'
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (org_id, scope, scope_id, key)
);

-- Governing documents (verksamhetsplan, ledningsgenomgång, budget...).
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  kind TEXT,                     -- verksamhetsplan|ledningsgenomgang|budget|policy|other
  text_content TEXT NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL,
  extraction_model TEXT,
  item_count INTEGER DEFAULT 0
);

-- Structured objects extracted from documents, pending review.
-- On approval they materialize into goals/risks/decisions/actions.
CREATE TABLE IF NOT EXISTS document_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id),
  kind TEXT NOT NULL,            -- goal|kpi|risk|decision|action|observation
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed|approved|rejected
  materialized_id TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS risks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT DEFAULT 'medium',
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active|mitigated|closed
  unit_id TEXT,
  source TEXT,
  source_document_id TEXT,
  created_at TEXT NOT NULL
);

-- Opportunities: something could get BETTER (vs findings: something happens,
-- risks: something could go wrong). Discovered by background intelligence.
-- Principle: expand the owner's field of view without owning the decision.
CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,              -- purchasing|tax|pricing|incentive|process|...
  domain TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,         -- why the system finds this interesting
  potential_effect TEXT,
  caution TEXT,                    -- what must be checked before acting
  confidence REAL NOT NULL,
  requires_human_review INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed|investigating|dismissed|actioned
  evidence_json TEXT,
  detected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dismissed_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_opp_fp ON opportunities(org_id, fingerprint);

-- Investigations: a locked-context thread around one specific question.
-- Every discovered issue becomes an optional investigation, never an
-- automatic conclusion.
CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT,
  trigger_kind TEXT,               -- opportunity|finding|manual
  trigger_id TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open|concluded|abandoned
  context_json TEXT,               -- locked context snapshot (evidence, data, scope)
  conclusion TEXT,
  confidence REAL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  concluded_at TEXT
);

CREATE TABLE IF NOT EXISTS investigation_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  role TEXT NOT NULL,              -- user|system
  content TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invmsg ON investigation_messages(investigation_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT,
  at TEXT NOT NULL
);
