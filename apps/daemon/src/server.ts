import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import {
  AttachWorkspaceRequest,
  type AttachWorkspaceResponse,
  CreateGoalRequest,
  type CreateGoalResponse,
  type GoalDetailResponse,
  type GuidedRefinementOutput,
  HealthResponse,
  InspectWorkspaceRequest,
  type InspectWorkspaceResponse,
  LIST_EVENTS_MAX_LIMIT,
  ListEventsQuery,
  type ListEventsResponse,
  type ListGoalsResponse,
  type ListPluginsResponse,
  type ListSkillsResponse,
  RefineGoalRequest,
  type RefineGoalResponse,
  UpdateGoalRequest,
  type UpdateGoalResponse,
  type ArchiveGoalResponse
} from '@orca/contracts';
import type { Config } from './config.js';
import { getDatabase } from './db.js';
import {
  archiveGoal,
  createGoal,
  DuplicateWorkspaceInRequestError,
  getGoalById,
  listGoals,
  NotFoundError,
  updateGoal,
  ValidationError
} from './goals.js';
import { eventBus, listEventsSince } from './events.js';
import { getGoalRefinement } from './goal-refinements.js';
import { inspectWorkspace } from './workspaces/inspect.js';
import { WorkspaceInspectionError } from './workspaces/errors.js';
import { listWorkspacesByGoal } from './workspaces/projection.js';
import {
  attachWorkspace,
  detachWorkspace,
  DuplicateWorkspaceError
} from './workspaces/usecases.js';
import { pluginRegistry } from './registry/plugin-registry.js';
import { skillRegistry } from './registry/skill-registry.js';

// Sidecar (CJS-bundled SEA) sets ORCA_DAEMON_VERSION at build time; fall back
// to reading package.json at the source-tree path otherwise.
function readPackageVersion(): string {
  if (process.env.ORCA_DAEMON_VERSION) return process.env.ORCA_DAEMON_VERSION;
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8');
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}
const pkg = { version: readPackageVersion() };

const CORS_ORIGINS = [
  'http://localhost:5173',
  'tauri://localhost',
  'http://tauri.localhost'
];

const WS_OPEN = 1; // ws library WebSocket.OPEN

export function createServer(config: Config): FastifyInstance {
  const startedAt = new Date().toISOString();

  const server = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization']
    }
  });

  server.register(cors, { origin: CORS_ORIGINS });
  server.register(websocket);

  server.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0];

    // Health is the only unauthenticated HTTP route.
    if (request.method === 'GET' && pathname === '/v1/health') return;

    // WS upgrade keeps the existing ?token= path (validated inside wsHandler).
    if (request.headers.upgrade?.toLowerCase() === 'websocket') return;

    const expected = `Bearer ${config.getAuthToken()}`;
    if (request.headers.authorization !== expected) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  server.get('/v1/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    version: pkg.version,
    startedAt,
    registries: {
      plugins: pluginRegistry.list().length,
      skills: skillRegistry.list().length
    }
  }));

  server.get('/v1/plugins', async (): Promise<ListPluginsResponse> => {
    const plugins = pluginRegistry.list().map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      capabilities: plugin.capabilities
    }));

    return { plugins };
  });

  server.get('/v1/skills', async (): Promise<ListSkillsResponse> => {
    const skills = skillRegistry.list().map((skill) => ({
      id: skill.id,
      pluginId: skill.pluginId,
      extensionPoint: skill.extensionPoint,
      title: skill.title,
      description: skill.description
    }));

    return { skills };
  });

  function apiError(code: string, message: string): { error: { code: string; message: string } } {
    return { error: { code, message } };
  }

  function inspectionStatus(e: WorkspaceInspectionError): 400 | 504 {
    return e.code === 'inspection_timeout' ? 504 : 400;
  }

  server.post('/v1/goals/refine', async (request, reply) => {
    const parsed = RefineGoalRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const skills = skillRegistry.byExtensionPoint('goal.refine');
    if (skills.length !== 1) {
      reply.status(500);
      return apiError('runtime_misconfigured', `Expected exactly one goal.refine skill, found ${skills.length}`);
    }

    const skill = skills[0]!;
    const draft = skill.invoke(parsed.data, { now: () => new Date().toISOString() }) as GuidedRefinementOutput;
    return { draft };
  });

  server.post('/v1/goals', async (request, reply) => {
    const parsed = CreateGoalRequest.safeParse(request.body);

    if (!parsed.success) {
      reply.status(400);
      return {
        error: 'validation_failed',
        issues: parsed.error.issues
      };
    }

    try {
      const goal = await createGoal(parsed.data, { db: getDatabase(), bus: eventBus, skills: skillRegistry, inspectWorkspace });
      reply.status(201);
      return { goal };
    } catch (error) {
      if (error instanceof ValidationError) {
        reply.status(400);
        return { error: 'validation_failed', issues: error.issues };
      }
      if (error instanceof DuplicateWorkspaceInRequestError) {
        reply.status(400);
        return apiError(error.code, error.message);
      }
      if (error instanceof WorkspaceInspectionError) {
        reply.status(inspectionStatus(error));
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.get('/v1/goals', async (): Promise<ListGoalsResponse> => {
    const goals = listGoals();
    return { goals };
  });

  server.get('/v1/goals/:id', async (request, reply): Promise<GoalDetailResponse | { error: unknown }> => {
    const { id } = request.params as { id: string };
    const db = getDatabase();
    const goal = getGoalById(db, id);
    if (!goal) {
      reply.status(404);
      return apiError('not_found', `Goal not found: ${id}`);
    }

    const refinement = getGoalRefinement(db, id);
    const workspaces = listWorkspacesByGoal(db, id);
    return { goal, refinement, workspaces };
  });

  server.post('/v1/goals/:id/workspaces', async (request, reply): Promise<AttachWorkspaceResponse | { error: unknown }> => {
    const { id: goalId } = request.params as { id: string };
    const parsed = AttachWorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues } as { error: unknown };
    }

    try {
      const workspace = await attachWorkspace(
        { db: getDatabase(), bus: eventBus, inspectWorkspace },
        { goalId, inputPath: parsed.data.inputPath, name: parsed.data.name }
      );
      reply.status(201);
      return { workspace };
    } catch (error) {
      if (error instanceof NotFoundError) {
        reply.status(404);
        return apiError('not_found', `Goal not found: ${goalId}`);
      }
      if (error instanceof DuplicateWorkspaceError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (error instanceof WorkspaceInspectionError) {
        reply.status(inspectionStatus(error));
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.delete('/v1/goals/:id/workspaces/:workspaceId', async (request, reply): Promise<void | { error: unknown }> => {
    const { id: goalId, workspaceId } = request.params as { id: string; workspaceId: string };

    try {
      await detachWorkspace(
        { db: getDatabase(), bus: eventBus, inspectWorkspace },
        { goalId, workspaceId }
      );
      reply.code(204).send();
    } catch (error) {
      if (error instanceof NotFoundError) {
        reply.status(404);
        return apiError('not_found', `Workspace not found: ${workspaceId}`);
      }
      throw error;
    }
  });

  server.post('/v1/workspaces/inspect', async (request, reply): Promise<InspectWorkspaceResponse | { error: unknown }> => {
    const parsed = InspectWorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues } as { error: unknown };
    }

    try {
      const preview = await inspectWorkspace(parsed.data.inputPath);
      return { preview };
    } catch (error) {
      if (error instanceof WorkspaceInspectionError) {
        reply.status(inspectionStatus(error));
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.patch('/v1/goals/:id', async (request, reply): Promise<UpdateGoalResponse | { error: string; issues?: unknown }> => {
    const { id } = request.params as { id: string };
    const parsed = UpdateGoalRequest.safeParse(request.body);

    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    try {
      const goal = updateGoal(id, parsed.data);
      return { goal };
    } catch (error) {
      if (error instanceof ValidationError) {
        reply.status(400);
        return { error: 'validation_failed', issues: error.issues };
      }
      if (error instanceof NotFoundError) {
        reply.status(404);
        return { error: 'not_found' };
      }
      throw error;
    }
  });

  server.post('/v1/goals/:id/archive', async (request, reply): Promise<ArchiveGoalResponse | { error: string }> => {
    const { id } = request.params as { id: string };
    try {
      const goal = archiveGoal(id);
      return { goal };
    } catch (error) {
      if (error instanceof NotFoundError) {
        reply.status(404);
        return { error: 'not_found' };
      }
      throw error;
    }
  });

  // WS route must be inside a register callback so @fastify/websocket's onRoute hook fires
  server.register(async (fastify) => {
    fastify.route({
      method: 'GET',
      url: '/v1/events',
      wsHandler: (socket, request) => {
        const { token } = request.query as { token?: string };

        if (token !== config.getAuthToken()) {
          socket.close(1008, 'Unauthorized');
          return;
        }

        const unsubscribe = eventBus.subscribe((event) => {
          if (socket.readyState === WS_OPEN) {
            socket.send(JSON.stringify(event));
          }
        });

        socket.on('close', () => {
          unsubscribe();
        });
      },
      handler: async (request, reply): Promise<ListEventsResponse | { error: string; issues?: unknown }> => {
        const parsed = ListEventsQuery.safeParse(request.query);
        if (!parsed.success) {
          reply.status(400);
          return { error: 'validation_failed', issues: parsed.error.issues };
        }

        const { sinceSeq } = parsed.data;
        const events = listEventsSince(sinceSeq, LIST_EVENTS_MAX_LIMIT);
        const nextSinceSeq =
          events.length > 0 ? events[events.length - 1]!.seq : sinceSeq;

        return { events, nextSinceSeq };
      }
    });
  });

  return server;
}
