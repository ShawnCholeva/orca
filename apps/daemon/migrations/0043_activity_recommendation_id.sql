-- 0043_activity_recommendation_id.sql
-- The mark-done activity (sourceKind mark_done_pending) carries the
-- complete_workflow_run recommendation id so the chat can render and accept the
-- approve-to-complete affordance straight from the activities projection — no
-- separate recommendations fetch. Nullable; only mark_done_pending rows set it.
ALTER TABLE activities ADD COLUMN recommendation_id TEXT;
