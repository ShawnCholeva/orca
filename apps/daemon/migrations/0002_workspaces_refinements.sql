CREATE TABLE goal_refinements (
  goal_id           TEXT PRIMARY KEY,
  skill_id          TEXT NOT NULL,
  success_criteria  TEXT NOT NULL,
  constraints       TEXT NOT NULL,
  assumptions       TEXT NOT NULL,
  refined_at        TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
);

CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  goal_id         TEXT NOT NULL,
  path            TEXT NOT NULL,
  name            TEXT NOT NULL,
  workspace_type  TEXT NOT NULL,
  branch          TEXT,
  is_dirty        INTEGER,
  git_probe       TEXT NOT NULL,
  attached_at     TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_workspaces_goal_path ON workspaces(goal_id, path);
CREATE INDEX idx_workspaces_goal_attached ON workspaces(goal_id, attached_at);
