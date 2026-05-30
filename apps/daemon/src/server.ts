import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import {
  AttachWorkspaceRequest,
  type AttachWorkspaceResponse,
  CreateGoalRequest,
  type CreateGoalResponse,
  CreateGoalMemoryRequest,
  type ListGoalMemoryResponse,
  PatchGoalMemoryRequest,
  CreateGoalDecisionRequest,
  type ListGoalDecisionsResponse,
  PatchGoalDecisionRequest,
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
  type ListModelProvidersResponse,
  ListOperatorsResponse,
  type ListSessionsResponse,
  type ListSkillsResponse,
  type ListAgentsResponse,
  type UpdateAgentResponse,
  UpdateAgentRequest,
  type ListAdaptersResponse,
  RefineGoalRequest,
  type RefineGoalResponse,
  SessionInputFrame,
  SessionResizeFrame,
  SessionSubscribeFrame,
  SessionUnsubscribeFrame,
  StartSessionRequest,
  type StartSessionResponse,
  StopSessionRequest,
  type StopSessionResponse,
  UpdateGoalRequest,
  type UpdateGoalResponse,
  UpdateGoalOrchestratorModelRequest,
  type UpdateGoalOrchestratorModelResponse,
  type ArchiveGoalResponse,
  type GoalMemoryItem,
  type GoalDecision,
  CheckReadinessAllResponse,
  CheckReadinessOneResponse
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
  updateGoalOrchestratorModel,
  ValidationError
} from './goals.js';
import { eventBus, listEventsSince, type EventBus } from './events.js';
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
import { AgentNotFoundError, listAgents, setAgentConnected } from './agents.js';
import { adapterRegistry } from './adapters/registry.js';
import {
  AdapterNotFoundError,
  ArchivedTargetError,
  AssociationGoalMismatchError,
  CommandNotFoundError,
  ContextPackageMismatchError,
  ContextPackageNotFoundError,
  GoalArchivedError,
  GoalNotFoundError,
  InvalidRecommendationStateError,
  RecommendationNotFoundError,
  SessionNotFoundError,
  SessionNotStoppableError,
  SessionWrongStateError,
  SpawnFailedError,
  TaskNotFoundError,
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
import { createSessionOutputStore, type SessionOutputStore } from './sessions/output-store.js';
import { SessionRuntime, WS_CLIENT_OPEN, type WsClient } from './sessions/runtime.js';
import { ExtractionRunner } from './extractions/runner.js';
import { DETERMINISTIC_EXTRACTOR_VERSION } from './extractions/deterministic-extractor.js';
import { enqueueEligibleForGoal, tryEnqueueForTerminalSession } from './extractions/goal-open.js';
import { getSessionDetail } from './sessions/projection.js';
import { NodePtyManager } from './pty/manager.js';
import {
  getLatestSummaryForSession,
} from './extractions/projection.js';
import {
  createMemoryItem,
  patchMemoryItem,
  listMemoryByGoal,
  GoalArchivedError as MemoryGoalArchivedError,
  GoalNotFoundError as MemoryGoalNotFoundError,
  MemoryDuplicateError,
  MemoryNotFoundError,
  InvalidMemoryTransitionError,
} from './memory/usecases.js';
import {
  createDecision,
  patchDecision,
  listDecisionsByGoal,
  GoalArchivedError as DecisionGoalArchivedError,
  GoalNotFoundError as DecisionGoalNotFoundError,
  DecisionNotFoundError,
  InvalidDecisionTransitionError,
} from './decisions/usecases.js';
import {
  manualExtractEnqueue,
  GoalArchivedForExtractionError,
  SessionArchivedForExtractionError,
  SessionNotFoundForExtractionError,
  SessionNotTerminalError,
} from './extractions/usecases.js';
import type { SessionPreparationAssembler } from './context/assembler.js';
import { registerContextRoutes } from './context/routes.js';
import { registerAdapterExecutionModeRoutes } from './adapters/execution-modes-routes.js';
import { createDaemonContext, type DaemonContext } from './daemon-context.js';
import { ProductionWorkflowSessionLauncher } from './workflows/orchestrator/session-launcher-impl.js';
import { registerTaskRoutes } from './tasks/routes.js';
import { registerRecommendationRoutes } from './recommendations/routes.js';
import { registerConflictRoutes } from './conflicts/routes.js';
import { registerGoalBootstrapRoute } from './goals/bootstrap-route.js';
import { startWorkflowRun } from './workflows/runs/usecases.js';
import { OrchestratorService } from './workflows/orchestrator/service.js';
import { resumeActiveRuns } from './workflows/orchestrator/resume.js';
import { registerWorkflowTemplateRoutes } from './workflows/templates/routes.js';
import { registerWorkflowRunRoutes } from './workflows/runs/routes.js';
import { registerWorkflowArtifactRoutes } from './workflows/artifacts/routes.js';
import { registerWorkflowDecisionRoutes } from './workflows/decisions/routes.js';
import { registerOrchestratorRoutes } from './workflows/orchestrator/routes.js';
import { registerOrchestratorChatRoutes } from './orchestrator-chat/routes.js';
import { insertMessageWithEvent } from './orchestrator-chat/usecases.js';
import { registerOrchestratorHookRoutes } from './orchestrator-hooks/routes.js';
import { ShadowSessionManager, shadowSessionId } from './orchestrator-llm/shadow-session.js';
import { ShadowSessionLlmClient } from './orchestrator-llm/shadow-llm-client.js';
import { OrchestratorMediator } from './orchestrator-llm/mediator.js';
import { composeOrchestratorPrompt } from './orchestrator-llm/prompts.js';
import { buildContextFromDb } from './orchestrator-llm/build-context.js';
import { registerWorkflowStepRoutes } from './workflows/steps/routes.js';
import { registerAgentHookRoutes } from './agent-hooks/routes.js';
import { WorkerSessionManager } from './workflows/orchestrator/worker-session.js';
import { registerOrchestrationTransportRoutes } from './workflows/orchestration-transport/routes.js';
import {
  buildOrchestrationProviderCatalog,
  toModelProvidersResponse,
} from './workflows/orchestration-transport/provider-catalog.js';
import { NotConnectedError, UnknownAgentError } from './readiness/service.js';

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

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const CORS_ORIGINS = [
  'http://localhost:5173',
  'tauri://localhost',
  'http://tauri.localhost'
];

export function createServer(
  config: Config,
  deps?: {
    sessionRuntime?: SessionRuntime;
    sessionOutputStore?: SessionOutputStore;
    extractionRunner?: ExtractionRunner;
    assembler?: SessionPreparationAssembler;
    daemonContext?: DaemonContext;
    resumeActiveRunsOnBoot?: boolean;
  }
): FastifyInstance {
  const startedAt = new Date().toISOString();
  const db = getDatabase();
  const daemonContext = deps?.daemonContext ?? createDaemonContext(db, eventBus);
  // Late-binding ref so the onChunkAppended callback can reference orchestratorService
  // even though sessionOutputStore is constructed before orchestratorService below.
  const _orchestratorServiceRef: { current: OrchestratorService | null } = { current: null };
  const sessionOutputStore =
    deps?.sessionOutputStore ??
    createSessionOutputStore(db, {
      tailBytes: config.sessionOutputTailBytes,
      onChunkAppended: (sessionId) => {
        if (!_orchestratorServiceRef.current) return;
        // Best-effort: look up goalId from the session row.
        const row = db
          .prepare("SELECT goal_id FROM sessions WHERE id = ?")
          .get(sessionId) as { goal_id: string } | undefined;
        if (!row) return;
        _orchestratorServiceRef.current
          .onSessionOutputChunk(
            db,
            daemonContext.now,
            { sessionId, goalId: row.goal_id },
            { bus: eventBus, idFactory: daemonContext.idFactory }
          )
          .catch((err) => console.error("[workflow] onSessionOutputChunk error", err));
      },
    });
  const sessionRuntime =
    deps?.sessionRuntime ??
    new SessionRuntime(new NodePtyManager(), config.sessionStopGraceMs, config.sessionWsBufferLimitBytes);
  const extractionRunner = deps?.extractionRunner;
  const assembler = deps?.assembler ?? daemonContext.contextAssembler;

  // Note: the workflow session launcher is now used only to create the session
  // DB row. Step agents are started as tmux workers via WorkerSessionManager,
  // so the node-pty setStarter wiring is intentionally omitted here.

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
      skills: skillRegistry.listPublic().length
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

  server.get('/v1/model-providers', async (): Promise<ListModelProvidersResponse> => {
    const catalog = await buildOrchestrationProviderCatalog(daemonContext.modelProviderRegistry);
    const providers = toModelProvidersResponse(catalog);
    return { providers };
  });

  const ListOperatorsQuery = z
    .object({
      goalId: z.string().min(1),
    })
    .strict();

  server.get('/v1/operators', async (request, reply): Promise<ListOperatorsResponse | { error: unknown; issues?: unknown }> => {
    const parsed = ListOperatorsQuery.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }
    if (!getGoalById(db, parsed.data.goalId)) {
      reply.status(404);
      return apiError('goal_not_found', `Goal not found: ${parsed.data.goalId}`);
    }

    const operators = await daemonContext.operatorRegistry.list(parsed.data.goalId);
    return ListOperatorsResponse.parse({ operators });
  });

  server.get('/v1/skills', async (): Promise<ListSkillsResponse> => {
    const skills = skillRegistry.listPublic().map((skill) => ({
      id: skill.id,
      pluginId: skill.pluginId,
      extensionPoint: skill.extensionPoint,
      title: skill.title,
      description: skill.description
    }));

    return { skills };
  });

  server.get('/v1/agents', async (): Promise<ListAgentsResponse> => {
    return { agents: listAgents(db) };
  });

  server.patch('/v1/agents/:id', async (request, reply): Promise<UpdateAgentResponse | { error: unknown; issues?: unknown }> => {
    const parsed = UpdateAgentRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }
    const { id } = request.params as { id: string };
    try {
      const agent = setAgentConnected(db, id, parsed.data.connected);
      return { agent };
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        reply.status(404);
        return { error: apiError('agent_not_found', err.message).error };
      }
      throw err;
    }
  });

  server.post('/v1/agents/readiness:check', async () => {
    const reports = await daemonContext.readinessService.checkSelected();
    return CheckReadinessAllResponse.parse({ reports });
  });

  server.post<{ Params: { id: string } }>(
    '/v1/agents/:id/readiness:check',
    async (request, reply) => {
      const { id } = request.params;
      try {
        const agent = listAgents(db).find((candidate) => candidate.id === id);
        if (!agent) {
          reply.code(404);
          return { error: 'not_found' };
        }
        if (!agent.connected) {
          reply.code(400);
          return { error: 'not_connected' };
        }
        const report = await daemonContext.readinessService.checkAgent(id);
        return CheckReadinessOneResponse.parse({ report });
      } catch (err) {
        if (err instanceof UnknownAgentError) {
          reply.code(404);
          return { error: 'not_found' };
        }
        if (err instanceof NotConnectedError) {
          reply.code(400);
          return { error: 'not_connected' };
        }
        throw err;
      }
    }
  );

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
      const goal = await createGoal(parsed.data, {
        db: getDatabase(),
        bus: eventBus,
        skills: skillRegistry,
        modelProviderRegistry: daemonContext.modelProviderRegistry,
        inspectWorkspace
      });
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

  // Shadow session manager for the orchestrator-LLM (tmux-backed).
  const shadowSessions = new ShadowSessionManager({
    shadowRoot: path.join(config.dataDir, "shadow"),
    daemonPort: config.port,
    authToken: config.getAuthToken(),
    isReady: async () => {
      const adapter = adapterRegistry.get("claude-code");
      if (!adapter) return false;
      const step = await adapter.checkAuth();
      return step.ok;
    },
    claudeBin: process.env["ORCA_CLAUDE_CODE_BIN"] ?? "claude",
  });

  // Worker session manager for orchestrator-dispatched agent sessions (tmux-backed).
  const workerSessions = new WorkerSessionManager({
    privateRoot: path.join(config.dataDir, "workers"),
    daemonPort: 0, // set after listen via setDaemonPort, mirroring the shadow
    authToken: config.getAuthToken(),
    claudeBin: process.env["ORCA_CLAUDE_CODE_BIN"] ?? "claude",
    captureSink: (sessionId, chunk) => sessionOutputStore.appendChunk(sessionId, chunk),
  });

  // Update the hook endpoint URLs with the actual bound port after listen.
  server.addHook("onListen", async () => {
    const addr = server.server.address();
    if (addr && typeof addr === "object" && typeof addr.port === "number") {
      shadowSessions.setDaemonPort(addr.port);
      workerSessions.setDaemonPort(addr.port);
    }
  });

  const shadowClient = new ShadowSessionLlmClient(shadowSessions, { timeoutMs: 60_000 });
  const orchestratorMediator = new OrchestratorMediator({
    llm: shadowClient,
    buildContext: ({ goalId, runId, stepRunId }) =>
      buildContextFromDb(db, { goalId, runId, stepRunId, payloadBudgetBytes: 64 * 1024 }),
    composePrompt: composeOrchestratorPrompt,
  });

  // Shared orchestrator service instance — receives sessionOutputStore so that
  // onWorkflowSessionCompleted can synthesize step output from session tails.
  const orchestratorService = new OrchestratorService(
    daemonContext.operatorSelector,
    daemonContext.orchestrationTransportBroker,
    daemonContext.operatorRegistry,
    daemonContext.workflowSessionLauncher,
    sessionOutputStore,
    daemonContext.stepDispatchCapabilities,
    orchestratorMediator,
    // workerSpawn: resolve workspace + adapter spawn, then start the tmux worker.
    async ({ sessionId, goalId, adapterId }) => {
      const wsRow = db.prepare("SELECT w.path AS path FROM workspaces w WHERE w.goal_id = ? ORDER BY w.created_at ASC LIMIT 1").get(goalId) as { path: string } | undefined;
      if (!wsRow) { console.warn(`[orchestrator] workerSpawn: no workspace for goal ${goalId}`); return; }
      const adapter = adapterRegistry.get(adapterId);
      if (!adapter) { console.warn(`[orchestrator] workerSpawn: no adapter ${adapterId}`); return; }
      const spawn = await adapter.resolveSpawn({ goalId, sessionId, workspacePath: wsRow.path });
      await workerSessions.spawn({ sessionId, workspacePath: wsRow.path, command: spawn.command, env: spawn.env });
    },
    // workerDeliver
    (sessionId, text) => workerSessions.deliver(sessionId, text),
    // workerTerminate
    (sessionId) => workerSessions.terminate(sessionId)
  );
  // Wire the late-binding ref so the onChunkAppended callback is live.
  _orchestratorServiceRef.current = orchestratorService;

  // Boot-time resume (production only — gated so createServer in tests is inert).
  // reconcileSessionsOnBoot has already marked stale running/starting sessions as
  // terminal before this point, so in practice every active run's session is dead
  // → respawn. reattach is a no-op because node-pty children cannot survive a
  // daemon restart; reconcile + respawn cover recovery.
  if (deps?.resumeActiveRunsOnBoot) {
    void resumeActiveRuns({
      listActiveRuns: async () => {
        const rows = db.prepare(`
          SELECT wr.id AS run_id, wr.goal_id, wr.current_step_run_id,
                 (SELECT s.id FROM sessions s WHERE s.workflow_step_run_id = wr.current_step_run_id AND s.status IN ('running','starting') ORDER BY s.created_at DESC LIMIT 1) AS session_id
          FROM workflow_runs wr
          WHERE wr.status = 'active'
        `).all() as Array<{ run_id: string; goal_id: string; current_step_run_id: string; session_id: string | null }>;
        return rows.map((r) => ({
          runId: r.run_id,
          goalId: r.goal_id,
          currentStepRunId: r.current_step_run_id,
          sessionId: r.session_id,
        }));
      },
      isSessionAlive: async (id) => {
        const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(id) as { status: string } | undefined;
        return row?.status === "running" || row?.status === "starting";
      },
      reattach: async () => {
        // node-pty cannot reattach across restart; reconcile already marked stale
        // sessions terminal. No-op.
      },
      respawn: async ({ runId, stepRunId, goalId }) => {
        await orchestratorService.respawnStepAgent(
          db,
          daemonContext.now ?? (() => new Date().toISOString()),
          runId,
          stepRunId,
          { bus: eventBus, idFactory: daemonContext.idFactory }
        );
      },
    }).catch((err) => console.error("[resume] boot resume failed", err));
  }

  // Tear down shadow sessions when a workflow run reaches a terminal state (best-effort).
  const TERMINAL_RUN_EVENTS = new Set<string>([
    "workflow.run.completed",
    "workflow.run.failed",
    "workflow.run.cancelled",
    "workflow.run.blocked",
  ]);
  eventBus.subscribe((event) => {
    if (TERMINAL_RUN_EVENTS.has(event.type) && event.goalId) {
      void shadowSessions.terminate(event.goalId).catch(() => {});
    }
  });

  // Subscribe to session terminal events → drive workflow step synthesis.
  eventBus.subscribe((event) => {
    if (
      event.type !== "session.exited" &&
      event.type !== "session.stopped" &&
      event.type !== "session.failed"
    )
      return;
    const sessionId =
      typeof event.payload.sessionId === "string" ? event.payload.sessionId : null;
    const goalId =
      typeof event.payload.goalId === "string" ? event.payload.goalId : null;
    if (!sessionId || !goalId) return;
    orchestratorService
      .onWorkflowSessionCompleted(
        db,
        daemonContext.now,
        { sessionId, goalId },
        { bus: eventBus, idFactory: daemonContext.idFactory }
      )
      .catch((err) => console.error("[workflow] onWorkflowSessionCompleted error", err));
  });

  // ---- Composite goal + workflow bootstrap ----

  registerGoalBootstrapRoute(server, {
    createGoalFn: (input) =>
      createGoal(input, {
        db: getDatabase(),
        bus: eventBus,
        skills: skillRegistry,
        modelProviderRegistry: daemonContext.modelProviderRegistry,
        inspectWorkspace,
      }),
    startWorkflowRunFn: (args) =>
      startWorkflowRun(
        { db: getDatabase(), bus: eventBus, now: daemonContext.now, idFactory: daemonContext.idFactory },
        args
      ),
    spawnOrchestratorSessionFn: async (goalId, _runId) => shadowSessions.spawn(goalId),
    startWorkflowFirstStepFn: async (_goalId, runId) =>
      orchestratorService.startWorkflowFirstStep(
        getDatabase(),
        daemonContext.now ?? (() => new Date().toISOString()),
        runId,
        { bus: eventBus, idFactory: daemonContext.idFactory }
      ),
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

    if (extractionRunner) {
      try {
        enqueueEligibleForGoal(
          { db, bus: eventBus, outputStore: sessionOutputStore, runner: extractionRunner },
          id
        );
      } catch {
        // Non-blocking: enqueue errors must not fail the read
      }
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

  server.patch(
    '/v1/goals/:goalId/orchestrator-model',
    async (
      request,
      reply
    ): Promise<UpdateGoalOrchestratorModelResponse | { error: string; issues?: unknown }> => {
      const { goalId } = request.params as { goalId: string };
      const parsed = UpdateGoalOrchestratorModelRequest.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'validation_failed', issues: parsed.error.issues };
      }

      try {
        return await updateGoalOrchestratorModel(
          goalId,
          parsed.data,
          daemonContext.modelProviderRegistry
        );
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
    }
  );

  server.post('/v1/goals/:id/archive', async (request, reply): Promise<ArchiveGoalResponse | { error: string }> => {
    const { id } = request.params as { id: string };
    try {
      const goal = archiveGoal(id);
      void shadowSessions.terminate(id).catch(() => {});
      return { goal };
    } catch (error) {
      if (error instanceof NotFoundError) {
        reply.status(404);
        return { error: 'not_found' };
      }
      throw error;
    }
  });

  // ---- Memory routes ----

  server.get(
    '/v1/goals/:goalId/memory',
    async (request): Promise<ListGoalMemoryResponse> => {
      const { goalId } = request.params as { goalId: string };
      const { includeArchived } = request.query as { includeArchived?: string };
      const items = listMemoryByGoal(db, goalId, {
        includeArchived: includeArchived === '1',
      });
      return { items };
    }
  );

  server.post(
    '/v1/goals/:goalId/memory',
    async (request, reply): Promise<{ item: GoalMemoryItem } | { error: unknown; issues?: unknown }> => {
      const { goalId } = request.params as { goalId: string };
      const parsed = CreateGoalMemoryRequest.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'validation_failed', issues: parsed.error.issues };
      }

      try {
        const item = createMemoryItem(
          { db, bus: eventBus },
          { goalId, ...parsed.data }
        );
        reply.status(201);
        return { item };
      } catch (error) {
        if (error instanceof MemoryGoalNotFoundError) {
          reply.status(404);
          return apiError(error.code, error.message);
        }
        if (error instanceof MemoryGoalArchivedError) {
          reply.status(409);
          return apiError(error.code, error.message);
        }
        if (error instanceof MemoryDuplicateError) {
          reply.status(409);
          return apiError(error.code, error.message);
        }
        throw error;
      }
    }
  );

  server.patch(
    '/v1/memory/:id',
    async (request, reply): Promise<{ item: GoalMemoryItem } | { error: unknown; issues?: unknown }> => {
      const { id } = request.params as { id: string };
      const parsed = PatchGoalMemoryRequest.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'validation_failed', issues: parsed.error.issues };
      }

      try {
        const item = patchMemoryItem({ db, bus: eventBus }, id, parsed.data);
        return { item };
      } catch (error) {
        if (error instanceof MemoryNotFoundError) {
          reply.status(404);
          return apiError(error.code, error.message);
        }
        if (error instanceof InvalidMemoryTransitionError) {
          reply.status(409);
          return apiError(error.code, error.message);
        }
        if (error instanceof MemoryDuplicateError) {
          reply.status(409);
          return apiError(error.code, error.message);
        }
        throw error;
      }
    }
  );

  // ---- Decision routes ----

  server.get(
    '/v1/goals/:goalId/decisions',
    async (request): Promise<ListGoalDecisionsResponse> => {
      const { goalId } = request.params as { goalId: string };
      const { includeArchived } = request.query as { includeArchived?: string };
      const items = listDecisionsByGoal(db, goalId, {
        includeArchived: includeArchived === '1',
      });
      return { items };
    }
  );

  server.post(
    '/v1/goals/:goalId/decisions',
    async (request, reply): Promise<{ item: GoalDecision } | { error: unknown; issues?: unknown }> => {
      const { goalId } = request.params as { goalId: string };
      const parsed = CreateGoalDecisionRequest.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'validation_failed', issues: parsed.error.issues };
      }

      try {
        const item = createDecision(
          { db, bus: eventBus },
          { goalId, ...parsed.data }
        );
        reply.status(201);
        return { item };
      } catch (error) {
        if (error instanceof DecisionGoalNotFoundError) {
          reply.status(404);
          return apiError(error.code, error.message);
        }
        if (error instanceof DecisionGoalArchivedError) {
          reply.status(409);
          return apiError(error.code, error.message);
        }
        throw error;
      }
    }
  );

  server.patch(
    '/v1/decisions/:id',
    async (request, reply): Promise<{ item: GoalDecision } | { error: unknown; issues?: unknown }> => {
      const { id } = request.params as { id: string };
      const parsed = PatchGoalDecisionRequest.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'validation_failed', issues: parsed.error.issues };
      }

      try {
        const item = patchDecision({ db, bus: eventBus }, id, parsed.data);
        return { item };
      } catch (error) {
        if (error instanceof DecisionNotFoundError) {
          reply.status(404);
          return apiError(error.code, error.message);
        }
        if (error instanceof InvalidDecisionTransitionError) {
          reply.status(409);
          return apiError(error.code, error.message);
        }
        throw error;
      }
    }
  );

  // ---- Context Package routes ----

  registerContextRoutes(server, { db, bus: eventBus, assembler, adapterRegistry });

  // ---- Adapter execution-mode routes ----

  {
    const supportedByAdapter: Record<string, import("@orca/contracts").ExecutionMode[]> = {};
    for (const adapter of adapterRegistry.listAgentAdapters()) {
      supportedByAdapter[adapter.id] = adapter.supportedExecutionModes;
    }
    registerAdapterExecutionModeRoutes(server, {
      db,
      now: daemonContext.now,
      supportedByAdapter,
      bus: eventBus,
    });
  }

  // ---- Workflow template routes ----

  registerWorkflowTemplateRoutes(server, {
    db,
    bus: eventBus,
    now: daemonContext.now,
    idFactory: daemonContext.idFactory,
  });

  // ---- Workflow run lifecycle routes ----

  registerWorkflowRunRoutes(server, {
    db,
    bus: eventBus,
    now: daemonContext.now,
    idFactory: daemonContext.idFactory,
  });

  // ---- Workflow artifact routes ----

  registerWorkflowArtifactRoutes(server, {
    db,
    now: daemonContext.now,
    idFactory: daemonContext.idFactory,
  });

  // ---- Workflow decision routes ----

  registerWorkflowDecisionRoutes(server, {
    db,
  });

  // ---- Workflow step routes ----

  registerWorkflowStepRoutes(server, {
    db,
    bus: eventBus,
    operatorSelector: daemonContext.operatorSelector,
    orchestrationTransportBroker: daemonContext.orchestrationTransportBroker,
    operatorRegistry: daemonContext.operatorRegistry,
    workflowSessionLauncher: daemonContext.workflowSessionLauncher,
    stepDispatch: daemonContext.stepDispatchCapabilities,
    sessionRuntime,
    now: daemonContext.now,
    idFactory: daemonContext.idFactory,
  });

  // ---- Agent hook routes ----

  registerAgentHookRoutes(server, {
    onResponseDone: async (payload) => {
      await orchestratorService.onAgentResponseDone(db, daemonContext.now, payload, {
        bus: eventBus,
        idFactory: daemonContext.idFactory,
      });
    },
    resolveAdapterForSession: (sid) =>
      (db.prepare("SELECT adapter_id FROM sessions WHERE id = ?").get(sid) as { adapter_id: string } | undefined)?.adapter_id ?? "claude-code",
  });

  // ---- Workflow orchestrator routes ----

  registerOrchestratorRoutes(server, {
    db,
    bus: eventBus,
    operatorSelector: daemonContext.operatorSelector,
    orchestrationTransportBroker: daemonContext.orchestrationTransportBroker,
    operatorRegistry: daemonContext.operatorRegistry,
    workflowSessionLauncher: daemonContext.workflowSessionLauncher,
    stepDispatch: daemonContext.stepDispatchCapabilities,
    now: daemonContext.now,
    idFactory: daemonContext.idFactory,
  });

  // ---- Goal-scoped orchestrator chat routes ----

  registerOrchestratorChatRoutes(server, {
    db,
    bus: eventBus,
    modelProviderRegistry: daemonContext.modelProviderRegistry,
    now: daemonContext.now,
    idFactory: daemonContext.idFactory,
    shadowAsk: async (goalId, input) => {
      await shadowSessions.spawn(goalId);
      return shadowSessions.ask(goalId, input);
    },
    resolveOrchestratorMode: (provider) => {
      const adapterId =
        provider === "orca/anthropic" ? "claude-code"
        : provider === "orca/openai" ? "codex"
        : provider === "orca/google-gemini" ? "gemini-cli"
        : "claude-code";
      try {
        return daemonContext.stepDispatchCapabilities.resolveMode(adapterId).mode === "shadow_session"
          ? "shadow_session" : "one_shot";
      } catch (err) {
        console.error("[orchestrator] resolveOrchestratorMode failed; defaulting to one_shot", err);
        return "one_shot";
      }
    },
    onOrchestratorReply: (goalId, body) => {
      postOrchestratorChatReply(db, eventBus, daemonContext, goalId, body);
    },
    onUserMessage: async (goalId, body) => {
      await orchestratorService.onUserMessage(
        getDatabase(),
        daemonContext.now ?? (() => new Date().toISOString()),
        { goalId, body },
        { bus: eventBus, idFactory: daemonContext.idFactory }
      );
    },
  });

  // ---- Orchestrator hook endpoint ----

  registerOrchestratorHookRoutes(server, {
    resolvePending: (goalId, result) => shadowSessions.resolvePending(goalId, result),
  });

  // ---- Orchestration transport routes ----

  registerOrchestrationTransportRoutes(server, {
    db,
    bus: eventBus,
    now: daemonContext.now,
    idFactory: daemonContext.idFactory,
    listOperators: async (goalId) => daemonContext.operatorRegistry.list(goalId),
  });

  // ---- Task orchestration routes ----

  registerTaskRoutes(server, {
    db,
    bus: eventBus,
    taskGenerator: daemonContext.taskGenerator,
    now: daemonContext.now,
    idFactory: daemonContext.idFactory,
  });

  // ---- Recommendation orchestration routes ----

  registerRecommendationRoutes(server, {
    db,
    bus: eventBus,
    recommendationProvider: daemonContext.recommendationProvider,
    now: daemonContext.now,
    idFactory: daemonContext.idFactory,
  });

  // ---- Conflict orchestration routes ----

  registerConflictRoutes(server, {
    db,
    bus: eventBus,
    now: daemonContext.now,
    idFactory: daemonContext.idFactory,
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
      if (error instanceof ContextPackageNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof GoalArchivedError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (error instanceof ContextPackageMismatchError) {
        reply.status(400);
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
      if (
        error instanceof TaskNotFoundError ||
        error instanceof RecommendationNotFoundError
      ) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (
        error instanceof InvalidRecommendationStateError ||
        error instanceof ArchivedTargetError
      ) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (error instanceof AssociationGoalMismatchError) {
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

  server.get('/v1/sessions/:sessionId/summary', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const summary = getLatestSummaryForSession(db, sessionId);
    if (!summary) {
      reply.status(404);
      return apiError('summary_not_found', `No summary found for session ${sessionId}`);
    }
    return { summary };
  });

  server.post('/v1/sessions/:sessionId/extract-memory', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    if (!extractionRunner) {
      reply.status(500);
      return apiError('runtime_misconfigured', 'Extraction runner is not configured');
    }

    try {
      const result = manualExtractEnqueue(
        {
          db,
          bus: eventBus,
          outputStore: sessionOutputStore,
          extractorVersion: DETERMINISTIC_EXTRACTOR_VERSION,
        },
        sessionId
      );
      if (result.created) {
        extractionRunner.notify();
        reply.status(201);
      } else {
        reply.status(200);
      }
      return { extraction: result.extraction };
    } catch (error) {
      if (error instanceof SessionNotFoundForExtractionError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof SessionNotTerminalError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (error instanceof SessionArchivedForExtractionError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (error instanceof GoalArchivedForExtractionError) {
        reply.status(409);
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
        {
          db,
          bus: eventBus,
          adapterRegistry,
          sessionOutputStore,
          sessionRuntime,
          dataDir: config.dataDir,
          onTerminalState: extractionRunner
            ? (sid) => tryEnqueueForTerminalSession(
                { db: getDatabase(), bus: eventBus, outputStore: sessionOutputStore, runner: extractionRunner },
                sid
              )
            : undefined,
        },
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

  server.post('/v1/sessions/:id/stop', async (request, reply): Promise<StopSessionResponse | { error: unknown; issues?: unknown }> => {
    const { id } = request.params as { id: string };
    const parsed = StopSessionRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }
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

  function sendSessionError(
    socket: WsClient,
    sessionId: string | undefined,
    code: 'unknown_session' | 'not_active' | 'invalid_message',
    message: string
  ): void {
    if (socket.readyState !== WS_CLIENT_OPEN) return;
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

        const wsClient = socket as unknown as WsClient;

        const unsubscribe = eventBus.subscribe((event) => {
          if (socket.readyState === WS_CLIENT_OPEN) {
            socket.send(JSON.stringify(event));
          }
        });

        socket.on('message', (rawData: Buffer) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawData.toString());
          } catch {
            sendSessionError(wsClient, undefined, 'invalid_message', 'malformed JSON');
            return;
          }

          if (typeof parsed !== 'object' || parsed === null) {
            sendSessionError(wsClient, undefined, 'invalid_message', 'expected JSON object');
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
              sendSessionError(wsClient, undefined, 'invalid_message', 'invalid session.subscribe frame');
              return;
            }
            const session = getSessionDetail(db, frame.data.sessionId);
            if (!session) {
              sendSessionError(wsClient, frame.data.sessionId, 'unknown_session', 'session not found');
              return;
            }
            sessionRuntime.subscribe(frame.data.sessionId, wsClient);
            return;
          }

          if (type === 'session.unsubscribe') {
            const frame = SessionUnsubscribeFrame.safeParse(parsed);
            if (!frame.success) {
              sendSessionError(wsClient, undefined, 'invalid_message', 'invalid session.unsubscribe frame');
              return;
            }
            sessionRuntime.unsubscribeSocket(frame.data.sessionId, wsClient);
            return;
          }

          if (type === 'session.input') {
            const frame = SessionInputFrame.safeParse(parsed);
            if (!frame.success) {
              sendSessionError(wsClient, undefined, 'invalid_message', 'invalid session.input frame');
              return;
            }
            if (!BASE64_RE.test(frame.data.dataBase64)) {
              sendSessionError(wsClient, frame.data.sessionId, 'invalid_message', 'invalid base64 in dataBase64');
              return;
            }
            const handle = sessionRuntime.getHandle(frame.data.sessionId);
            if (!handle) {
              const session = getSessionDetail(db, frame.data.sessionId);
              if (!session) {
                sendSessionError(wsClient, frame.data.sessionId, 'unknown_session', 'session not found');
              } else {
                sendSessionError(wsClient, frame.data.sessionId, 'not_active', 'session not running');
              }
              return;
            }
            handle.write(Buffer.from(frame.data.dataBase64, 'base64'));
            return;
          }

          if (type === 'session.resize') {
            const frame = SessionResizeFrame.safeParse(parsed);
            if (!frame.success) {
              sendSessionError(wsClient, undefined, 'invalid_message', 'invalid session.resize frame');
              return;
            }
            const resizeHandle = sessionRuntime.getHandle(frame.data.sessionId);
            if (!resizeHandle) {
              const session = getSessionDetail(db, frame.data.sessionId);
              if (!session) {
                sendSessionError(wsClient, frame.data.sessionId, 'unknown_session', 'session not found');
              } else {
                sendSessionError(wsClient, frame.data.sessionId, 'not_active', 'session not running');
              }
              return;
            }
            sessionRuntime.resize(db, frame.data.sessionId, frame.data.cols, frame.data.rows);
            return;
          }

          sendSessionError(wsClient, undefined, 'invalid_message', `unknown frame type: ${type}`);
        });

        socket.on('close', () => {
          unsubscribe();
          sessionRuntime.removeSocket(wsClient);
        });

        socket.on('error', () => {
          sessionRuntime.removeSocket(wsClient);
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

function postOrchestratorChatReply(
  db: ReturnType<typeof getDatabase>,
  bus: EventBus,
  ctx: DaemonContext,
  goalId: string,
  body: string
): void {
  try {
    insertMessageWithEvent(
      { db, bus, modelProviderRegistry: ctx.modelProviderRegistry, now: ctx.now, idFactory: ctx.idFactory },
      {
        id: ctx.idFactory(),
        goalId,
        role: "orchestrator",
        body,
        correlationId: ctx.idFactory(),
        createdAt: ctx.now(),
      }
    );
  } catch (err) {
    console.error("[orchestrator] postOrchestratorChatReply failed", err);
    // never rethrow: this runs in a fire-and-forget orchestrator-reply path
  }
}
