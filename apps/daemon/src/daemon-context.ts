import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EventBus } from './events.js';
import type { SessionPreparationAssembler } from './context/assembler.js';
import { DeterministicAssembler } from './context/deterministic-assembler.js';

/**
 * Shared dependency container for M6 daemon use cases.
 * Production wiring via createDaemonContext(); tests inject fakes.
 */
export interface DaemonContext {
  db: Database.Database;
  bus: EventBus;
  contextAssembler: SessionPreparationAssembler;
  now: () => string;
  idFactory: () => string;
}

export function createDaemonContext(db: Database.Database, bus: EventBus): DaemonContext {
  return {
    db,
    bus,
    contextAssembler: new DeterministicAssembler(),
    now: () => new Date().toISOString(),
    idFactory: randomUUID,
  };
}
