-- 0022_workflow_step_result.sql
ALTER TABLE workflow_step_runs ADD COLUMN step_result_json TEXT;
