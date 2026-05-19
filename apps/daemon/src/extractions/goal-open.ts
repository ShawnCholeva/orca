import type Database from 'better-sqlite3';
import type { EventBus } from '../events.js';
import type { SessionOutputStore } from '../sessions/output-store.js';
import { getSessionDetail } from '../sessions/projection.js';
import { seedRefinementMemory } from '../memory/refinement-seed.js';
import { listEligibleSessionsForGoal } from './projection.js';
import { enqueueExtraction } from './usecases.js';
import type { ExtractionRunner } from './runner.js';
import { DETERMINISTIC_EXTRACTOR_VERSION } from './deterministic-extractor.js';

export interface GoalOpenCtx {
  db: Database.Database;
  bus: EventBus;
  outputStore: SessionOutputStore;
  runner: ExtractionRunner;
  now?: () => string;
}

export function tryEnqueueForTerminalSession(
  ctx: Omit<GoalOpenCtx, 'now'>,
  sessionId: string
): void {
  const { db, bus, outputStore, runner } = ctx;

  const session = getSessionDetail(db, sessionId);
  if (!session) return;

  const snapshot = outputStore.readTail(sessionId);
  const offsetFirst = snapshot.firstByteOffset;
  const offsetLast = snapshot.firstByteOffset + snapshot.totalBytesKept;

  try {
    enqueueExtraction(
      { db, bus },
      {
        goalId: session.goalId,
        sessionId,
        trigger: 'terminal_state',
        sourceOffsetFirst: offsetFirst,
        sourceOffsetLast: offsetLast,
        extractorVersion: DETERMINISTIC_EXTRACTOR_VERSION,
      }
    );
    runner.notify();
  } catch {
    // Non-blocking: enqueue errors must not propagate to the M4 lifecycle path
  }
}

export function enqueueEligibleForGoal(ctx: GoalOpenCtx, goalId: string): void {
  const { db, bus, outputStore, runner } = ctx;

  seedRefinementMemory({ db, bus, now: ctx.now }, goalId);

  const eligible = listEligibleSessionsForGoal(db, goalId);
  if (eligible.length === 0) return;

  let enqueued = 0;

  for (const session of eligible) {
    const snapshot = outputStore.readTail(session.id);
    const offsetFirst = snapshot.firstByteOffset;
    const offsetLast = snapshot.firstByteOffset + snapshot.totalBytesKept;

    try {
      enqueueExtraction(
        { db, bus, now: ctx.now },
        {
          goalId,
          sessionId: session.id,
          trigger: 'goal_open',
          sourceOffsetFirst: offsetFirst,
          sourceOffsetLast: offsetLast,
          extractorVersion: DETERMINISTIC_EXTRACTOR_VERSION,
        }
      );
      enqueued++;
    } catch {
      // Non-blocking: a single session failure must not block others or the read
    }
  }

  if (enqueued > 0) {
    runner.notify();
  }
}
