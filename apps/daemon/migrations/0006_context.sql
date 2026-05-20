CREATE TABLE context_packages (
  id                    TEXT PRIMARY KEY,
  goal_id               TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  supersedes_package_id TEXT REFERENCES context_packages(id) ON DELETE SET NULL,
  adapter_id            TEXT NOT NULL,
  workspace_id          TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  role                  TEXT NOT NULL CHECK (role IN ('architect', 'engineer', 'reviewer', 'generalist')),
  objective             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('ready')),
  rendered_context      TEXT NOT NULL,
  rendered_bytes        INTEGER NOT NULL,
  estimated_tokens      INTEGER NOT NULL,
  truncated             INTEGER NOT NULL DEFAULT 0,
  sparse                INTEGER NOT NULL DEFAULT 0,
  source_count          INTEGER NOT NULL,
  sources_json          TEXT NOT NULL,
  warnings_json         TEXT NOT NULL DEFAULT '[]',
  source_fingerprint    TEXT NOT NULL,
  assembler_version     TEXT NOT NULL,
  created_at            TEXT NOT NULL
);

CREATE TABLE context_assemblies (
  id                  TEXT PRIMARY KEY,
  goal_id             TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  package_id          TEXT REFERENCES context_packages(id) ON DELETE SET NULL,
  replace_package_id  TEXT REFERENCES context_packages(id) ON DELETE SET NULL,
  adapter_id          TEXT NOT NULL,
  workspace_id        TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  role                TEXT NOT NULL CHECK (role IN ('architect', 'engineer', 'reviewer', 'generalist')),
  objective_hash      TEXT NOT NULL,
  source_fingerprint  TEXT NOT NULL,
  assembler_version   TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  trigger             TEXT NOT NULL CHECK (trigger IN ('prepare', 'regenerate', 'retry')),
  failure_code        TEXT,
  failure_message     TEXT,
  requested_at        TEXT NOT NULL,
  started_at          TEXT,
  finished_at         TEXT
);

CREATE INDEX idx_context_packages_goal_created ON context_packages(goal_id, created_at DESC);
CREATE INDEX idx_context_assemblies_goal_requested ON context_assemblies(goal_id, requested_at DESC);
CREATE INDEX idx_context_assemblies_status_requested ON context_assemblies(status, requested_at);
CREATE UNIQUE INDEX idx_context_assemblies_active_fingerprint
  ON context_assemblies(goal_id, request_fingerprint)
  WHERE status IN ('pending', 'running', 'succeeded');

ALTER TABLE sessions ADD COLUMN context_package_id TEXT REFERENCES context_packages(id) ON DELETE SET NULL;

CREATE INDEX idx_sessions_context_package
  ON sessions(context_package_id)
  WHERE context_package_id IS NOT NULL;
