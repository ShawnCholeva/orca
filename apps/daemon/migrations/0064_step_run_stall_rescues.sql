-- 0064_step_run_stall_rescues.sql
-- Counts rescues caused by a worker that stopped making progress (or by the user
-- saying so), as distinct from crash_retries, which counts workers that died.
-- Both share the CRASH_RETRY_CAP budget; only this one costs the step score.
ALTER TABLE workflow_step_runs ADD COLUMN stall_rescues INTEGER NOT NULL DEFAULT 0;
