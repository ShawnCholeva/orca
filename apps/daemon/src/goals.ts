import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { CreateGoalRequest, type DomainEvent, type Goal } from "@orca/contracts";
import { getDatabase } from "./db.js";
import { eventBus } from "./events.js";

export class ValidationError extends Error {
  constructor(public readonly issues: unknown) {
    super("Validation failed");
    this.name = "ValidationError";
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
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as Goal["status"],
    autonomyLevel: row.autonomy_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

// Tracks current DB instance to detect close/reopen cycles and re-prepare statements.
let _db: Database.Database | null = null;
let _stmts: {
  insertEvent: Database.Statement;
  insertGoal: Database.Statement;
  selectGoals: Database.Statement;
} | null = null;

function ensureStmts(): { db: Database.Database; stmts: NonNullable<typeof _stmts> } {
  const db = getDatabase();
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertEvent: db.prepare(
        "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, 'goal.created', ?, ?, ?)"
      ),
      insertGoal: db.prepare(
        "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?)"
      ),
      selectGoals: db.prepare(
        "SELECT * FROM goals WHERE archived_at IS NULL ORDER BY updated_at DESC"
      ),
    };
  }
  return { db, stmts: _stmts! };
}

export function createGoal(input: unknown): Goal {
  const parsed = CreateGoalRequest.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues);
  }
  const { title, description } = parsed.data;

  const goalId = randomUUID();
  const eventId = randomUUID();
  const now = new Date().toISOString();
  const payload = JSON.stringify({ title, description });

  const { db, stmts } = ensureStmts();

  let seq = 0;

  db.transaction(() => {
    const result = stmts.insertEvent.run(eventId, goalId, payload, now);
    seq = Number(result.lastInsertRowid);
    stmts.insertGoal.run(goalId, title, description, now, now);
  })();

  const event: DomainEvent = {
    seq,
    id: eventId,
    type: "goal.created",
    goalId,
    payload: { title, description },
    createdAt: now,
  };

  eventBus.publish(event);

  return {
    id: goalId,
    title,
    description,
    status: "active",
    autonomyLevel: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

export function listGoals(): Goal[] {
  const { stmts } = ensureStmts();
  const rows = stmts.selectGoals.all() as GoalRow[];
  return rows.map(rowToGoal);
}
