ALTER TABLE workflow_step_runs ADD COLUMN selected_operator_id TEXT;
ALTER TABLE workflow_step_runs ADD COLUMN selected_provider_id TEXT;
ALTER TABLE workflow_step_runs ADD COLUMN selected_model_id TEXT;
ALTER TABLE workflow_step_runs ADD COLUMN operator_selected_at TEXT;
