CREATE TABLE orchestrator_messages (
  id             TEXT PRIMARY KEY,
  goal_id        TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('user', 'orchestrator', 'system')),
  kind           TEXT NOT NULL CHECK (kind IN ('message')),
  body           TEXT NOT NULL,
  correlation_id TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_orchestrator_messages_goal_created
  ON orchestrator_messages(goal_id, created_at, id);
