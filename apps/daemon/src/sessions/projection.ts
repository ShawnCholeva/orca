import type Database from 'better-sqlite3';
import { SessionDetail, SessionSummary } from '@orca/contracts';

interface SessionRow {
  id: string;
  goal_id: string;
  workspace_id: string;
  adapter_id: string;
  role: string | null;
  instruction: string | null;
  title: string;
  status: string;
  pid: number | null;
  command: string | null;
  args_json: string | null;
  cwd: string | null;
  terminal_cols: number | null;
  terminal_rows: number | null;
  exit_code: number | null;
  exit_signal: string | null;
  failure_reason: string | null;
  failure_detail: string | null;
  created_at: string;
  started_at: string | null;
  exited_at: string | null;
  archived_at: string | null;
  latest_extraction_id: string | null;
  latest_extraction_status: string | null;
  latest_extraction_requested_at: string | null;
  latest_extraction_finished_at: string | null;
  latest_extraction_failure_code: string | null;
  latest_extraction_truncated: number | null;
  latest_summary_headline: string | null;
}

export interface InsertSessionRow {
  id: string;
  goalId: string;
  workspaceId: string;
  adapterId: string;
  role?: string | null;
  instruction?: string | null;
  title: string;
  status: string;
  createdAt: string;
}

const SESSION_COLS = `s.id, s.goal_id, s.workspace_id, s.adapter_id, s.role, s.instruction, s.title, s.status, s.pid,
  s.command, s.args_json, s.cwd, s.terminal_cols, s.terminal_rows, s.exit_code, s.exit_signal,
  s.failure_reason, s.failure_detail, s.created_at, s.started_at, s.exited_at, s.archived_at,
  latest_extraction.id AS latest_extraction_id,
  latest_extraction.status AS latest_extraction_status,
  latest_extraction.requested_at AS latest_extraction_requested_at,
  latest_extraction.finished_at AS latest_extraction_finished_at,
  latest_extraction.failure_code AS latest_extraction_failure_code,
  latest_extraction_summary.truncated AS latest_extraction_truncated,
  latest_summary.headline AS latest_summary_headline`;

const SESSION_FROM = `FROM sessions s
  LEFT JOIN memory_extractions latest_extraction
    ON latest_extraction.id = (
      SELECT memory_extractions.id
      FROM memory_extractions
      WHERE memory_extractions.session_id = s.id
      ORDER BY memory_extractions.requested_at DESC, memory_extractions.id DESC
      LIMIT 1
    )
  LEFT JOIN session_summaries latest_extraction_summary
    ON latest_extraction_summary.extraction_id = latest_extraction.id
  LEFT JOIN session_summaries latest_summary
    ON latest_summary.id = (
      SELECT session_summaries.id
      FROM session_summaries
      WHERE session_summaries.session_id = s.id
      ORDER BY session_summaries.created_at DESC, session_summaries.id DESC
      LIMIT 1
    )`;

function rowToSummary(row: SessionRow): SessionSummary {
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
    latestExtraction: row.latest_extraction_id
      ? {
          id: row.latest_extraction_id,
          status: row.latest_extraction_status!,
          requestedAt: row.latest_extraction_requested_at!,
          finishedAt: row.latest_extraction_finished_at,
          failureCode: row.latest_extraction_failure_code,
          truncated: row.latest_extraction_truncated !== null && row.latest_extraction_truncated !== 0,
        }
      : undefined,
    latestSummaryHeadline: row.latest_summary_headline ?? null,
  });
}

function rowToDetail(row: SessionRow): SessionDetail {
  return SessionDetail.parse({
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
    instruction: row.instruction,
    pid: row.pid,
    command: row.command,
    args: row.args_json ? (JSON.parse(row.args_json) as string[]) : null,
    cwd: row.cwd,
    terminalCols: row.terminal_cols,
    terminalRows: row.terminal_rows,
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
    failureReason: row.failure_reason,
    failureDetail: row.failure_detail,
    archivedAt: row.archived_at,
    latestExtraction: row.latest_extraction_id
      ? {
          id: row.latest_extraction_id,
          status: row.latest_extraction_status!,
          requestedAt: row.latest_extraction_requested_at!,
          finishedAt: row.latest_extraction_finished_at,
          failureCode: row.latest_extraction_failure_code,
          truncated: row.latest_extraction_truncated !== null && row.latest_extraction_truncated !== 0,
        }
      : undefined,
    latestSummaryHeadline: row.latest_summary_headline ?? null,
  });
}

let _db: Database.Database | null = null;
let _stmts: {
  insertSession: Database.Statement;
  listByGoal: Database.Statement;
  getById: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertSession: db.prepare(
        `INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, role, instruction, title, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      listByGoal: db.prepare(
        `SELECT ${SESSION_COLS} ${SESSION_FROM} WHERE s.goal_id = ? ORDER BY s.created_at DESC, s.id ASC`
      ),
      getById: db.prepare(
        `SELECT ${SESSION_COLS} ${SESSION_FROM} WHERE s.id = ?`
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

export function insertSession(db: Database.Database, row: InsertSessionRow): void {
  const stmts = ensureStmts(db);
  stmts.insertSession.run(
    row.id,
    row.goalId,
    row.workspaceId,
    row.adapterId,
    row.role ?? null,
    row.instruction ?? null,
    row.title,
    row.status,
    row.createdAt
  );
}

export function listSessionsByGoal(db: Database.Database, goalId: string): SessionSummary[] {
  const stmts = ensureStmts(db);
  const rows = stmts.listByGoal.all(goalId) as SessionRow[];
  return rows.map(rowToSummary);
}

export function getSessionDetail(db: Database.Database, sessionId: string): SessionDetail | null {
  const stmts = ensureStmts(db);
  const row = stmts.getById.get(sessionId) as SessionRow | undefined;
  if (!row) return null;
  return rowToDetail(row);
}

// For later use in M4-008+. Updates status and any provided optional fields.
// Fields not included in the `fields` object are left unchanged.
export interface SetSessionStatusFields {
  failureReason?: string | null;
  failureDetail?: string | null;
  exitedAt?: string | null;
  startedAt?: string | null;
  pid?: number | null;
  command?: string | null;
  argsJson?: string | null;
  cwd?: string | null;
  terminalCols?: number | null;
  terminalRows?: number | null;
  exitCode?: number | null;
  exitSignal?: string | null;
}

const FIELD_TO_COL: Record<keyof SetSessionStatusFields, string> = {
  failureReason: 'failure_reason',
  failureDetail: 'failure_detail',
  exitedAt: 'exited_at',
  startedAt: 'started_at',
  pid: 'pid',
  command: 'command',
  argsJson: 'args_json',
  cwd: 'cwd',
  terminalCols: 'terminal_cols',
  terminalRows: 'terminal_rows',
  exitCode: 'exit_code',
  exitSignal: 'exit_signal',
};

export function setSessionStatus(
  db: Database.Database,
  sessionId: string,
  status: string,
  fields?: SetSessionStatusFields
): void {
  const sets = ['status = ?'];
  const params: unknown[] = [status];

  if (fields) {
    for (const key of Object.keys(fields) as (keyof SetSessionStatusFields)[]) {
      sets.push(`${FIELD_TO_COL[key]} = ?`);
      params.push(fields[key]);
    }
  }

  params.push(sessionId);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}
