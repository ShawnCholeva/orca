-- 0046_step_run_pending_revision.sql
-- Durable stash for revision feedback that could not be delivered inline. The
-- orchestrator decides a revision on the worker's Stop-hook request, but the
-- worker cannot return to idle until that request returns — so delivering in
-- band self-deadlocks and the step is stranded active. We instead persist the
-- pending revision here and flush it once the worker is genuinely idle (and let
-- reconcile re-drive it after a restart). Nullable; cleared on delivery.
ALTER TABLE workflow_step_runs ADD COLUMN pending_revision_json TEXT;
