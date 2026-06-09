import { randomUUID } from 'node:crypto';
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
import { ModelProviderRegistry } from './llm/registry.js';
import { createAnthropicProvider } from './llm/anthropic.js';
import { createOpenAIProvider } from './llm/openai.js';
import { OperatorRegistry } from './workflows/operators/registry.js';
import { OperatorSelector } from './workflows/operators/selector.js';
import { OrchestrationTransportBroker, execModeToTransport } from './workflows/orchestration-transport/broker.js';
import { AdapterDispatcher } from './adapters/dispatcher.js';
import type { StepDispatchCapabilities } from './workflows/orchestrator/service.js';
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
  operatorSelector: OperatorSelector;
  stepDispatchCapabilities: StepDispatchCapabilities;
  workflowSessionLauncher: WorkflowSessionLauncher;
  now: () => string;
  idFactory: () => string;
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
  const idFactory = randomUUID;
  const adapterDispatcher = new AdapterDispatcher({ db });
  const stepDispatchCapabilities: StepDispatchCapabilities = {
    isAdapterReady: async (adapterId) => {
      if (!adapterRegistry.get(adapterId)) return false;
      const report = await readinessService.checkAgent(adapterId);
      return report.status === "ready";
    },
    supportsModel: (adapterId, modelId) =>
      adapterRegistry.get(adapterId)?.supportsModel(modelId) ?? false,
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
    operatorSelector: new OperatorSelector(
      modelProviderRegistry,
      operatorRegistry,
      orchestrationTransportBroker,
      (adapterId) => adapterDispatcher.resolveMode(adapterId)
    ),
    stepDispatchCapabilities,
    workflowSessionLauncher,
    now,
    idFactory,
  };
}
