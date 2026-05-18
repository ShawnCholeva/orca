import type Database from "better-sqlite3";
import { Workspace } from "@orca/contracts";

interface WorkspaceRow {
  id: string;
  goal_id: string;
  path: string;
  name: string;
  workspace_type: "repo" | "folder";
  branch: string | null;
  is_dirty: number | null;
  git_probe: "ok" | "unavailable" | "errored" | "not_a_repo";
  attached_at: string;
}

export class DuplicateWorkspaceError extends Error {
  readonly code = "workspace_duplicate" as const;

  constructor(public readonly goalId: string, public readonly path: string) {
    super(`Workspace already attached: ${path}`);
    this.name = "DuplicateWorkspaceError";
  }
}

let _db: Database.Database | null = null;
let _stmts: {
  insertWorkspace: Database.Statement;
  deleteWorkspace: Database.Statement;
  findWorkspaceByPath: Database.Statement;
  listWorkspacesByGoal: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertWorkspace: db.prepare(
        "INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      deleteWorkspace: db.prepare("DELETE FROM workspaces WHERE goal_id = ? AND id = ?"),
      findWorkspaceByPath: db.prepare(
        "SELECT id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at FROM workspaces WHERE goal_id = ? AND path = ?",
      ),
      listWorkspacesByGoal: db.prepare(
        "SELECT id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at FROM workspaces WHERE goal_id = ? ORDER BY attached_at ASC, id ASC",
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return Workspace.parse({
    id: row.id,
    goalId: row.goal_id,
    path: row.path,
    name: row.name,
    workspaceType: row.workspace_type,
    branch: row.branch,
    isDirty: row.is_dirty === null ? null : row.is_dirty !== 0,
    gitProbe: row.git_probe,
    attachedAt: row.attached_at,
  });
}

function isSqliteUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && code === "SQLITE_CONSTRAINT_UNIQUE";
}

export function insertWorkspace(db: Database.Database, row: Workspace): void {
  const stmts = ensureStmts(db);
  const existing = findWorkspaceByPath(db, row.goalId, row.path);
  if (existing) {
    throw new DuplicateWorkspaceError(row.goalId, row.path);
  }

  try {
    stmts.insertWorkspace.run(
      row.id,
      row.goalId,
      row.path,
      row.name,
      row.workspaceType,
      row.branch,
      row.isDirty === null ? null : row.isDirty ? 1 : 0,
      row.gitProbe,
      row.attachedAt,
    );
  } catch (error: unknown) {
    if (isSqliteUniqueConstraintError(error)) {
      throw new DuplicateWorkspaceError(row.goalId, row.path);
    }
    throw error;
  }
}

export function deleteWorkspace(db: Database.Database, goalId: string, workspaceId: string): boolean {
  const stmts = ensureStmts(db);
  const result = stmts.deleteWorkspace.run(goalId, workspaceId);
  return result.changes > 0;
}

export function findWorkspaceByPath(
  db: Database.Database,
  goalId: string,
  path: string,
): Workspace | null {
  const stmts = ensureStmts(db);
  const row = stmts.findWorkspaceByPath.get(goalId, path) as WorkspaceRow | undefined;
  if (!row) {
    return null;
  }
  return rowToWorkspace(row);
}

export function listWorkspacesByGoal(db: Database.Database, goalId: string): Workspace[] {
  const stmts = ensureStmts(db);
  const rows = stmts.listWorkspacesByGoal.all(goalId) as WorkspaceRow[];
  return rows.map(rowToWorkspace);
}
