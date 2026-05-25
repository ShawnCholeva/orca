CREATE TABLE orchestration_workers (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'starting','ready','awaiting_input','producing_decision',
    'hung','auth_required','failed','stopped'
  )),
  pid INTEGER,
  command TEXT,
  args_json TEXT,
  cwd TEXT,
  current_goal_id TEXT REFERENCES goals(id),
  current_workflow_run_id TEXT REFERENCES workflow_runs(id),
  current_step_run_id TEXT REFERENCES workflow_step_runs(id),
  last_health_at TEXT,
  last_output_at TEXT,
  failure_reason TEXT,
  failure_detail TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  stopped_at TEXT
);

CREATE INDEX idx_orchestration_workers_provider_model_state
  ON orchestration_workers(provider_id, model, state);
CREATE INDEX idx_orchestration_workers_state_health
  ON orchestration_workers(state, last_health_at DESC);
CREATE INDEX idx_orchestration_workers_goal_run_step
  ON orchestration_workers(current_goal_id, current_workflow_run_id, current_step_run_id);

CREATE TABLE orchestration_worker_output_chunks (
  worker_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  written_at TEXT NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (worker_id, seq),
  FOREIGN KEY (worker_id) REFERENCES orchestration_workers(id) ON DELETE CASCADE
);

CREATE INDEX idx_orchestration_worker_output_written
  ON orchestration_worker_output_chunks(worker_id, written_at DESC);

CREATE TABLE orchestration_transport_attempts (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id TEXT REFERENCES workflow_runs(id),
  step_run_id TEXT REFERENCES workflow_step_runs(id),
  decision_id TEXT REFERENCES workflow_decisions(id),
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('one_shot','hidden_interactive','human_review')),
  worker_id TEXT REFERENCES orchestration_workers(id),
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','rejected','failed','fallback')),
  failure_reason TEXT,
  failure_message TEXT,
  raw_text_length INTEGER,
  latency_ms INTEGER,
  input_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX idx_orchestration_attempts_goal_created
  ON orchestration_transport_attempts(goal_id, created_at DESC);
CREATE INDEX idx_orchestration_attempts_run_created
  ON orchestration_transport_attempts(workflow_run_id, created_at DESC)
  WHERE workflow_run_id IS NOT NULL;
CREATE INDEX idx_orchestration_attempts_step_created
  ON orchestration_transport_attempts(step_run_id, created_at DESC)
  WHERE step_run_id IS NOT NULL;
CREATE INDEX idx_orchestration_attempts_worker_created
  ON orchestration_transport_attempts(worker_id, created_at DESC)
  WHERE worker_id IS NOT NULL;
CREATE INDEX idx_orchestration_attempts_active_reconcile
  ON orchestration_transport_attempts(status, created_at)
  WHERE status IN ('pending','running');

CREATE TABLE orchestration_worker_hook_traces (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES orchestration_transport_attempts(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL REFERENCES orchestration_workers(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  hook_event_name TEXT NOT NULL,
  hook_status TEXT NOT NULL CHECK (hook_status IN ('started','succeeded','blocked','failed','skipped')),
  summary TEXT NOT NULL,
  failure_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_orchestration_hook_traces_attempt_created
  ON orchestration_worker_hook_traces(attempt_id, created_at DESC);
CREATE INDEX idx_orchestration_hook_traces_worker_created
  ON orchestration_worker_hook_traces(worker_id, created_at DESC);

CREATE TABLE orchestration_human_reviews (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id TEXT REFERENCES workflow_step_runs(id),
  attempt_id TEXT NOT NULL REFERENCES orchestration_transport_attempts(id),
  decision_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','submitted','accepted','rejected')),
  submitted_proposal_json TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT
);

CREATE INDEX idx_orchestration_human_reviews_goal_created
  ON orchestration_human_reviews(goal_id, created_at DESC);
CREATE INDEX idx_orchestration_human_reviews_run_created
  ON orchestration_human_reviews(workflow_run_id, created_at DESC);
CREATE INDEX idx_orchestration_human_reviews_step_created
  ON orchestration_human_reviews(step_run_id, created_at DESC)
  WHERE step_run_id IS NOT NULL;
CREATE INDEX idx_orchestration_human_reviews_attempt
  ON orchestration_human_reviews(attempt_id);
CREATE INDEX idx_orchestration_human_reviews_status_created
  ON orchestration_human_reviews(status, created_at DESC);
