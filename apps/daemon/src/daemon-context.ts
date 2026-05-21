import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EventBus } from './events.js';
import type { SessionPreparationAssembler } from './context/assembler.js';
import { DeterministicAssembler } from './context/deterministic-assembler.js';
import type { TaskGenerator } from './tasks/rules.js';
import { DeterministicTaskGenerator } from './tasks/rules.js';

/**
 * Shared dependency container for M6 daemon use cases.
 * Production wiring via createDaemonContext(); tests inject fakes.
 */
export interface DaemonContext {
  db: Database.Database;
  bus: EventBus;
  contextAssembler: SessionPreparationAssembler;
  taskGenerator: TaskGenerator;
  now: () => string;
  idFactory: () => string;
}

export function createDaemonContext(db: Database.Database, bus: EventBus): DaemonContext {
  return {
    db,
    bus,
    contextAssembler: new DeterministicAssembler(),
    taskGenerator: new DeterministicTaskGenerator(),
    now: () => new Date().toISOString(),
    idFactory: randomUUID,
  };
}
