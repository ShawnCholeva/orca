import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DomainEvent, DomainEventType, InspectWorkspacePreview, Workspace } from "@orca/contracts";
import type { EventBus } from "../events.js";
import { NotFoundError } from "../goals.js";
import {
  DuplicateWorkspaceError, findWorkspaceByPath, findWorkspaceById,
  insertWorkspaceEntity, updateWorkspaceEntity, linkGoalWorkspace, unlinkGoalWorkspace,
} from "./projection.js";

export { DuplicateWorkspaceError };

export interface WorkspaceCtx {
  db: Database.Database;
  bus: EventBus;
  inspectWorkspace(inputPath: string): Promise<InspectWorkspacePreview>;
}

function commitWithEvent(
  ctx: WorkspaceCtx,
  type: DomainEventType,
  goalId: string | null,
  payload: Record<string, unknown>,
  mutate: () => void,
): void {
  const now = new Date().toISOString();
  let event!: DomainEvent;
  ctx.db.transaction(() => {
    mutate();
    const id = randomUUID();
    const result = ctx.db.prepare(
      "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, type, goalId, JSON.stringify(payload), now);
    event = { seq: Number(result.lastInsertRowid), id, type, goalId, payload, createdAt: now };
  })();
  ctx.bus.publish(event);
}

export async function createWorkspace(
  ctx: WorkspaceCtx,
  input: { inputPath: string; name?: string; description?: string },
): Promise<Workspace> {
  const preview = await ctx.inspectWorkspace(input.inputPath);
  if (findWorkspaceByPath(ctx.db, preview.path)) throw new DuplicateWorkspaceError(preview.path);
  const now = new Date().toISOString();
  const ws: Workspace = {
    id: randomUUID(), path: preview.path, name: input.name ?? preview.name,
    description: input.description ?? "", createdAt: now, updatedAt: now,
  };
  commitWithEvent(ctx, "workspace.created", null, { workspaceId: ws.id, path: ws.path, name: ws.name }, () => {
    insertWorkspaceEntity(ctx.db, ws);
  });
  return ws;
}

export async function updateWorkspace(
  ctx: WorkspaceCtx,
  input: { id: string; name?: string; description?: string },
): Promise<Workspace> {
  const existing = findWorkspaceById(ctx.db, input.id);
  if (!existing) throw new NotFoundError(input.id);
  let updated!: Workspace;
  commitWithEvent(ctx, "workspace.updated", null, { workspaceId: input.id, name: input.name ?? existing.name }, () => {
    updated = updateWorkspaceEntity(ctx.db, input.id, { name: input.name, description: input.description }, new Date().toISOString())!;
  });
  return updated;
}

export async function attachWorkspace(
  ctx: WorkspaceCtx,
  input: { goalId: string; inputPath: string; name?: string },
): Promise<Workspace> {
  const goalRow = ctx.db.prepare("SELECT id, archived_at FROM goals WHERE id = ?").get(input.goalId) as { id: string; archived_at: string | null } | undefined;
  if (!goalRow || goalRow.archived_at !== null) throw new NotFoundError(input.goalId);
  const preview = await ctx.inspectWorkspace(input.inputPath);
  const existing = findWorkspaceByPath(ctx.db, preview.path);
  const now = new Date().toISOString();
  const ws: Workspace = existing ?? { id: randomUUID(), path: preview.path, name: input.name ?? preview.name, description: "", createdAt: now, updatedAt: now };
  commitWithEvent(ctx, "workspace.attached", input.goalId, { workspaceId: ws.id, path: ws.path, name: ws.name }, () => {
    if (!existing) insertWorkspaceEntity(ctx.db, ws);
    linkGoalWorkspace(ctx.db, input.goalId, ws.id, new Date().toISOString());
  });
  return ws;
}

export async function detachWorkspace(
  ctx: WorkspaceCtx,
  input: { goalId: string; workspaceId: string },
): Promise<void> {
  const linked = ctx.db.prepare("SELECT 1 FROM goal_workspaces WHERE goal_id = ? AND workspace_id = ?").get(input.goalId, input.workspaceId);
  if (!linked) throw new NotFoundError(input.workspaceId);
  commitWithEvent(ctx, "workspace.removed", input.goalId, { workspaceId: input.workspaceId }, () => {
    unlinkGoalWorkspace(ctx.db, input.goalId, input.workspaceId);
  });
}
