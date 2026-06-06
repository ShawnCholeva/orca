-- 0024_activities.sql
-- First-class Orca Activity Thread projection: one updating row per agent turn,
-- grouped by step run. Subsumes the never-wired internal_thought scaffold for
-- supervision narration. Nothing FK-references this table.
CREATE TABLE activities (
  id               TEXT PRIMARY KEY,
  goal_id          TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  workflow_run_id  TEXT NOT NULL,
  step_run_id      TEXT NOT NULL,
  agent_session_id TEXT,
  turn_ordinal     INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL CHECK (status IN ('active','paused_for_input','completed','expired')),
  current_text     TEXT NOT NULL,
  final_summary    TEXT,
  source_kind      TEXT NOT NULL,
  work_category    TEXT,
  confidence       TEXT,
  pending_question TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  completed_at     TEXT
);

CREATE INDEX idx_activities_goal_created ON activities(goal_id, created_at, id);
CREATE INDEX idx_activities_step_run ON activities(step_run_id, turn_ordinal);

-- Dedup key: at most one live (non-terminal) activity per step run.
CREATE UNIQUE INDEX idx_activities_one_live_per_step
  ON activities(step_run_id) WHERE status IN ('active','paused_for_input');
