-- Stashed agent response for an active step whose orchestrator evaluation
-- (the judge / shadow orchestrator) failed — e.g. a shadow timeout. NULL when
-- no evaluation is pending retry. Lets a failed judge be replayed instead of
-- the run silently parking with no result.
ALTER TABLE workflow_step_runs
  ADD COLUMN pending_judge_json TEXT;
