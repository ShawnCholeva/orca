-- 0068_session_model_choice.sql
-- The model a session must run, carried on the session row.
--
-- Dispatch resolves the model, but the launcher only CREATES the row; the pty
-- starts later, in sessions/runtime.ts, where the resolved choice is no longer
-- in scope. Without these columns that hop drops the choice and the CLI falls
-- back to whatever ~/.claude/settings.json says — which is precisely the defect
-- this work exists to remove.
--
-- Additive and nullable. Rows written before this land carry NULL and were run
-- under the ambient default; they must NOT be backfilled with the model their
-- step template merely preferred, since that preference is what was already
-- being recorded and never honoured.
ALTER TABLE sessions ADD COLUMN model_id TEXT;
ALTER TABLE sessions ADD COLUMN context_variant TEXT;
ALTER TABLE sessions ADD COLUMN effort TEXT;
