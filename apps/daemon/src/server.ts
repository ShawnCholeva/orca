import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import {
  AttachGoalDocumentRequest,
  type AttachGoalDocumentResponse,
  AttachWorkspaceRequest,
  type AttachWorkspaceResponse,
  type ListGoalDocumentsResponse,
  CreateGoalRequest,
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
  type ModelProviderId,
  CheckReadinessAllResponse,
  CheckReadinessOneResponse,
  type PendingQuestionItem,
  type PendingQuestionAnswer,
  SubmitWorkerAnswersRequest,
  CheckSystemReadinessResponse,
  SubmitPermissionDecisionRequest,
  UpdateWorkerPermissionModeRequest,
  UpdateOperatingModeRequest,
  PutSettingsRequest,
  ProviderRecoveryActionRequest,
  ProviderRecoverySwitchRequest,
  ProviderRecoveryCheckpoint,
  SubmitStepRevisionRequest,
  type ListWorkspacesResponse,
  type GetWorkspaceResponse,
  CreateWorkspaceRequest,
  type CreateWorkspaceResponse,
  UpdateWorkspaceRequest,
  type UpdateWorkspaceResponse
} from '@orca/contracts';
import type { Config } from './config.js';
import { getDatabase } from './db.js';
import {
  archiveGoal,
  createGoal,
  DuplicateDocumentInRequestError,
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
import {
  listWorkspacesByGoal,
  listWorkspaceSummaries,
  findWorkspaceById,
  listGoalViewsForWorkspace,
} from './workspaces/projection.js';
import {
  attachWorkspace,
  detachWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  DuplicateWorkspaceError,
  type WorkspaceCtx
} from './workspaces/usecases.js';
import { listGoalDocumentMetaByGoal } from './goal-documents/projection.js';
import {
  attachGoalDocument,
  detachGoalDocument,
  DuplicateDocumentError,
  DocumentSnapshotError,
  type GoalDocumentCtx
} from './goal-documents/usecases.js';
import { pluginRegistry } from './registry/plugin-registry.js';
import { skillRegistry } from './registry/skill-registry.js';
import { AgentNotFoundError, listAgents, setAgentConnected } from './agents.js';
import { adapterRegistry } from './adapters/registry.js';
import { noopSandbox } from './adapters/sandbox.js';
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
import { registerTaskRoutes } from './tasks/routes.js';
import { registerRecommendationRoutes } from './recommendations/routes.js';
import { registerConflictRoutes } from './conflicts/routes.js';
import { registerHarnessTransitionRoutes } from './harness-transitions/routes.js';
import { registerHarnessMetricsRoutes } from './harness-metrics/routes.js';
import { registerMetricsRoutes } from './metrics/routes.js';
import { registerLearningRoutes } from './learning/routes.js';
import { SessionCostAccumulator } from './harness-telemetry/accumulator.js';
import { parseOtlpTokens } from './harness-telemetry/otlp-receiver.js';

declare module 'fastify' {
  interface FastifyInstance {
    otlpAccumulator: SessionCostAccumulator;
  }
}
import { resolvePermissionDecision, resolveToolPolicyDenial } from './permission-gate.js';
import { classifyToolAction } from './harness-risk/classify.js';
import {
  actionClassOf,
  recordApprovalOutcome,
  recordRelaxationDecision,
  shouldSuggestRemember,
} from './harness-risk/accountability.js';
import { registerGoalBootstrapRoute } from './goals/bootstrap-route.js';
import { startWorkflowRun } from './workflows/runs/usecases.js';
import {
  OrchestratorService,
  OrchestratorProviderRecoveryNotFoundError,
  OrchestratorProviderRecoveryInvalidTransitionError,
} from './workflows/orchestrator/service.js';
import { DispatchEngine } from './workflows/orchestrator/dispatch-engine.js';
import { ProviderRecoveryController } from './workflows/orchestrator/provider-recovery-controller.js';
import type { RunnerPort } from './workflows/orchestrator/runner-port.js';
import {
  openOrUpdateLive as openOrUpdateLiveActivity,
  pauseForProviderRecovery as pauseForProviderRecoveryActivity,
} from './activities/store.js';
import { resumeActiveRuns } from './workflows/orchestrator/resume.js';
import {
  buildLivenessWatchdogDeps,
  livenessWatchdogTick,
  type ProgressMark,
} from './workflows/orchestrator/liveness-watchdog.js';
import { joinChildRun } from './workflows/composition/join.js';
import { realVersionProbe } from './harness-state/workspace-version.js';
import { registerWorkflowTemplateRoutes } from './workflows/templates/routes.js';
import { registerWorkflowRunRoutes } from './workflows/runs/routes.js';
import { registerWorkflowArtifactRoutes } from './workflows/artifacts/routes.js';
import { registerWorkflowDecisionRoutes } from './workflows/decisions/routes.js';
import { registerActivityRoutes } from './activities/routes.js';
import { categorizeClaudeTool, isLowSignalTool, narratePendingToolDetail, narrateToolDetail } from './activities/claude-adapter.js';
import { reconstructEditDiff } from './activities/diff.js';
import type { ActivitySignal } from './activities/signals.js';
import type { ActivityStoreCtx } from './activities/store.js';
import { recordOrchestratorReasoning } from './activities/store.js';
import { extractOrchestratorReasoning } from './orchestrator-llm/reasoning-extract.js';
import { ActivityUpdater } from './activities/updater.js';
import { reconcileStepResultActivities } from './activities/step-result-activity.js';
import { registerOrchestratorRoutes } from './workflows/orchestrator/routes.js';
import { registerOrchestratorChatRoutes } from './orchestrator-chat/routes.js';
import { registerGoalCommandRoutes } from './commands/routes.js';
import { deletePendingApprovalMessage, insertMessageWithEvent, recordWorkerQuestionAnswer, withdrawOrchestratorPromptsForStepRun } from './orchestrator-chat/usecases.js';
import { registerShadowHookRoutes } from './shadow-hooks/routes.js';
import { ShadowSessionManager, shadowSessionId, type ShadowAdapterId } from './orchestrator-llm/shadow-session.js';
import {
  SHADOW_LLM_TIMEOUT_MS,
  ShadowSessionLlmClient,
} from './orchestrator-llm/shadow-llm-client.js';
import {
  ModelProviderOrchestratorLlmClient,
  RoutedOrchestratorLlmClient,
  adapterIdForProvider,
} from './orchestrator-llm/model-provider-llm-client.js';
import { OrchestratorMediator } from './orchestrator-llm/mediator.js';
import { composeOrchestratorPrompt } from './orchestrator-llm/prompts.js';
import { buildContextFromDb } from './orchestrator-llm/build-context.js';
import { registerWorkflowStepRoutes } from './workflows/steps/routes.js';
import { registerAgentHookRoutes } from './agent-hooks/routes.js';
import { WorkerSessionManager } from './workflows/orchestrator/worker-session.js';
import { defaultTmuxRunner } from './tmux/runner.js';
import { reapOrphanTmuxSessions, workerSessionIdsForRun } from './sessions/reap-orphan-sessions.js';
import { resolveAgentProvider } from './orchestrator-llm/providers/registry.js';
import { WorkerQuestionStore } from './workflows/orchestrator/worker-questions.js';
import { PermissionApprovalStore } from './workflows/orchestrator/permission-approvals.js';
import { validateAnswers, assembleAnswerReason, assembleFreeTextReason } from './workflows/orchestrator/worker-answer-format.js';

// Returned to the worker (as the AskUserQuestion deny reason) the instant it
// asks. The question is posted to chat and the step parks durably; the worker
// must stop here and wait to be re-prompted rather than block or guess.
const WORKER_QUESTION_PARKED_REASON =
  "Your question has been delivered to the user in Orca chat and is awaiting their answer. " +
  "Do not call AskUserQuestion again and do not guess. Stop now and end your turn — you will be " +
  "automatically re-prompted with the user's answer when they respond.";
import { registerOrchestrationTransportRoutes } from './workflows/orchestration-transport/routes.js';
import {
  buildOrchestrationProviderCatalog,
  modelOverridesForConnectedAgents,
  providerIdsForConnectedAgents,
  toModelProvidersResponse,
} from './workflows/orchestration-transport/provider-catalog.js';
import { loadRunTemplate } from './workflows/runs/run-template.js';
import { NotConnectedError, UnknownAgentError } from './readiness/service.js';
import { checkTmuxReadiness } from './readiness/system.js';
import { getSupervisionMode, setSupervisionMode } from './settings/store.js';

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

function isShadowAdapterId(adapterId: string): adapterId is ShadowAdapterId {
  return adapterId === "claude-code" || adapterId === "codex" || adapterId === "antigravity";
}

// Tauri webview origins, plus any loopback origin on any port so browser mode
// (`pnpm dev:browser`, see CLAUDE.md) works regardless of which dev port Vite
// picks. Loopback-only: requests can only originate from this machine.
const CORS_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^http:\/\/\[::1\](:\d+)?$/
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
    // Override the idle-gated worker stdin delivery (defaults to the real tmux
    // WorkerSessionManager.deliver). Tests inject a deterministic stub.
    workerDeliver?: (sessionId: string, text: string) => Promise<"delivered" | "no_session" | "timeout">;
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
    });
  const unsubscribeFromSessionOutput = sessionOutputStore.onChunkAppended?.((sessionId) => {
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
  });
  const sessionRuntime =
    deps?.sessionRuntime ??
    new SessionRuntime(new NodePtyManager(), config.sessionStopGraceMs, config.sessionWsBufferLimitBytes);
  const extractionRunner = deps?.extractionRunner;
  const assembler = deps?.assembler ?? daemonContext.contextAssembler;

  // Single shared per-session token accumulator fed by the OTLP ingest routes
  // below. Decorated onto the server so Task 7 (transition attach) can drain it.
  const otlpAccumulator = new SessionCostAccumulator();

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
  server.addHook('onClose', async () => {
    unsubscribeFromSessionOutput?.();
  });

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
    service: 'orca-daemon',
    pid: process.pid,
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
    const agents = listAgents(db);
    const allowedProviderIds =
      agents.length > 0 ? providerIdsForConnectedAgents(agents) : undefined;
    const modelOverrides =
      agents.length > 0 ? modelOverridesForConnectedAgents(agents) : undefined;
    const catalog = await buildOrchestrationProviderCatalog(
      daemonContext.modelProviderRegistry,
      { allowedProviderIds, modelOverrides }
    );
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

  // Host-level dependency probe (tmux). Gates onboarding the same way a missing
  // agent CLI does, but applies to Orca itself rather than a connected agent.
  server.post('/v1/system/readiness:check', async () => {
    const report = await checkTmuxReadiness();
    return CheckSystemReadinessResponse.parse({ report });
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
      if (error instanceof DuplicateWorkspaceInRequestError || error instanceof DuplicateDocumentInRequestError) {
        reply.status(400);
        return apiError(error.code, error.message);
      }
      if (error instanceof WorkspaceInspectionError) {
        reply.status(inspectionStatus(error));
        return apiError(error.code, error.message);
      }
      if (error instanceof DocumentSnapshotError) {
        reply.status(error.code === 'url_fetch_timeout' ? 504 : 400);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  // Resolve the active workflow run's current step run for a goal.
  // Used by the orchestrator-reasoning tap to attach the activity to the right step.
  function resolveStepContextFromGoal(
    dbConn: typeof db,
    goalId: string
  ): { workflowRunId: string; stepRunId: string } | null {
    const row = dbConn
      .prepare(
        `SELECT wr.id AS workflow_run_id, wr.current_step_run_id AS step_run_id
         FROM goals g
         JOIN workflow_runs wr ON wr.id = g.active_workflow_run_id AND wr.goal_id = g.id
         WHERE g.id = ? AND wr.status = 'active' AND wr.current_step_run_id IS NOT NULL`
      )
      .get(goalId) as { workflow_run_id: string; step_run_id: string } | undefined;
    if (!row) return null;
    return { workflowRunId: row.workflow_run_id, stepRunId: row.step_run_id };
  }

  // Shadow session manager for the orchestrator-LLM (tmux-backed).
  const shadowSessions = new ShadowSessionManager({
    shadowRoot: path.join(config.dataDir, "shadow"),
    authToken: config.getAuthToken(),
    hookResolverCommand: config.hookResolverCommand,
    isReady: async (adapterId = "claude-code") => {
      const adapter = adapterRegistry.get(adapterId);
      if (!adapter) return false;
      const step = await adapter.checkAuth();
      return step.ok;
    },
    claudeBin: process.env["ORCA_CLAUDE_CODE_BIN"] ?? "claude",
    codexBin: process.env["ORCA_CODEX_BIN"] ?? "codex",
    antigravityBin: process.env["ORCA_ANTIGRAVITY_BIN"] ?? "agy",
    // PROVISIONAL: in-process tap that persists each orchestrator LLM turn as an
    // auditable activity. Moves to the Runner Protocol at the plane split.
    onOrchestratorTurn: (goalId, fullText) => {
      try {
        const ctx = resolveStepContextFromGoal(db, goalId);
        if (!ctx) return;
        const reasoning = extractOrchestratorReasoning(fullText);
        recordOrchestratorReasoning(
          { db, bus: eventBus },
          { goalId, workflowRunId: ctx.workflowRunId, stepRunId: ctx.stepRunId, text: reasoning }
        );
      } catch { /* auditable-trajectory capture must never break orchestration */ }
    },
  });

  // Worker session manager for orchestrator-dispatched agent sessions (tmux-backed).
  const workerSessions = new WorkerSessionManager({
    privateRoot: path.join(config.dataDir, "workers"),
    authToken: config.getAuthToken(),
    // Loopback OTLP receiver base; threaded into each worker so Claude/Codex emit
    // token/cost telemetry to the daemon's /v1/otlp routes (Inspectable Task 6).
    otlpBaseUrl: `http://127.0.0.1:${config.port}/v1/otlp`,
    hookResolverCommand: config.hookResolverCommand,
    claudeBin: process.env["ORCA_CLAUDE_CODE_BIN"] ?? "claude",
    resolveProvider: (adapterId) => resolveAgentProvider(adapterId as ShadowAdapterId),
    captureSink: (sessionId, chunk) => sessionOutputStore.appendChunk(sessionId, chunk),
    markRunning: (sessionId) => {
      db.prepare(
        "UPDATE sessions SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?"
      ).run(new Date().toISOString(), sessionId);
    },
    // The manager reaps deliberately-terminated workers, so it reports the
    // terminal status too — only flipping rows that are still live, so a
    // failure path that already stamped 'failed'/'stopped' is not overwritten.
    markExited: (sessionId) => {
      db.prepare(
        "UPDATE sessions SET status = 'exited', exited_at = COALESCE(exited_at, ?) WHERE id = ? AND status IN ('created','starting','running')"
      ).run(new Date().toISOString(), sessionId);
    },
  });
  const workerQuestions = new WorkerQuestionStore(daemonContext.idFactory);
  const permissionApprovals = new PermissionApprovalStore(daemonContext.idFactory);
  const PERMISSION_DECISION_TIMEOUT_MS = 1_790_000; // ~under the 1800s PermissionRequest hook timeout; then deny
  const activityUpdater = new ActivityUpdater();
  const activityCtx: ActivityStoreCtx = {
    db,
    bus: eventBus,
    now: daemonContext.now,
    idFactory: daemonContext.idFactory,
  };
  try {
    reconcileStepResultActivities(activityCtx);
  } catch (error) {
    console.error("[activity] step result reconciliation failed", { error });
  }
  const applyActivitySafely = (
    source: string,
    signal: ActivitySignal
  ): void => {
    try {
      activityUpdater.apply(activityCtx, signal);
    } catch (error) {
      console.error("[activity] narration update failed", {
        source,
        kind: signal.kind,
        stepRunId: signal.stepRunId,
        error,
      });
    }
  };
  const resolveStepContext = (
    sessionId: string
  ): {
    goalId: string;
    workflowRunId: string;
    stepRunId: string;
    agentSessionId: string;
  } | null => {
    const row = db
      .prepare(
        `SELECT s.id AS agent_session_id, s.goal_id, s.workflow_step_run_id AS step_run_id,
                wsr.workflow_run_id
         FROM sessions s
         JOIN workflow_step_runs wsr
           ON wsr.id = s.workflow_step_run_id
          AND wsr.goal_id = s.goal_id
         JOIN workflow_runs wr
           ON wr.id = wsr.workflow_run_id
          AND wr.goal_id = s.goal_id
         WHERE s.id = ?
           AND s.status IN ('starting', 'running')
           AND wsr.status = 'active'
           AND wr.status = 'active'
           AND wr.current_step_run_id = wsr.id
           AND s.id = (
             SELECT latest.id
             FROM sessions latest
             WHERE latest.workflow_step_run_id = wsr.id
               AND latest.goal_id = wsr.goal_id
               AND latest.status IN ('starting', 'running')
             ORDER BY latest.created_at DESC, latest.id DESC
             LIMIT 1
           )`
      )
      .get(sessionId) as
      | {
          agent_session_id: string;
          goal_id: string;
          step_run_id: string;
          workflow_run_id: string;
        }
      | undefined;
    if (!row) return null;
    return {
      goalId: row.goal_id,
      workflowRunId: row.workflow_run_id,
      stepRunId: row.step_run_id,
      agentSessionId: row.agent_session_id,
    };
  };

  const shadowClient = new ShadowSessionLlmClient(shadowSessions, {
    timeoutMs: SHADOW_LLM_TIMEOUT_MS,
  });
  const providerClient = new ModelProviderOrchestratorLlmClient(daemonContext.modelProviderRegistry);
  const routedOrchestratorClient = new RoutedOrchestratorLlmClient(shadowClient, providerClient);
  const orchestratorMediator = new OrchestratorMediator({
    llm: routedOrchestratorClient,
    buildContext: ({ goalId, runId, stepRunId }) =>
      buildContextFromDb(db, { goalId, runId, stepRunId, payloadBudgetBytes: 64 * 1024 }),
    composePrompt: composeOrchestratorPrompt,
  });

  const workerSpawnFn = async ({ sessionId, goalId, adapterId }: { sessionId: string; goalId: string; adapterId: string }) => {
    const wsRow = db.prepare("SELECT w.path AS path FROM workspaces w JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ? ORDER BY gw.attached_at ASC LIMIT 1").get(goalId) as { path: string } | undefined;
    if (!wsRow) { console.warn(`[orchestrator] workerSpawn: no workspace for goal ${goalId}`); return; }
    const adapter = adapterRegistry.get(adapterId);
    if (!adapter) { console.warn(`[orchestrator] workerSpawn: no adapter ${adapterId}`); return; }
    const spawn = await adapter.resolveSpawn({ goalId, sessionId, workspacePath: wsRow.path });
    // Containment seam (identity today): see adapters/sandbox.ts.
    const sandboxed = noopSandbox.wrap(spawn);
    await workerSessions.spawn({ sessionId, goalId, adapterId, workspacePath: wsRow.path, command: sandboxed.command, env: sandboxed.env });
  };
  const workerDeliverFn = deps?.workerDeliver ?? ((sessionId: string, text: string) => workerSessions.deliver(sessionId, text));
  const workerWaitFn = (sessionId: string, adapterId: string) => workerSessions.waitForProviderReset(sessionId, adapterId);

  const dispatchEngine = new DispatchEngine(
    daemonContext.orchestrationTransportBroker,
    daemonContext.operatorRegistry,
    daemonContext.workflowSessionLauncher,
    daemonContext.stepDispatchCapabilities,
    workerSpawnFn,
    workerDeliverFn,
    otlpAccumulator,
    shadowSessions
  );

  // Shared orchestrator service instance — receives sessionOutputStore so that
  // onWorkflowSessionCompleted can synthesize step output from session tails.
  const orchestratorService = new OrchestratorService(
    dispatchEngine,
    daemonContext.orchestrationTransportBroker,
    daemonContext.operatorRegistry,
    sessionOutputStore,
    daemonContext.stepDispatchCapabilities,
    orchestratorMediator,
    workerDeliverFn,
    // workerTerminate
    (sessionId) => workerSessions.terminate(sessionId),
    shadowSessions,
    // recoveryPromptComposer: keep the constructor default.
    undefined,
    // workerInterrupt: sends Escape to the worker so the user can course-correct.
    (sessionId) => workerSessions.interrupt(sessionId),
    // otlpAccumulator: drains accrued worker tokens at step_complete for the cost facet.
    otlpAccumulator
  );
  // Wire the late-binding ref so the onChunkAppended callback is live.
  _orchestratorServiceRef.current = orchestratorService;

  const runnerPort: RunnerPort = {
    launch: daemonContext.workflowSessionLauncher.launch.bind(daemonContext.workflowSessionLauncher),
    workerSpawn: workerSpawnFn,
    workerDeliver: workerDeliverFn,
    workerWait: workerWaitFn,
    readTail: sessionOutputStore.readTail.bind(sessionOutputStore),
  };
  const recoveryController = new ProviderRecoveryController({
    runner: runnerPort,
    operators: daemonContext.operatorRegistry,
    stepDispatch: daemonContext.stepDispatchCapabilities,
  });

  // Boot-time resume (production only — gated so createServer in tests is inert).
  // reconcileSessionsOnBoot skips workflow-step sessions (tmux workers may survive
  // the restart), so those sessions still have status 'running' in DB. Here we
  // try to reattach surviving tmux workers; if the tmux session is gone we respawn.
  if (deps?.resumeActiveRunsOnBoot) {
    void resumeActiveRuns({
      listActiveRuns: async () => {
        const rows = db.prepare(`
          SELECT wr.id AS run_id, wr.goal_id, wr.current_step_run_id,
                 (SELECT s.id FROM sessions s WHERE s.workflow_step_run_id = wr.current_step_run_id AND s.status IN ('running','starting') ORDER BY s.created_at DESC LIMIT 1) AS session_id,
                 (SELECT ws.pending_provider_recovery_json IS NOT NULL FROM workflow_step_runs ws WHERE ws.id = wr.current_step_run_id) AS provider_recovery_pending
          FROM workflow_runs wr
          WHERE wr.status = 'active'
        `).all() as Array<{ run_id: string; goal_id: string; current_step_run_id: string; session_id: string | null; provider_recovery_pending: number | null }>;
        return rows.map((r) => ({
          runId: r.run_id,
          goalId: r.goal_id,
          currentStepRunId: r.current_step_run_id,
          sessionId: r.session_id,
          providerRecoveryPending: r.provider_recovery_pending === 1,
        }));
      },
      isSessionAlive: async (id) => {
        // Worker sessions are tmux-backed: a DB row marked 'running' is not proof
        // of liveness (the tmux session can die independently). Check the actual
        // tmux session so a dead worker falls through to reattach→respawn.
        return workerSessions.isTmuxAlive(id);
      },
      reattach: async ({ sessionId }) => {
        // Try to reattach a surviving tmux worker. If the tmux session is gone,
        // reattach returns false and we fall through; the run will be picked up
        // by a subsequent reconcile cycle or left for respawn on the next boot.
        // For now, a failed reattach is best-effort — the worker may have exited
        // and its StopFailure hook will drive synthesis normally.
        const wsRow = db.prepare(
          "SELECT w.path AS path FROM workspaces w JOIN goal_workspaces gw ON gw.workspace_id = w.id JOIN sessions s ON s.goal_id = gw.goal_id WHERE s.id = ? ORDER BY gw.attached_at ASC LIMIT 1"
        ).get(sessionId) as { path: string } | undefined;
        if (wsRow) {
          await workerSessions.reattach(sessionId, wsRow.path);
        }
      },
      respawn: async ({ runId, stepRunId, goalId }) => {
        // Prefer reattaching a surviving tmux worker over respawning a fresh one.
        const sessionRow = db.prepare(
          "SELECT id FROM sessions WHERE workflow_step_run_id = ? ORDER BY created_at DESC LIMIT 1"
        ).get(stepRunId) as { id: string } | undefined;
        if (sessionRow) {
          const wsRow = db.prepare(
            "SELECT w.path AS path FROM workspaces w JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ? ORDER BY gw.attached_at ASC LIMIT 1"
          ).get(goalId) as { path: string } | undefined;
          if (wsRow && await workerSessions.reattach(sessionRow.id, wsRow.path)) return; // adopted; no respawn
        }
        await orchestratorService.respawnStepAgent(
          db,
          daemonContext.now ?? (() => new Date().toISOString()),
          runId,
          stepRunId,
          { bus: eventBus, idFactory: daemonContext.idFactory }
        );
      },
      markRecoverySessionMissing: async ({ stepRunId, sessionId }) => {
        // A run paused for provider recovery lost its native worker across the
        // restart. Never respawn (that discards the checkpoint). Flip the
        // checkpoint to a fresh-session restart and republish the recovery card
        // so the current-provider action restarts the step in a new session;
        // alternative switch choices are preserved unchanged.
        const stepRow = db
          .prepare("SELECT goal_id, workflow_run_id, pending_provider_recovery_json AS recovery FROM workflow_step_runs WHERE id = ?")
          .get(stepRunId) as { goal_id: string; workflow_run_id: string; recovery: string | null } | undefined;
        if (!stepRow?.recovery) return;
        let checkpoint: ProviderRecoveryCheckpoint;
        try {
          checkpoint = ProviderRecoveryCheckpoint.parse(JSON.parse(stepRow.recovery));
        } catch (err) {
          console.error("[resume] malformed recovery checkpoint for missing worker", stepRunId, err);
          return;
        }
        const next = ProviderRecoveryCheckpoint.parse({
          ...checkpoint,
          mode: "choose",
          retryKind: "fresh_session",
          lastError: null,
        });
        db.prepare(
          "UPDATE workflow_step_runs SET pending_provider_recovery_json = ? WHERE id = ?"
        ).run(JSON.stringify(next), stepRunId);

        const summary = `${checkpoint.currentProviderName} reached its session limit and its native session did not survive the restart. Retrying restarts this step in a fresh ${checkpoint.currentProviderName} session, or switch to another provider.`;
        openOrUpdateLiveActivity(
          { db, bus: eventBus },
          {
            goalId: stepRow.goal_id,
            workflowRunId: stepRow.workflow_run_id,
            stepRunId,
            agentSessionId: sessionId,
            sourceKind: "step_started",
            currentText: summary,
            workCategory: null,
          }
        );
        pauseForProviderRecoveryActivity({ db, bus: eventBus }, { stepRunId, summary });
      },
      listFailedChildCompositions: async () => {
        const rows = db.prepare(`
          SELECT wrc.child_run_id
          FROM workflow_run_compositions wrc
          JOIN workflow_runs child ON child.id = wrc.child_run_id
          WHERE wrc.status = 'active'
            AND child.status = 'failed'
        `).all() as Array<{ child_run_id: string }>;
        return rows.map((r) => ({ childRunId: r.child_run_id }));
      },
      propagateChildFailure: async (childRunId: string) => {
        await joinChildRun(
          {
            db,
            bus: eventBus,
            now: daemonContext.now ?? (() => new Date().toISOString()),
            idFactory: daemonContext.idFactory,
          },
          childRunId,
          realVersionProbe
        );
      },
    })
      // After reattach has adopted the workers of still-active runs, reap any
      // orca-worker/orca-shadow tmux sessions orphaned by a prior daemon
      // generation (tmux outlives the daemon; nothing else reaps them). Ordered
      // AFTER resume so a wanted worker is never killed out from under a reattach.
      .then(() => reapOrphanTmuxSessions(defaultTmuxRunner(), db))
      .then((reaped) => {
        if (reaped.length > 0) {
          console.log(`[reap] killed ${reaped.length} orphaned tmux session(s): ${reaped.join(", ")}`);
        }
      })
      .catch((err) => console.error("[resume] boot resume failed", err));
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
      void shadowSessions.terminate(`${event.goalId}::refute`).catch(() => {});
      // Also tear down the run's worker sessions. A completed run already killed
      // them via the step-completion path (this is then a no-op), but a run that
      // goes terminal WITHOUT completing (cancel/fail/block mid-step) would
      // otherwise leak its live worker tmux session.
      const runId = typeof event.payload.workflowRunId === "string" ? event.payload.workflowRunId : null;
      if (runId) {
        for (const sessionId of workerSessionIdsForRun(db, runId)) {
          void workerSessions.terminate(sessionId).catch(() => {});
        }
      }
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

  // Liveness watchdog: a tmux worker can die mid-turn (crash/kill/tmux death)
  // without firing its Stop hook, so no session terminal event is emitted and the
  // run stalls forever on its step node behind a spinner. This periodic tick reaps
  // such dead workers — emitting the same session.failed signal the boot path uses,
  // which the subscriber above routes into onWorkflowSessionCompleted → crash-retry
  // (respawn under cap, escalate to a human at cap). Production-gated (same as boot
  // resume) so createServer stays inert in tests. A grace window protects a
  // just-spawned worker whose tmux session does not exist yet.
  if (deps?.resumeActiveRunsOnBoot) {
    const watchdogMs = Number(process.env["ORCA_LIVENESS_WATCHDOG_MS"] ?? 5000);
    const watchdogGraceMs = Number(process.env["ORCA_LIVENESS_GRACE_MS"] ?? 15000);
    const stallMs = Number(process.env["ORCA_STALL_MS"] ?? 600000);
    const watchdogProgress = new Map<string, ProgressMark>();
    const watchdogDeps = buildLivenessWatchdogDeps(db, eventBus, {
      isTmuxAlive: (sessionId) => workerSessions.isTmuxAlive(sessionId),
      now: daemonContext.now ?? (() => new Date().toISOString()),
      graceMs: watchdogGraceMs,
      stallMs,
      progress: watchdogProgress,
    });
    const watchdogTimer = setInterval(() => {
      void livenessWatchdogTick(watchdogDeps).catch((err) =>
        console.error("[liveness-watchdog] tick error", err)
      );
    }, watchdogMs);
    watchdogTimer.unref?.();
    server.addHook("onClose", async () => {
      clearInterval(watchdogTimer);
    });
  }

  const unsubscribeActivityEvents = eventBus.subscribe((event) => {
    if (event.type !== "workflow.step.started") return;
    const eventGoalId =
      typeof event.goalId === "string" && event.goalId.length > 0
        ? event.goalId
        : null;
    const stepRunId =
      typeof event.payload.stepRunId === "string" ? event.payload.stepRunId : null;
    const goalId =
      typeof event.payload.goalId === "string" ? event.payload.goalId : null;
    const workflowRunId =
      typeof event.payload.workflowRunId === "string"
        ? event.payload.workflowRunId
        : null;
    const stepTemplateId =
      typeof event.payload.stepTemplateId === "string"
        ? event.payload.stepTemplateId
        : null;
    const ordinal =
      typeof event.payload.ordinal === "number" &&
      Number.isInteger(event.payload.ordinal) &&
      event.payload.ordinal >= 0
        ? event.payload.ordinal
        : null;
    if (
      !eventGoalId ||
      !stepRunId ||
      !goalId ||
      !workflowRunId ||
      !stepTemplateId ||
      ordinal === null ||
      eventGoalId !== goalId
    ) {
      return;
    }

    const row = db
      .prepare(
        `SELECT wsr.goal_id, wsr.workflow_run_id, wsr.step_template_id, wsr.ordinal,
                wr.template_id
         FROM workflow_step_runs wsr
         JOIN workflow_runs wr
           ON wr.id = wsr.workflow_run_id
          AND wr.goal_id = wsr.goal_id
         WHERE wsr.id = ?
           AND wsr.status = 'active'
           AND wr.status = 'active'
           AND wr.current_step_run_id = wsr.id`
      )
      .get(stepRunId) as
      | {
          goal_id: string;
          workflow_run_id: string;
          step_template_id: string;
          ordinal: number;
          template_id: string;
        }
      | undefined;
    if (
      !row ||
      row.goal_id !== goalId ||
      row.goal_id !== eventGoalId ||
      row.workflow_run_id !== workflowRunId ||
      row.step_template_id !== stepTemplateId ||
      row.ordinal !== ordinal
    ) {
      return;
    }

    const template = loadRunTemplate(db, { id: row.workflow_run_id, templateId: row.template_id });
    const step = template?.steps.find(
      (candidate) => candidate.id === row.step_template_id
    );
    if (!step) return;

    applyActivitySafely("workflow.step.started", {
      kind: "step_started",
      goalId: row.goal_id,
      workflowRunId: row.workflow_run_id,
      stepRunId,
      // The step activity row now opens lazily on the first tool_use (which
      // carries its own session id), so step_started attributes no session.
      agentSessionId: null,
      stepName: step.name,
    });
  });
  server.addHook("onClose", async () => {
    unsubscribeActivityEvents();
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
    spawnOrchestratorSessionFn: async (goalId, _runId) => {
      const goal = getGoalById(getDatabase(), goalId);
      if (!goal?.orchestratorProvider) return shadowSessionId(goalId);
      const adapterId = adapterIdForProvider(goal.orchestratorProvider);
      if (daemonContext.stepDispatchCapabilities.resolveMode(adapterId).mode !== "shadow_session") {
        return shadowSessionId(goalId);
      }
      if (!isShadowAdapterId(adapterId)) {
        throw new Error(`unsupported shadow adapter: ${adapterId}`);
      }
      return shadowSessions.spawn(goalId, adapterId);
    },
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
    const documents = listGoalDocumentMetaByGoal(db, id);
    return { goal, refinement, workspaces, documents };
  });

  const workspaceCtx: WorkspaceCtx = { db: getDatabase(), bus: eventBus, inspectWorkspace };

  server.post('/v1/goals/:id/workspaces', async (request, reply): Promise<AttachWorkspaceResponse | { error: unknown }> => {
    const { id: goalId } = request.params as { id: string };
    const parsed = AttachWorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues } as { error: unknown };
    }

    try {
      const workspace = await attachWorkspace(
        workspaceCtx,
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
        workspaceCtx,
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

  const documentCtx: GoalDocumentCtx = { db: getDatabase(), bus: eventBus };

  server.get('/v1/goals/:id/documents', async (request, reply): Promise<ListGoalDocumentsResponse | { error: unknown }> => {
    const { id: goalId } = request.params as { id: string };
    const db = getDatabase();
    if (!getGoalById(db, goalId)) {
      reply.status(404);
      return apiError('not_found', `Goal not found: ${goalId}`);
    }
    return { documents: listGoalDocumentMetaByGoal(db, goalId) };
  });

  server.post('/v1/goals/:id/documents', async (request, reply): Promise<AttachGoalDocumentResponse | { error: unknown }> => {
    const { id: goalId } = request.params as { id: string };
    const parsed = AttachGoalDocumentRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues } as { error: unknown };
    }

    try {
      const document = await attachGoalDocument(
        documentCtx,
        { goalId, kind: parsed.data.kind, ref: parsed.data.ref, name: parsed.data.name }
      );
      reply.status(201);
      return { document };
    } catch (error) {
      if (error instanceof NotFoundError) {
        reply.status(404);
        return apiError('not_found', `Goal not found: ${goalId}`);
      }
      if (error instanceof DuplicateDocumentError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (error instanceof DocumentSnapshotError) {
        reply.status(error.code === 'url_fetch_timeout' ? 504 : 400);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.delete('/v1/goals/:id/documents/:documentId', async (request, reply): Promise<void | { error: unknown }> => {
    const { id: goalId, documentId } = request.params as { id: string; documentId: string };

    try {
      await detachGoalDocument(documentCtx, { goalId, documentId });
      reply.code(204).send();
    } catch (error) {
      if (error instanceof NotFoundError) {
        reply.status(404);
        return apiError('not_found', `Document not found: ${documentId}`);
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

  server.get('/v1/workspaces', async (_request, reply): Promise<ListWorkspacesResponse> => {
    const workspaces = listWorkspaceSummaries(db);
    return reply.send({ workspaces } satisfies ListWorkspacesResponse);
  });

  server.get('/v1/workspaces/:id', async (request, reply): Promise<GetWorkspaceResponse | { error: unknown }> => {
    const { id } = request.params as { id: string };
    const workspace = findWorkspaceById(db, id);
    if (!workspace) {
      reply.status(404);
      return apiError('not_found', `Workspace not found: ${id}`);
    }
    const goals = listGoalViewsForWorkspace(db, id);
    return reply.send({ workspace, goals } satisfies GetWorkspaceResponse);
  });

  server.post('/v1/workspaces', async (request, reply): Promise<CreateWorkspaceResponse | { error: unknown }> => {
    const parsed = CreateWorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues } as { error: unknown };
    }
    try {
      const workspace = await createWorkspace(workspaceCtx, parsed.data);
      reply.status(201);
      return { workspace } satisfies CreateWorkspaceResponse;
    } catch (error) {
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

  server.patch('/v1/workspaces/:id', async (request, reply): Promise<UpdateWorkspaceResponse | { error: unknown }> => {
    const { id } = request.params as { id: string };
    const parsed = UpdateWorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues } as { error: unknown };
    }
    try {
      const workspace = await updateWorkspace(workspaceCtx, { id, ...parsed.data });
      return reply.send({ workspace } satisfies UpdateWorkspaceResponse);
    } catch (error) {
      if (error instanceof NotFoundError) {
        reply.status(404);
        return apiError('not_found', `Workspace not found: ${id}`);
      }
      throw error;
    }
  });

  server.delete('/v1/workspaces/:id', async (request, reply): Promise<void | { error: unknown }> => {
    const { id } = request.params as { id: string };
    try {
      await deleteWorkspace(workspaceCtx, { id });
      reply.code(204).send();
    } catch (error) {
      if (error instanceof NotFoundError) {
        reply.status(404);
        return apiError('not_found', `Workspace not found: ${id}`);
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
      void shadowSessions.terminate(`${id}::refute`).catch(() => {});
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

  // ---- Activity routes ----

  registerActivityRoutes(server, {
    db,
  });

  // ---- Workflow step routes ----

  registerWorkflowStepRoutes(server, {
    db,
    bus: eventBus,
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
      const stepContext = resolveStepContext(payload.sessionId);
      try {
        await orchestratorService.onAgentResponseDone(db, daemonContext.now, payload, {
          bus: eventBus,
          idFactory: daemonContext.idFactory,
        });
      } finally {
        if (stepContext) {
          // The activity card carries no worker-authored summary: the worker's
          // raw narration would leak first-person voice and internal mechanics.
          // The clean per-turn narration is the orchestrator's sanitized
          // paraphrase (its own chat bubble); the card stays a tool-step
          // checklist (empty-summary turns are filtered out client-side).
          applyActivitySafely("agent.response_done", {
            kind: "turn_completed",
            stepRunId: stepContext.stepRunId,
            summary: "",
            confidence: null,
          });
        }
      }
    },
    resolveAdapterForSession: (sid) =>
      (db.prepare("SELECT adapter_id FROM sessions WHERE id = ?").get(sid) as { adapter_id: string } | undefined)?.adapter_id ?? "claude-code",
    onToolUse: async (sessionId, payload) => {
      const stepContext = resolveStepContext(sessionId);
      if (!stepContext) return;
      // Curate the checklist: searches and read-only look-around are low signal —
      // skip them so the persisted steps stay substantive (reads, edits, runs).
      if (isLowSignalTool(payload.toolName, payload.toolInput)) return;
      applyActivitySafely("agent.tool_use", {
        kind: "tool_use",
        ...stepContext,
        category: categorizeClaudeTool(payload.toolName, payload.toolInput),
        detail: narrateToolDetail(payload.toolName, payload.toolInput),
        diff: reconstructEditDiff(payload.toolName, payload.toolInput),
        // Dedupes at-least-once spool redeliveries (empty when the id is absent).
        toolUseId: payload.toolUseId || null,
      });
    },
    onToolGate: async (sessionId, payload) =>
      resolveToolPolicyDenial(
        { db, bus: eventBus, now: daemonContext.now, idFactory: daemonContext.idFactory },
        sessionId,
        payload
      ),
    onPermissionRequest: async (sessionId, payload) => {
      const decision = resolvePermissionDecision(
        { db, bus: eventBus, now: daemonContext.now, idFactory: daemonContext.idFactory },
        sessionId,
        payload
      );
      if (decision === "allow") return "allow";
      if (decision === "deny") return "deny";
      // require_approval → the existing record-and-wait flow (unchanged below):
      const sessionRow = db.prepare("SELECT goal_id FROM sessions WHERE id = ?").get(sessionId) as { goal_id: string } | undefined;
      if (!sessionRow) return "deny";
      const goalId = sessionRow.goal_id;
      const summary = summarizePermission(payload.toolName, payload.toolInput);
      // Present-tense one-liner (e.g. "Edit App.tsx", "Run tests") so the approval
      // card honestly describes the action being REQUESTED — not a past-tense
      // "Edited/Ran" that implies it already executed — and, for Bash, without
      // re-echoing the command the card already shows verbatim.
      const detail = narratePendingToolDetail(payload.toolName, payload.toolInput);
      const { approvalId, answered, isNew } = permissionApprovals.record({
        toolUseId: payload.toolUseId, sessionId, goalId,
        toolName: payload.toolName, summary, detail, toolInput: payload.toolInput,
      });
      if (isNew) {
        const adapterId = (db.prepare("SELECT adapter_id FROM sessions WHERE id = ?").get(sessionId) as { adapter_id: string } | undefined)?.adapter_id ?? "claude-code";
        const supportsPermissionPersistence = resolveAgentProvider(adapterId as ShadowAdapterId).supportsPermissionPersistence;
        const actionClass = actionClassOf(
          payload.toolName,
          classifyToolAction({ toolName: payload.toolName, toolInput: payload.toolInput })
        );
        const canRemember = supportsPermissionPersistence && shouldSuggestRemember(db, goalId, actionClass);
        insertMessageWithEvent(
          { db, bus: eventBus, idFactory: daemonContext.idFactory },
          {
            id: daemonContext.idFactory(),
            goalId,
            role: "orchestrator",
            body: `The agent wants to run ${payload.toolName}.`,
            correlationId: daemonContext.idFactory(),
            createdAt: daemonContext.now(),
            pendingApproval: { approvalId, sessionId, toolName: payload.toolName, summary, detail, canRemember },
          }
        );
      }
      const stepContext = resolveStepContext(sessionId);
      if (stepContext) {
        applyActivitySafely("agent.permission_pending", {
          kind: "permission_pending",
          ...stepContext,
          toolName: payload.toolName,
        });
      }
      let timerId: ReturnType<typeof setTimeout>;
      const timed = new Promise<"deny">((res) => { timerId = setTimeout(() => res("deny"), PERMISSION_DECISION_TIMEOUT_MS); });
      const result = await Promise.race([answered, timed]);
      clearTimeout(timerId!);
      const resolvedByTimeout = permissionApprovals.resolveDecision(approvalId, result); // false if answer route already resolved
      if (resolvedByTimeout) {
        // The decision timed out with no human answer. The answer route deletes the
        // card when it resolves; on timeout we must do it too, else the card lingers
        // and a later click 404s (approval_not_found). Best-effort.
        try {
          deletePendingApprovalMessage(
            { db, bus: eventBus, idFactory: daemonContext.idFactory },
            { goalId, approvalId }
          );
        } catch (err) {
          console.error("[permission] deletePendingApprovalMessage (timeout) failed", err);
        }
      }
      return result;
    },
    onWorkerQuestion: async (sessionId, payload) => {
      const goalRow = db.prepare("SELECT goal_id FROM sessions WHERE id = ?").get(sessionId) as { goal_id: string } | undefined;
      if (!goalRow) return "No goal is associated with this session; proceed using your best judgment.";
      const goalId = goalRow.goal_id;
      const { questionId, isNew } = workerQuestions.record({ toolUseId: payload.toolUseId });
      if (isNew) {
        // Resolve step context first so it's available for both the
        // pending_question payload and the supersede call below.
        const stepContext = resolveStepContext(sessionId);
        // Persist the worker question as a first-class chat message so it lives
        // in chat history and can render an answered state later.
        insertMessageWithEvent(
          { db, bus: eventBus, idFactory: daemonContext.idFactory },
          {
            id: daemonContext.idFactory(),
            goalId,
            role: "orchestrator",
            body: orcaVoiceQuestionText(payload.questions),
            correlationId: daemonContext.idFactory(),
            createdAt: daemonContext.now(),
            pendingQuestion: {
              questionId,
              toolUseId: payload.toolUseId,
              source: "worker",
              questions: payload.questions,
              ...(stepContext ? { stepRunId: stepContext.stepRunId } : {}),
            },
          },
        );
        // Park the step on the question: the worker ends its turn now and the
        // step waits (indefinitely) for the human. pending_worker_question_id
        // tells the worker's Stop-hook not to judge/advance while parked, and
        // survives a restart so the answer can still be delivered. Supersede any
        // redundant orchestrator question, then settle the current activity
        // thread (empty summary -> expireLive) so the agent's post-answer work
        // opens a fresh thread after the question bubble.
        if (stepContext) {
          db.prepare("UPDATE workflow_step_runs SET pending_worker_question_id = ? WHERE id = ?").run(
            questionId,
            stepContext.stepRunId
          );
          try {
            withdrawOrchestratorPromptsForStepRun(
              { db, bus: eventBus, idFactory: daemonContext.idFactory },
              { goalId, stepRunId: stepContext.stepRunId }
            );
          } catch (err) {
            console.error("[worker-question] withdrawOrchestratorPromptsForStepRun failed", {
              goalId, stepRunId: stepContext.stepRunId, err,
            });
          }
          applyActivitySafely("agent.question_pending", {
            kind: "turn_completed",
            stepRunId: stepContext.stepRunId,
            summary: "",
            confidence: null,
          });
        }
      }
      // Non-blocking: return immediately so the hook can't time out and bypass
      // the human. The worker parks; the answer is delivered out of band by the
      // /answer route once the user responds in chat.
      return WORKER_QUESTION_PARKED_REASON;
    },
  });

  // ---- Worker question answer route ----

  server.post("/v1/goals/:goalId/worker-questions/:questionId/answer", async (request, reply) => {
    const { goalId, questionId } = request.params as { goalId: string; questionId: string };
    const parsed = SubmitWorkerAnswersRequest.safeParse(request.body);
    if (!parsed.success) { reply.status(400); return { error: "validation_failed", issues: parsed.error.issues }; }
    // Read the durable question from its chat message (not an in-memory store),
    // so answering works after a daemon restart. Scoping by goal_id means a
    // question owned by one goal reads as "not found" through another goal's URL.
    const msgRow = db
      .prepare(
        `SELECT pending_question FROM orchestrator_messages
          WHERE goal_id = ? AND json_extract(pending_question, '$.questionId') = ? LIMIT 1`
      )
      .get(goalId, questionId) as { pending_question: string } | undefined;
    if (!msgRow) { reply.status(404); return { error: { code: "question_not_found" } }; }
    const pending = JSON.parse(msgRow.pending_question) as {
      questions: PendingQuestionItem[];
      stepRunId?: string;
      answer?: unknown;
    };
    // Already answered — durable idempotency guard (survives restart).
    if (pending.answer != null) { reply.status(409); return { error: { code: "already_answered" } }; }

    let reason: string;
    let answer: PendingQuestionAnswer;
    if (parsed.data.freeText != null) {
      reason = assembleFreeTextReason(parsed.data.freeText);
      answer = parsed.data.fromChat ? { viaChat: true } : { freeText: parsed.data.freeText };
    } else {
      const invalid = validateAnswers(pending.questions, parsed.data.answers!);
      if (invalid) { reply.status(400); return { error: { code: invalid } }; }
      reason = assembleAnswerReason(pending.questions, parsed.data.answers!);
      answer = { answers: parsed.data.answers! };
    }

    // Composer answers post the user's text as a chat message; card answers
    // (options or inline "Something else") render inline on the question bubble
    // and add no separate user message.
    if (parsed.data.freeText != null && parsed.data.fromChat) {
      insertMessageWithEvent(
        { db, bus: eventBus, idFactory: daemonContext.idFactory },
        {
          id: daemonContext.idFactory(),
          goalId,
          role: "user",
          body: parsed.data.freeText,
          correlationId: daemonContext.idFactory(),
          createdAt: daemonContext.now(),
        },
      );
    }

    // Record the answer on the question bubble (also the persisted "answered"
    // state the guard above reads), then deliver it to the parked worker out of
    // band so the step resumes.
    recordWorkerQuestionAnswer(
      { db, bus: eventBus, idFactory: daemonContext.idFactory },
      { goalId, questionId, answer },
    );
    orchestratorService.deliverWorkerAnswer(
      db,
      daemonContext.now,
      { goalId, stepRunId: pending.stepRunId ?? null, reason },
      { bus: eventBus, idFactory: daemonContext.idFactory }
    );

    return { ok: true };
  });

  // ---- Permission approval answer route ----

  server.post("/v1/goals/:goalId/permission-approvals/:approvalId", async (request, reply) => {
    const { goalId, approvalId } = request.params as { goalId: string; approvalId: string };
    const parsed = SubmitPermissionDecisionRequest.safeParse(request.body);
    if (!parsed.success) { reply.status(400); return { error: "validation_failed", issues: parsed.error.issues }; }
    const pending = permissionApprovals.get(approvalId);
    if (!pending || pending.goalId !== goalId) {
      // The approval is gone (resolved/expired) but the client may still be showing
      // its card — clean it up so the phantom card disappears on this interaction.
      try {
        deletePendingApprovalMessage(
          { db, bus: eventBus, idFactory: daemonContext.idFactory },
          { goalId, approvalId }
        );
      } catch (err) {
        console.error("[permission] deletePendingApprovalMessage (stale 404) failed", err);
      }
      reply.status(404); return { error: { code: "approval_not_found" } };
    }
    const ok = permissionApprovals.resolveDecision(approvalId, parsed.data.decision);
    if (!ok) { reply.status(409); return { error: { code: "already_answered" } }; }
    // The approval prompt is ephemeral: once decided, delete the whole message so it
    // doesn't persist or reappear on reload. Best-effort — never fail the decision.
    try {
      deletePendingApprovalMessage(
        { db, bus: eventBus, idFactory: daemonContext.idFactory },
        { goalId, approvalId }
      );
    } catch (err) {
      console.error("[permission] deletePendingApprovalMessage failed", err);
    }
    const actionClass = actionClassOf(
      pending.toolName,
      classifyToolAction({ toolName: pending.toolName, toolInput: pending.toolInput })
    );
    // Accountability writes are best-effort audit: the gate is already unblocked by
    // resolveDecision above, so a DB error here must not 500 the resolve route. Log, don't swallow silently.
    try {
      recordApprovalOutcome(
        { db, bus: eventBus, now: daemonContext.now },
        { goalId, actionClass, decision: parsed.data.decision }
      );
      if (parsed.data.decision === "allow" && parsed.data.remember) {
        recordRelaxationDecision({ db, bus: eventBus, now: daemonContext.now }, { goalId, actionClass });
      }
    } catch (err) {
      console.error("[permission] accountability write failed", err);
    }
    if (parsed.data.decision === "allow" && parsed.data.remember) {
      try {
        const adapterId = (db.prepare("SELECT adapter_id FROM sessions WHERE id = ?").get(pending.sessionId) as { adapter_id: string } | undefined)?.adapter_id ?? "claude-code";
        const provider = resolveAgentProvider(adapterId as ShadowAdapterId);
        const rule = provider.permissionRule(pending.toolName, pending.toolInput);
        if (rule) {
          const wsRow = db.prepare("SELECT w.path AS path FROM workspaces w JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ? ORDER BY gw.attached_at ASC LIMIT 1").get(goalId) as { path: string } | undefined;
          if (wsRow) provider.writePermissionRule(wsRow.path, rule);
        }
      } catch (err) {
        console.warn("[permission] always-allow rule write failed", err);
      }
    }
    return { ok: true };
  });

  // ---- Worker permission mode toggle route ----

  server.put("/v1/goals/:goalId/worker-permission-mode", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const parsed = UpdateWorkerPermissionModeRequest.safeParse(request.body);
    if (!parsed.success) { reply.status(400); return { error: "validation_failed", issues: parsed.error.issues }; }
    const now = daemonContext.now();
    const eventId = daemonContext.idFactory();
    let seq = 0;
    let goalExists = false;
    db.transaction(() => {
      const existing = db.prepare("SELECT id FROM goals WHERE id = ? AND archived_at IS NULL").get(goalId);
      if (!existing) return;
      goalExists = true;
      const result = db.prepare("INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(eventId, "goal.worker_permission_mode_changed", goalId, JSON.stringify({ workerPermissionMode: parsed.data.workerPermissionMode }), now);
      seq = Number(result.lastInsertRowid);
      db.prepare("UPDATE goals SET worker_permission_mode = ?, updated_at = ? WHERE id = ?")
        .run(parsed.data.workerPermissionMode, now, goalId);
    })();
    if (!goalExists) { reply.status(404); return { error: { code: "goal_not_found" } }; }
    eventBus.publish({ seq, id: eventId, type: "goal.worker_permission_mode_changed", goalId, payload: { workerPermissionMode: parsed.data.workerPermissionMode }, createdAt: now });
    return { ok: true, workerPermissionMode: parsed.data.workerPermissionMode };
  });

  // ---- Operating mode toggle route ----

  server.put("/v1/goals/:goalId/operating-mode", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const parsed = UpdateOperatingModeRequest.safeParse(request.body);
    if (!parsed.success) { reply.status(400); return { error: "validation_failed", issues: parsed.error.issues }; }
    const now = daemonContext.now();
    const eventId = daemonContext.idFactory();
    let seq = 0; let goalExists = false;
    db.transaction(() => {
      const existing = db.prepare("SELECT id FROM goals WHERE id = ? AND archived_at IS NULL").get(goalId);
      if (!existing) return;
      goalExists = true;
      const result = db.prepare("INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(eventId, "goal.operating_mode_changed", goalId, JSON.stringify({ operatingMode: parsed.data.operatingMode }), now);
      seq = Number(result.lastInsertRowid);
      db.prepare("UPDATE goals SET operating_mode = ?, updated_at = ? WHERE id = ?").run(parsed.data.operatingMode, now, goalId);
    })();
    if (!goalExists) { reply.status(404); return { error: { code: "goal_not_found" } }; }
    eventBus.publish({ seq, id: eventId, type: "goal.operating_mode_changed", goalId, payload: { operatingMode: parsed.data.operatingMode }, createdAt: now });
    if (parsed.data.operatingMode === "automated") {
      await orchestratorService.continueAllPausedSteps(
        getDatabase(),
        daemonContext.now,
        { bus: eventBus, idFactory: daemonContext.idFactory },
        goalId
      );
    }
    return { ok: true, operatingMode: parsed.data.operatingMode };
  });

  // ---- Settings routes ----

  server.get("/v1/settings", async () => {
    return { supervisionMode: getSupervisionMode(db) };
  });

  server.put("/v1/settings", async (request, reply) => {
    const parsed = PutSettingsRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_failed", issues: parsed.error.issues });
    }
    const now = daemonContext.now();
    setSupervisionMode(db, parsed.data.supervisionMode, now);
    // Default-only: the global supervision setting is the default for *future* goals
    // (inherited at creation), not a force-confirm of existing ones. Each goal's
    // per-goal operating_mode is the source of truth, flipped via
    // PUT /v1/goals/:goalId/operating-mode (which scopes the drain to that goal).
    // Draining globally here would force-confirm parked steps in human_review goals.
    return { supervisionMode: parsed.data.supervisionMode };
  });

  // ---- Confirm-step route (supervised Continue action) ----

  server.post<{ Params: { id: string } }>("/v1/workflows/runs/:id/confirm-step", async (request, reply) => {
    await orchestratorService.confirmStep(
      getDatabase(),
      daemonContext.now,
      request.params.id,
      { bus: eventBus, idFactory: daemonContext.idFactory }
    );
    return reply.code(202).send({ ok: true });
  });

  server.post<{ Params: { id: string } }>("/v1/workflows/runs/:id/revise-step", async (request, reply) => {
    await orchestratorService.requestStepRevision(
      getDatabase(),
      daemonContext.now,
      request.params.id,
      { bus: eventBus, idFactory: daemonContext.idFactory }
    );
    return reply.code(202).send({ ok: true });
  });

  server.post<{ Params: { id: string } }>("/v1/workflows/runs/:id/revise-step/submit", async (request, reply) => {
    const parsed = SubmitStepRevisionRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }
    await orchestratorService.submitStepRevision(
      getDatabase(),
      daemonContext.now,
      request.params.id,
      parsed.data.feedback,
      { bus: eventBus, idFactory: daemonContext.idFactory }
    );
    return reply.code(202).send({ ok: true });
  });

  server.post<{ Params: { id: string } }>("/v1/workflows/runs/:id/confirm-gate", async (request, reply) => {
    await dispatchEngine.confirmGate(
      getDatabase(),
      daemonContext.now,
      request.params.id,
      { bus: eventBus, idFactory: daemonContext.idFactory }
    );
    return reply.code(202).send({ ok: true });
  });

  server.post<{ Params: { id: string }; Body: { branch?: string } }>(
    "/v1/workflows/runs/:id/confirm-split",
    async (request, reply) => {
      const branch = typeof request.body?.branch === "string" ? request.body.branch : undefined;
      await dispatchEngine.confirmSplit(
        getDatabase(),
        daemonContext.now,
        request.params.id,
        { bus: eventBus, idFactory: daemonContext.idFactory },
        branch
      );
      return reply.code(202).send({ ok: true });
    }
  );

  server.post<{ Params: { id: string } }>("/v1/workflows/runs/:id/interrupt", async (request, reply) => {
    const interrupted = await orchestratorService.interruptStepAgent(
      getDatabase(),
      daemonContext.now,
      request.params.id,
      { bus: eventBus }
    );
    return reply.code(202).send({ ok: true, interrupted });
  });

  server.post<{ Params: { id: string }; Body: { outcome?: string; reason?: string } }>(
    "/v1/workflows/runs/:id/decide-gate",
    async (request, reply) => {
      const outcome = request.body?.outcome;
      if (outcome !== "approved" && outcome !== "rejected") {
        reply.status(400);
        return { error: "validation_failed", message: "outcome must be 'approved' or 'rejected'" };
      }
      const result = await dispatchEngine.decideGate(
        getDatabase(),
        daemonContext.now,
        request.params.id,
        outcome,
        {
          bus: eventBus,
          idFactory: daemonContext.idFactory,
          ...(typeof request.body?.reason === "string" ? { reason: request.body.reason } : {}),
        }
      );
      // Honest mapping: a decision that did not take effect must not read ok:true.
      if (!result.applied && result.reason === "run_not_found") {
        reply.status(404);
        return apiError("run_not_found", "workflow run not found");
      }
      if (!result.applied && result.reason === "gate_evaluation_in_flight") {
        reply.status(409);
        return apiError(
          "gate_evaluation_in_flight",
          "the gate is still being evaluated — the decision did not take effect; retry once it parks"
        );
      }
      // no_pending_gate is the idempotent re-decide (already decided) — still ok.
      return reply.code(202).send({ ok: true, applied: result.applied });
    }
  );

  // ---- Provider-limit recovery action routes ----
  // Routes validate the body + map domain errors; persistence, transitions, and
  // idempotency live inside the OrchestratorService methods (Task 5).

  function mapProviderRecoveryError(
    reply: import('fastify').FastifyReply,
    error: unknown
  ): { error: unknown } {
    if (error instanceof OrchestratorProviderRecoveryNotFoundError) {
      reply.status(404);
      return apiError(error.code, error.message);
    }
    if (error instanceof OrchestratorProviderRecoveryInvalidTransitionError) {
      reply.status(409);
      return apiError(error.code, error.message);
    }
    throw error;
  }

  server.post<{ Params: { id: string } }>(
    "/v1/workflows/runs/:id/provider-recovery/wait",
    async (request, reply) => {
      const parsed = ProviderRecoveryActionRequest.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return apiError("validation_failed", "invalid provider recovery request");
      }
      try {
        await recoveryController.waitForProvider(
          getDatabase(),
          daemonContext.now,
          request.params.id,
          parsed.data.checkpointId,
          { bus: eventBus, idFactory: daemonContext.idFactory }
        );
        return reply.code(202).send({ ok: true });
      } catch (error) {
        return mapProviderRecoveryError(reply, error);
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/v1/workflows/runs/:id/provider-recovery/retry",
    async (request, reply) => {
      const parsed = ProviderRecoveryActionRequest.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return apiError("validation_failed", "invalid provider recovery request");
      }
      try {
        await recoveryController.retryProvider(
          getDatabase(),
          daemonContext.now,
          request.params.id,
          parsed.data.checkpointId,
          { bus: eventBus, idFactory: daemonContext.idFactory }
        );
        return reply.code(202).send({ ok: true });
      } catch (error) {
        return mapProviderRecoveryError(reply, error);
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/v1/workflows/runs/:id/provider-recovery/refresh",
    async (request, reply) => {
      const parsed = ProviderRecoveryActionRequest.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return apiError("validation_failed", "invalid provider recovery request");
      }
      try {
        await recoveryController.refreshProviderRecovery(
          getDatabase(),
          daemonContext.now,
          request.params.id,
          parsed.data.checkpointId,
          { bus: eventBus, idFactory: daemonContext.idFactory }
        );
        return reply.code(202).send({ ok: true });
      } catch (error) {
        return mapProviderRecoveryError(reply, error);
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/v1/workflows/runs/:id/provider-recovery/switch",
    async (request, reply) => {
      const parsed = ProviderRecoverySwitchRequest.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return apiError("validation_failed", "invalid provider recovery switch request");
      }
      try {
        await recoveryController.switchProvider(
          getDatabase(),
          daemonContext.now,
          request.params.id,
          parsed.data.checkpointId,
          parsed.data.adapterId,
          { bus: eventBus, idFactory: daemonContext.idFactory }
        );
        return reply.code(202).send({ ok: true });
      } catch (error) {
        return mapProviderRecoveryError(reply, error);
      }
    }
  );

  // ---- Workflow orchestrator routes ----

  registerOrchestratorRoutes(server, {
    db,
    bus: eventBus,
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
      await shadowSessions.spawn(goalId, input.adapterId);
      return shadowSessions.ask(goalId, input);
    },
    resolveOrchestratorMode: (provider) => {
      const adapterId = adapterIdForProvider(provider as ModelProviderId);
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

  // ---- Goal command routes (deterministic, no orchestrator LLM) ----

  registerGoalCommandRoutes(server, {
    db,
    bus: eventBus,
    now: daemonContext.now,
    idFactory: daemonContext.idFactory,
  });

  // ---- Orchestrator hook endpoint ----

  registerShadowHookRoutes(server, {
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

  registerHarnessTransitionRoutes(server, { db });
  registerHarnessMetricsRoutes(server, { db });
  registerMetricsRoutes(server, { db });
  registerLearningRoutes(server, {
    db,
    broker: daemonContext.orchestrationTransportBroker,  // the broker the orchestrator uses
    actor: () => "owner",                                // single-owner today; tenancy replaces this
    shadowAsk: {
      ask: async (goalId, input) => {
        await shadowSessions.spawn(goalId, input.adapterId);
        return shadowSessions.ask(goalId, input);
      },
    },
    terminateShadow: (key) => shadowSessions.terminate(key),
  });

  // OTLP/JSON ingest (loopback worker telemetry). Auth via the global Bearer hook
  // (the OTEL exporter sends OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>).
  // Both providers land here: Claude appends /v1/metrics + /v1/logs to its base;
  // Codex is pointed directly at the full /v1/logs. Ingest is best-effort.
  server.decorate('otlpAccumulator', otlpAccumulator);
  for (const path of ['/v1/otlp/v1/metrics', '/v1/otlp/v1/logs']) {
    server.post(path, async (request, reply) => {
      try {
        otlpAccumulator.ingest(parseOtlpTokens(request.body));
      } catch (e) {
        console.error('otlp ingest', e);
      }
      reply.status(200);
      return {};
    });
  }

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

function summarizePermission(toolName: string, toolInput: unknown): string {
  if (toolName === "Bash" && toolInput && typeof toolInput === "object" && "command" in toolInput) {
    const cmd = String((toolInput as { command: unknown }).command ?? "").trim();
    if (cmd) return cmd.length > 200 ? `${cmd.slice(0, 200)}…` : cmd;
  }
  // File tools: surface the path so the card isn't a bare "Edit"/"Write".
  if (toolInput && typeof toolInput === "object" && "file_path" in toolInput) {
    const path = String((toolInput as { file_path: unknown }).file_path ?? "").trim();
    if (path) return `${toolName} ${path}`;
  }
  return toolName;
}

function orcaVoiceQuestionText(questions: PendingQuestionItem[]): string {
  const first = questions[0];
  if (!first) return "I need your input to continue.";
  if (questions.length === 1) {
    return `I need your call on ${first.header.toLowerCase()}.`;
  }
  return `I need your input on a few things, starting with ${first.header.toLowerCase()}.`;
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
      { db, bus, idFactory: ctx.idFactory },
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
