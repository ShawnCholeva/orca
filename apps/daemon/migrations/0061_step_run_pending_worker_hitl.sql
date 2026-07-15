-- 0061_step_run_pending_worker_hitl.sql
-- Durable park for a worker's AskUserQuestion (human-in-the-loop). The elicit
-- hook cannot hold open indefinitely (it times out and would bypass the human),
-- so instead of blocking we post the question to chat and PARK the step here:
--   pending_worker_question_id  — the step is waiting on a human answer; the
--                                 worker ended its turn. Set at ask time, cleared
--                                 when the answer is recorded. While set, the
--                                 worker's Stop-hook must NOT judge/advance the
--                                 step (a park is not a completion).
--   pending_worker_answer_json  — the recorded answer stashed for out-of-band
--                                 delivery to the (idle) worker, mirroring
--                                 pending_revision_json. Cleared on delivery;
--                                 reconcile blocks the run if it can't be
--                                 delivered after a restart. Both nullable.
ALTER TABLE workflow_step_runs ADD COLUMN pending_worker_question_id TEXT;
ALTER TABLE workflow_step_runs ADD COLUMN pending_worker_answer_json TEXT;
