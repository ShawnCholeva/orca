import type Database from "better-sqlite3";
import {
  HARNESS_FACETS,
  HarnessTransition,
  type DomainEvent,
  type EvidenceFacet,
  type HarnessTransitionBoundary,
  type RiskFacet,
  type StateDepsFacet,
  type TelemetryFacet,
} from "@orca/contracts";
import type { EventBus } from "../events.js";
import { insertTransition, listTransitionsByGoal, listTransitionsByGoalPaged } from "./projection.js";

export { listTransitionsByGoal, listTransitionsByGoalPaged };
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
  risk?: RiskFacet | null;
  evidence?: EvidenceFacet | null;
  stateDeps?: StateDepsFacet | null;
  telemetry?: TelemetryFacet | null;
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

  const facetFields: Record<string, unknown> = {};
  for (const f of HARNESS_FACETS) {
    facetFields[f.key] = (input as Record<string, unknown>)[f.key] ?? null;
  }
  // Validate-on-write: the choke point all emitters funnel through. Parsing here
  // (not in each emitter) means every write is validated and throws on invalid,
  // and the persisted form equals the validated form. Closes the prior gap where
  // the write path returned an unvalidated in-memory row.
  const row: HarnessTransition = HarnessTransition.parse({
    id: idFactory(),
    goalId: input.goalId,
    workflowRunId: input.workflowRunId ?? null,
    workflowStepRunId: input.workflowStepRunId ?? null,
    boundary: input.boundary,
    ...facetFields,
    createdAt: now,
  });

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
