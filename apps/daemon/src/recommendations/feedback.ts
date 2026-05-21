import type Database from 'better-sqlite3';
import { RecommendationFeedback } from '@orca/contracts';

interface FeedbackDbRow {
  id: string;
  recommendation_id: string;
  goal_id: string;
  action: string;
  note: string | null;
  modified_payload_json: string | null;
  created_at: string;
}

function rowToFeedback(row: FeedbackDbRow): RecommendationFeedback {
  return RecommendationFeedback.parse({
    id: row.id,
    goalId: row.goal_id,
    recommendationId: row.recommendation_id,
    action: row.action,
    note: row.note,
    modifiedPayloadJson: row.modified_payload_json,
    createdAt: row.created_at,
  });
}

let _db: Database.Database | null = null;
let _stmts: {
  insert: Database.Statement;
  getById: Database.Statement;
  getByRecommendationId: Database.Statement;
  getTerminal: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insert: db.prepare(`
        INSERT INTO recommendation_feedback
          (id, recommendation_id, goal_id, action, note, modified_payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      getById: db.prepare(
        'SELECT * FROM recommendation_feedback WHERE id = ?'
      ),
      getByRecommendationId: db.prepare(
        'SELECT * FROM recommendation_feedback WHERE recommendation_id = ? ORDER BY created_at ASC LIMIT ?'
      ),
      getTerminal: db.prepare(
        "SELECT * FROM recommendation_feedback WHERE recommendation_id = ? AND action IN ('accept','reject','dismiss') LIMIT 1"
      ),
    };
  }
  return _stmts!;
}

export function resetFeedbackStatements(): void {
  _db = null;
  _stmts = null;
}

export interface InsertFeedbackInput {
  id: string;
  goalId: string;
  recommendationId: string;
  action: string;
  note: string | null;
  modifiedPayloadJson: string | null;
  createdAt: string;
}

/** May throw SQLITE_CONSTRAINT_UNIQUE for terminal actions (accept/reject/dismiss). */
export function insertFeedback(db: Database.Database, input: InsertFeedbackInput): void {
  ensureStmts(db).insert.run(
    input.id,
    input.recommendationId,
    input.goalId,
    input.action,
    input.note,
    input.modifiedPayloadJson,
    input.createdAt
  );
}

export function getFeedbackById(db: Database.Database, id: string): RecommendationFeedback | null {
  const row = ensureStmts(db).getById.get(id) as FeedbackDbRow | undefined;
  return row ? rowToFeedback(row) : null;
}

export function getFeedbackByRecommendationId(
  db: Database.Database,
  recommendationId: string,
  limit = 50
): RecommendationFeedback[] {
  const rows = ensureStmts(db).getByRecommendationId.all(
    recommendationId,
    Math.min(limit, 200)
  ) as FeedbackDbRow[];
  return rows.map(rowToFeedback);
}

export function listRecentFeedbackByGoal(
  db: Database.Database,
  goalId: string,
  limit = 10
): RecommendationFeedback[] {
  const rows = db
    .prepare(
      'SELECT * FROM recommendation_feedback WHERE goal_id = ? ORDER BY created_at DESC LIMIT ?'
    )
    .all(goalId, Math.min(limit, 50)) as FeedbackDbRow[];
  return rows.map(rowToFeedback);
}

export function getTerminalFeedbackByRecommendationId(
  db: Database.Database,
  recommendationId: string
): RecommendationFeedback | null {
  const row = ensureStmts(db).getTerminal.get(recommendationId) as FeedbackDbRow | undefined;
  return row ? rowToFeedback(row) : null;
}
