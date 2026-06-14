-- 0031_workflow_ledger.sql
-- Per-run platform-managed ledger: immutable versions + the canonical records
-- materialized at each version. A new version is committed per executable step
-- whose ledger proposals validate.

-- Monotonic version counter per run (mirrors workflow_runs.traversal_seq pattern).
ALTER TABLE workflow_runs ADD COLUMN ledger_version INTEGER NOT NULL DEFAULT 0;

-- One immutable row per committed ledger version.
CREATE TABLE workflow_ledger_versions (
  id                 TEXT PRIMARY KEY,
  goal_id            TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id    TEXT NOT NULL REFERENCES workflow_runs(id),
  version            INTEGER NOT NULL,
  source_step_run_id TEXT,                 -- null for non-step commits (none in this phase)
  traversal_seq      INTEGER NOT NULL,
  updates_json       TEXT NOT NULL,        -- the normalized, canonical-id'd LedgerUpdate[]
  created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ledger_versions_run_version
  ON workflow_ledger_versions(workflow_run_id, version);

-- Canonical records, one row per (run, canonical record id), carrying the
-- latest committed state. Earlier states are reconstructable from versions.
CREATE TABLE workflow_ledger_records (
  id                  TEXT NOT NULL,        -- canonical record id (engine-allocated)
  goal_id             TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id     TEXT NOT NULL REFERENCES workflow_runs(id),
  record_type         TEXT NOT NULL,
  status              TEXT NOT NULL,
  note                TEXT NOT NULL DEFAULT '',
  evidence_refs_json  TEXT NOT NULL DEFAULT '[]',
  related_ids_json    TEXT NOT NULL DEFAULT '[]',
  first_version       INTEGER NOT NULL,
  last_version        INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (workflow_run_id, id)
);
CREATE INDEX idx_ledger_records_run ON workflow_ledger_records(workflow_run_id, last_version DESC);
