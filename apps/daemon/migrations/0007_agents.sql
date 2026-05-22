CREATE TABLE agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  short_label  TEXT NOT NULL,
  description  TEXT NOT NULL,
  swatch       TEXT NOT NULL,
  recommended  INTEGER NOT NULL DEFAULT 0,
  connected    INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_agents_connected ON agents(connected);
CREATE INDEX idx_agents_sort_order ON agents(sort_order);
