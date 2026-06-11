-- Supervised-mode stash: the approved completion (orca:step-complete block,
-- validated scoring proposal, finishedAt) held while a step waits at the
-- user confirmation checkpoint. NULL when not paused.
ALTER TABLE workflow_step_runs
  ADD COLUMN pending_completion_json TEXT;
