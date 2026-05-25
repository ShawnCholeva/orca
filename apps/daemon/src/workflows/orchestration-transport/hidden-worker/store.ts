import type Database from "better-sqlite3";
import {
  ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES,
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  type ModelProviderId,
  type OrchestrationTransportFailureReason,
  type OrchestrationWorkerState,
} from "@orca/contracts";

import { sanitizeOutput } from "../../../readiness/sanitize.js";

const DEFAULT_OUTPUT_RETENTION_BYTES = 1024 * 1024;

interface WorkerExistsRow {
  id: string;
}

interface WorkerOutputChunkMetaRow {
  seq: number;
  byte_offset: number;
  byte_length: number;
}

interface WorkerOutputChunkRow extends WorkerOutputChunkMetaRow {
  data: Buffer;
}

export interface OrchestrationWorkerRow {
  id: string;
  provider_id: ModelProviderId;
  model: string;
  adapter_id: string;
  state: OrchestrationWorkerState;
  pid: number | null;
  command: string | null;
  args_json: string | null;
  cwd: string | null;
  current_goal_id: string | null;
  current_workflow_run_id: string | null;
  current_step_run_id: string | null;
  last_health_at: string | null;
  last_output_at: string | null;
  failure_reason: OrchestrationTransportFailureReason | null;
  failure_detail: string | null;
  created_at: string;
  started_at: string | null;
  stopped_at: string | null;
}

export interface CreateOrchestrationWorkerInput {
  id: string;
  providerId: ModelProviderId;
  modelId: string;
  adapterId: string;
  state: OrchestrationWorkerState;
  pid?: number | null;
  command?: string | null;
  argsJson?: string | null;
  cwd?: string | null;
  currentGoalId?: string | null;
  currentWorkflowRunId?: string | null;
  currentStepRunId?: string | null;
  lastHealthAt?: string | null;
  failureReason?: OrchestrationTransportFailureReason | null;
  failureDetail?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  stoppedAt?: string | null;
}

export interface UpdateWorkerAssignmentInput {
  workerId: string;
  goalId: string | null;
  workflowRunId: string | null;
  stepRunId: string | null;
}

export interface TransitionWorkerStateInput {
  workerId: string;
  state: OrchestrationWorkerState;
  lastHealthAt?: string | null;
  startedAt?: string | null;
  stoppedAt?: string | null;
  failureReason?: OrchestrationTransportFailureReason | null;
  failureDetail?: string | null;
}

export interface AppendWorkerOutputResult {
  seq: number;
  byteOffset: number;
  byteLength: number;
}

export interface WorkerOutputTailSnapshot {
  workerId: string;
  firstByteOffset: number;
  nextSeq: number;
  totalBytesKept: number;
  tailBytesReturned: number;
  tailText: string;
}

export interface WorkerOutputTailOptions {
  tailBytes?: number;
}

export interface OrchestrationWorkerStore {
  createWorker(input: CreateOrchestrationWorkerInput): OrchestrationWorkerRow;
  getWorker(workerId: string): OrchestrationWorkerRow;
  transitionWorkerState(input: TransitionWorkerStateInput): OrchestrationWorkerRow;
  updateWorkerAssignment(input: UpdateWorkerAssignmentInput): OrchestrationWorkerRow;
  clearWorkerAssignment(workerId: string): OrchestrationWorkerRow;
  appendWorkerOutput(workerId: string, data: Buffer): AppendWorkerOutputResult;
  readWorkerOutputTail(
    workerId: string,
    options?: WorkerOutputTailOptions
  ): WorkerOutputTailSnapshot;
  markWorkerStopped(workerId: string, stoppedAt?: string): OrchestrationWorkerRow;
  markWorkerFailed(input: {
    workerId: string;
    failureReason: OrchestrationTransportFailureReason;
    failureDetail?: string | null;
    stoppedAt?: string;
  }): OrchestrationWorkerRow;
}

function sanitizeFailureDetail(input: string | null | undefined): string | null {
  if (!input) return null;
  const value = sanitizeOutput(input).trim().slice(0, WORKFLOW_FAILURE_MAX_MESSAGE_CHARS);
  return value.length > 0 ? value : null;
}

function nowIso(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

function requireWorker(db: Database.Database, workerId: string): OrchestrationWorkerRow {
  const row = db
    .prepare("SELECT * FROM orchestration_workers WHERE id = ?")
    .get(workerId) as OrchestrationWorkerRow | undefined;
  if (!row) {
    throw new Error(`Orchestration worker not found: ${workerId}`);
  }
  return row;
}

function listOutputChunkMeta(
  db: Database.Database,
  workerId: string
): WorkerOutputChunkMetaRow[] {
  return db
    .prepare(
      "SELECT seq, byte_offset, byte_length FROM orchestration_worker_output_chunks WHERE worker_id = ? ORDER BY seq ASC"
    )
    .all(workerId) as WorkerOutputChunkMetaRow[];
}

function listOutputChunks(db: Database.Database, workerId: string): WorkerOutputChunkRow[] {
  return db
    .prepare(
      "SELECT seq, byte_offset, byte_length, data FROM orchestration_worker_output_chunks WHERE worker_id = ? ORDER BY seq ASC"
    )
    .all(workerId) as WorkerOutputChunkRow[];
}

function outputPosition(chunks: WorkerOutputChunkMetaRow[]): { seq: number; byteOffset: number } {
  const last = chunks[chunks.length - 1];
  if (!last) return { seq: 0, byteOffset: 0 };
  return {
    seq: last.seq + 1,
    byteOffset: last.byte_offset + last.byte_length,
  };
}

function ensureWorkerExists(db: Database.Database, workerId: string): void {
  const row = db
    .prepare("SELECT id FROM orchestration_workers WHERE id = ?")
    .get(workerId) as WorkerExistsRow | undefined;
  if (!row) {
    throw new Error(`Orchestration worker not found: ${workerId}`);
  }
}

function decodeUtf8(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

export function createOrchestrationWorkerStore(
  db: Database.Database,
  options?: {
    outputRetentionBytes?: number;
    outputTailBytes?: number;
    now?: () => string;
  }
): OrchestrationWorkerStore {
  const outputRetentionBytes =
    options?.outputRetentionBytes ?? DEFAULT_OUTPUT_RETENTION_BYTES;
  const outputTailBytes =
    options?.outputTailBytes ?? ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES;

  return {
    createWorker(input: CreateOrchestrationWorkerInput): OrchestrationWorkerRow {
      const createdAt = input.createdAt ?? nowIso(options?.now);
      db.prepare(
        "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, pid, command, args_json, cwd, current_goal_id, current_workflow_run_id, current_step_run_id, last_health_at, last_output_at, failure_reason, failure_detail, created_at, started_at, stopped_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        input.id,
        input.providerId,
        input.modelId,
        input.adapterId,
        input.state,
        input.pid ?? null,
        input.command ?? null,
        input.argsJson ?? null,
        input.cwd ?? null,
        input.currentGoalId ?? null,
        input.currentWorkflowRunId ?? null,
        input.currentStepRunId ?? null,
        input.lastHealthAt ?? null,
        null,
        input.failureReason ?? null,
        sanitizeFailureDetail(input.failureDetail),
        createdAt,
        input.startedAt ?? null,
        input.stoppedAt ?? null
      );
      return requireWorker(db, input.id);
    },

    getWorker(workerId: string): OrchestrationWorkerRow {
      return requireWorker(db, workerId);
    },

    transitionWorkerState(input: TransitionWorkerStateInput): OrchestrationWorkerRow {
      ensureWorkerExists(db, input.workerId);
      db.prepare(
        "UPDATE orchestration_workers SET state = ?, last_health_at = COALESCE(?, last_health_at), started_at = COALESCE(?, started_at), stopped_at = COALESCE(?, stopped_at), failure_reason = ?, failure_detail = ? WHERE id = ?"
      ).run(
        input.state,
        input.lastHealthAt ?? null,
        input.startedAt ?? null,
        input.stoppedAt ?? null,
        input.failureReason ?? null,
        sanitizeFailureDetail(input.failureDetail),
        input.workerId
      );
      return requireWorker(db, input.workerId);
    },

    updateWorkerAssignment(input: UpdateWorkerAssignmentInput): OrchestrationWorkerRow {
      ensureWorkerExists(db, input.workerId);
      db.prepare(
        "UPDATE orchestration_workers SET current_goal_id = ?, current_workflow_run_id = ?, current_step_run_id = ? WHERE id = ?"
      ).run(input.goalId, input.workflowRunId, input.stepRunId, input.workerId);
      return requireWorker(db, input.workerId);
    },

    clearWorkerAssignment(workerId: string): OrchestrationWorkerRow {
      return this.updateWorkerAssignment({
        workerId,
        goalId: null,
        workflowRunId: null,
        stepRunId: null,
      });
    },

    appendWorkerOutput(workerId: string, data: Buffer): AppendWorkerOutputResult {
      ensureWorkerExists(db, workerId);
      const sanitizedBuffer = Buffer.from(sanitizeOutput(data.toString("utf8")), "utf8");
      const bounded =
        sanitizedBuffer.length > outputRetentionBytes
          ? sanitizedBuffer.subarray(
              sanitizedBuffer.length - outputRetentionBytes,
              sanitizedBuffer.length
            )
          : sanitizedBuffer;
      const skippedBytes = sanitizedBuffer.length - bounded.length;
      const now = nowIso(options?.now);

      return db.transaction(() => {
        const chunks = listOutputChunkMeta(db, workerId);
        const position = outputPosition(chunks);
        if (bounded.length === 0) {
          return {
            seq: position.seq,
            byteOffset: position.byteOffset,
            byteLength: 0,
          };
        }

        const seq = position.seq;
        const byteOffset = position.byteOffset + skippedBytes;
        db.prepare(
          "INSERT INTO orchestration_worker_output_chunks (worker_id, seq, byte_offset, byte_length, written_at, data) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(workerId, seq, byteOffset, bounded.length, now, bounded);
        db.prepare("UPDATE orchestration_workers SET last_output_at = ? WHERE id = ?").run(
          now,
          workerId
        );

        const rowsAfterInsert = chunks.concat([
          { seq, byte_offset: byteOffset, byte_length: bounded.length },
        ]);
        let totalBytesKept = rowsAfterInsert.reduce((sum, row) => sum + row.byte_length, 0);

        while (totalBytesKept > outputRetentionBytes && rowsAfterInsert.length > 1) {
          const oldest = rowsAfterInsert.shift();
          if (!oldest) break;
          db.prepare(
            "DELETE FROM orchestration_worker_output_chunks WHERE worker_id = ? AND seq = ?"
          ).run(workerId, oldest.seq);
          totalBytesKept -= oldest.byte_length;
        }

        return { seq, byteOffset, byteLength: bounded.length };
      })();
    },

    readWorkerOutputTail(
      workerId: string,
      tailOptions?: WorkerOutputTailOptions
    ): WorkerOutputTailSnapshot {
      ensureWorkerExists(db, workerId);
      const chunks = listOutputChunks(db, workerId);
      if (chunks.length === 0) {
        return {
          workerId,
          firstByteOffset: 0,
          nextSeq: 0,
          totalBytesKept: 0,
          tailBytesReturned: 0,
          tailText: "",
        };
      }

      const tailCap = tailOptions?.tailBytes ?? outputTailBytes;
      const totalBytesKept = chunks.reduce((sum, row) => sum + row.byte_length, 0);
      const combined = Buffer.concat(chunks.map((row) => row.data));
      const tail =
        combined.length > tailCap
          ? combined.subarray(combined.length - tailCap, combined.length)
          : combined;
      const lastChunk = chunks[chunks.length - 1];

      return {
        workerId,
        firstByteOffset: chunks[0].byte_offset,
        nextSeq: lastChunk.seq + 1,
        totalBytesKept,
        tailBytesReturned: tail.length,
        tailText: decodeUtf8(tail),
      };
    },

    markWorkerStopped(workerId: string, stoppedAt?: string): OrchestrationWorkerRow {
      ensureWorkerExists(db, workerId);
      db.prepare(
        "UPDATE orchestration_workers SET state = 'stopped', stopped_at = ?, failure_reason = NULL, failure_detail = NULL, current_goal_id = NULL, current_workflow_run_id = NULL, current_step_run_id = NULL WHERE id = ?"
      ).run(stoppedAt ?? nowIso(options?.now), workerId);
      return requireWorker(db, workerId);
    },

    markWorkerFailed(input: {
      workerId: string;
      failureReason: OrchestrationTransportFailureReason;
      failureDetail?: string | null;
      stoppedAt?: string;
    }): OrchestrationWorkerRow {
      ensureWorkerExists(db, input.workerId);
      db.prepare(
        "UPDATE orchestration_workers SET state = 'failed', stopped_at = ?, failure_reason = ?, failure_detail = ?, current_goal_id = NULL, current_workflow_run_id = NULL, current_step_run_id = NULL WHERE id = ?"
      ).run(
        input.stoppedAt ?? nowIso(options?.now),
        input.failureReason,
        sanitizeFailureDetail(input.failureDetail),
        input.workerId
      );
      return requireWorker(db, input.workerId);
    },
  };
}
