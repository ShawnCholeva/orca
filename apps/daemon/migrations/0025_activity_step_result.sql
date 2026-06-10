-- 0025_activity_step_result.sql
-- Idempotency for terminal step-result activities: at most one step_result
-- activity per step run, surviving event replay and daemon recovery.
CREATE UNIQUE INDEX idx_activities_one_step_result_per_step
  ON activities(step_run_id) WHERE source_kind = 'step_result';
