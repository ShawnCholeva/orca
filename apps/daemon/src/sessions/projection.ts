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

const SESSION_COLS = `id, goal_id, workspace_id, adapter_id, role, instruction, title, status, pid,
  command, args_json, cwd, terminal_cols, terminal_rows, exit_code, exit_signal,
  failure_reason, failure_detail, created_at, started_at, exited_at, archived_at`;

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
        `SELECT ${SESSION_COLS} FROM sessions WHERE goal_id = ? ORDER BY created_at DESC, id ASC`
      ),
      getById: db.prepare(
        `SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`
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
