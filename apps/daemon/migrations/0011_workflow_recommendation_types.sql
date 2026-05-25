DROP INDEX IF EXISTS idx_recs_goal_status_created;
DROP INDEX IF EXISTS idx_recs_goal_type;
DROP INDEX IF EXISTS idx_recs_task;
DROP INDEX IF EXISTS idx_recs_session;
DROP INDEX IF EXISTS idx_recs_conflict;
DROP INDEX IF EXISTS idx_recs_goal_fingerprint_active;

PRAGMA legacy_alter_table = ON;
ALTER TABLE recommendations RENAME TO recommendations_old;
PRAGMA legacy_alter_table = OFF;

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
      'pause_work',
      'advance_workflow_step',
      'launch_workflow_session',
      'complete_workflow_run',
      'mark_artifact_satisfied',
      'request_user_input'
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
  resolved_at            TEXT,
  workflow_step_run_id   TEXT REFERENCES workflow_step_runs(id)
);

INSERT INTO recommendations (
  id,
  goal_id,
  generation_id,
  type,
  status,
  source,
  title,
  rationale,
  proposed_action_json,
  confidence,
  sources_json,
  related_task_id,
  related_session_id,
  related_context_pkg_id,
  related_conflict_id,
  fingerprint,
  superseded_by_id,
  superseded_reason,
  created_at,
  updated_at,
  resolved_at,
  workflow_step_run_id
)
SELECT
  id,
  goal_id,
  generation_id,
  type,
  status,
  source,
  title,
  rationale,
  proposed_action_json,
  confidence,
  sources_json,
  related_task_id,
  related_session_id,
  related_context_pkg_id,
  related_conflict_id,
  fingerprint,
  superseded_by_id,
  superseded_reason,
  created_at,
  updated_at,
  resolved_at,
  workflow_step_run_id
FROM recommendations_old;

DROP TABLE recommendations_old;

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
