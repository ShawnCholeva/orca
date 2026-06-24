import type Database from "better-sqlite3";
import type {
  DomainEvent,
  HarnessTransition,
  HarnessTransitionBoundary,
} from "@orca/contracts";
import type { EventBus } from "../events.js";
import { insertTransition, listTransitionsByGoal } from "./projection.js";

export { listTransitionsByGoal };
export { resetPreparedStatements } from "./projection.js";

export interface HarnessTransitionCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

export type RecordTransitionInput = {
  goalId: string;
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  boundary: HarnessTransitionBoundary;
  risk?: Record<string, unknown> | null;
  evidence?: Record<string, unknown> | null;
  stateDeps?: Record<string, unknown> | null;
  telemetry?: Record<string, unknown> | null;
};

let _db: Database.Database | null = null;
let _insertEvent: Database.Statement | null = null;

function ensureEventStmt(db: Database.Database): Database.Statement {
  if (db !== _db) {
    _db = db;
    _insertEvent = db.prepare(
      "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)"
    );
  }
  return _insertEvent!;
}

export function recordHarnessTransition(
  ctx: HarnessTransitionCtx,
  input: RecordTransitionInput
): HarnessTransition {
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFactory = ctx.idFactory ?? (() => crypto.randomUUID());
  const insertEvent = ensureEventStmt(ctx.db);

  const row: HarnessTransition = {
    id: idFactory(),
    goalId: input.goalId,
    workflowRunId: input.workflowRunId ?? null,
    workflowStepRunId: input.workflowStepRunId ?? null,
    boundary: input.boundary,
    risk: input.risk ?? null,
    evidence: input.evidence ?? null,
    stateDeps: input.stateDeps ?? null,
    telemetry: input.telemetry ?? null,
    createdAt: now,
  };

  const toPublish: DomainEvent[] = [];
  ctx.db.transaction(() => {
    insertTransition(ctx.db, row);
    const eventId = idFactory();
    const payload = {
      transitionId: row.id,
      goalId: row.goalId,
      boundary: row.boundary,
      workflowStepRunId: row.workflowStepRunId,
    };
    const result = insertEvent.run(
      eventId,
      "harness.transition.recorded",
      row.goalId,
      JSON.stringify(payload),
      now
    );
    toPublish.push({
      seq: Number(result.lastInsertRowid),
      id: eventId,
      type: "harness.transition.recorded",
      goalId: row.goalId,
      payload,
      createdAt: now,
    });
  })();

  for (const event of toPublish) ctx.bus.publish(event);
  return row;
}
