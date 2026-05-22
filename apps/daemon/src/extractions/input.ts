import type Database from 'better-sqlite3';
import type { SessionExtractionInput, SessionOutputSnapshot } from '@orca/contracts';
import { SessionExtractionInput as SessionExtractionInputSchema } from '@orca/contracts';
import { getGoalRefinement } from '../goal-refinements.js';
import { SessionNotFoundError, GoalNotFoundError } from '../sessions/errors.js';
import { getSessionDetail } from '../sessions/projection.js';
import { listWorkspacesByGoal } from '../workspaces/projection.js';

export { SessionNotFoundError, GoalNotFoundError };

export interface InputBuilderCtx {
  db: Database.Database;
  outputStore: { readTail(sessionId: string): SessionOutputSnapshot | null };
  config: { memoryExtractionMaxInputBytes: number };
}

export class OutputUnavailableError extends Error {
  readonly code = 'output_unavailable' as const;
  constructor(sessionId: string) {
    super(`Output unavailable for session: ${sessionId}`);
    this.name = 'OutputUnavailableError';
  }
}

type GoalRow = { id: string; title: string; status: string; archived_at: string | null };

let _db: Database.Database | null = null;
let _selectGoal: Database.Statement<[string], GoalRow> | null = null;

function getGoalStmt(db: Database.Database): Database.Statement<[string], GoalRow> {
  if (db !== _db) {
    _db = db;
    _selectGoal = db.prepare('SELECT id, title, status, archived_at FROM goals WHERE id = ?');
  }
  return _selectGoal!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _selectGoal = null;
}

function stripAnsi(text: string): string {
  return (
    text
      // OSC: ESC ] ... BEL or ST
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // CSI: ESC [ param* intermediate* final
      .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
      // Other two-char ESC sequences
      .replace(/\x1b[\x20-\x7e]/g, '')
      // Remaining lone ESC
      .replace(/\x1b/g, '')
      // C0 except \t (0x09) and \n (0x0a)
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  );
}

function extractWindowBytes(
  snapshot: SessionOutputSnapshot,
  windowStart: number,
  windowEnd: number,
): Buffer {
  const parts: Buffer[] = [];
  for (const chunk of snapshot.chunks) {
    const data = Buffer.from(chunk.dataBase64, 'base64');
    const chunkEnd = chunk.byteOffset + data.length;
    if (chunkEnd <= windowStart) continue;
    if (chunk.byteOffset >= windowEnd) break;
    const sliceStart = Math.max(0, windowStart - chunk.byteOffset);
    const sliceEnd = Math.min(data.length, windowEnd - chunk.byteOffset);
    parts.push(data.subarray(sliceStart, sliceEnd));
  }
  return Buffer.concat(parts);
}

export async function buildSessionExtractionInput(
  ctx: InputBuilderCtx,
  { sessionId, extractorVersion }: { sessionId: string; extractorVersion: string },
): Promise<SessionExtractionInput> {
  const session = getSessionDetail(ctx.db, sessionId);
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }

  const goalRow = getGoalStmt(ctx.db).get(session.goalId);
  if (!goalRow) {
    throw new GoalNotFoundError(session.goalId);
  }

  const refinement = getGoalRefinement(ctx.db, session.goalId);
  const workspaces = listWorkspacesByGoal(ctx.db, session.goalId);

  const snapshot = ctx.outputStore.readTail(sessionId);
  if (snapshot === null) {
    throw new OutputUnavailableError(sessionId);
  }

  const cap = ctx.config.memoryExtractionMaxInputBytes;
  const outputTailEnd = snapshot.firstByteOffset + snapshot.totalBytesKept;

  // The session output tail may have dropped bytes from the front; extraction cap may further trim.
  const outputTailTruncated = snapshot.firstByteOffset > 0;
  const m5Capped = snapshot.totalBytesKept > cap;
  const truncated = outputTailTruncated || m5Capped;

  const windowStart = m5Capped ? outputTailEnd - cap : snapshot.firstByteOffset;
  const windowEnd = outputTailEnd;

  let text: string;
  let byteOffsetFirst: number;
  let byteOffsetLast: number;

  if (snapshot.totalBytesKept > 0) {
    text = stripAnsi(extractWindowBytes(snapshot, windowStart, windowEnd).toString('utf8'));
    byteOffsetFirst = windowStart;
    byteOffsetLast = windowEnd;
  } else {
    text = '';
    byteOffsetFirst = 0;
    byteOffsetLast = 0;
  }

  return SessionExtractionInputSchema.parse({
    goal: {
      id: goalRow.id,
      title: goalRow.title,
      status: goalRow.status,
      archived: goalRow.archived_at !== null,
    },
    refinement: refinement
      ? {
          id: refinement.goalId,
          constraints: refinement.constraints,
          successCriteria: refinement.successCriteria,
        }
      : null,
    workspaces: workspaces.map((ws) => ({
      id: ws.id,
      label: ws.name,
      rootPath: ws.path,
    })),
    session: {
      id: session.id,
      adapterId: session.adapterId,
      role: session.role ?? null,
      instructions: session.instruction ?? null,
      exitCode: session.exitCode ?? null,
      terminalReason: session.failureReason ?? null,
      startedAt: session.startedAt ?? null,
      terminatedAt: session.exitedAt ?? null,
    },
    outputTail: {
      text,
      byteOffsetFirst,
      byteOffsetLast,
      truncated,
    },
    extractorVersion,
  });
}
