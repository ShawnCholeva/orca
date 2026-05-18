import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DomainEvent, InspectWorkspacePreview, Workspace } from "@orca/contracts";
import type { EventBus } from "../events.js";
import { NotFoundError } from "../goals.js";
import { findWorkspaceByPath, insertWorkspace, deleteWorkspace, DuplicateWorkspaceError } from "./projection.js";

export { DuplicateWorkspaceError };

export interface WorkspaceCtx {
  db: Database.Database;
  bus: EventBus;
  inspectWorkspace(inputPath: string): Promise<InspectWorkspacePreview>;
}

interface GoalRow {
  id: string;
  archived_at: string | null;
}

interface WorkspaceRow {
  id: string;
  goal_id: string;
}

let _db: Database.Database | null = null;
let _stmts: {
  selectGoalById: Database.Statement;
  selectWorkspaceById: Database.Statement;
  insertEvent: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      selectGoalById: db.prepare("SELECT id, archived_at FROM goals WHERE id = ?"),
      selectWorkspaceById: db.prepare("SELECT id, goal_id FROM workspaces WHERE id = ?"),
      insertEvent: db.prepare(
        "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

export async function attachWorkspace(
  ctx: WorkspaceCtx,
  input: { goalId: string; inputPath: string; name?: string },
): Promise<Workspace> {
  const { goalId, inputPath, name } = input;
  const stmts = ensureStmts(ctx.db);

  const goalRow = stmts.selectGoalById.get(goalId) as GoalRow | undefined;
  if (!goalRow || goalRow.archived_at !== null) {
    throw new NotFoundError(goalId);
  }

  // authoritative; UI preview is not trusted
  const preview = await ctx.inspectWorkspace(inputPath);

  // optimistic check before the transaction — unique index is the final guard
  const existing = findWorkspaceByPath(ctx.db, goalId, preview.path);
  if (existing) {
    throw new DuplicateWorkspaceError(goalId, preview.path);
  }

  const wsId = randomUUID();
  const now = new Date().toISOString();
  const wsName = name ?? preview.name;

  const workspace: Workspace = {
    id: wsId,
    goalId,
    path: preview.path,
    name: wsName,
    workspaceType: preview.workspaceType,
    branch: preview.branch,
    isDirty: preview.isDirty,
    gitProbe: preview.gitProbe,
    attachedAt: now,
  };

  const eventPayload = {
    workspaceId: wsId,
    path: workspace.path,
    name: workspace.name,
    workspaceType: workspace.workspaceType,
    branch: workspace.branch,
    isDirty: workspace.isDirty,
    gitProbe: workspace.gitProbe,
  };

  let event!: DomainEvent;

  ctx.db.transaction(() => {
    const eventId = randomUUID();
    const result = stmts.insertEvent.run(
      eventId,
      "workspace.attached",
      goalId,
      JSON.stringify(eventPayload),
      now,
    );
    event = {
      seq: Number(result.lastInsertRowid),
      id: eventId,
      type: "workspace.attached",
      goalId,
      payload: eventPayload,
      createdAt: now,
    };
    insertWorkspace(ctx.db, workspace);
  })();

  // broadcast only after commit
  ctx.bus.publish(event);

  return workspace;
}

export async function detachWorkspace(
  ctx: WorkspaceCtx,
  input: { goalId: string; workspaceId: string },
): Promise<void> {
  const { goalId, workspaceId } = input;
  const stmts = ensureStmts(ctx.db);

  const wsRow = stmts.selectWorkspaceById.get(workspaceId) as WorkspaceRow | undefined;
  if (!wsRow || wsRow.goal_id !== goalId) {
    throw new NotFoundError(workspaceId);
  }

  const now = new Date().toISOString();
  const eventPayload = { workspaceId };

  let event!: DomainEvent;

  ctx.db.transaction(() => {
    const eventId = randomUUID();
    const result = stmts.insertEvent.run(
      eventId,
      "workspace.removed",
      goalId,
      JSON.stringify(eventPayload),
      now,
    );
    event = {
      seq: Number(result.lastInsertRowid),
      id: eventId,
      type: "workspace.removed",
      goalId,
      payload: eventPayload,
      createdAt: now,
    };
    deleteWorkspace(ctx.db, goalId, workspaceId);
  })();

  // broadcast only after commit
  ctx.bus.publish(event);
}
