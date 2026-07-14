-- Reference documents attached to a goal: original ref (file path or URL)
-- plus a content snapshot for injection into agent context.
CREATE TABLE goal_documents (
  id            TEXT PRIMARY KEY,
  goal_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('file','url')),
  ref           TEXT NOT NULL,
  name          TEXT NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  content_bytes INTEGER NOT NULL,
  truncated     INTEGER NOT NULL DEFAULT 0,
  fetched_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
);

CREATE INDEX idx_goal_documents_goal ON goal_documents(goal_id);
CREATE UNIQUE INDEX idx_goal_documents_goal_ref ON goal_documents(goal_id, ref);
