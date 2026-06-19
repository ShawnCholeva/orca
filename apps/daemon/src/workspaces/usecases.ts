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

function emit(ctx: WorkspaceCtx, type: DomainEventType, goalId: string | null, payload: Record<string, unknown>): void {
  const now = new Date().toISOString();
  let event!: DomainEvent;
  ctx.db.transaction(() => {
    const id = randomUUID();
    const result = ctx.db.prepare(
      "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, type, goalId, JSON.stringify(payload), now);
    event = { seq: Number(result.lastInsertRowid), id, type, goalId, payload, createdAt: now };
  })();
  ctx.bus.publish(event);
}

// find-or-create the canonical entity for a path (no event)
function ensureEntity(ctx: WorkspaceCtx, preview: InspectWorkspacePreview, name?: string): { ws: Workspace; created: boolean } {
  const existing = findWorkspaceByPath(ctx.db, preview.path);
  if (existing) return { ws: existing, created: false };
  const now = new Date().toISOString();
  const ws: Workspace = { id: randomUUID(), path: preview.path, name: name ?? preview.name, description: "", createdAt: now, updatedAt: now };
  insertWorkspaceEntity(ctx.db, ws);
  return { ws, created: true };
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
  insertWorkspaceEntity(ctx.db, ws);
  emit(ctx, "workspace.created", null, { workspaceId: ws.id, path: ws.path, name: ws.name });
  return ws;
}

export async function updateWorkspace(
  ctx: WorkspaceCtx,
  input: { id: string; name?: string; description?: string },
): Promise<Workspace> {
  const updated = updateWorkspaceEntity(ctx.db, input.id, { name: input.name, description: input.description }, new Date().toISOString());
  if (!updated) throw new NotFoundError(input.id);
  emit(ctx, "workspace.updated", null, { workspaceId: updated.id, name: updated.name });
  return updated;
}

export async function attachWorkspace(
  ctx: WorkspaceCtx,
  input: { goalId: string; inputPath: string; name?: string },
): Promise<Workspace> {
  const goalRow = ctx.db.prepare("SELECT id, archived_at FROM goals WHERE id = ?").get(input.goalId) as { id: string; archived_at: string | null } | undefined;
  if (!goalRow || goalRow.archived_at !== null) throw new NotFoundError(input.goalId);
  const preview = await ctx.inspectWorkspace(input.inputPath);
  const { ws } = ensureEntity(ctx, preview, input.name);
  linkGoalWorkspace(ctx.db, input.goalId, ws.id, new Date().toISOString());
  emit(ctx, "workspace.attached", input.goalId, { workspaceId: ws.id, path: ws.path, name: ws.name });
  return ws;
}

export async function detachWorkspace(
  ctx: WorkspaceCtx,
  input: { goalId: string; workspaceId: string },
): Promise<void> {
  const removed = unlinkGoalWorkspace(ctx.db, input.goalId, input.workspaceId);
  if (!removed) throw new NotFoundError(input.workspaceId);
  emit(ctx, "workspace.removed", input.goalId, { workspaceId: input.workspaceId });
}
