import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DomainEvent } from '@orca/contracts';
import type { EventBus } from '../events.js';
import { listActiveAndRunningExtractions, updateExtractionStatus } from './projection.js';

// Marks all pending/running extraction rows as failed with daemon_restart in one transaction.
// Runs before HTTP/WS listener starts; safe to call multiple times (idempotent via status filter).
export function reconcileStaleExtractions(
  db: Database.Database,
  bus: EventBus,
  now: string
): void {
  const stale = listActiveAndRunningExtractions(db);
  if (stale.length === 0) return;

  const insertEvent = db.prepare(
    'INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  const events: DomainEvent[] = [];

  db.transaction(() => {
    for (const extraction of stale) {
      updateExtractionStatus(db, extraction.id, {
        status: 'failed',
        failureCode: 'daemon_restart',
        failureMessage: null,
        finishedAt: now,
      });

      const eventId = randomUUID();
      const payload = {
        extractionId: extraction.id,
        goalId: extraction.goalId,
        sessionId: extraction.sessionId,
        failureCode: 'daemon_restart' as const,
      };
      const result = insertEvent.run(
        eventId,
        'memory.extraction.failed',
        extraction.goalId,
        JSON.stringify(payload),
        now
      );

      events.push({
        seq: Number(result.lastInsertRowid),
        id: eventId,
        type: 'memory.extraction.failed',
        goalId: extraction.goalId,
        payload,
        createdAt: now,
      });
    }
  })();

  for (const event of events) {
    bus.publish(event);
  }
}
