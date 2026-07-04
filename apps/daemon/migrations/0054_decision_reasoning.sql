-- Reasoning-first (5.5): persist the model's pre-verdict reasoning on gate/split decisions.
ALTER TABLE workflow_gate_decisions ADD COLUMN reasoning TEXT;
ALTER TABLE workflow_split_decisions ADD COLUMN reasoning TEXT;
