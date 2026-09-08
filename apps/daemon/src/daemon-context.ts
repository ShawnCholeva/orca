import { uuidv7 } from './ids.js';
import type Database from 'better-sqlite3';
import type { EventBus } from './events.js';
import type { SessionPreparationAssembler } from './context/assembler.js';
import { DeterministicAssembler } from './context/deterministic-assembler.js';
import type { TaskGenerator } from './tasks/rules.js';
import { DeterministicTaskGenerator } from './tasks/rules.js';
import type { RecommendationProvider } from './recommendations/provider.js';
import { DeterministicRecommendationProvider } from './recommendations/provider.js';
import type { ConflictDetector } from './conflicts/detectors.js';
import { DeterministicConflictDetector } from './conflicts/detectors.js';
import { ReadinessService } from './readiness/service.js';
import { adapterRegistry } from './adapters/registry.js';
import { resolveBinary } from './adapters/resolve.js';
import { extractClaudeCatalog } from './adapters/model-catalog/extract-claude.js';
import { SEED_PROFILES } from './adapters/model-catalog/profiles.js';
import { loadCatalog, type LoadedCatalog } from './adapters/model-catalog/store.js';
import type { AdapterId } from '@orca/contracts';
import { ModelProviderRegistry } from './llm/registry.js';
import { createAnthropicProvider } from './llm/anthropic.js';
import { createOpenAIProvider } from './llm/openai.js';
import { OperatorRegistry } from './workflows/operators/registry.js';
import { OrchestrationTransportBroker, execModeToTransport } from './workflows/orchestration-transport/broker.js';
import { AdapterDispatcher } from './adapters/dispatcher.js';
import type { StepDispatchCapabilities } from './workflows/orchestrator/dispatch-types.js';
import { createSession as createSessionUseCase } from './sessions/usecases.js';
import { listWorkspacesByGoal } from './workspaces/projection.js';
import { ProductionWorkflowSessionLauncher } from './workflows/orchestrator/session-launcher-impl.js';
import type { WorkflowSessionLauncher } from './workflows/orchestrator/session-launcher.js';

/**
 * Shared dependency container for orchestration daemon use cases.
 * Production wiring via createDaemonContext(); tests inject fakes.
 */
export interface DaemonContext {
  db: Database.Database;
  bus: EventBus;
  contextAssembler: SessionPreparationAssembler;
  taskGenerator: TaskGenerator;
  recommendationProvider: RecommendationProvider;
  conflictDetector: ConflictDetector;
  readinessService: ReadinessService;
  modelProviderRegistry: ModelProviderRegistry;
  operatorRegistry: OperatorRegistry;
  adapterDispatcher: AdapterDispatcher;
  orchestrationTransportBroker: OrchestrationTransportBroker;
  stepDispatchCapabilities: StepDispatchCapabilities;
  workflowSessionLauncher: WorkflowSessionLauncher;
  now: () => string;
  idFactory: () => string;
}

/** The binary the claude-code adapter would spawn, resolved the same way it does. */
async function claudeBinaryPath(): Promise<string | null> {
  const override = process.env['ORCA_CLAUDE_CODE_BIN'];
  const resolved = await resolveBinary(override ? [override] : ['claude']);
  return 'error' in resolved ? null : resolved.resolvedPath;
}

/**
 * The installed CLI's model lineup, extracted once per adapter version and
 * cached in the DB. Only claude-code can be extracted today; every other adapter
 * falls through to the checked-in seed inside loadCatalog.
 */
export async function loadAdapterCatalog(
  db: Database.Database,
  adapterId: AdapterId,
  now: () => string,
  opts?: { force?: boolean }
): Promise<LoadedCatalog> {
  const adapter = adapterRegistry.get(adapterId);
  return loadCatalog(
    db,
    adapterId,
    {
      version: async () => {
        if (!adapter) return null;
        const installed = await adapter.checkInstalled();
        return installed.ok ? (installed.version ?? null) : null;
      },
      extract: async () => {
        if (adapterId !== 'claude-code') return [];
        const binary = await claudeBinaryPath();
        return binary ? extractClaudeCatalog(binary) : [];
      },
      now,
    },
    opts
  );
}

function createDefaultModelProviderRegistry(): ModelProviderRegistry {
  const registry = new ModelProviderRegistry();
  registry.register(createAnthropicProvider());
  registry.register(createOpenAIProvider());
  return registry;
}

export function createDaemonContext(db: Database.Database, bus: EventBus): DaemonContext {
  const readinessService = new ReadinessService(db, adapterRegistry);
  const modelProviderRegistry = createDefaultModelProviderRegistry();
  const operatorRegistry = new OperatorRegistry(
    adapterRegistry,
    modelProviderRegistry,
    readinessService
  );
  const now = () => new Date().toISOString();
  const idFactory = uuidv7;
  const adapterDispatcher = new AdapterDispatcher({ db });
  const stepDispatchCapabilities: StepDispatchCapabilities = {
    isAdapterReady: async (adapterId) => {
      if (!adapterRegistry.get(adapterId)) return false;
      const report = await readinessService.checkAgent(adapterId);
      return report.status === "ready";
    },
    catalogFor: (adapterId) => loadAdapterCatalog(db, adapterId, now).then((loaded) => loaded.models),
    profiles: SEED_PROFILES,
    resolveMode: (adapterId) => adapterDispatcher.resolveMode(adapterId),
  };
  const orchestrationTransportBroker = new OrchestrationTransportBroker({
    db,
    bus,
    now,
    idFactory,
    modeResolver: (adapterId: string) => execModeToTransport(adapterDispatcher.resolveMode(adapterId).mode),
  });

  // Production workflow session launcher: picks first attached workspace for goal (Phase 2 limitation).
  const workflowSessionLauncher = new ProductionWorkflowSessionLauncher({
    createSession: async (input) => {
      const session = await createSessionUseCase(
        { db, bus, adapterRegistry },
        {
          goalId: input.goalId,
          workspaceId: input.workspaceId,
          adapterId: input.adapterId,
          role: input.role,
          instruction: input.instruction,
          title: input.title,
        }
      );
      // Set workflow_step_run_id on the created session row so the orchestrator
      // can detect a live linked session via the sessions query in commitAgentStepDecision.
      db.prepare("UPDATE sessions SET workflow_step_run_id = ? WHERE id = ?")
        .run(input.workflowStepRunId, session.id);
      return session;
    },
    firstWorkspaceId: (goalId) => {
      const workspaces = listWorkspacesByGoal(db, goalId);
      return workspaces[0]?.id ?? null;
    },
  });

  return {
    db,
    bus,
    contextAssembler: new DeterministicAssembler(),
    taskGenerator: new DeterministicTaskGenerator(),
    recommendationProvider: new DeterministicRecommendationProvider(),
    conflictDetector: new DeterministicConflictDetector(),
    readinessService,
    modelProviderRegistry,
    operatorRegistry,
    adapterDispatcher,
    orchestrationTransportBroker,
    stepDispatchCapabilities,
    workflowSessionLauncher,
    now,
    idFactory,
  };
}
