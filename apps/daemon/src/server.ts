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
  type ListGoalsResponse
} from '@orca/contracts';
import type { Config } from './config.js';
import { createGoal, listGoals, ValidationError } from './goals.js';
import { eventBus } from './events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
) as { version: string };

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

  server.get('/v1/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    version: pkg.version,
    startedAt
  }));

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

  // WS route must be inside a register callback so @fastify/websocket's onRoute hook fires
  server.register(async (fastify) => {
    fastify.get('/v1/events', { websocket: true }, (socket, request) => {
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
    });
  });

  return server;
}
