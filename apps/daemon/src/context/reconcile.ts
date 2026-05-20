import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DomainEvent } from '@orca/contracts';
import type { EventBus } from '../events.js';
import { getAssembliesByStatus, updateAssemblyFailed } from './projection.js';

const FAILURE_MESSAGE = 'daemon restarted while assembly was in flight';

// Marks all pending/running context_assemblies rows as failed/daemon_restart in one transaction.
// Runs before HTTP/WS listener starts; idempotent via status filter.
export function reconcileStaleAssemblies(
  db: Database.Database,
  bus: EventBus,
  now: string
): void {
  const stale = getAssembliesByStatus(db, ['pending', 'running']);
  if (stale.length === 0) return;

  const insertEvent = db.prepare(
    'INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const events: DomainEvent[] = [];

  db.transaction(() => {
    for (const assembly of stale) {
      updateAssemblyFailed(db, assembly.id, {
        failureCode: 'daemon_restart',
        failureMessage: FAILURE_MESSAGE,
        finishedAt: now,
      });

      const eventId = randomUUID();
      const payload = {
        assemblyId: assembly.id,
        goalId: assembly.goalId,
        failureCode: 'daemon_restart' as const,
      };
      const result = insertEvent.run(
        eventId,
        'context.assembly.failed',
        assembly.goalId,
        JSON.stringify(payload),
        now
      );
      events.push({
        seq: Number(result.lastInsertRowid),
        id: eventId,
        type: 'context.assembly.failed',
        goalId: assembly.goalId,
        payload,
        createdAt: now,
      });
    }
  })();

  for (const event of events) {
    bus.publish(event);
  }
}
