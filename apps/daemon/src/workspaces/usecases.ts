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

// Purge a registered workspace and everything scoped to it: its sessions and
// tasks, the goals it exclusively owns, and the entire dependency subtree of
// those goals (workflow runs, decisions, memory, context, …). Goals that are
// also attached to another workspace are kept — only their link to, and
// sessions that ran in, this workspace are removed.
//
// The schema guards workspace deletion with RESTRICT/NO ACTION foreign keys
// (sessions, tasks) and fans a goal out across ~40 tables, so a hand-ordered
// cascade would be fragile and rot as tables are added. Instead we disable
// foreign keys for the duration, delete the anchor rows, then run a
// `foreign_key_check` fixpoint that removes exactly the rows those deletes
// orphaned. Because foreign keys were enforced before this call, the DB was
// referentially clean, so the only violations the check can report are ones we
// just created — the loop never reaches beyond this workspace's subtree.
export async function deleteWorkspace(
  ctx: WorkspaceCtx,
  input: { id: string },
): Promise<{ goalsDeleted: number; sessionsDeleted: number }> {
  const { db, bus } = ctx;
  const existing = findWorkspaceById(db, input.id);
  if (!existing) throw new NotFoundError(input.id);

  // Goals attached to ONLY this workspace are purged with it.
  const ownedGoals = (db.prepare(
    `SELECT gw.goal_id AS id FROM goal_workspaces gw
     WHERE gw.workspace_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM goal_workspaces o
         WHERE o.goal_id = gw.goal_id AND o.workspace_id <> ?
       )`,
  ).all(input.id, input.id) as { id: string }[]).map((r) => r.id);
  const sessionsDeleted = (db.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ?",
  ).get(input.id) as { n: number }).n;

  const now = new Date().toISOString();
  let event!: DomainEvent;

  // FK enforcement can only be toggled outside a transaction. Everything from
  // here to the re-enable is synchronous (better-sqlite3), so no other DB work
  // interleaves and the pragma window can't leak to another request.
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      if (ownedGoals.length) {
        const placeholders = ownedGoals.map(() => "?").join(",");
        db.prepare(`DELETE FROM goals WHERE id IN (${placeholders})`).run(...ownedGoals);
      }
      db.prepare("DELETE FROM sessions WHERE workspace_id = ?").run(input.id);
      db.prepare("DELETE FROM tasks WHERE workspace_id = ?").run(input.id);
      db.prepare("DELETE FROM goal_workspaces WHERE workspace_id = ?").run(input.id);
      db.prepare("DELETE FROM workspaces WHERE id = ?").run(input.id);

      for (let i = 0; i < 100; i++) {
        const violations = db.pragma("foreign_key_check") as { table: string; rowid: number | null }[];
        if (violations.length === 0) break;
        for (const v of violations) {
          if (v.rowid === null) continue;
          db.prepare(`DELETE FROM "${v.table}" WHERE rowid = ?`).run(v.rowid);
        }
      }
      const remaining = db.pragma("foreign_key_check") as unknown[];
      if (remaining.length > 0) {
        throw new Error(`workspace purge left ${remaining.length} dangling reference(s)`);
      }

      const id = randomUUID();
      const payload = {
        workspaceId: input.id, path: existing.path,
        goalsDeleted: ownedGoals.length, sessionsDeleted,
      };
      const result = db.prepare(
        "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, "workspace.deleted", null, JSON.stringify(payload), now);
      event = { seq: Number(result.lastInsertRowid), id, type: "workspace.deleted", goalId: null, payload, createdAt: now };
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  bus.publish(event);
  return { goalsDeleted: ownedGoals.length, sessionsDeleted };
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
