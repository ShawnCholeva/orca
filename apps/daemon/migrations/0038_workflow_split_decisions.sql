-- 0038_workflow_split_decisions.sql
-- N-way splitter routing decisions. Mirrors workflow_gate_decisions but stores
-- the selected branch label instead of an approved/rejected outcome, and has no
-- issue references. Kept separate so branch labels never enter gate history.
CREATE TABLE workflow_split_decisions (
  id                      TEXT PRIMARY KEY,
  goal_id                 TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id                 TEXT NOT NULL,
  traversal_seq           INTEGER NOT NULL,
  selected_branch         TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  selected_edge_to        TEXT NOT NULL,
  inputs_considered_json  TEXT NOT NULL DEFAULT '[]',
  ledger_version          INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL
);
CREATE INDEX idx_workflow_split_decisions_run
  ON workflow_split_decisions(workflow_run_id, created_at DESC);
CREATE UNIQUE INDEX idx_workflow_split_decisions_seq
  ON workflow_split_decisions(workflow_run_id, node_id, traversal_seq);
