-- Recoverable provider-limit state for an active workflow step.
-- NULL when the step is not awaiting a wait/retry/switch decision.
ALTER TABLE workflow_step_runs
  ADD COLUMN pending_provider_recovery_json TEXT;
