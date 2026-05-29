-- 0017_orchestrator_messages_chat_kinds.sql
-- Relax the role CHECK to allow agent_paraphrased + internal_thought, and add
-- chat-kind columns. SQLite cannot ALTER a CHECK, so rebuild the table.
-- Nothing FK-references orchestrator_messages, so this runs in the normal txn.
CREATE TABLE orchestrator_messages_new (
  id             TEXT PRIMARY KEY,
  goal_id        TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('user', 'orchestrator', 'system', 'agent_paraphrased', 'internal_thought')),
  kind           TEXT NOT NULL CHECK (kind IN ('message')),
  body           TEXT NOT NULL,
  correlation_id TEXT,
  created_at     TEXT NOT NULL,
  raw_agent_text TEXT,
  why_rationale  TEXT,
  internal_kind  TEXT
);

INSERT INTO orchestrator_messages_new
  (id, goal_id, role, kind, body, correlation_id, created_at)
SELECT id, goal_id, role, kind, body, correlation_id, created_at
  FROM orchestrator_messages;

DROP TABLE orchestrator_messages;

ALTER TABLE orchestrator_messages_new RENAME TO orchestrator_messages;

CREATE INDEX idx_orchestrator_messages_goal_created
  ON orchestrator_messages(goal_id, created_at, id);
