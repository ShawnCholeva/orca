import type Database from 'better-sqlite3';
import { GoalMemoryItem } from '@orca/contracts';

interface MemoryRow {
  id: string;
  goal_id: string;
  type: string;
  status: string;
  content: string;
  content_hash: string;
  confidence: number | null;
  source_type: string;
  source_id: string | null;
  source_session_id: string | null;
  source_extraction_id: string | null;
  source_offset_first: number | null;
  source_offset_last: number | null;
  created_at: string;
  updated_at: string;
  promoted_at: string | null;
  archived_at: string | null;
}

export interface ListMemoryOptions {
  includeArchived: boolean;
}

export interface UpdateMemoryItemPatch {
  type?: GoalMemoryItem['type'];
  status?: GoalMemoryItem['status'];
  content?: string;
  contentHash?: string;
  confidence?: number | null;
  sourceType?: GoalMemoryItem['sourceType'];
  sourceId?: string | null;
  sourceSessionId?: string | null;
  sourceExtractionId?: string | null;
  sourceOffsetFirst?: number | null;
  sourceOffsetLast?: number | null;
  updatedAt: string;
  promotedAt?: string | null;
  archivedAt?: string | null;
}

export class MemoryDuplicateError extends Error {
  readonly code = 'memory_duplicate' as const;

  constructor(
    public readonly goalId: string,
    public readonly type: GoalMemoryItem['type'],
    public readonly contentHash: string
  ) {
    super(`Memory item already exists for goal ${goalId}`);
    this.name = 'MemoryDuplicateError';
  }
}

const MEMORY_COLS = `id, goal_id, type, status, content, content_hash, confidence, source_type,
  source_id, source_session_id, source_extraction_id, source_offset_first, source_offset_last,
  created_at, updated_at, promoted_at, archived_at`;

let _db: Database.Database | null = null;
let _stmts: {
  insertMemoryItem: Database.Statement;
  getMemoryById: Database.Statement;
  listMemoryByGoal: Database.Statement;
  listMemoryByGoalIncludingArchived: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertMemoryItem: db.prepare(
        `INSERT INTO goal_memory_items (
          id, goal_id, type, status, content, content_hash, confidence, source_type, source_id,
          source_session_id, source_extraction_id, source_offset_first, source_offset_last,
          created_at, updated_at, promoted_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      getMemoryById: db.prepare(`SELECT ${MEMORY_COLS} FROM goal_memory_items WHERE id = ?`),
      listMemoryByGoal: db.prepare(
        `SELECT ${MEMORY_COLS}
         FROM goal_memory_items
         WHERE goal_id = ? AND status != 'archived'
         ORDER BY
           CASE status
             WHEN 'promoted' THEN 0
             WHEN 'candidate' THEN 1
             ELSE 2
           END,
           created_at DESC,
           id ASC`
      ),
      listMemoryByGoalIncludingArchived: db.prepare(
        `SELECT ${MEMORY_COLS}
         FROM goal_memory_items
         WHERE goal_id = ?
         ORDER BY
           CASE status
             WHEN 'promoted' THEN 0
             WHEN 'candidate' THEN 1
             ELSE 2
           END,
           created_at DESC,
           id ASC`
      ),
    };
  }
  return _stmts!;
}

function rowToMemoryItem(row: MemoryRow): GoalMemoryItem {
  return GoalMemoryItem.parse({
    id: row.id,
    goalId: row.goal_id,
    type: row.type,
    status: row.status,
    content: row.content,
    contentHash: row.content_hash,
    confidence: row.confidence,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceSessionId: row.source_session_id,
    sourceExtractionId: row.source_extraction_id,
    sourceOffsetFirst: row.source_offset_first,
    sourceOffsetLast: row.source_offset_last,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    promotedAt: row.promoted_at,
    archivedAt: row.archived_at,
  });
}

export function isSqliteUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' && code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

export function listMemoryByGoal(
  db: Database.Database,
  goalId: string,
  options: ListMemoryOptions
): GoalMemoryItem[] {
  const stmts = ensureStmts(db);
  const statement = options.includeArchived
    ? stmts.listMemoryByGoalIncludingArchived
    : stmts.listMemoryByGoal;
  const rows = statement.all(goalId) as MemoryRow[];
  return rows.map(rowToMemoryItem);
}

export function getMemoryById(db: Database.Database, id: string): GoalMemoryItem | null {
  const stmts = ensureStmts(db);
  const row = stmts.getMemoryById.get(id) as MemoryRow | undefined;
  if (!row) {
    return null;
  }
  return rowToMemoryItem(row);
}

export function insertMemoryItem(db: Database.Database, row: GoalMemoryItem): void {
  const stmts = ensureStmts(db);
  try {
    stmts.insertMemoryItem.run(
      row.id,
      row.goalId,
      row.type,
      row.status,
      row.content,
      row.contentHash,
      row.confidence,
      row.sourceType,
      row.sourceId,
      row.sourceSessionId,
      row.sourceExtractionId,
      row.sourceOffsetFirst,
      row.sourceOffsetLast,
      row.createdAt,
      row.updatedAt,
      row.promotedAt,
      row.archivedAt
    );
  } catch (error: unknown) {
    if (isSqliteUniqueConstraintError(error)) {
      throw new MemoryDuplicateError(row.goalId, row.type, row.contentHash);
    }
    throw error;
  }
}

const MEMORY_PATCH_COLS: Record<Exclude<keyof UpdateMemoryItemPatch, 'updatedAt'>, string> = {
  type: 'type',
  status: 'status',
  content: 'content',
  contentHash: 'content_hash',
  confidence: 'confidence',
  sourceType: 'source_type',
  sourceId: 'source_id',
  sourceSessionId: 'source_session_id',
  sourceExtractionId: 'source_extraction_id',
  sourceOffsetFirst: 'source_offset_first',
  sourceOffsetLast: 'source_offset_last',
  promotedAt: 'promoted_at',
  archivedAt: 'archived_at',
};

export function updateMemoryItem(
  db: Database.Database,
  id: string,
  patch: UpdateMemoryItemPatch
): void {
  const sets = ['updated_at = ?'];
  const params: unknown[] = [patch.updatedAt];

  for (const key of Object.keys(MEMORY_PATCH_COLS) as (keyof typeof MEMORY_PATCH_COLS)[]) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) {
      continue;
    }
    sets.push(`${MEMORY_PATCH_COLS[key]} = ?`);
    params.push(patch[key]);
  }

  params.push(id);
  db.prepare(`UPDATE goal_memory_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}
