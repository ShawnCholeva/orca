-- 0041_goal_operating_mode.sql
-- Unified per-goal autonomy control: 'human_review' (gate consequential actions
-- + pause step progression for confirm) or 'automated' (run unattended except
-- the safety floor). Supersedes worker_permission_mode (per-tool) and the global
-- supervision_mode (step progression); those remain for back-compat but are no
-- longer read for gate decisions. Backfilled from worker_permission_mode.
ALTER TABLE goals
  ADD COLUMN operating_mode TEXT NOT NULL DEFAULT 'human_review'
  CHECK (operating_mode IN ('human_review', 'automated'));

UPDATE goals SET operating_mode =
  CASE worker_permission_mode WHEN 'auto' THEN 'automated' ELSE 'human_review' END;
