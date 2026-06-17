import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  Activity,
  ActivityStep,
  PendingQuestion,
  type Activity as ActivityT,
  type ActivityConfidence,
  type ActivityDiff,
  type ActivitySourceKind,
  type ActivityStep as ActivityStepT,
  type ActivityWorkCategory,
  type DomainEvent,
  type PendingQuestion as PendingQuestionT
} from "@orca/contracts";

import type { EventBus } from "../events.js";

export interface ActivityStoreCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

export interface OpenOrUpdateInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  agentSessionId: string | null;
  sourceKind: ActivitySourceKind;
  currentText: string;
  workCategory: ActivityWorkCategory | null;
}

interface ActivityRow {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  step_run_id: string;
  agent_session_id: string | null;
  turn_ordinal: number;
  status: string;
  current_text: string;
  final_summary: string | null;
  source_kind: string;
  work_category: string | null;
  confidence: string | null;
  pending_question: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function currentTime(ctx: ActivityStoreCtx): string {
  return ctx.now?.() ?? new Date().toISOString();
}

function nextActivityId(ctx: ActivityStoreCtx): string {
  return ctx.idFactory?.() ?? randomUUID();
}

function loadSteps(db: Database.Database, activityId: string): ActivityStepT[] {
  const rows = db
    .prepare(
      `SELECT id, text, category, status, diff, created_at
       FROM activity_steps WHERE activity_id = ? ORDER BY ordinal ASC`
    )
    .all(activityId) as Array<{
      id: string; text: string; category: string | null;
      status: string; diff: string | null; created_at: string;
    }>;
  return rows.map((r) =>
    ActivityStep.parse({
      id: r.id,
      text: r.text,
      category: r.category,
      status: r.status,
      ...(r.diff ? { diff: JSON.parse(r.diff) } : {}),
      createdAt: r.created_at,
    })
  );
}

function rowToActivity(db: Database.Database, row: ActivityRow): ActivityT {
  let pendingQuestion: PendingQuestionT | undefined;
  if (row.pending_question !== null) {
    pendingQuestion = PendingQuestion.parse(JSON.parse(row.pending_question));
  }

  return Activity.parse({
    id: row.id,
    goalId: row.goal_id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    agentSessionId: row.agent_session_id,
    turnOrdinal: row.turn_ordinal,
    status: row.status,
    currentText: row.current_text,
    finalSummary: row.final_summary,
    sourceKind: row.source_kind,
    workCategory: row.work_category,
    confidence: row.confidence,
    ...(pendingQuestion !== undefined ? { pendingQuestion } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    steps: loadSteps(db, row.id),
  });
}

function getActivityById(db: Database.Database, id: string): ActivityT | undefined {
  const row = db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as
    | ActivityRow
    | undefined;
  return row === undefined ? undefined : rowToActivity(db, row);
}

export function getLiveForStepRun(
  db: Database.Database,
  stepRunId: string
): ActivityT | undefined {
  const row = db
    .prepare(
      `SELECT * FROM activities
       WHERE step_run_id = ? AND status IN ('active', 'paused_for_input')
       ORDER BY turn_ordinal DESC, updated_at DESC, id DESC
       LIMIT 1`
    )
    .get(stepRunId) as ActivityRow | undefined;
  return row === undefined ? undefined : rowToActivity(db, row);
}

export function getPausedForGoal(
  db: Database.Database,
  goalId: string
): ActivityT | undefined {
  const row = db
    .prepare(
      `SELECT * FROM activities
       WHERE goal_id = ? AND status = 'paused_for_input'
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`
    )
    .get(goalId) as ActivityRow | undefined;
  return row === undefined ? undefined : rowToActivity(db, row);
}

function nextTurnOrdinal(db: Database.Database, stepRunId: string): number {
  const row = db
    .prepare("SELECT MAX(turn_ordinal) AS max_turn FROM activities WHERE step_run_id = ?")
    .get(stepRunId) as { max_turn: number | null };
  return (row.max_turn ?? -1) + 1;
}

function insertActivityChangedEvent(
  db: Database.Database,
  activity: ActivityT,
  now: string
): DomainEvent {
  const payload = {
    activityId: activity.id,
    goalId: activity.goalId,
    workflowRunId: activity.workflowRunId,
    stepRunId: activity.stepRunId,
    turnOrdinal: activity.turnOrdinal,
    status: activity.status
  };
  const eventId = randomUUID();
  const result = db
    .prepare("INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(eventId, "activity.changed", activity.goalId, JSON.stringify(payload), now);

  return {
    seq: Number(result.lastInsertRowid),
    id: eventId,
    type: "activity.changed",
    goalId: activity.goalId,
    payload,
    createdAt: now
  };
}

function publishActivityChanged(ctx: ActivityStoreCtx, event: DomainEvent | undefined): void {
  if (event !== undefined) ctx.bus.publish(event);
}

export function openOrUpdateLive(
  ctx: ActivityStoreCtx,
  input: OpenOrUpdateInput
): ActivityT {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const existing = getLiveForStepRun(ctx.db, input.stepRunId);
    if (existing?.status === "paused_for_input") return existing;

    const now = currentTime(ctx);
    if (existing !== undefined) {
      ctx.db
        .prepare(
          `UPDATE activities
           SET agent_session_id = ?, current_text = ?, source_kind = ?, work_category = ?,
               pending_question = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.agentSessionId,
          input.currentText,
          input.sourceKind,
          input.workCategory,
          now,
          existing.id
        );
      const updated = getActivityById(ctx.db, existing.id);
      if (updated === undefined) throw new Error(`Activity disappeared: ${existing.id}`);
      event = insertActivityChangedEvent(ctx.db, updated, now);
      return updated;
    }

    const id = nextActivityId(ctx);
    const turnOrdinal = nextTurnOrdinal(ctx.db, input.stepRunId);
    ctx.db
      .prepare(
        `INSERT INTO activities (
           id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
           status, current_text, final_summary, source_kind, work_category, confidence,
           pending_question, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, NULL, NULL, ?, ?, NULL)`
      )
      .run(
        id,
        input.goalId,
        input.workflowRunId,
        input.stepRunId,
        input.agentSessionId,
        turnOrdinal,
        input.currentText,
        input.sourceKind,
        input.workCategory,
        now,
        now
      );
    const inserted = getActivityById(ctx.db, id);
    if (inserted === undefined) throw new Error(`Activity insert failed: ${id}`);
    event = insertActivityChangedEvent(ctx.db, inserted, now);
    return inserted;
  })();

  publishActivityChanged(ctx, event);
  return activity;
}

export interface AppendStepInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  agentSessionId: string | null;
  text: string;
  category: ActivityWorkCategory | null;
  diff: ActivityDiff | null;
}

export function appendActivityStep(ctx: ActivityStoreCtx, input: AppendStepInput): ActivityT {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const now = currentTime(ctx);
    let live = getLiveForStepRun(ctx.db, input.stepRunId);

    // Create the activity lazily if no live one exists (defensive — normally
    // step_started already opened it).
    if (live === undefined) {
      const id = nextActivityId(ctx);
      const turnOrdinal = nextTurnOrdinal(ctx.db, input.stepRunId);
      ctx.db
        .prepare(
          `INSERT INTO activities (
             id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
             status, current_text, final_summary, source_kind, work_category, confidence,
             pending_question, created_at, updated_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', '', NULL, 'tool_use', ?, NULL, NULL, ?, ?, NULL)`
        )
        .run(id, input.goalId, input.workflowRunId, input.stepRunId, input.agentSessionId,
          turnOrdinal, input.category, now, now);
      live = getActivityById(ctx.db, id);
      if (live === undefined) throw new Error(`Activity insert failed: ${id}`);
    }

    // Close the current active step.
    ctx.db
      .prepare("UPDATE activity_steps SET status = 'done' WHERE activity_id = ? AND status = 'active'")
      .run(live.id);

    // Insert the new active step.
    const ord = (ctx.db
      .prepare("SELECT MAX(ordinal) AS m FROM activity_steps WHERE activity_id = ?")
      .get(live.id) as { m: number | null }).m;
    ctx.db
      .prepare(
        `INSERT INTO activity_steps (id, activity_id, ordinal, text, category, status, diff, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(nextActivityId(ctx), live.id, (ord ?? -1) + 1, input.text, input.category,
        input.diff ? JSON.stringify(input.diff) : null, now);

    // Mirror latest text + source onto the activity row (back-compat).
    ctx.db
      .prepare("UPDATE activities SET current_text = ?, source_kind = 'tool_use', work_category = ?, updated_at = ? WHERE id = ?")
      .run(input.text, input.category, now, live.id);

    const updated = getActivityById(ctx.db, live.id);
    if (updated === undefined) throw new Error(`Activity disappeared: ${live.id}`);
    event = insertActivityChangedEvent(ctx.db, updated, now);
    return updated;
  })();

  publishActivityChanged(ctx, event);
  return activity;
}

export function pauseForInput(
  ctx: ActivityStoreCtx,
  input: {
    stepRunId: string;
    currentText: string;
    pendingQuestion: PendingQuestionT;
  }
): ActivityT | undefined {
  const pendingQuestion = PendingQuestion.parse(input.pendingQuestion);
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const live = getLiveForStepRun(ctx.db, input.stepRunId);
    if (live === undefined) return undefined;

    const now = currentTime(ctx);
    ctx.db
      .prepare(
        `UPDATE activities
         SET status = 'paused_for_input', current_text = ?, source_kind = 'question_pending',
             work_category = NULL, pending_question = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.currentText, JSON.stringify(pendingQuestion), now, live.id);

    const paused = getActivityById(ctx.db, live.id);
    if (paused === undefined) throw new Error(`Activity disappeared: ${live.id}`);
    event = insertActivityChangedEvent(ctx.db, paused, now);
    return paused;
  })();

  publishActivityChanged(ctx, event);
  return activity;
}

export function pauseForConfirmation(
  ctx: ActivityStoreCtx,
  input: { stepRunId: string; summary: string }
): ActivityT | undefined {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const live = getLiveForStepRun(ctx.db, input.stepRunId);
    if (live === undefined) return undefined;

    const now = currentTime(ctx);
    ctx.db
      .prepare(
        `UPDATE activities
         SET status = 'paused_for_input', current_text = ?,
             source_kind = 'step_confirmation_pending', work_category = NULL,
             pending_question = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(input.summary, now, live.id);

    const paused = getActivityById(ctx.db, live.id);
    if (paused === undefined) throw new Error(`Activity disappeared: ${live.id}`);
    event = insertActivityChangedEvent(ctx.db, paused, now);
    return paused;
  })();

  publishActivityChanged(ctx, event);
  return activity;
}

export function resumeFromConfirmation(
  ctx: ActivityStoreCtx,
  input: { stepRunId: string }
): ActivityT | undefined {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const live = getLiveForStepRun(ctx.db, input.stepRunId);
    if (live === undefined || live.status !== "paused_for_input") return undefined;
    if (live.sourceKind !== "step_confirmation_pending") return live;

    const now = currentTime(ctx);
    ctx.db
      .prepare(
        `UPDATE activities
         SET status = 'active', source_kind = 'step_started', updated_at = ?
         WHERE id = ?`
      )
      .run(now, live.id);

    const resumed = getActivityById(ctx.db, live.id);
    if (resumed === undefined) throw new Error(`Activity disappeared: ${live.id}`);
    event = insertActivityChangedEvent(ctx.db, resumed, now);
    return resumed;
  })();

  publishActivityChanged(ctx, event);
  return activity;
}

export function pauseForProviderRecovery(
  ctx: ActivityStoreCtx,
  input: { stepRunId: string; summary: string }
): ActivityT | undefined {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const live = getLiveForStepRun(ctx.db, input.stepRunId);
    if (live === undefined) return undefined;

    const now = currentTime(ctx);
    ctx.db
      .prepare(
        `UPDATE activities
         SET status = 'paused_for_input', current_text = ?,
             source_kind = 'provider_recovery_pending', work_category = NULL,
             pending_question = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(input.summary, now, live.id);

    const paused = getActivityById(ctx.db, live.id);
    if (paused === undefined) throw new Error(`Activity disappeared: ${live.id}`);
    event = insertActivityChangedEvent(ctx.db, paused, now);
    return paused;
  })();

  publishActivityChanged(ctx, event);
  return activity;
}

export function resumeFromProviderRecovery(
  ctx: ActivityStoreCtx,
  input: { stepRunId: string; agentSessionId: string; summary: string }
): ActivityT | undefined {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const live = getLiveForStepRun(ctx.db, input.stepRunId);
    if (live === undefined || live.status !== "paused_for_input") return undefined;
    if (live.sourceKind !== "provider_recovery_pending") return live;

    const now = currentTime(ctx);
    ctx.db
      .prepare(
        `UPDATE activities
         SET status = 'active', source_kind = 'step_started', agent_session_id = ?,
             current_text = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.agentSessionId, input.summary, now, live.id);

    const resumed = getActivityById(ctx.db, live.id);
    if (resumed === undefined) throw new Error(`Activity disappeared: ${live.id}`);
    event = insertActivityChangedEvent(ctx.db, resumed, now);
    return resumed;
  })();

  publishActivityChanged(ctx, event);
  return activity;
}

export function completeLive(
  ctx: ActivityStoreCtx,
  input: {
    stepRunId: string;
    finalSummary: string;
    confidence: ActivityConfidence | null;
  }
): ActivityT | undefined {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const live = getLiveForStepRun(ctx.db, input.stepRunId);
    if (live === undefined) return undefined;
    if (live.sourceKind === "step_confirmation_pending") return undefined;

    const now = currentTime(ctx);
    ctx.db
      .prepare(
        `UPDATE activities
         SET status = 'completed', final_summary = ?, source_kind = 'turn_completed',
             confidence = ?, pending_question = NULL, updated_at = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(input.finalSummary, input.confidence, now, now, live.id);

    ctx.db
      .prepare("UPDATE activity_steps SET status = 'done' WHERE activity_id = ? AND status = 'active'")
      .run(live.id);

    const completed = getActivityById(ctx.db, live.id);
    if (completed === undefined) throw new Error(`Activity disappeared: ${live.id}`);
    event = insertActivityChangedEvent(ctx.db, completed, now);
    return completed;
  })();

  publishActivityChanged(ctx, event);
  return activity;
}

export function expireLive(
  ctx: ActivityStoreCtx,
  input: { stepRunId: string }
): ActivityT | undefined {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const row = ctx.db
      .prepare("SELECT * FROM activities WHERE step_run_id = ? AND status = 'active' LIMIT 1")
      .get(input.stepRunId) as ActivityRow | undefined;
    if (row === undefined) return undefined;
    const live = rowToActivity(ctx.db, row);

    const now = currentTime(ctx);
    ctx.db
      .prepare(
        `UPDATE activities
         SET status = 'expired', final_summary = NULL, confidence = NULL,
             pending_question = NULL, updated_at = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(now, now, live.id);

    ctx.db
      .prepare("UPDATE activity_steps SET status = 'done' WHERE activity_id = ? AND status = 'active'")
      .run(live.id);

    const expired = getActivityById(ctx.db, live.id);
    if (expired === undefined) throw new Error(`Activity disappeared: ${live.id}`);
    event = insertActivityChangedEvent(ctx.db, expired, now);
    return expired;
  })();

  publishActivityChanged(ctx, event);
  return activity;
}

export function expireConfirmation(
  ctx: ActivityStoreCtx,
  input: { stepRunId: string }
): ActivityT | undefined {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const live = getLiveForStepRun(ctx.db, input.stepRunId);
    if (
      live === undefined ||
      live.status !== "paused_for_input" ||
      live.sourceKind !== "step_confirmation_pending"
    ) {
      return undefined;
    }
    const now = currentTime(ctx);
    ctx.db
      .prepare(
        `UPDATE activities
         SET status = 'expired', pending_question = NULL, updated_at = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(now, now, live.id);
    const expired = getActivityById(ctx.db, live.id);
    if (expired === undefined) throw new Error(`Activity disappeared: ${live.id}`);
    event = insertActivityChangedEvent(ctx.db, expired, now);
    return expired;
  })();
  publishActivityChanged(ctx, event);
  return activity;
}
