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
import { createGeminiProvider } from './llm/gemini.js';
import { OperatorRegistry } from './workflows/operators/registry.js';
import { OperatorSelector } from './workflows/operators/selector.js';

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
  operatorSelector: OperatorSelector;
  now: () => string;
  idFactory: () => string;
}

function createDefaultModelProviderRegistry(): ModelProviderRegistry {
  const registry = new ModelProviderRegistry();
  registry.register(createAnthropicProvider());
  registry.register(createOpenAIProvider());
  registry.register(createGeminiProvider());
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
    operatorSelector: new OperatorSelector(modelProviderRegistry, operatorRegistry),
    now: () => new Date().toISOString(),
    idFactory: randomUUID,
  };
}
