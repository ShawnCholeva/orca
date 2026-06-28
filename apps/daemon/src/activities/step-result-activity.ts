import { randomUUID } from "node:crypto";

import type { DomainEvent } from "@orca/contracts";

import type { ActivityStoreCtx } from "./store.js";

export interface MaterializeInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
}

const SQLITE_CONSTRAINT = "SQLITE_CONSTRAINT_UNIQUE";

export function materializeStepResultActivity(
  ctx: ActivityStoreCtx,
  input: MaterializeInput
): void {
  const now = ctx.now?.() ?? new Date().toISOString();
  const id = ctx.idFactory?.() ?? randomUUID();
  let event: DomainEvent | undefined;
  const sweepEvents: DomainEvent[] = [];

  ctx.db.transaction(() => {
    // Finalize any dangling 'active' worker activities for this step run. Their
    // turn ended but `turn_completed` never fired (the Stop hook raced the step
    // advance, so resolveStepContext's current_step_run_id check failed), leaving
    // them — and their open substep — 'active' forever, which the UI renders as a
    // perpetual "Working on the step…" pulse. Expire them (mirrors expireLive) and
    // close their active substeps so the projection is honest. Targets only
    // status='active', so it never touches interrupt-glyph rows (status='completed'
    // with an active substep), step_result/gate rows, or other steps' activities.
    const stale = ctx.db
      .prepare(
        "SELECT id, goal_id, workflow_run_id, turn_ordinal FROM activities WHERE step_run_id = ? AND status = 'active'"
      )
      .all(input.stepRunId) as Array<{
      id: string;
      goal_id: string;
      workflow_run_id: string;
      turn_ordinal: number;
    }>;
    for (const a of stale) {
      ctx.db
        .prepare(
          `UPDATE activities
             SET status = 'expired', final_summary = NULL, confidence = NULL,
                 pending_question = NULL, updated_at = ?, completed_at = ?
           WHERE id = ?`
        )
        .run(now, now, a.id);
      ctx.db
        .prepare("UPDATE activity_steps SET status = 'done' WHERE activity_id = ? AND status = 'active'")
        .run(a.id);
      const sweepPayload = {
        activityId: a.id,
        goalId: a.goal_id,
        workflowRunId: a.workflow_run_id,
        stepRunId: input.stepRunId,
        turnOrdinal: a.turn_ordinal,
        status: "expired"
      };
      const sweepEventId = randomUUID();
      const sweepResult = ctx.db
        .prepare("INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(sweepEventId, "activity.changed", a.goal_id, JSON.stringify(sweepPayload), now);
      sweepEvents.push({
        seq: Number(sweepResult.lastInsertRowid),
        id: sweepEventId,
        type: "activity.changed",
        goalId: a.goal_id,
        payload: sweepPayload,
        createdAt: now
      });
    }

    const turn = ctx.db
      .prepare("SELECT MAX(turn_ordinal) AS m FROM activities WHERE step_run_id = ?")
      .get(input.stepRunId) as { m: number | null };
    const turnOrdinal = (turn.m ?? -1) + 1;

    try {
      ctx.db
        .prepare(
          `INSERT INTO activities (
             id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
             status, current_text, final_summary, source_kind, work_category, confidence,
             pending_question, created_at, updated_at, completed_at
           ) VALUES (?, ?, ?, ?, NULL, ?, 'completed', '', NULL, 'step_result', NULL, NULL, NULL, ?, ?, ?)`
        )
        .run(
          id,
          input.goalId,
          input.workflowRunId,
          input.stepRunId,
          turnOrdinal,
          now,
          now,
          now
        );
    } catch (err) {
      if ((err as { code?: string }).code === SQLITE_CONSTRAINT) return;
      throw err;
    }

    const payload = {
      activityId: id,
      goalId: input.goalId,
      workflowRunId: input.workflowRunId,
      stepRunId: input.stepRunId,
      turnOrdinal,
      status: "completed"
    };
    const eventId = randomUUID();
    const result = ctx.db
      .prepare("INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(eventId, "activity.changed", input.goalId, JSON.stringify(payload), now);
    event = {
      seq: Number(result.lastInsertRowid),
      id: eventId,
      type: "activity.changed",
      goalId: input.goalId,
      payload,
      createdAt: now
    };
  })();

  for (const swept of sweepEvents) ctx.bus.publish(swept);
  if (event !== undefined) ctx.bus.publish(event);
}

export function reconcileStepResultActivities(ctx: ActivityStoreCtx): void {
  const rows = ctx.db
    .prepare(
      `SELECT sr.id AS step_run_id, sr.goal_id, sr.workflow_run_id
       FROM workflow_step_runs sr
       WHERE sr.step_result_json IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM activities a
           WHERE a.step_run_id = sr.id AND a.source_kind = 'step_result'
         )`
    )
    .all() as Array<{
    step_run_id: string;
    goal_id: string;
    workflow_run_id: string;
  }>;

  for (const row of rows) {
    materializeStepResultActivity(ctx, {
      goalId: row.goal_id,
      workflowRunId: row.workflow_run_id,
      stepRunId: row.step_run_id
    });
  }
}
