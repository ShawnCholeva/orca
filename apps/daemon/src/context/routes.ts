import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  CreateContextPackageRequest,
  CreateContextPackageResponse,
  GetContextPackageResponse,
  ListContextPackagesQuery,
  ListContextPackagesResponse,
} from '@orca/contracts';
import type { EventBus } from '../events.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { SessionPreparationAssembler } from './assembler.js';
import { requestContextPackage } from './usecases.js';
import { getContextPackageById, listContextPackagesByGoal } from './projection.js';
import { getWorkspaceByIdAndGoal } from '../workspaces/projection.js';

export interface ContextRouteDeps {
  db: Database.Database;
  bus: EventBus;
  assembler: SessionPreparationAssembler;
  adapterRegistry: AdapterRegistry;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function registerContextRoutes(server: FastifyInstance, deps: ContextRouteDeps): void {
  const { db, bus, assembler, adapterRegistry } = deps;

  const stmtGetGoal = db.prepare<[string], { id: string; archived_at: string | null }>(
    'SELECT id, archived_at FROM goals WHERE id = ?'
  );
  const stmtGetTrigger = db.prepare<[string, string, string], { status: string }>(
    `SELECT status FROM context_assemblies
     WHERE goal_id = ? AND adapter_id = ? AND role = ?
     ORDER BY requested_at DESC LIMIT 1`
  );

  server.post('/v1/goals/:goalId/context-packages', async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    const parsed = CreateContextPackageRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const { adapterId, role, objective, workspaceId, replacePackageId } = parsed.data;

    const goalRow = stmtGetGoal.get(goalId);
    if (!goalRow) {
      reply.status(404);
      return apiError('goal_not_found', `Goal not found: ${goalId}`);
    }
    if (goalRow.archived_at !== null) {
      reply.status(409);
      return apiError('goal_archived', `Goal is archived: ${goalId}`);
    }

    if (!adapterRegistry.get(adapterId)) {
      reply.status(404);
      return apiError('adapter_not_found', `Adapter not found: ${adapterId}`);
    }

    if (workspaceId !== undefined) {
      const ws = getWorkspaceByIdAndGoal(db, workspaceId, goalId);
      if (!ws) {
        reply.status(404);
        return apiError('workspace_not_found', `Workspace ${workspaceId} not attached to goal ${goalId}`);
      }
    }

    if (replacePackageId !== undefined) {
      const replacePkg = getContextPackageById(db, replacePackageId);
      if (!replacePkg || replacePkg.goalId !== goalId || replacePkg.status !== 'ready') {
        reply.status(404);
        return apiError(
          'replace_package_not_found',
          `replacePackageId ${replacePackageId} not found, not ready, or belongs to a different goal`
        );
      }
    }

    let trigger: string;
    if (replacePackageId !== undefined) {
      trigger = 'regenerate';
    } else {
      const triggerRow = stmtGetTrigger.get(goalId, adapterId, role);
      trigger = triggerRow?.status === 'failed' ? 'retry' : 'prepare';
    }

    const result = requestContextPackage(
      { db, bus, assembler },
      {
        goalId,
        adapterId,
        workspaceId: workspaceId ?? null,
        role,
        objective,
        replacePackageId: replacePackageId ?? null,
        trigger,
      }
    );

    const httpStatus = result.reused || result.assembly.status === 'failed' ? 200 : 201;
    reply.status(httpStatus);
    return CreateContextPackageResponse.parse({
      package: result.package,
      assembly: result.assembly,
      reused: result.reused,
    });
  });

  server.get('/v1/goals/:goalId/context-packages', async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    const queryParsed = ListContextPackagesQuery.safeParse(request.query);
    if (!queryParsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: queryParsed.error.issues };
    }

    const { sessionId, adapterId, limit } = queryParsed.data;
    const result = listContextPackagesByGoal(db, goalId, { sessionId, adapterId, limit });
    return ListContextPackagesResponse.parse(result);
  });

  server.get('/v1/context-packages/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const pkg = getContextPackageById(db, id);
    if (!pkg) {
      reply.status(404);
      return apiError('not_found', `Context package not found: ${id}`);
    }
    return GetContextPackageResponse.parse({ package: pkg });
  });
}
