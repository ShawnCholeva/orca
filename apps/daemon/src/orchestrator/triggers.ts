import type Database from 'better-sqlite3';
import type { DomainEvent, DomainEventType, TriggerKind } from '@orca/contracts';
import type { DaemonContext } from '../daemon-context.js';
import { runTaskGeneration } from '../tasks/usecases.js';
import { runRecommendationGeneration } from '../recommendations/usecases.js';
import { detectAndPersist } from '../conflicts/usecases.js';
import { setGoalReEvaluator } from './runner.js';

// ── Trigger entry ─────────────────────────────────────────────────────────────

interface TriggerEntry {
  triggerKind: TriggerKind;
  runRecs: boolean;
  runConflicts: boolean;
  /** Only fires when countActiveTasks(db, goalId) === 0 */
  runTasksIfEmpty: boolean;
}

// ── Data-driven trigger map ───────────────────────────────────────────────────
//
// Maps domain event types to orchestration actions.
// Events absent from this map are silently ignored.
// M7 generation lifecycle events are deliberately absent (re-entrancy guard).
//
// The payload-based entries (memory.extraction.completed, decision.created,
// decision.updated, user.feedback.recorded) are handled in mapEventToAction
// below after this static table is consulted.

export const TRIGGER_MAP: Readonly<Partial<Record<DomainEventType, TriggerEntry>>> = {
  'goal.refined': {
    triggerKind: 'refinement_applied',
    runRecs: true,
    runConflicts: false,
    runTasksIfEmpty: true,
  },
  'session.exited': {
    triggerKind: 'session_completed',
    runRecs: true,
    runConflicts: true,
    runTasksIfEmpty: false,
  },
  'memory.item.promoted': {
    triggerKind: 'memory_promoted',
    runRecs: true,
    runConflicts: true,
    runTasksIfEmpty: false,
  },
  'memory.item.archived': {
    triggerKind: 'memory_canonical',
    runRecs: true,
    runConflicts: true,
    runTasksIfEmpty: false,
  },
  'decision.confirmed': {
    triggerKind: 'decision_confirmed',
    runRecs: true,
    runConflicts: true,
    runTasksIfEmpty: false,
  },
  'context.package.created': {
    triggerKind: 'context_package_created',
    runRecs: true,
    runConflicts: false,
    runTasksIfEmpty: false,
  },
  'task.created': {
    triggerKind: 'task_created',
    runRecs: false,
    runConflicts: true,
    runTasksIfEmpty: false,
  },
  'task.status_changed': {
    triggerKind: 'task_status_changed',
    runRecs: false,
    runConflicts: true,
    runTasksIfEmpty: false,
  },
  'conflict.detected': {
    // Cascade already handled by M7-010 detectAndPersist; no further action.
    triggerKind: 'conflict_detected',
    runRecs: false,
    runConflicts: false,
    runTasksIfEmpty: false,
  },
};

// ── Payload-based entry constants ─────────────────────────────────────────────

const ENTRY_SESSION_SUMMARY_CREATED: TriggerEntry = {
  triggerKind: 'session_summary_created',
  runRecs: true,
  runConflicts: true,
  runTasksIfEmpty: false,
};

const ENTRY_DECISION_CONFIRMATION_REQUIRED: TriggerEntry = {
  triggerKind: 'decision_confirmation_required',
  runRecs: true,
  runConflicts: false,
  runTasksIfEmpty: false,
};

const ENTRY_USER_FEEDBACK_RECORDED: TriggerEntry = {
  triggerKind: 'user_feedback_recorded',
  runRecs: true,
  runConflicts: false,
  runTasksIfEmpty: false,
};

// ── Payload-based dispatch ────────────────────────────────────────────────────

interface MappedAction {
  entry: TriggerEntry;
  triggerSourceId: string | null;
}

function mapEventToAction(event: DomainEvent): MappedAction | null {
  const { type, payload } = event;

  const staticEntry = TRIGGER_MAP[type];
  if (staticEntry !== undefined) {
    return { entry: staticEntry, triggerSourceId: extractStaticSourceId(payload) };
  }

  if (type === 'memory.extraction.completed') {
    const summaryId = typeof payload.summaryId === 'string' ? payload.summaryId : null;
    if (summaryId !== null) {
      return { entry: ENTRY_SESSION_SUMMARY_CREATED, triggerSourceId: summaryId };
    }
    return null;
  }

  if (type === 'decision.created' || type === 'decision.updated') {
    if (payload.confirmationRequired === true) {
      const sourceId = typeof payload.decisionId === 'string' ? payload.decisionId : null;
      return { entry: ENTRY_DECISION_CONFIRMATION_REQUIRED, triggerSourceId: sourceId };
    }
    return null;
  }

  if (type === 'user.feedback.recorded') {
    if (payload.action === 'modify') {
      const sourceId = typeof payload.feedbackId === 'string' ? payload.feedbackId : null;
      return { entry: ENTRY_USER_FEEDBACK_RECORDED, triggerSourceId: sourceId };
    }
    return null;
  }

  return null;
}

const SOURCE_ID_KEYS = [
  'refinementId',
  'sessionId',
  'memoryItemId',
  'decisionId',
  'conflictId',
  'taskId',
  'contextPackageId',
  'feedbackId',
] as const;

function extractStaticSourceId(payload: Record<string, unknown>): string | null {
  for (const key of SOURCE_ID_KEYS) {
    const v = payload[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

// ── Count helper ──────────────────────────────────────────────────────────────

let _countDb: Database.Database | null = null;
let _countStmt: Database.Statement | null = null;

function countActiveTasks(db: Database.Database, goalId: string): number {
  if (db !== _countDb) {
    _countDb = db;
    _countStmt = db.prepare(
      `SELECT COUNT(*) as cnt FROM tasks
       WHERE goal_id = ? AND status NOT IN ('cancelled','archived')`
    );
  }
  const row = _countStmt!.get(goalId) as { cnt: number };
  return row.cnt;
}

/** Reset cached prepared statements. For use in tests only. */
export function resetPreparedStatements(): void {
  _countDb = null;
  _countStmt = null;
}

// ── Trigger handler ───────────────────────────────────────────────────────────

async function handleTrigger(
  ctx: DaemonContext,
  goalId: string,
  event: DomainEvent,
  mapped: MappedAction
): Promise<void> {
  const { db, bus, taskGenerator, recommendationProvider, conflictDetector, now, idFactory } = ctx;
  const { entry, triggerSourceId } = mapped;
  const sourceId = triggerSourceId ?? event.id;

  if (entry.runConflicts) {
    detectAndPersist(
      { db, bus, conflictDetector, now, idFactory },
      { goalId, triggerEvent: { id: event.id, type: event.type } }
    );
  }

  // Task generation runs first (awaited) so it does not compete for the single-flight
  // slot with recommendation generation. Only fires for refinement_applied when zero tasks.
  if (entry.runTasksIfEmpty && countActiveTasks(db, goalId) === 0) {
    try {
      await runTaskGeneration(
        { db, bus, taskGenerator, now, idFactory },
        { goalId, trigger: 'refinement_applied', triggerSourceId: sourceId }
      );
    } catch {
      // Dirty-queued or failed — re-evaluator handles retry.
    }
  }

  if (entry.runRecs) {
    runRecommendationGeneration(
      { db, bus, recommendationProvider, now, idFactory },
      { goalId, trigger: entry.triggerKind, triggerSourceId: sourceId }
    ).catch(() => {
      // Dirty-queued or generation already active — runner handles re-evaluation.
    });
  }
}

// ── Re-evaluator ──────────────────────────────────────────────────────────────

/**
 * Called by the runner when a generation completes and a dirty flag was set,
 * indicating a trigger arrived while in-flight. Re-runs conflict detection and
 * recommendation generation conservatively.
 */
function createReEvaluator(ctx: DaemonContext): (goalId: string) => void {
  return (goalId: string) => {
    const { db, bus, recommendationProvider, conflictDetector, now, idFactory } = ctx;

    detectAndPersist(
      { db, bus, conflictDetector, now, idFactory },
      { goalId, triggerEvent: null }
    );

    runRecommendationGeneration(
      { db, bus, recommendationProvider, now, idFactory },
      { goalId, trigger: 'manual', triggerSourceId: null }
    ).catch(() => {});
  };
}

// ── Subscribe ─────────────────────────────────────────────────────────────────

/**
 * Subscribe the orchestrator to the committed event bus and register the
 * dirty-flag re-evaluator with the runner. Call once during daemon bootstrap.
 * Returns an unsubscribe function.
 */
export function subscribeOrchestrationTriggers(ctx: DaemonContext): () => void {
  setGoalReEvaluator(createReEvaluator(ctx));

  const unsubscribe = ctx.bus.subscribe((event: DomainEvent) => {
    const { goalId } = event;
    if (goalId == null) return;

    const mapped = mapEventToAction(event);
    if (mapped === null) return;

    // Fire-and-forget; errors are logged inside handleTrigger / runner.
    handleTrigger(ctx, goalId, event, mapped).catch((err: unknown) => {
      console.error('[orchestrator/triggers] handleTrigger error', err);
    });
  });

  return unsubscribe;
}
