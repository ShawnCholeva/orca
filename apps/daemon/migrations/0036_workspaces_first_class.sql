-- Promote workspaces to first-class entities (workspace == repo) and make
-- goal<->workspace many-to-many. Runs with foreign_keys OFF (see migrations.ts).

CREATE TABLE workspaces_new (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE goal_workspaces (
  goal_id      TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  attached_at  TEXT NOT NULL,
  PRIMARY KEY (goal_id, workspace_id),
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces_new(id) ON DELETE CASCADE
);

-- distinct path -> one new entity id (name/created_at from earliest attachment)
CREATE TEMP TABLE ws_map AS
SELECT
  path,
  lower(hex(randomblob(16))) AS new_id,
  (SELECT w2.name FROM workspaces w2
     WHERE w2.path = w.path ORDER BY w2.attached_at ASC, w2.id ASC LIMIT 1) AS name,
  MIN(attached_at) AS created_at
FROM workspaces w
GROUP BY path;

INSERT INTO workspaces_new (id, path, name, description, created_at, updated_at)
SELECT new_id, path, name, '', created_at, created_at FROM ws_map;

-- old workspace id -> new entity id, for the tasks remap
CREATE TEMP TABLE ws_idmap AS
SELECT w.id AS old_id, m.new_id AS new_id
FROM workspaces w JOIN ws_map m ON m.path = w.path;

INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at)
SELECT w.goal_id, m.new_id, w.attached_at
FROM workspaces w JOIN ws_map m ON m.path = w.path;

UPDATE tasks
SET workspace_id = (SELECT new_id FROM ws_idmap WHERE old_id = tasks.workspace_id)
WHERE workspace_id IS NOT NULL;

DROP TABLE workspaces;
ALTER TABLE workspaces_new RENAME TO workspaces;

CREATE INDEX idx_goal_workspaces_workspace ON goal_workspaces(workspace_id);

DROP TABLE ws_map;
DROP TABLE ws_idmap;
