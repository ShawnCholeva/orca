import type Database from 'better-sqlite3';
import { Conflict, type ConflictSourceRef } from '@orca/contracts';

interface ConflictDbRow {
  id: string;
  goal_id: string;
  conflict_type: string;
  severity: string;
  status: string;
  title: string;
  description: string;
  sources_json: string;
  fingerprint: string;
  resolution_note: string | null;
  detected_at: string;
  resolved_at: string | null;
}

function rowToConflict(row: ConflictDbRow): Conflict {
  return Conflict.parse({
    id: row.id,
    goalId: row.goal_id,
    conflictType: row.conflict_type,
    severity: row.severity,
    status: row.status,
    title: row.title,
    description: row.description,
    sources: JSON.parse(row.sources_json) as ConflictSourceRef[],
    fingerprint: row.fingerprint,
    resolutionNote: row.resolution_note,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
  });
}

let _db: Database.Database | null = null;
let _stmts: {
  insert: Database.Statement;
  updateStatus: Database.Statement;
  getById: Database.Statement;
  getByGoalAndFingerprint: Database.Statement;
  getLinkedResolveConflictRec: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insert: db.prepare(`
        INSERT OR IGNORE INTO conflicts
          (id, goal_id, conflict_type, severity, status, title, description,
           sources_json, fingerprint, resolution_note, detected_at, resolved_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL, ?, NULL)
      `),
      updateStatus: db.prepare(
        'UPDATE conflicts SET status = ?, resolution_note = ?, resolved_at = ? WHERE id = ?'
      ),
      getById: db.prepare('SELECT * FROM conflicts WHERE id = ?'),
      getByGoalAndFingerprint: db.prepare(
        "SELECT * FROM conflicts WHERE goal_id = ? AND fingerprint = ? AND status = 'open' LIMIT 1"
      ),
      getLinkedResolveConflictRec: db.prepare(`
        SELECT id, goal_id, status, type
        FROM recommendations
        WHERE related_conflict_id = ? AND type = 'resolve_conflict'
        ORDER BY created_at DESC
        LIMIT 1
      `),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

// ── Conflict row helpers ──────────────────────────────────────────────────────

export interface InsertConflictInput {
  id: string;
  goalId: string;
  conflictType: string;
  severity: string;
  title: string;
  description: string;
  sourcesJson: string;
  fingerprint: string;
  detectedAt: string;
}

/** Returns `{ isNew: true }` if inserted, `{ isNew: false }` if fingerprint already open. */
export function insertConflictRow(
  db: Database.Database,
  input: InsertConflictInput
): { isNew: boolean } {
  const stmts = ensureStmts(db);
  const result = stmts.insert.run(
    input.id,
    input.goalId,
    input.conflictType,
    input.severity,
    input.title,
    input.description,
    input.sourcesJson,
    input.fingerprint,
    input.detectedAt
  );
  return { isNew: result.changes > 0 };
}

export function getExistingOpenConflict(
  db: Database.Database,
  goalId: string,
  fingerprint: string
): Conflict | null {
  const row = ensureStmts(db).getByGoalAndFingerprint.get(goalId, fingerprint) as
    | ConflictDbRow
    | undefined;
  return row ? rowToConflict(row) : null;
}

export function updateConflictStatusRow(
  db: Database.Database,
  id: string,
  status: string,
  resolutionNote: string | null,
  resolvedAt: string
): void {
  ensureStmts(db).updateStatus.run(status, resolutionNote, resolvedAt, id);
}

export function getConflictById(db: Database.Database, id: string): Conflict | null {
  const row = ensureStmts(db).getById.get(id) as ConflictDbRow | undefined;
  return row ? rowToConflict(row) : null;
}

export interface LinkedResolveConflictRec {
  id: string;
  goalId: string;
  status: string;
  type: string;
}

export function getLinkedResolveConflictRec(
  db: Database.Database,
  conflictId: string
): LinkedResolveConflictRec | null {
  const row = ensureStmts(db).getLinkedResolveConflictRec.get(conflictId) as
    | { id: string; goal_id: string; status: string; type: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, goalId: row.goal_id, status: row.status, type: row.type };
}

// ── List conflicts ────────────────────────────────────────────────────────────

export interface ListConflictsOptions {
  goalId: string;
  status?: string;
  severity?: string;
  cursor?: string;
  limit?: number;
}

export function listConflictsByGoal(
  db: Database.Database,
  opts: ListConflictsOptions
): { conflicts: Conflict[]; nextCursor: string | null } {
  const { goalId, status, severity, cursor, limit = 50 } = opts;

  const conds: string[] = ['goal_id = ?'];
  const params: unknown[] = [goalId];

  if (status !== undefined) {
    conds.push('status = ?');
    params.push(status);
  }

  if (severity !== undefined) {
    conds.push('severity = ?');
    params.push(severity);
  }

  if (cursor) {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
      c: string;
      i: string;
    };
    conds.push('(detected_at < ? OR (detected_at = ? AND id < ?))');
    params.push(decoded.c, decoded.c, decoded.i);
  }

  const cap = Math.min(limit, 200);
  params.push(cap + 1);

  const rows = db
    .prepare(
      `SELECT * FROM conflicts WHERE ${conds.join(' AND ')} ORDER BY detected_at DESC, id DESC LIMIT ?`
    )
    .all(...params) as ConflictDbRow[];

  let nextCursor: string | null = null;
  if (rows.length > cap) {
    rows.pop();
    const last = rows[rows.length - 1];
    nextCursor = Buffer.from(JSON.stringify({ c: last.detected_at, i: last.id })).toString(
      'base64'
    );
  }

  return { conflicts: rows.map(rowToConflict), nextCursor };
}
