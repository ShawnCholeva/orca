import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS } from '@orca/contracts';
import { redactSecrets } from '../memory/normalize.js';

interface StaleGenerationRow {
  id: string;
  goal_id: string;
}

interface ReconcileOptions {
  now?: string;
  idFactory?: () => string;
}

const BOOT_RECONCILED_MESSAGE = 'reconciled at boot';

function capAndRedactFailureMessage(message: string): string {
  return redactSecrets(message.slice(0, ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS));
}

/**
 * Marks stale orchestration in-flight generation rows (pending/running) as failed with daemon_restart.
 * Event rows are appended in the same transaction as projection row updates.
 * Runs during daemon bootstrap before trigger subscription and HTTP listen.
 */
export async function reconcileInFlightGenerations(
  db: Database.Database,
  options?: ReconcileOptions
): Promise<void> {
  const now = options?.now ?? new Date().toISOString();
  const idFactory = options?.idFactory ?? randomUUID;
  const failureMessage = capAndRedactFailureMessage(BOOT_RECONCILED_MESSAGE);

  const selectStaleTasks = db.prepare(
    "SELECT id, goal_id FROM task_generations WHERE status IN ('pending', 'running')"
  );
  const selectStaleRecommendations = db.prepare(
    "SELECT id, goal_id FROM recommendation_generations WHERE status IN ('pending', 'running')"
  );
  const failTaskGeneration = db.prepare(
    "UPDATE task_generations SET status = 'failed', failure_code = 'daemon_restart', failure_message = ?, finished_at = ? WHERE id = ?"
  );
  const failRecommendationGeneration = db.prepare(
    "UPDATE recommendation_generations SET status = 'failed', failure_code = 'daemon_restart', failure_message = ?, finished_at = ? WHERE id = ?"
  );
  const insertEvent = db.prepare(
    'INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  db.transaction(() => {
    const staleTasks = selectStaleTasks.all() as StaleGenerationRow[];
    const staleRecommendations = selectStaleRecommendations.all() as StaleGenerationRow[];

    for (const row of staleTasks) {
      failTaskGeneration.run(failureMessage, now, row.id);
      insertEvent.run(
        idFactory(),
        'task.generation.failed',
        row.goal_id,
        JSON.stringify({
          generationId: row.id,
          goalId: row.goal_id,
          failureCode: 'daemon_restart',
        }),
        now
      );
    }

    for (const row of staleRecommendations) {
      failRecommendationGeneration.run(failureMessage, now, row.id);
      insertEvent.run(
        idFactory(),
        'recommendation.generation.failed',
        row.goal_id,
        JSON.stringify({
          generationId: row.id,
          goalId: row.goal_id,
          failureCode: 'daemon_restart',
        }),
        now
      );
    }
  })();
}
