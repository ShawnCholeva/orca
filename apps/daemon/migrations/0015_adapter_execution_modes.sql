CREATE TABLE IF NOT EXISTS adapter_execution_modes (
  adapter_id            TEXT PRIMARY KEY,
  enabled_modes_json    TEXT NOT NULL,
  disabled_modes_json   TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  updated_by            TEXT
);
