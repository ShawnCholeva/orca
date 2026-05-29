-- 0018_workflow_step_runs_crash_retries.sql
ALTER TABLE workflow_step_runs ADD COLUMN crash_retries INTEGER NOT NULL DEFAULT 0;
