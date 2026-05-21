import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  ListConflictsQuery,
  ListConflictsResponse,
  ResolveConflictRequest,
  ResolveConflictResponse,
} from '@orca/contracts';
import type { EventBus } from '../events.js';
import {
  dismissConflict,
  ConflictNotFoundError,
  InvalidConflictStatusError,
  listConflictsByGoal,
  resolveConflict,
} from './usecases.js';

export interface ConflictRouteDeps {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

interface GoalRow {
  id: string;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function registerConflictRoutes(server: FastifyInstance, deps: ConflictRouteDeps): void {
  const { db, bus } = deps;

  const stmtGetGoal = db.prepare<[string], GoalRow>(
    'SELECT id FROM goals WHERE id = ?'
  );

  server.get('/v1/goals/:goalId/conflicts', async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    const queryParsed = ListConflictsQuery.safeParse(request.query);
    if (!queryParsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: queryParsed.error.issues };
    }

    const goalRow = stmtGetGoal.get(goalId);
    if (!goalRow) {
      reply.status(404);
      return apiError('goal_not_found', `Goal not found: ${goalId}`);
    }

    const query = queryParsed.data;
    const result = listConflictsByGoal(db, {
      goalId,
      status: query.status,
      severity: query.severity,
      limit: query.limit,
      cursor: query.cursor,
    });

    return ListConflictsResponse.parse({ conflicts: result.conflicts });
  });

  server.post('/v1/conflicts/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };

    const parsed = ResolveConflictRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    try {
      const result = parsed.data.resolution === 'resolved'
        ? resolveConflict(
            { db, bus, now: deps.now, idFactory: deps.idFactory },
            id,
            parsed.data.note
          )
        : dismissConflict(
            { db, bus, now: deps.now, idFactory: deps.idFactory },
            id,
            parsed.data.note
          );

      return ResolveConflictResponse.parse({ conflict: result.conflict });
    } catch (error) {
      if (error instanceof ConflictNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof InvalidConflictStatusError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });
}
