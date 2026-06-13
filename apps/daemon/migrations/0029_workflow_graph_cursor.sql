-- 0029_workflow_graph_cursor.sql
-- Run-level graph cursor: when current_node_kind = 'gate', current_step_run_id is NULL.
ALTER TABLE workflow_runs ADD COLUMN current_node_id TEXT;
ALTER TABLE workflow_runs ADD COLUMN current_node_kind TEXT;
ALTER TABLE workflow_runs ADD COLUMN traversal_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE workflow_gate_decisions (
  id                      TEXT PRIMARY KEY,
  goal_id                 TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id                 TEXT NOT NULL,
  traversal_seq           INTEGER NOT NULL,
  outcome                 TEXT NOT NULL CHECK (outcome IN ('approved','rejected')),
  reason                  TEXT NOT NULL,
  selected_edge_to        TEXT NOT NULL,
  inputs_considered_json  TEXT NOT NULL DEFAULT '[]',
  issue_refs_json         TEXT NOT NULL DEFAULT '[]',
  created_at              TEXT NOT NULL
);
CREATE INDEX idx_workflow_gate_decisions_run
  ON workflow_gate_decisions(workflow_run_id, created_at DESC);
CREATE UNIQUE INDEX idx_workflow_gate_decisions_seq
  ON workflow_gate_decisions(workflow_run_id, node_id, traversal_seq);

-- Task 15: supervised-mode gate pause. Run-level stash of the deferred gate
-- route ({ gateNodeId, outcome, destNodeId, traversalSeq, sourceStepRunId }),
-- consumed exactly once by the Continue/confirm-gate path.
ALTER TABLE workflow_runs ADD COLUMN pending_gate_route_json TEXT;
