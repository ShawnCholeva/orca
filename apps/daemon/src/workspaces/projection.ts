import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { Workspace, WorkspaceSummary, WorkspaceGoalView } from "@orca/contracts";

export class DuplicateWorkspaceError extends Error {
  readonly code = "workspace_duplicate" as const;
  constructor(public readonly path: string) {
    super(`Workspace already exists for path: ${path}`);
    this.name = "DuplicateWorkspaceError";
  }
}

interface EntityRow { id: string; path: string; name: string; description: string; created_at: string; updated_at: string; }

function toWorkspace(r: EntityRow): Workspace {
  return Workspace.parse({ id: r.id, path: r.path, name: r.name, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at });
}

let _db: Database.Database | null = null;
let _s: Record<string, Database.Statement> | null = null;

function stmts(db: Database.Database) {
  if (db !== _db) {
    _db = db;
    _s = {
      insert: db.prepare("INSERT INTO workspaces (id,path,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)"),
      byId: db.prepare("SELECT id,path,name,description,created_at,updated_at FROM workspaces WHERE id = ?"),
      byPath: db.prepare("SELECT id,path,name,description,created_at,updated_at FROM workspaces WHERE path = ?"),
      update: db.prepare("UPDATE workspaces SET name = ?, description = ?, updated_at = ? WHERE id = ?"),
      link: db.prepare("INSERT OR IGNORE INTO goal_workspaces (goal_id,workspace_id,attached_at) VALUES (?,?,?)"),
      unlink: db.prepare("DELETE FROM goal_workspaces WHERE goal_id = ? AND workspace_id = ?"),
      byGoal: db.prepare(
        "SELECT w.id,w.path,w.name,w.description,w.created_at,w.updated_at FROM workspaces w " +
        "JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ? ORDER BY gw.attached_at ASC, w.id ASC"),
      identitiesByGoal: db.prepare(
        "SELECT gw.goal_id AS goal_id, w.id AS id, w.name AS name FROM goal_workspaces gw " +
        "JOIN workspaces w ON w.id = gw.workspace_id ORDER BY gw.attached_at ASC, w.id ASC"),
      linksByGoal: db.prepare(
        "SELECT workspace_id, attached_at FROM goal_workspaces WHERE goal_id = ? ORDER BY attached_at ASC"),
      byIdAndGoal: db.prepare(
        "SELECT w.id,w.path,w.name,w.description,w.created_at,w.updated_at FROM workspaces w " +
        "JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE w.id = ? AND gw.goal_id = ?"),
      summaries: db.prepare(
        "SELECT w.id,w.path,w.name,w.description,w.created_at,w.updated_at, " +
        " COALESCE(SUM(CASE WHEN g.status='active' THEN 1 ELSE 0 END),0) AS active, " +
        " COALESCE(SUM(CASE WHEN g.status='completed' THEN 1 ELSE 0 END),0) AS completed, " +
        " COALESCE(SUM(CASE WHEN g.status='archived' THEN 1 ELSE 0 END),0) AS archived " +
        "FROM workspaces w " +
        "LEFT JOIN goal_workspaces gw ON gw.workspace_id = w.id " +
        "LEFT JOIN goals g ON g.id = gw.goal_id " +
        "GROUP BY w.id ORDER BY w.name ASC, w.id ASC"),
      goalsForWs: db.prepare(
        "SELECT g.id,g.title,g.intent AS description,g.status,g.created_at,g.active_workflow_run_id AS run_id " +
        "FROM goals g JOIN goal_workspaces gw ON gw.goal_id = g.id " +
        "WHERE gw.workspace_id = ? ORDER BY g.created_at DESC, g.id ASC"),
      runProgress: db.prepare(
        "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status='passed' THEN 1 ELSE 0 END),0) AS done " +
        "FROM workflow_step_runs WHERE workflow_run_id = ?"),
    };
  }
  return _s!;
}

export function resetPreparedStatements(): void { _db = null; _s = null; }

export function insertWorkspaceEntity(db: Database.Database, ws: Workspace): void {
  try {
    stmts(db).insert.run(ws.id, ws.path, ws.name, ws.description, ws.createdAt, ws.updatedAt);
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new DuplicateWorkspaceError(ws.path);
    }
    throw e;
  }
}

export function findWorkspaceById(db: Database.Database, id: string): Workspace | null {
  const r = stmts(db).byId.get(id) as EntityRow | undefined;
  return r ? toWorkspace(r) : null;
}

export function findWorkspaceByPath(db: Database.Database, path: string): Workspace | null {
  const r = stmts(db).byPath.get(path) as EntityRow | undefined;
  return r ? toWorkspace(r) : null;
}

export function updateWorkspaceEntity(db: Database.Database, id: string, patch: { name?: string; description?: string }, updatedAt: string): Workspace | null {
  const cur = findWorkspaceById(db, id);
  if (!cur) return null;
  const name = patch.name ?? cur.name;
  const description = patch.description ?? cur.description;
  stmts(db).update.run(name, description, updatedAt, id);
  return findWorkspaceById(db, id);
}

export function linkGoalWorkspace(db: Database.Database, goalId: string, workspaceId: string, attachedAt: string): void {
  stmts(db).link.run(goalId, workspaceId, attachedAt);
}

export function unlinkGoalWorkspace(db: Database.Database, goalId: string, workspaceId: string): boolean {
  return stmts(db).unlink.run(goalId, workspaceId).changes > 0;
}

export function listWorkspacesByGoal(db: Database.Database, goalId: string): Workspace[] {
  return (stmts(db).byGoal.all(goalId) as EntityRow[]).map(toWorkspace);
}

// Batched goal→workspace identity map for the goals-list payload: one grouped
// query over all attachments (no N+1), keyed by goal_id. Goals with no
// workspaces are simply absent from the map (callers default to []).
export function listWorkspaceIdentitiesByGoal(
  db: Database.Database,
): Map<string, { id: string; name: string }[]> {
  type Row = { goal_id: string; id: string; name: string };
  const rows = stmts(db).identitiesByGoal.all() as Row[];
  const byGoal = new Map<string, { id: string; name: string }[]>();
  for (const r of rows) {
    const list = byGoal.get(r.goal_id);
    if (list) list.push({ id: r.id, name: r.name });
    else byGoal.set(r.goal_id, [{ id: r.id, name: r.name }]);
  }
  return byGoal;
}

export function listGoalWorkspaceLinks(db: Database.Database, goalId: string): { workspaceId: string; attachedAt: string }[] {
  type Row = { workspace_id: string; attached_at: string };
  return (stmts(db).linksByGoal.all(goalId) as Row[]).map((r) => ({ workspaceId: r.workspace_id, attachedAt: r.attached_at }));
}

export function getWorkspaceByIdAndGoal(db: Database.Database, workspaceId: string, goalId: string): Workspace | null {
  const r = stmts(db).byIdAndGoal.get(workspaceId, goalId) as EntityRow | undefined;
  return r ? toWorkspace(r) : null;
}

export function listWorkspaceSummaries(db: Database.Database): WorkspaceSummary[] {
  type Row = EntityRow & { active: number; completed: number; archived: number };
  return (stmts(db).summaries.all() as Row[]).map((r) =>
    WorkspaceSummary.parse({ ...toWorkspace(r), exists: existsSync(r.path), goalCounts: { active: r.active, completed: r.completed, archived: r.archived } })
  );
}

export function listGoalViewsForWorkspace(db: Database.Database, workspaceId: string): WorkspaceGoalView[] {
  type Row = { id: string; title: string; description: string; status: string; created_at: string; run_id: string | null };
  const rows = stmts(db).goalsForWs.all(workspaceId) as Row[];
  return rows.map((g) => {
    let progress: number | null = null;
    if (g.status === "completed") {
      // A completed goal is, by definition, fully progressed.
      progress = 1;
    } else if (g.status === "active" && g.run_id) {
      const p = stmts(db).runProgress.get(g.run_id) as { total: number; done: number };
      progress = p.total > 0 ? p.done / p.total : null;
    }
    return WorkspaceGoalView.parse({
      id: g.id, title: g.title, description: g.description, status: g.status, createdAt: g.created_at, progress,
    });
  });
}
