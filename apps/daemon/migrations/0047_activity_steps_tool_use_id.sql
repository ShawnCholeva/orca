-- 0047_activity_steps_tool_use_id.sql
-- Make tool-step appends idempotent on the agent's tool_use_id. The hook spool
-- redelivers at-least-once (drained on every daemon start), so without a stable
-- key a redelivered tool call would append a second identical step row — the
-- source of duplicate "Read X" rows across restarts. Nullable + a partial unique
-- index: pre-existing rows and any step without a tool id keep NULL and are
-- exempt, while every id-bearing step is unique.
ALTER TABLE activity_steps ADD COLUMN tool_use_id TEXT;

CREATE UNIQUE INDEX idx_activity_steps_tool_use
  ON activity_steps(tool_use_id) WHERE tool_use_id IS NOT NULL;
