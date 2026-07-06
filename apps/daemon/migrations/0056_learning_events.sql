CREATE TABLE learning_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  template_id TEXT NOT NULL,
  proposal_id TEXT,                -- null for analyzed events
  step_template_id TEXT,           -- null for template-level events (baseline_restored)
  event_type TEXT NOT NULL,        -- created|judged|applied|dismissed|rolled_back|superseded|baseline_restored|analyzed
  template_version INTEGER NOT NULL, -- version at event time
  payload_json TEXT NOT NULL,      -- typed per event_type, bounded
  created_at TEXT NOT NULL
);
CREATE INDEX idx_learning_events_template ON learning_events (template_id, seq DESC);
