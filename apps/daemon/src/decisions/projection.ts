import type Database from 'better-sqlite3';
import { GoalDecision } from '@orca/contracts';

interface DecisionRow {
  id: string;
  goal_id: string;
  title: string;
  decision_text: string;
  rationale: string | null;
  status: string;
  confirmation_required: number;
  confidence: number | null;
  source_type: string;
  source_id: string | null;
  source_session_id: string | null;
  source_extraction_id: string | null;
  source_offset_first: number | null;
  source_offset_last: number | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  archived_at: string | null;
}

export interface UpdateDecisionPatch {
  title?: string;
  decisionText?: string;
  rationale?: string | null;
  status?: GoalDecision['status'];
  confirmationRequired?: boolean;
  confidence?: number | null;
  sourceType?: GoalDecision['sourceType'];
  sourceId?: string | null;
  sourceSessionId?: string | null;
  sourceExtractionId?: string | null;
  sourceOffsetFirst?: number | null;
  sourceOffsetLast?: number | null;
  updatedAt: string;
  confirmedAt?: string | null;
  archivedAt?: string | null;
}

export interface ListDecisionsOptions {
  includeArchived?: boolean;
}

const DECISION_COLS = `id, goal_id, title, decision_text, rationale, status, confirmation_required,
  confidence, source_type, source_id, source_session_id, source_extraction_id,
  source_offset_first, source_offset_last, created_at, updated_at, confirmed_at, archived_at`;

let _db: Database.Database | null = null;
let _stmts: {
  insertDecision: Database.Statement;
  getDecisionById: Database.Statement;
  listDecisionsByGoal: Database.Statement;
  listDecisionsByGoalIncludingArchived: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertDecision: db.prepare(
        `INSERT INTO goal_decisions (
          id, goal_id, title, decision_text, rationale, status, confirmation_required,
          confidence, source_type, source_id, source_session_id, source_extraction_id,
          source_offset_first, source_offset_last, created_at, updated_at, confirmed_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      getDecisionById: db.prepare(`SELECT ${DECISION_COLS} FROM goal_decisions WHERE id = ?`),
      listDecisionsByGoal: db.prepare(
        `SELECT ${DECISION_COLS}
         FROM goal_decisions
         WHERE goal_id = ?
           AND status != 'archived'
         ORDER BY
           CASE status
             WHEN 'proposed' THEN 0
             WHEN 'confirmed' THEN 1
             ELSE 2
           END,
           created_at DESC,
           id ASC`
      ),
      listDecisionsByGoalIncludingArchived: db.prepare(
        `SELECT ${DECISION_COLS}
         FROM goal_decisions
         WHERE goal_id = ?
         ORDER BY
           CASE status
             WHEN 'proposed' THEN 0
             WHEN 'confirmed' THEN 1
             ELSE 2
           END,
           created_at DESC,
           id ASC`
      ),
    };
  }
  return _stmts!;
}

function rowToDecision(row: DecisionRow): GoalDecision {
  return GoalDecision.parse({
    id: row.id,
    goalId: row.goal_id,
    title: row.title,
    decisionText: row.decision_text,
    rationale: row.rationale,
    status: row.status,
    confirmationRequired: row.confirmation_required !== 0,
    confidence: row.confidence,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceSessionId: row.source_session_id,
    sourceExtractionId: row.source_extraction_id,
    sourceOffsetFirst: row.source_offset_first,
    sourceOffsetLast: row.source_offset_last,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    archivedAt: row.archived_at,
  });
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

export function listDecisionsByGoal(
  db: Database.Database,
  goalId: string,
  options: ListDecisionsOptions = {}
): GoalDecision[] {
  const stmts = ensureStmts(db);
  const statement = options.includeArchived
    ? stmts.listDecisionsByGoalIncludingArchived
    : stmts.listDecisionsByGoal;
  const rows = statement.all(goalId) as DecisionRow[];
  return rows.map(rowToDecision);
}

export function getDecisionById(db: Database.Database, id: string): GoalDecision | null {
  const stmts = ensureStmts(db);
  const row = stmts.getDecisionById.get(id) as DecisionRow | undefined;
  if (!row) {
    return null;
  }
  return rowToDecision(row);
}

export function insertDecision(db: Database.Database, row: GoalDecision): void {
  const stmts = ensureStmts(db);
  stmts.insertDecision.run(
    row.id,
    row.goalId,
    row.title,
    row.decisionText,
    row.rationale,
    row.status,
    row.confirmationRequired ? 1 : 0,
    row.confidence,
    row.sourceType,
    row.sourceId,
    row.sourceSessionId,
    row.sourceExtractionId,
    row.sourceOffsetFirst,
    row.sourceOffsetLast,
    row.createdAt,
    row.updatedAt,
    row.confirmedAt,
    row.archivedAt
  );
}

const DECISION_PATCH_COLS: Record<Exclude<keyof UpdateDecisionPatch, 'updatedAt'>, string> = {
  title: 'title',
  decisionText: 'decision_text',
  rationale: 'rationale',
  status: 'status',
  confirmationRequired: 'confirmation_required',
  confidence: 'confidence',
  sourceType: 'source_type',
  sourceId: 'source_id',
  sourceSessionId: 'source_session_id',
  sourceExtractionId: 'source_extraction_id',
  sourceOffsetFirst: 'source_offset_first',
  sourceOffsetLast: 'source_offset_last',
  confirmedAt: 'confirmed_at',
  archivedAt: 'archived_at',
};

export function updateDecision(
  db: Database.Database,
  id: string,
  patch: UpdateDecisionPatch
): void {
  const sets = ['updated_at = ?'];
  const params: unknown[] = [patch.updatedAt];

  for (const key of Object.keys(DECISION_PATCH_COLS) as (keyof typeof DECISION_PATCH_COLS)[]) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) {
      continue;
    }
    sets.push(`${DECISION_PATCH_COLS[key]} = ?`);
    params.push(key === 'confirmationRequired' ? ((patch[key] as boolean) ? 1 : 0) : patch[key]);
  }

  params.push(id);
  db.prepare(`UPDATE goal_decisions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}
