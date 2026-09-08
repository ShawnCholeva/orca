-- 0068_session_model_choice.sql
-- The model a session must run, carried on the session row.
--
-- Dispatch resolves the model, but the launcher only CREATES the row; the pty
-- starts later, in sessions/runtime.ts, where the resolved choice is no longer
-- in scope. Without these columns that hop drops the choice and the CLI falls
-- back to whatever ~/.claude/settings.json says — which is precisely the defect
-- this work exists to remove.
--
-- STAGED, NOT YET FILLED IN PRODUCTION. `createSession({model})` writes these
-- columns, but no production caller passes `model`: the workflow worker path
-- never goes through sessions/runtime.ts at all — it runs
-- workerSpawnFn -> resolveSpawn -> worker-session.ts, which passes the model to
-- the CLI directly. sessions/runtime.ts serves POST /v1/sessions/:id/start, the
-- manually opened session, which has no step template and so no agentPreference
-- to honour. The caller that must eventually fill them is commitAgentStepDecision's
-- launcher path (dispatch-engine.ts ~:900 -> session-launcher-impl.ts), whose pty
-- starter is deliberately unwired today (server.ts ~:414-416).
--
-- Additive and nullable. Rows written before this land carry NULL and were run
-- under the ambient default; they must NOT be backfilled with the model their
-- step template merely preferred, since that preference is what was already
-- being recorded and never honoured.
ALTER TABLE sessions ADD COLUMN model_id TEXT;
ALTER TABLE sessions ADD COLUMN context_variant TEXT;
ALTER TABLE sessions ADD COLUMN effort TEXT;
