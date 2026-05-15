CREATE TABLE events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL,
  goal_id     TEXT,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_events_goal_seq ON events(goal_id, seq);
CREATE INDEX idx_events_type_seq ON events(type, seq);

CREATE TABLE goals (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL,
  autonomy_level  INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  archived_at     TEXT
);

CREATE INDEX idx_goals_updated_at ON goals(updated_at);
CREATE INDEX idx_goals_status ON goals(status);
