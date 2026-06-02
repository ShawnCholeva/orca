import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DomainEvent } from '@orca/contracts';
import type { EventBus } from '../events.js';
import { setSessionStatus } from './projection.js';

interface StaleSessionRow {
  id: string;
  goal_id: string;
}

// Before HTTP/WS listen, mark any starting/running sessions as failed.
// One atomic transaction covers all rows; events broadcast after COMMIT so
// subscribers never observe a running session without a live process.
export function reconcileSessionsOnBoot(
  db: Database.Database,
  bus: EventBus,
  now: string
): void {
  // Skip sessions owned by a workflow step — those are tmux-backed workers that may
  // have survived the restart. resume/reattach handles them immediately after boot.
  const rows = db
    .prepare("SELECT id, goal_id FROM sessions WHERE status IN ('starting', 'running') AND workflow_step_run_id IS NULL")
    .all() as StaleSessionRow[];

  if (rows.length === 0) return;

  const insertEvent = db.prepare(
    'INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const events: DomainEvent[] = [];

  db.transaction(() => {
    for (const row of rows) {
      const payload = { sessionId: row.id, goalId: row.goal_id, failureReason: 'daemon_restart' };
      setSessionStatus(db, row.id, 'failed', { failureReason: 'daemon_restart', exitedAt: now });
      const eventId = randomUUID();
      const result = insertEvent.run(eventId, 'session.failed', row.goal_id, JSON.stringify(payload), now);
      events.push({
        seq: Number(result.lastInsertRowid),
        id: eventId,
        type: 'session.failed',
        goalId: row.goal_id,
        payload,
        createdAt: now,
      });
    }
  })();

  for (const event of events) {
    bus.publish(event);
  }
}
