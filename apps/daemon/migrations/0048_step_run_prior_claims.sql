-- 0048_step_run_prior_claims.sql
-- Snapshot of the file-path claim-set asserted by the step's last-judged output
-- (a JSON array of path strings). Item 2.8 (assumption-level claim verification):
-- on a correction, the corrected output's NEW claims are diffed against this
-- snapshot and any that don't resolve against the step's workspace root are
-- rejected as fabrications. Nullable; overwritten each judged completion.
ALTER TABLE workflow_step_runs ADD COLUMN prior_claims_json TEXT;
