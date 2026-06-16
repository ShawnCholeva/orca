-- 0034_activity_steps.sql
-- Persist each agent tool step as its own row so the chat can render an
-- accumulating checklist instead of overwriting a single live line. Nothing
-- FK-references activity_steps, so this runs in the normal transaction.
CREATE TABLE activity_steps (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  text        TEXT NOT NULL,
  category    TEXT,
  status      TEXT NOT NULL CHECK (status IN ('active', 'done')),
  diff        TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_activity_steps_activity ON activity_steps(activity_id, ordinal);
