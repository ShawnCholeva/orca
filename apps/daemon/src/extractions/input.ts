import type Database from 'better-sqlite3';
import type { SessionExtractionInput, SessionOutputSnapshot } from '@orca/contracts';
import { SessionExtractionInput as SessionExtractionInputSchema } from '@orca/contracts';
import { getGoalRefinement } from '../goal-refinements.js';
import { getSessionDetail } from '../sessions/projection.js';
import { listWorkspacesByGoal } from '../workspaces/projection.js';

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

export class SessionNotFoundError extends Error {
  readonly code = 'session_not_found' as const;
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class GoalNotFoundError extends Error {
  readonly code = 'goal_not_found' as const;
  constructor(goalId: string) {
    super(`Goal not found: ${goalId}`);
    this.name = 'GoalNotFoundError';
  }
}

// Strips ANSI/CSI/OSC escape sequences and C0 control characters except \t and \n.
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

// Extracts bytes from the snapshot within [windowStart, windowEnd), returning the raw Buffer.
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

  const goalRow = ctx.db
    .prepare('SELECT id, title, status, archived_at FROM goals WHERE id = ?')
    .get(session.goalId) as
    | { id: string; title: string; status: string; archived_at: string | null }
    | undefined;
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
  const m4TailEnd = snapshot.firstByteOffset + snapshot.totalBytesKept;

  // m4 truncation: bytes were dropped from the front by the rolling window
  const m4Truncated = snapshot.firstByteOffset > 0;
  // m5 cap: our cap is smaller than what M4 has
  const m5Capped = snapshot.totalBytesKept > cap;
  const truncated = m4Truncated || m5Capped;

  const windowStart = m5Capped ? m4TailEnd - cap : snapshot.firstByteOffset;
  const windowEnd = m4TailEnd;

  let text = '';
  let byteOffsetFirst = windowStart;
  let byteOffsetLast = windowEnd;

  if (snapshot.totalBytesKept > 0) {
    const raw = extractWindowBytes(snapshot, windowStart, windowEnd);
    text = stripAnsi(raw.toString('utf8'));
    byteOffsetFirst = windowStart;
    byteOffsetLast = windowEnd;
  } else {
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
          problemStatement: undefined,
          constraints: refinement.constraints,
          successCriteria: refinement.successCriteria,
          stakeholders: undefined,
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
