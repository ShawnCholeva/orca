-- Transient per-step status shown while the orchestrator is between the worker
-- finishing and the step parking: 'reviewing' (judge turn) or
-- 'independent_check' (adversarial refute turn). Always cleared to NULL once the
-- step parks/completes; never a durable record — it exists only so the chat can
-- show honest in-progress status during that otherwise-silent window.
ALTER TABLE workflow_step_runs ADD COLUMN orchestrator_phase TEXT;
