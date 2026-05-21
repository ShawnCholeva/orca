CREATE TABLE task_generations (
  id                    TEXT PRIMARY KEY,
  goal_id               TEXT NOT NULL REFERENCES goals(id),
  trigger               TEXT NOT NULL CHECK (trigger IN ('manual', 'refinement_applied')),
  trigger_source_id     TEXT,
  generator_id          TEXT NOT NULL,
  generator_version     TEXT NOT NULL,
  input_fingerprint     TEXT NOT NULL,
  request_fingerprint   TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  failure_code          TEXT CHECK (
    failure_code IS NULL OR failure_code IN (
      'invalid_input',
      'invalid_output',
      'provider_error',
      'daemon_restart',
      'goal_archived',
      'sparse_input',
      'internal_error'
    )
  ),
  failure_message       TEXT,
  task_ids_json         TEXT NOT NULL DEFAULT '[]',
  sparse                INTEGER NOT NULL DEFAULT 0 CHECK (sparse IN (0, 1)),
  requested_at          TEXT NOT NULL,
  started_at            TEXT,
  finished_at           TEXT
);

CREATE UNIQUE INDEX idx_task_generations_active_fp
  ON task_generations(goal_id, request_fingerprint)
  WHERE status IN ('pending', 'running', 'succeeded');
CREATE INDEX idx_task_generations_goal_requested
  ON task_generations(goal_id, requested_at DESC);
CREATE INDEX idx_task_generations_status
  ON task_generations(status, requested_at);

CREATE TABLE tasks (
  id                       TEXT PRIMARY KEY,
  goal_id                  TEXT NOT NULL REFERENCES goals(id),
  parent_task_id           TEXT REFERENCES tasks(id),
  workspace_id             TEXT REFERENCES workspaces(id),
  role                     TEXT NOT NULL CHECK (role IN ('architect', 'engineer', 'reviewer', 'qa', 'generalist')),
  status                   TEXT NOT NULL CHECK (status IN ('proposed', 'open', 'in_progress', 'blocked', 'done', 'cancelled', 'archived')),
  origin                   TEXT NOT NULL CHECK (origin IN ('user', 'generator', 'recommendation')),
  title                    TEXT NOT NULL,
  description              TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  validation_steps_json    TEXT NOT NULL DEFAULT '[]',
  dependencies_json        TEXT NOT NULL DEFAULT '[]',
  sources_json             TEXT NOT NULL DEFAULT '[]',
  generation_id            TEXT REFERENCES task_generations(id),
  fingerprint              TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  archived_at              TEXT
);

CREATE INDEX idx_tasks_goal_status_created
  ON tasks(goal_id, status, created_at DESC);
CREATE INDEX idx_tasks_workspace_status
  ON tasks(workspace_id, status)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX idx_tasks_parent
  ON tasks(parent_task_id)
  WHERE parent_task_id IS NOT NULL;
CREATE UNIQUE INDEX idx_tasks_goal_fingerprint_active
  ON tasks(goal_id, fingerprint)
  WHERE origin = 'generator' AND status NOT IN ('cancelled', 'archived');

CREATE TABLE recommendation_generations (
  id                      TEXT PRIMARY KEY,
  goal_id                 TEXT NOT NULL REFERENCES goals(id),
  trigger                 TEXT NOT NULL CHECK (
    trigger IN (
      'manual',
      'refinement_applied',
      'session_completed',
      'session_summary_created',
      'session_summary_updated',
      'memory_promoted',
      'memory_canonical',
      'decision_confirmed',
      'decision_confirmation_required',
      'context_package_created',
      'task_created',
      'task_status_changed',
      'conflict_detected',
      'user_feedback_recorded'
    )
  ),
  trigger_source_id       TEXT,
  provider_id             TEXT NOT NULL,
  provider_version        TEXT NOT NULL,
  input_fingerprint       TEXT NOT NULL,
  request_fingerprint     TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  failure_code            TEXT CHECK (
    failure_code IS NULL OR failure_code IN (
      'invalid_input',
      'invalid_output',
      'provider_error',
      'daemon_restart',
      'goal_archived',
      'sparse_input',
      'internal_error'
    )
  ),
  failure_message         TEXT,
  recommendation_ids_json TEXT NOT NULL DEFAULT '[]',
  superseded_ids_json     TEXT NOT NULL DEFAULT '[]',
  sparse                  INTEGER NOT NULL DEFAULT 0 CHECK (sparse IN (0, 1)),
  requested_at            TEXT NOT NULL,
  started_at              TEXT,
  finished_at             TEXT
);

CREATE UNIQUE INDEX idx_rec_generations_active_fp
  ON recommendation_generations(goal_id, request_fingerprint)
  WHERE status IN ('pending', 'running', 'succeeded');
CREATE INDEX idx_rec_generations_goal_requested
  ON recommendation_generations(goal_id, requested_at DESC);
CREATE INDEX idx_rec_generations_status
  ON recommendation_generations(status, requested_at);

CREATE TABLE recommendations (
  id                     TEXT PRIMARY KEY,
  goal_id                TEXT NOT NULL REFERENCES goals(id),
  generation_id          TEXT REFERENCES recommendation_generations(id),
  type                   TEXT NOT NULL CHECK (
    type IN (
      'create_session',
      'continue_session',
      'review_output',
      'refine_goal',
      'split_task',
      'run_validation',
      'resolve_conflict',
      'update_plan',
      'ask_user',
      'mark_complete',
      'pause_work'
    )
  ),
  status                 TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'dismissed', 'modified', 'superseded')),
  source                 TEXT NOT NULL CHECK (source IN ('deterministic_provider', 'user_modified')),
  title                  TEXT NOT NULL,
  rationale              TEXT NOT NULL,
  proposed_action_json   TEXT NOT NULL,
  confidence             REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  sources_json           TEXT NOT NULL DEFAULT '[]',
  related_task_id        TEXT REFERENCES tasks(id),
  related_session_id     TEXT REFERENCES sessions(id),
  related_context_pkg_id TEXT REFERENCES context_packages(id),
  related_conflict_id    TEXT REFERENCES conflicts(id),
  fingerprint            TEXT NOT NULL,
  superseded_by_id       TEXT REFERENCES recommendations(id),
  superseded_reason      TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  resolved_at            TEXT
);

CREATE INDEX idx_recs_goal_status_created
  ON recommendations(goal_id, status, created_at DESC);
CREATE INDEX idx_recs_goal_type
  ON recommendations(goal_id, type);
CREATE INDEX idx_recs_task
  ON recommendations(related_task_id)
  WHERE related_task_id IS NOT NULL;
CREATE INDEX idx_recs_session
  ON recommendations(related_session_id)
  WHERE related_session_id IS NOT NULL;
CREATE INDEX idx_recs_conflict
  ON recommendations(related_conflict_id)
  WHERE related_conflict_id IS NOT NULL;
CREATE UNIQUE INDEX idx_recs_goal_fingerprint_active
  ON recommendations(goal_id, fingerprint)
  WHERE status = 'proposed';

CREATE TABLE conflicts (
  id              TEXT PRIMARY KEY,
  goal_id         TEXT NOT NULL REFERENCES goals(id),
  conflict_type   TEXT NOT NULL CHECK (
    conflict_type IN (
      'workspace_overlap',
      'contradictory_decisions',
      'reviewer_rejection',
      'blocker_reported',
      'unresolved_question'
    )
  ),
  severity        TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocker')),
  status          TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  sources_json    TEXT NOT NULL DEFAULT '[]',
  fingerprint     TEXT NOT NULL,
  resolution_note TEXT,
  detected_at     TEXT NOT NULL,
  resolved_at     TEXT
);

CREATE INDEX idx_conflicts_goal_status
  ON conflicts(goal_id, status, detected_at DESC);
CREATE UNIQUE INDEX idx_conflicts_goal_fp_open
  ON conflicts(goal_id, fingerprint)
  WHERE status = 'open';

CREATE TABLE recommendation_feedback (
  id                    TEXT PRIMARY KEY,
  recommendation_id     TEXT NOT NULL REFERENCES recommendations(id),
  goal_id               TEXT NOT NULL REFERENCES goals(id),
  action                TEXT NOT NULL CHECK (action IN ('accept', 'reject', 'dismiss', 'modify')),
  note                  TEXT,
  modified_payload_json TEXT,
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_feedback_goal_created
  ON recommendation_feedback(goal_id, created_at DESC);
CREATE INDEX idx_feedback_recommendation
  ON recommendation_feedback(recommendation_id);
CREATE UNIQUE INDEX idx_feedback_terminal_action
  ON recommendation_feedback(recommendation_id, action)
  WHERE action IN ('accept', 'reject', 'dismiss');

ALTER TABLE sessions ADD COLUMN task_id TEXT REFERENCES tasks(id);
ALTER TABLE sessions ADD COLUMN from_recommendation_id TEXT REFERENCES recommendations(id);

CREATE INDEX idx_sessions_task
  ON sessions(task_id)
  WHERE task_id IS NOT NULL;

ALTER TABLE context_packages ADD COLUMN task_id TEXT REFERENCES tasks(id);
ALTER TABLE context_packages ADD COLUMN from_recommendation_id TEXT REFERENCES recommendations(id);

CREATE INDEX idx_context_packages_task
  ON context_packages(task_id)
  WHERE task_id IS NOT NULL;
