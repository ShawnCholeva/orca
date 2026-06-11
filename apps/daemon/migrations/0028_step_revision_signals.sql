-- Divergence signal: the user refined a step the orchestrator had already
-- approved and scored. One row per refinement.
CREATE TABLE IF NOT EXISTS step_revision_signals (
  id                      TEXT PRIMARY KEY,
  step_run_id             TEXT NOT NULL,
  goal_id                 TEXT NOT NULL,
  revision_index          INTEGER NOT NULL,
  superseded_scoring_json TEXT NOT NULL,
  feedback_text           TEXT,
  created_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_step_revision_signals_step_run
  ON step_revision_signals (step_run_id);
