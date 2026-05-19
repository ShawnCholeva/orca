CREATE TABLE sessions (
  id                    TEXT PRIMARY KEY,
  goal_id               TEXT NOT NULL,
  workspace_id          TEXT NOT NULL,
  adapter_id            TEXT NOT NULL,
  role                  TEXT,
  instruction           TEXT,
  title                 TEXT NOT NULL,
  status                TEXT NOT NULL,
  pid                   INTEGER,
  command               TEXT,
  args_json             TEXT,
  cwd                   TEXT,
  terminal_cols         INTEGER,
  terminal_rows         INTEGER,
  exit_code             INTEGER,
  exit_signal           TEXT,
  failure_reason        TEXT,
  failure_detail        TEXT,
  created_at            TEXT NOT NULL,
  started_at            TEXT,
  exited_at             TEXT,
  archived_at           TEXT,
  output_seq            INTEGER NOT NULL DEFAULT 0,
  output_bytes_kept     INTEGER NOT NULL DEFAULT 0,
  output_offset_first   INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE INDEX idx_sessions_goal_created ON sessions(goal_id, created_at DESC);
CREATE INDEX idx_sessions_goal_status ON sessions(goal_id, status);

CREATE TABLE session_output_chunks (
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  byte_offset   INTEGER NOT NULL,
  byte_length   INTEGER NOT NULL,
  written_at    TEXT NOT NULL,
  data          BLOB NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_output_session_seq ON session_output_chunks(session_id, seq);
