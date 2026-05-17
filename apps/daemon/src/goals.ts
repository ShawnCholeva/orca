import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { Goal, UpdateGoalRequest } from "@orca/contracts";
import { getDatabase } from "./db.js";
import { eventBus, EventBus } from "./events.js";
import type { SkillRegistry } from "./registry/skill-registry.js";

export interface CreateGoalCtx {
  db: Database.Database;
  bus: EventBus;
  skills: SkillRegistry;
}

export class ValidationError extends Error {
  constructor(public readonly issues: unknown) {
    super("Validation failed");
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Goal not found: ${id}`);
    this.name = "NotFoundError";
  }
}

interface GoalRow {
  id: string;
  title: string;
  description: string;
  status: string;
  autonomy_level: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function rowToGoal(row: GoalRow): Goal {
  return Goal.parse({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    autonomyLevel: row.autonomy_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  });
}

// Tracks current DB instance to detect close/reopen cycles and re-prepare statements.
let _db: Database.Database | null = null;
let _stmts: {
  insertEvent: Database.Statement;
  insertGoal: Database.Statement;
  selectGoals: Database.Statement;
  selectGoalById: Database.Statement;
  updateGoal: Database.Statement;
  archiveGoal: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): { db: Database.Database; stmts: NonNullable<typeof _stmts> } {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertEvent: db.prepare(
        "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)"
      ),
      insertGoal: db.prepare(
        "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?)"
      ),
      selectGoals: db.prepare(
        "SELECT * FROM goals WHERE archived_at IS NULL ORDER BY updated_at DESC"
      ),
      selectGoalById: db.prepare("SELECT * FROM goals WHERE id = ?"),
      updateGoal: db.prepare(
        "UPDATE goals SET title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ? WHERE id = ?"
      ),
      archiveGoal: db.prepare(
        "UPDATE goals SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?"
      ),
    };
  }
  return { db, stmts: _stmts! };
}

export function createGoal(input: unknown, ctx: CreateGoalCtx): Goal {
  const skill = ctx.skills.byId("quick-goal");
  if (!skill) {
    throw new Error("Boot misconfiguration: quick-goal skill not registered");
  }

  const startedAt = performance.now();
  // ValidationError from skill.invoke propagates as-is (→ HTTP 400); no DB writes occur.
  const normalized = skill.invoke(input, { now: () => new Date().toISOString() }) as {
    title: string;
    description: string;
  };
  const durationMs = Math.round(performance.now() - startedAt);

  const goalId = randomUUID();
  const skillEventId = randomUUID();
  const goalEventId = randomUUID();
  const now = new Date().toISOString();

  const { db, stmts } = ensureStmts(ctx.db);

  let skillSeq = 0;
  let goalSeq = 0;

  db.transaction(() => {
    const skillResult = stmts.insertEvent.run(
      skillEventId,
      "skill.invoked",
      goalId,
      JSON.stringify({ skillId: skill.id, extensionPoint: skill.extensionPoint, durationMs }),
      now,
    );
    skillSeq = Number(skillResult.lastInsertRowid);

    const goalResult = stmts.insertEvent.run(
      goalEventId,
      "goal.created",
      goalId,
      JSON.stringify({ title: normalized.title, description: normalized.description }),
      now,
    );
    goalSeq = Number(goalResult.lastInsertRowid);

    stmts.insertGoal.run(goalId, normalized.title, normalized.description, now, now);
  })();

  ctx.bus.publish({
    seq: skillSeq,
    id: skillEventId,
    type: "skill.invoked",
    goalId,
    payload: { skillId: skill.id, extensionPoint: skill.extensionPoint, durationMs },
    createdAt: now,
  });

  ctx.bus.publish({
    seq: goalSeq,
    id: goalEventId,
    type: "goal.created",
    goalId,
    payload: { title: normalized.title, description: normalized.description },
    createdAt: now,
  });

  return {
    id: goalId,
    title: normalized.title,
    description: normalized.description,
    status: "active",
    autonomyLevel: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

export function updateGoal(id: string, input: unknown): Goal {
  const parsed = UpdateGoalRequest.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues);
  }
  const patch = parsed.data;

  const { db, stmts } = ensureStmts(getDatabase());
  const eventId = randomUUID();
  const now = new Date().toISOString();
  const payload = JSON.stringify(patch);

  let seq = 0;
  let updatedRow: GoalRow | undefined;

  db.transaction(() => {
    const existing = stmts.selectGoalById.get(id) as GoalRow | undefined;
    if (!existing || existing.archived_at !== null) {
      throw new NotFoundError(id);
    }

    const result = stmts.insertEvent.run(eventId, "goal.updated", id, payload, now);
    seq = Number(result.lastInsertRowid);

    stmts.updateGoal.run(
      patch.title ?? null,
      patch.description ?? null,
      now,
      id
    );
    updatedRow = stmts.selectGoalById.get(id) as GoalRow;
  })();

  eventBus.publish({
    seq,
    id: eventId,
    type: "goal.updated",
    goalId: id,
    payload: patch as Record<string, unknown>,
    createdAt: now,
  });

  return rowToGoal(updatedRow!);
}

export function archiveGoal(id: string): Goal {
  const { db, stmts } = ensureStmts(getDatabase());
  const eventId = randomUUID();
  const now = new Date().toISOString();

  let seq = 0;
  let updatedRow: GoalRow | undefined;

  db.transaction(() => {
    const existing = stmts.selectGoalById.get(id) as GoalRow | undefined;
    if (!existing || existing.archived_at !== null) {
      throw new NotFoundError(id);
    }

    const result = stmts.insertEvent.run(eventId, "goal.archived", id, "{}", now);
    seq = Number(result.lastInsertRowid);

    stmts.archiveGoal.run(now, now, id);
    updatedRow = stmts.selectGoalById.get(id) as GoalRow;
  })();

  eventBus.publish({
    seq,
    id: eventId,
    type: "goal.archived",
    goalId: id,
    payload: {},
    createdAt: now,
  });

  return rowToGoal(updatedRow!);
}

export function listGoals(): Goal[] {
  const { stmts } = ensureStmts(getDatabase());
  const rows = stmts.selectGoals.all() as GoalRow[];
  return rows.map(rowToGoal);
}
