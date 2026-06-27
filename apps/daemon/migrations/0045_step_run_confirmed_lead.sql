-- 0045_step_run_confirmed_lead.sql
-- Snapshot the confirmation card's lead at confirm-pause time so the post-confirm
-- history card shows the SAME lead the user saw, instead of rebuilding it from a
-- different source (resultSummary ?? outcome.reason). Nullable; read side falls
-- back to the rebuild when NULL.
ALTER TABLE workflow_step_runs ADD COLUMN confirmed_lead TEXT;
