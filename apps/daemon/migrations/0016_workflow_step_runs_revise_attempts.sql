-- 0016_workflow_step_runs_revise_attempts.sql
ALTER TABLE workflow_step_runs ADD COLUMN revise_attempts INTEGER NOT NULL DEFAULT 0;
