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
  CreateSessionRequest,
  type CreateSessionResponse,
  type GetSessionResponse,
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
  type ListSessionsResponse,
  type ListSkillsResponse,
  type ListAdaptersResponse,
  RefineGoalRequest,
  type RefineGoalResponse,
  SessionInputFrame,
  SessionResizeFrame,
  SessionSubscribeFrame,
  SessionUnsubscribeFrame,
  StartSessionRequest,
  type StartSessionResponse,
  type StopSessionResponse,
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
import { adapterRegistry } from './adapters/registry.js';
import {
  AdapterNotFoundError,
  CommandNotFoundError,
  GoalArchivedError,
  GoalNotFoundError,
  SessionNotFoundError,
  SessionNotStoppableError,
  SessionWrongStateError,
  SpawnFailedError,
  WorkspaceNotAttachedError,
  WorkspaceNotFoundError,
  WorkspaceUnavailableError,
} from './sessions/errors.js';
import {
  createSession,
  getSession,
  listSessionsForGoal,
  startSession,
  stopSession,
} from './sessions/usecases.js';
import { createSessionOutputStore } from './sessions/output-store.js';
import { SessionRuntime, type WsClient } from './sessions/runtime.js';
import { getSessionDetail } from './sessions/projection.js';
import { NodePtyManager } from './pty/manager.js';

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

export function createServer(
  config: Config,
  deps?: { sessionRuntime?: SessionRuntime }
): FastifyInstance {
  const startedAt = new Date().toISOString();
  const db = getDatabase();
  const sessionOutputStore = createSessionOutputStore(db, {
    tailBytes: config.sessionOutputTailBytes,
  });
  const sessionRuntime =
    deps?.sessionRuntime ??
    new SessionRuntime(new NodePtyManager(), config.sessionStopGraceMs, config.sessionWsBufferLimitBytes);

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

  server.get('/v1/adapters', async (): Promise<ListAdaptersResponse> => {
    const adapters = await adapterRegistry.list();
    return { adapters };
  });

  server.post('/v1/goals/:goalId/sessions', async (request, reply): Promise<CreateSessionResponse | { error: unknown; issues?: unknown }> => {
    const { goalId } = request.params as { goalId: string };
    const parsed = CreateSessionRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    try {
      const session = await createSession(
        { db, bus: eventBus, adapterRegistry },
        { goalId, ...parsed.data }
      );
      reply.status(201);
      return { session };
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof GoalArchivedError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (
        error instanceof WorkspaceNotFoundError ||
        error instanceof WorkspaceNotAttachedError ||
        error instanceof WorkspaceUnavailableError ||
        error instanceof AdapterNotFoundError
      ) {
        reply.status(422);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.get('/v1/goals/:goalId/sessions', async (request): Promise<ListSessionsResponse> => {
    const { goalId } = request.params as { goalId: string };
    const sessions = listSessionsForGoal(db, goalId);
    return { sessions };
  });

  server.get('/v1/sessions/:id', async (request, reply): Promise<GetSessionResponse | { error: unknown }> => {
    const { id } = request.params as { id: string };
    try {
      return getSession(db, id, sessionOutputStore);
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.post('/v1/sessions/:id/start', async (request, reply): Promise<StartSessionResponse | { error: unknown; issues?: unknown }> => {
    const { id } = request.params as { id: string };
    const parsed = StartSessionRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }
    try {
      const session = await startSession(
        { db, bus: eventBus, adapterRegistry, sessionOutputStore, sessionRuntime },
        id,
        parsed.data
      );
      return { session };
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof SessionWrongStateError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (
        error instanceof WorkspaceUnavailableError ||
        error instanceof CommandNotFoundError ||
        error instanceof SpawnFailedError
      ) {
        reply.status(422);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.post('/v1/sessions/:id/stop', async (request, reply): Promise<StopSessionResponse | { error: unknown }> => {
    const { id } = request.params as { id: string };
    try {
      const session = stopSession({ db, sessionRuntime }, id);
      return { session };
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof SessionNotStoppableError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  // Sends a session.error frame if the socket is still open.
  function sendSessionError(
    socket: WsClient,
    sessionId: string | undefined,
    code: 'unknown_session' | 'not_active' | 'invalid_message',
    message: string
  ): void {
    if (socket.readyState !== WS_OPEN) return;
    const frame: Record<string, unknown> = { type: 'session.error', code, message };
    if (sessionId !== undefined) frame.sessionId = sessionId;
    socket.send(JSON.stringify(frame));
  }

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

        // Handle incoming session frames from this client.
        socket.on('message', (rawData: Buffer) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawData.toString());
          } catch {
            sendSessionError(socket as unknown as WsClient, undefined, 'invalid_message', 'malformed JSON');
            return;
          }

          if (typeof parsed !== 'object' || parsed === null) {
            sendSessionError(socket as unknown as WsClient, undefined, 'invalid_message', 'expected JSON object');
            return;
          }

          const type = (parsed as { type?: unknown }).type;
          if (typeof type !== 'string' || !type.startsWith('session.')) {
            // Not a session frame — ignore (domain event bus frames are server→client only)
            return;
          }

          if (type === 'session.subscribe') {
            const frame = SessionSubscribeFrame.safeParse(parsed);
            if (!frame.success) {
              sendSessionError(socket as unknown as WsClient, undefined, 'invalid_message', 'invalid session.subscribe frame');
              return;
            }
            const session = getSessionDetail(db, frame.data.sessionId);
            if (!session) {
              sendSessionError(socket as unknown as WsClient, frame.data.sessionId, 'unknown_session', 'session not found');
              return;
            }
            sessionRuntime.subscribe(frame.data.sessionId, socket as unknown as WsClient);
            return;
          }

          if (type === 'session.unsubscribe') {
            const frame = SessionUnsubscribeFrame.safeParse(parsed);
            if (!frame.success) {
              sendSessionError(socket as unknown as WsClient, undefined, 'invalid_message', 'invalid session.unsubscribe frame');
              return;
            }
            sessionRuntime.unsubscribeSocket(frame.data.sessionId, socket as unknown as WsClient);
            return;
          }

          if (type === 'session.input') {
            const frame = SessionInputFrame.safeParse(parsed);
            if (!frame.success) {
              sendSessionError(socket as unknown as WsClient, undefined, 'invalid_message', 'invalid session.input frame');
              return;
            }
            const handle = sessionRuntime.getHandle(frame.data.sessionId);
            if (!handle) {
              sendSessionError(socket as unknown as WsClient, frame.data.sessionId, 'not_active', 'session not running');
              return;
            }
            handle.write(Buffer.from(frame.data.dataBase64, 'base64'));
            return;
          }

          if (type === 'session.resize') {
            const frame = SessionResizeFrame.safeParse(parsed);
            if (!frame.success) {
              sendSessionError(socket as unknown as WsClient, undefined, 'invalid_message', 'invalid session.resize frame');
              return;
            }
            sessionRuntime.resize(db, frame.data.sessionId, frame.data.cols, frame.data.rows);
            return;
          }

          // Unknown session.* frame
          sendSessionError(socket as unknown as WsClient, undefined, 'invalid_message', `unknown frame type: ${type}`);
        });

        socket.on('close', () => {
          unsubscribe();
          sessionRuntime.removeSocket(socket as unknown as WsClient);
        });

        socket.on('error', () => {
          sessionRuntime.removeSocket(socket as unknown as WsClient);
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
