CREATE TABLE workflow_run_compositions (
  id                              TEXT PRIMARY KEY,
  goal_id                         TEXT NOT NULL REFERENCES goals(id),
  parent_run_id                   TEXT NOT NULL REFERENCES workflow_runs(id),
  child_run_id                    TEXT NOT NULL REFERENCES workflow_runs(id),
  delegate_node_id                TEXT NOT NULL,
  spawn_seq                       INTEGER NOT NULL DEFAULT 0,
  reads_json                      TEXT NOT NULL,
  writes_json                     TEXT NOT NULL,
  parent_workspace_snapshot_json  TEXT,
  depth                           INTEGER NOT NULL DEFAULT 0,
  status                          TEXT NOT NULL CHECK (status IN ('active','completed','failed','cancelled')),
  cost_rollup_usd                 REAL,
  created_at                      TEXT NOT NULL,
  finished_at                     TEXT
);
CREATE UNIQUE INDEX idx_compositions_parent_node_seq
  ON workflow_run_compositions (parent_run_id, delegate_node_id, spawn_seq);
CREATE INDEX idx_compositions_child ON workflow_run_compositions (child_run_id);
CREATE INDEX idx_compositions_parent ON workflow_run_compositions (parent_run_id);

-- Widen workflow_runs.status CHECK to include 'delegating' and add parent_composition_id column.
-- SQLite cannot ALTER a CHECK constraint, so we rebuild the table.
-- idx_workflow_runs_active_per_goal intentionally omits 'delegating' (no change to its predicate).
CREATE TABLE workflow_runs_new (
  id                       TEXT PRIMARY KEY,
  goal_id                  TEXT NOT NULL REFERENCES goals(id),
  template_id              TEXT NOT NULL REFERENCES workflow_templates(id),
  template_version         INTEGER NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('active','paused','blocked','completed','failed','cancelled','delegating')),
  current_step_run_id      TEXT,
  blocked_reason           TEXT,
  started_at               TEXT NOT NULL,
  finished_at              TEXT,
  current_node_id          TEXT,
  current_node_kind        TEXT,
  traversal_seq            INTEGER NOT NULL DEFAULT 0,
  pending_gate_route_json  TEXT,
  ledger_version           INTEGER NOT NULL DEFAULT 0,
  template_snapshot_json   TEXT,
  pending_split_route_json TEXT,
  parent_composition_id    TEXT
);
INSERT INTO workflow_runs_new SELECT
  id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason,
  started_at, finished_at, current_node_id, current_node_kind, traversal_seq,
  pending_gate_route_json, ledger_version, template_snapshot_json, pending_split_route_json,
  NULL
FROM workflow_runs;
DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_new RENAME TO workflow_runs;
CREATE INDEX idx_workflow_runs_goal_status ON workflow_runs(goal_id, status, started_at DESC);
CREATE UNIQUE INDEX idx_workflow_runs_active_per_goal
  ON workflow_runs(goal_id)
  WHERE status IN ('active','paused','blocked');

-- Add composition facet column to the harness transition spine.
ALTER TABLE harness_transitions ADD COLUMN composition_json TEXT;
