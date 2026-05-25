CREATE TABLE workflow_templates (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  version            INTEGER NOT NULL DEFAULT 1,
  is_built_in        INTEGER NOT NULL DEFAULT 0,
  is_locked          INTEGER NOT NULL DEFAULT 0,
  steps_json         TEXT NOT NULL DEFAULT '[]',
  guardrails_json    TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_workflow_templates_built_in ON workflow_templates(is_built_in);

CREATE TABLE workflow_runs (
  id                       TEXT PRIMARY KEY,
  goal_id                  TEXT NOT NULL REFERENCES goals(id),
  template_id              TEXT NOT NULL REFERENCES workflow_templates(id),
  template_version         INTEGER NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('active','paused','blocked','completed','failed','cancelled')),
  current_step_run_id      TEXT,
  blocked_reason           TEXT,
  started_at               TEXT NOT NULL,
  finished_at              TEXT
);
CREATE INDEX idx_workflow_runs_goal_status ON workflow_runs(goal_id, status, started_at DESC);
CREATE UNIQUE INDEX idx_workflow_runs_active_per_goal
  ON workflow_runs(goal_id)
  WHERE status IN ('active','paused','blocked');

CREATE TABLE workflow_step_runs (
  id                           TEXT PRIMARY KEY,
  goal_id                      TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id              TEXT NOT NULL REFERENCES workflow_runs(id),
  step_template_id             TEXT NOT NULL,
  ordinal                      INTEGER NOT NULL,
  attempt                      INTEGER NOT NULL DEFAULT 1,
  status                       TEXT NOT NULL CHECK (status IN ('pending','active','blocked','passed','failed','skipped')),
  satisfied_exit_criteria_json TEXT NOT NULL DEFAULT '[]',
  outstanding_exit_criteria_json TEXT NOT NULL DEFAULT '[]',
  blocked_reason               TEXT,
  started_at                   TEXT,
  finished_at                  TEXT,
  fingerprint                  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_workflow_step_runs_fp
  ON workflow_step_runs(workflow_run_id, step_template_id, attempt);
CREATE INDEX idx_workflow_step_runs_goal
  ON workflow_step_runs(goal_id, ordinal);
CREATE INDEX idx_workflow_step_runs_run_ordinal
  ON workflow_step_runs(workflow_run_id, ordinal);

CREATE TABLE workflow_artifacts (
  id                         TEXT PRIMARY KEY,
  goal_id                    TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id            TEXT REFERENCES workflow_runs(id),
  step_run_id                TEXT REFERENCES workflow_step_runs(id),
  type                       TEXT NOT NULL,
  title                      TEXT NOT NULL,
  body                       TEXT NOT NULL,
  source                     TEXT NOT NULL CHECK (source IN ('user','agent','orchestrator','system')),
  linked_session_id          TEXT REFERENCES sessions(id),
  linked_task_id             TEXT REFERENCES tasks(id),
  linked_context_package_id  TEXT REFERENCES context_packages(id),
  created_at                 TEXT NOT NULL
);
CREATE INDEX idx_workflow_artifacts_goal_type
  ON workflow_artifacts(goal_id, type, created_at DESC);
CREATE INDEX idx_workflow_artifacts_run_step
  ON workflow_artifacts(workflow_run_id, step_run_id);

CREATE TABLE workflow_decisions (
  id                            TEXT PRIMARY KEY,
  goal_id                       TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id               TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id                   TEXT REFERENCES workflow_step_runs(id),
  decision_type                 TEXT NOT NULL,
  selected_action               TEXT NOT NULL,
  reason                        TEXT NOT NULL,
  influenced_by_json            TEXT NOT NULL DEFAULT '[]',
  alternatives_considered_json  TEXT NOT NULL DEFAULT '[]',
  confidence                    REAL,
  operator_selection_json       TEXT,
  input_fingerprint             TEXT NOT NULL,
  created_at                    TEXT NOT NULL
);
CREATE INDEX idx_workflow_decisions_run_created
  ON workflow_decisions(workflow_run_id, created_at DESC);
CREATE INDEX idx_workflow_decisions_goal_created
  ON workflow_decisions(goal_id, created_at DESC);
CREATE INDEX idx_workflow_decisions_step
  ON workflow_decisions(step_run_id) WHERE step_run_id IS NOT NULL;
CREATE UNIQUE INDEX idx_workflow_decisions_fp_window
  ON workflow_decisions(workflow_run_id, COALESCE(step_run_id, ''), decision_type, input_fingerprint);

CREATE TABLE workflow_guardrail_evaluations (
  id              TEXT PRIMARY KEY,
  goal_id         TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id     TEXT REFERENCES workflow_step_runs(id),
  guardrail_id    TEXT NOT NULL,
  guardrail_kind  TEXT NOT NULL,
  decision_id     TEXT REFERENCES workflow_decisions(id),
  result          TEXT NOT NULL CHECK (result IN ('allow','deny','require_approval')),
  message         TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_workflow_guardrail_eval_run
  ON workflow_guardrail_evaluations(workflow_run_id, created_at DESC);
CREATE INDEX idx_workflow_guardrail_eval_goal
  ON workflow_guardrail_evaluations(goal_id, created_at DESC);

CREATE TABLE workflow_llm_calls (
  id                  TEXT PRIMARY KEY,
  goal_id             TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id     TEXT REFERENCES workflow_runs(id),
  step_run_id         TEXT REFERENCES workflow_step_runs(id),
  decision_id         TEXT REFERENCES workflow_decisions(id),
  provider_id         TEXT NOT NULL,
  provider_version    TEXT NOT NULL,
  model               TEXT NOT NULL,
  usage_tokens_input  INTEGER,
  usage_tokens_output INTEGER,
  latency_ms          INTEGER,
  status              TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  failure_code        TEXT,
  failure_message     TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_workflow_llm_calls_provider_created
  ON workflow_llm_calls(provider_id, created_at DESC);
CREATE INDEX idx_workflow_llm_calls_goal_created
  ON workflow_llm_calls(goal_id, created_at DESC);

ALTER TABLE goals ADD COLUMN orchestrator_provider TEXT;
ALTER TABLE goals ADD COLUMN orchestrator_model TEXT;
ALTER TABLE goals ADD COLUMN active_workflow_run_id TEXT REFERENCES workflow_runs(id);

ALTER TABLE sessions ADD COLUMN workflow_step_run_id TEXT REFERENCES workflow_step_runs(id);
ALTER TABLE context_packages ADD COLUMN workflow_step_run_id TEXT REFERENCES workflow_step_runs(id);
ALTER TABLE tasks ADD COLUMN workflow_step_run_id TEXT REFERENCES workflow_step_runs(id);
ALTER TABLE recommendations ADD COLUMN workflow_step_run_id TEXT REFERENCES workflow_step_runs(id);
