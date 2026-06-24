-- 0040_harness_transitions.sql
-- The HarnessTransition spine: one engine-emitted record per consequential
-- boundary (step launch/complete, tool gate, mark-done). Each reliability axis
-- is a nullable JSON facet column, filled in over later phases. Append-only;
-- rows are never updated.
CREATE TABLE harness_transitions (
  id                   TEXT PRIMARY KEY,
  goal_id              TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id      TEXT,
  workflow_step_run_id TEXT,
  boundary             TEXT NOT NULL,
  risk_json            TEXT,
  evidence_json        TEXT,
  state_deps_json      TEXT,
  telemetry_json       TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_harness_transitions_goal
  ON harness_transitions(goal_id, created_at DESC);
CREATE INDEX idx_harness_transitions_step_run
  ON harness_transitions(workflow_step_run_id, created_at DESC);
