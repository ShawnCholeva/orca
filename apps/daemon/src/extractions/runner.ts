import type Database from 'better-sqlite3';
import { SessionExtractionOutput } from '@orca/contracts';
import type { EventBus } from '../events.js';
import type { SessionOutputStore } from '../sessions/output-store.js';
import { buildSessionExtractionInput } from './input.js';
import { listPendingExtractions } from './projection.js';
import { markExtractionStarted } from './usecases.js';
import { commitExtractionResult, commitExtractionFailure } from './commit.js';
import type { SessionMemoryExtractor } from './fake-extractor.js';

export type { SessionMemoryExtractor };

export interface RunnerDeps {
  db: Database.Database;
  bus: EventBus;
  outputStore: SessionOutputStore;
  extractor: SessionMemoryExtractor;
  config: {
    memoryExtractionMaxInputBytes: number;
    memoryExtractionTimeoutMs: number;
  };
}

const IDLE_BACKOFF_MS = 100;

export class ExtractionRunner {
  private readonly deps: RunnerDeps;
  private shouldStop = false;
  private loopRunning = false;
  // Counter prevents lost wake-ups when notify() fires before waitForWake() registers its resolver.
  private missedNotifications = 0;
  private wakeResolve: (() => void) | null = null;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  notify(): void {
    if (this.wakeResolve) {
      const resolve = this.wakeResolve;
      this.wakeResolve = null;
      resolve();
    } else {
      this.missedNotifications++;
    }
  }

  start(): void {
    if (this.loopRunning) return;
    this.loopRunning = true;
    this.shouldStop = false;
    void this.loop();
  }

  stop(): void {
    this.shouldStop = true;
    this.notify();
  }

  private async waitForWake(): Promise<void> {
    if (this.missedNotifications > 0) {
      this.missedNotifications = 0;
      return;
    }
    await new Promise<void>((resolve) => {
      this.wakeResolve = resolve;
    });
  }

  private async loop(): Promise<void> {
    try {
      while (!this.shouldStop) {
        const pending = listPendingExtractions(this.deps.db);
        if (pending.length === 0) {
          await this.waitForWake();
          continue;
        }
        for (const extraction of pending) {
          if (this.shouldStop) break;
          await this.processOne(extraction.id);
        }
      }
    } finally {
      this.loopRunning = false;
    }
  }

  private async processOne(extractionId: string): Promise<void> {
    const { db, bus, outputStore, extractor, config } = this.deps;

    const commitCtx = { db, bus };

    let extraction;
    try {
      extraction = markExtractionStarted({ db, bus }, extractionId);
    } catch (err) {
      console.info('[runner] skipping extraction %s — could not mark started: %s', extractionId, (err as Error).message);
      return;
    }

    const inputCtx = {
      db,
      outputStore,
      config: { memoryExtractionMaxInputBytes: config.memoryExtractionMaxInputBytes },
    };

    let input;
    try {
      input = await buildSessionExtractionInput(inputCtx, {
        sessionId: extraction.sessionId,
        extractorVersion: extractor.version,
      });
    } catch (err) {
      commitExtractionFailure(commitCtx, extractionId, {
        failureCode: 'output_unavailable',
        failureMessage: null,
      });
      console.info('[runner] extraction %s failed: output_unavailable', extractionId);
      return;
    }

    let rawOutput: unknown;
    try {
      rawOutput = await withTimeout(
        extractor.extract(input),
        config.memoryExtractionTimeoutMs
      );
    } catch (err) {
      const isTimeout = err instanceof TimeoutError;
      commitExtractionFailure(commitCtx, extractionId, {
        failureCode: isTimeout ? 'timeout' : 'internal_error',
        failureMessage: null,
      });
      console.info('[runner] extraction %s failed: %s', extractionId, isTimeout ? 'timeout' : 'internal_error');
      return;
    }

    const parsed = SessionExtractionOutput.safeParse(rawOutput);
    if (!parsed.success) {
      commitExtractionFailure(commitCtx, extractionId, {
        failureCode: 'invalid_output',
        failureMessage: null,
      });
      console.info('[runner] extraction %s failed: invalid_output', extractionId);
      return;
    }

    try {
      commitExtractionResult(commitCtx, extractionId, parsed.data, {
        sourceOffsetFirst: input.outputTail.byteOffsetFirst,
        sourceOffsetLast: input.outputTail.byteOffsetLast,
      });
    } catch (err) {
      console.info('[runner] extraction %s failed: commit error: %s', extractionId, (err as Error).message);
      try {
        commitExtractionFailure(commitCtx, extractionId, {
          failureCode: 'internal_error',
          failureMessage: null,
        });
      } catch {
        // The extraction may already be terminal; reconciliation will handle any stale row.
      }
    }
  }
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError('timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); }
    );
  });
}
