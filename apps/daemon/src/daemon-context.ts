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

/**
 * Shared dependency container for M7 daemon use cases.
 * Production wiring via createDaemonContext(); tests inject fakes.
 */
export interface DaemonContext {
  db: Database.Database;
  bus: EventBus;
  contextAssembler: SessionPreparationAssembler;
  taskGenerator: TaskGenerator;
  recommendationProvider: RecommendationProvider;
  conflictDetector: ConflictDetector;
  now: () => string;
  idFactory: () => string;
}

export function createDaemonContext(db: Database.Database, bus: EventBus): DaemonContext {
  return {
    db,
    bus,
    contextAssembler: new DeterministicAssembler(),
    taskGenerator: new DeterministicTaskGenerator(),
    recommendationProvider: new DeterministicRecommendationProvider(),
    conflictDetector: new DeterministicConflictDetector(),
    now: () => new Date().toISOString(),
    idFactory: randomUUID,
  };
}
