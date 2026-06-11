-- Global key/value app settings. First key: supervision_mode
-- ('supervised' | 'unsupervised'). Absence of the row means supervised.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
