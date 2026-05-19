import type Database from 'better-sqlite3';
import {
  MemoryExtraction,
  SessionMemorySummary,
  SessionSummary,
} from '@orca/contracts';

interface ExtractionRow {
  id: string;
  goal_id: string;
  session_id: string;
  trigger: string;
  status: string;
  extractor_version: string;
  source_fingerprint: string;
  source_offset_first: number | null;
  source_offset_last: number | null;
  summary_id: string | null;
  item_count: number;
  decision_count: number;
  promoted_count: number;
  failure_code: string | null;
  failure_message: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface SummaryRow {
  id: string;
  session_id: string;
  goal_id: string;
  extraction_id: string;
  headline: string;
  summary_text: string;
  truncated: number;
  source_offset_first: number;
  source_offset_last: number;
  created_at: string;
}

interface SessionRow {
  id: string;
  goal_id: string;
  workspace_id: string;
  adapter_id: string;
  role: string | null;
  title: string;
  status: string;
  created_at: string;
  started_at: string | null;
  exited_at: string | null;
}

export interface UpdateExtractionStatusPatch {
  status: MemoryExtraction['status'];
  sourceOffsetFirst?: number | null;
  sourceOffsetLast?: number | null;
  summaryId?: string | null;
  itemCount?: number;
  decisionCount?: number;
  promotedCount?: number;
  failureCode?: MemoryExtraction['failureCode'];
  failureMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

const EXTRACTION_COLS = `id, goal_id, session_id, trigger, status, extractor_version, source_fingerprint,
  source_offset_first, source_offset_last, summary_id, item_count, decision_count,
  promoted_count, failure_code, failure_message, requested_at, started_at, finished_at`;

const SUMMARY_COLS = `id, session_id, goal_id, extraction_id, headline, summary_text, truncated,
  source_offset_first, source_offset_last, created_at`;

const SESSION_COLS = `id, goal_id, workspace_id, adapter_id, role, title, status, created_at,
  started_at, exited_at`;

let _db: Database.Database | null = null;
let _stmts: {
  insertExtraction: Database.Statement;
  getExtractionById: Database.Statement;
  getLatestExtractionForSession: Database.Statement;
  listEligibleSessionsForGoal: Database.Statement;
  listPendingExtractions: Database.Statement;
  listActiveAndRunningExtractions: Database.Statement;
  insertSummary: Database.Statement;
  getLatestSummaryForSession: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertExtraction: db.prepare(
        `INSERT INTO memory_extractions (
          id, goal_id, session_id, trigger, status, extractor_version, source_fingerprint,
          source_offset_first, source_offset_last, summary_id, item_count, decision_count,
          promoted_count, failure_code, failure_message, requested_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      getExtractionById: db.prepare(`SELECT ${EXTRACTION_COLS} FROM memory_extractions WHERE id = ?`),
      getLatestExtractionForSession: db.prepare(
        `SELECT ${EXTRACTION_COLS}
         FROM memory_extractions
         WHERE session_id = ?
         ORDER BY requested_at DESC, id DESC
         LIMIT 1`
      ),
      listEligibleSessionsForGoal: db.prepare(
        `SELECT ${SESSION_COLS}
         FROM sessions
         WHERE goal_id = ?
           AND status IN ('exited', 'failed', 'stopped')
           AND NOT EXISTS (
             SELECT 1
             FROM memory_extractions
             WHERE memory_extractions.session_id = sessions.id
               AND memory_extractions.status IN ('pending', 'running', 'succeeded')
           )
         ORDER BY created_at DESC, id ASC`
      ),
      listPendingExtractions: db.prepare(
        `SELECT ${EXTRACTION_COLS}
         FROM memory_extractions
         WHERE status = 'pending'
         ORDER BY requested_at ASC, id ASC`
      ),
      listActiveAndRunningExtractions: db.prepare(
        `SELECT ${EXTRACTION_COLS}
         FROM memory_extractions
         WHERE status IN ('pending', 'running')
         ORDER BY requested_at ASC, id ASC`
      ),
      insertSummary: db.prepare(
        `INSERT INTO session_summaries (
          id, session_id, goal_id, extraction_id, headline, summary_text, truncated,
          source_offset_first, source_offset_last, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      getLatestSummaryForSession: db.prepare(
        `SELECT ${SUMMARY_COLS}
         FROM session_summaries
         WHERE session_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      ),
    };
  }
  return _stmts!;
}

function rowToExtraction(row: ExtractionRow): MemoryExtraction {
  return MemoryExtraction.parse({
    id: row.id,
    goalId: row.goal_id,
    sessionId: row.session_id,
    trigger: row.trigger,
    status: row.status,
    extractorVersion: row.extractor_version,
    sourceFingerprint: row.source_fingerprint,
    sourceOffsetFirst: row.source_offset_first,
    sourceOffsetLast: row.source_offset_last,
    summaryId: row.summary_id,
    itemCount: row.item_count,
    decisionCount: row.decision_count,
    promotedCount: row.promoted_count,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

function rowToSummary(row: SummaryRow): SessionMemorySummary {
  return SessionMemorySummary.parse({
    id: row.id,
    sessionId: row.session_id,
    goalId: row.goal_id,
    extractionId: row.extraction_id,
    headline: row.headline,
    summaryText: row.summary_text,
    truncated: row.truncated !== 0,
    sourceOffsetFirst: row.source_offset_first,
    sourceOffsetLast: row.source_offset_last,
    createdAt: row.created_at,
  });
}

function rowToSession(row: SessionRow): SessionSummary {
  return SessionSummary.parse({
    id: row.id,
    goalId: row.goal_id,
    workspaceId: row.workspace_id,
    adapterId: row.adapter_id,
    role: row.role,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    exitedAt: row.exited_at,
  });
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

export function insertExtraction(db: Database.Database, row: MemoryExtraction): string {
  const stmts = ensureStmts(db);
  stmts.insertExtraction.run(
    row.id,
    row.goalId,
    row.sessionId,
    row.trigger,
    row.status,
    row.extractorVersion,
    row.sourceFingerprint,
    row.sourceOffsetFirst,
    row.sourceOffsetLast,
    row.summaryId,
    row.itemCount,
    row.decisionCount,
    row.promotedCount,
    row.failureCode,
    row.failureMessage,
    row.requestedAt,
    row.startedAt,
    row.finishedAt
  );
  return row.id;
}

const EXTRACTION_PATCH_COLS: Record<Exclude<keyof UpdateExtractionStatusPatch, 'status'>, string> = {
  sourceOffsetFirst: 'source_offset_first',
  sourceOffsetLast: 'source_offset_last',
  summaryId: 'summary_id',
  itemCount: 'item_count',
  decisionCount: 'decision_count',
  promotedCount: 'promoted_count',
  failureCode: 'failure_code',
  failureMessage: 'failure_message',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

export function updateExtractionStatus(
  db: Database.Database,
  id: string,
  patch: UpdateExtractionStatusPatch
): void {
  const sets = ['status = ?'];
  const params: unknown[] = [patch.status];

  for (const key of Object.keys(EXTRACTION_PATCH_COLS) as (keyof typeof EXTRACTION_PATCH_COLS)[]) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) {
      continue;
    }
    sets.push(`${EXTRACTION_PATCH_COLS[key]} = ?`);
    params.push(patch[key]);
  }

  params.push(id);
  db.prepare(`UPDATE memory_extractions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function getExtractionById(
  db: Database.Database,
  id: string
): MemoryExtraction | null {
  const stmts = ensureStmts(db);
  const row = stmts.getExtractionById.get(id) as ExtractionRow | undefined;
  if (!row) {
    return null;
  }
  return rowToExtraction(row);
}

export function getLatestExtractionForSession(
  db: Database.Database,
  sessionId: string
): MemoryExtraction | null {
  const stmts = ensureStmts(db);
  const row = stmts.getLatestExtractionForSession.get(sessionId) as ExtractionRow | undefined;
  if (!row) {
    return null;
  }
  return rowToExtraction(row);
}

export function listEligibleSessionsForGoal(
  db: Database.Database,
  goalId: string
): SessionSummary[] {
  const stmts = ensureStmts(db);
  const rows = stmts.listEligibleSessionsForGoal.all(goalId) as SessionRow[];
  return rows.map(rowToSession);
}

export function listPendingExtractions(db: Database.Database): MemoryExtraction[] {
  const stmts = ensureStmts(db);
  const rows = stmts.listPendingExtractions.all() as ExtractionRow[];
  return rows.map(rowToExtraction);
}

export function listActiveAndRunningExtractions(db: Database.Database): MemoryExtraction[] {
  const stmts = ensureStmts(db);
  const rows = stmts.listActiveAndRunningExtractions.all() as ExtractionRow[];
  return rows.map(rowToExtraction);
}

export function insertSummary(db: Database.Database, row: SessionMemorySummary): void {
  const stmts = ensureStmts(db);
  stmts.insertSummary.run(
    row.id,
    row.sessionId,
    row.goalId,
    row.extractionId,
    row.headline,
    row.summaryText,
    row.truncated ? 1 : 0,
    row.sourceOffsetFirst,
    row.sourceOffsetLast,
    row.createdAt
  );
}

export function getLatestSummaryForSession(
  db: Database.Database,
  sessionId: string
): SessionMemorySummary | null {
  const stmts = ensureStmts(db);
  const row = stmts.getLatestSummaryForSession.get(sessionId) as SummaryRow | undefined;
  if (!row) {
    return null;
  }
  return rowToSummary(row);
}
