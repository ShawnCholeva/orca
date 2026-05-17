import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import {
  CreateGoalRequest,
  type CreateGoalResponse,
  HealthResponse,
  LIST_EVENTS_MAX_LIMIT,
  ListEventsQuery,
  type ListEventsResponse,
  type ListGoalsResponse,
  type ListPluginsResponse,
  UpdateGoalRequest,
  type UpdateGoalResponse,
  type ArchiveGoalResponse
} from '@orca/contracts';
import type { Config } from './config.js';
import {
  archiveGoal,
  createGoal,
  listGoals,
  NotFoundError,
  updateGoal,
  ValidationError
} from './goals.js';
import { eventBus, listEventsSince } from './events.js';
import { pluginRegistry } from './registry/plugin-registry.js';

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
    startedAt
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

  server.post('/v1/goals', async (request, reply): Promise<CreateGoalResponse | { error: 'validation_failed'; issues: unknown }> => {
    const parsed = CreateGoalRequest.safeParse(request.body);

    if (!parsed.success) {
      reply.status(400);
      return {
        error: 'validation_failed',
        issues: parsed.error.issues
      };
    }

    try {
      const goal = createGoal(parsed.data);
      reply.status(201);
      return { goal };
    } catch (error) {
      if (error instanceof ValidationError) {
        reply.status(400);
        return {
          error: 'validation_failed',
          issues: error.issues
        };
      }

      throw error;
    }
  });

  server.get('/v1/goals', async (): Promise<ListGoalsResponse> => {
    const goals = listGoals();
    return { goals };
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
