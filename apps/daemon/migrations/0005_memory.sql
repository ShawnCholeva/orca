CREATE TABLE memory_extractions (
  id                   TEXT PRIMARY KEY,
  goal_id              TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  trigger              TEXT NOT NULL CHECK (trigger IN ('terminal_state', 'goal_open', 'manual')),
  status               TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  extractor_version    TEXT NOT NULL,
  source_fingerprint   TEXT NOT NULL,
  source_offset_first  INTEGER,
  source_offset_last   INTEGER,
  summary_id           TEXT,
  item_count           INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  decision_count       INTEGER NOT NULL DEFAULT 0 CHECK (decision_count >= 0),
  promoted_count       INTEGER NOT NULL DEFAULT 0 CHECK (promoted_count >= 0),
  failure_code         TEXT CHECK (
    failure_code IS NULL OR failure_code IN (
      'invalid_output',
      'timeout',
      'session_not_terminal',
      'output_unavailable',
      'source_truncated',
      'goal_archived',
      'session_archived',
      'daemon_restart',
      'internal_error'
    )
  ),
  failure_message      TEXT,
  requested_at         TEXT NOT NULL,
  started_at           TEXT,
  finished_at          TEXT,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE goal_memory_items (
  id                   TEXT PRIMARY KEY,
  goal_id              TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (
    type IN (
      'constraint',
      'success_criterion',
      'assumption',
      'blocker',
      'open_question',
      'validation_result',
      'architecture_note',
      'note'
    )
  ),
  status               TEXT NOT NULL CHECK (status IN ('candidate', 'promoted', 'archived')),
  content              TEXT NOT NULL,
  content_hash         TEXT NOT NULL,
  confidence           REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  source_type          TEXT NOT NULL CHECK (source_type IN ('refinement', 'session', 'manual')),
  source_id            TEXT,
  source_session_id    TEXT,
  source_extraction_id TEXT,
  source_offset_first  INTEGER,
  source_offset_last   INTEGER,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  promoted_at          TEXT,
  archived_at          TEXT,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
  FOREIGN KEY (source_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (source_extraction_id) REFERENCES memory_extractions(id) ON DELETE SET NULL
);

CREATE TABLE goal_decisions (
  id                   TEXT PRIMARY KEY,
  goal_id              TEXT NOT NULL,
  title                TEXT NOT NULL,
  decision_text        TEXT NOT NULL,
  rationale            TEXT,
  status               TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'archived')),
  confirmation_required INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_required IN (0, 1)),
  confidence           REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  source_type          TEXT NOT NULL CHECK (source_type IN ('session', 'manual')),
  source_id            TEXT,
  source_session_id    TEXT,
  source_extraction_id TEXT,
  source_offset_first  INTEGER,
  source_offset_last   INTEGER,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  confirmed_at         TEXT,
  archived_at          TEXT,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
  FOREIGN KEY (source_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (source_extraction_id) REFERENCES memory_extractions(id) ON DELETE SET NULL
);

CREATE TABLE session_summaries (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL,
  goal_id              TEXT NOT NULL,
  extraction_id        TEXT NOT NULL,
  headline             TEXT NOT NULL,
  summary_text         TEXT NOT NULL,
  truncated            INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  source_offset_first  INTEGER NOT NULL,
  source_offset_last   INTEGER NOT NULL,
  created_at           TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
  FOREIGN KEY (extraction_id) REFERENCES memory_extractions(id) ON DELETE CASCADE
);

CREATE INDEX idx_memory_goal_status_created ON goal_memory_items(goal_id, status, created_at DESC);
CREATE INDEX idx_memory_goal_type ON goal_memory_items(goal_id, type);
CREATE UNIQUE INDEX idx_memory_dedupe ON goal_memory_items(goal_id, type, content_hash) WHERE status != 'archived';
CREATE INDEX idx_decision_goal_status_created ON goal_decisions(goal_id, status, created_at DESC);
CREATE INDEX idx_summary_session_created ON session_summaries(session_id, created_at DESC);
CREATE INDEX idx_summary_goal_created ON session_summaries(goal_id, created_at DESC);
CREATE INDEX idx_extraction_session_requested ON memory_extractions(session_id, requested_at DESC);
CREATE INDEX idx_extraction_goal_status ON memory_extractions(goal_id, status);
CREATE INDEX idx_extraction_runner_pickup ON memory_extractions(status, requested_at);
CREATE UNIQUE INDEX idx_extraction_active_fingerprint ON memory_extractions(session_id, source_fingerprint) WHERE status IN ('pending', 'running', 'succeeded');
