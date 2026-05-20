import type Database from 'better-sqlite3';
import type { EventBus } from './events.js';
import type { SessionPreparationAssembler } from './context/assembler.js';

/**
 * Shared dependency container for M6 daemon use cases.
 * Production wiring in index.ts; tests inject fakes.
 */
export interface DaemonContext {
  db: Database.Database;
  bus: EventBus;
  contextAssembler: SessionPreparationAssembler;
  now: () => string;
  idFactory: () => string;
}
