import type Database from 'better-sqlite3';
import {
  Recommendation,
  RecommendationGeneration,
  RecommendationSourceRef,
} from '@orca/contracts';
import type { ProposedAction } from '@orca/contracts';

interface RecommendationDbRow {
  id: string;
  goal_id: string;
  generation_id: string | null;
  type: string;
  status: string;
  source: string;
  title: string;
  rationale: string;
  proposed_action_json: string;
  confidence: number;
  sources_json: string;
  related_task_id: string | null;
  related_session_id: string | null;
  related_context_pkg_id: string | null;
  related_conflict_id: string | null;
  fingerprint: string;
  superseded_by_id: string | null;
  superseded_reason: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface RecommendationGenerationDbRow {
  id: string;
  goal_id: string;
  trigger: string;
  trigger_source_id: string | null;
  provider_id: string;
  provider_version: string;
  input_fingerprint: string;
  request_fingerprint: string;
  status: string;
  failure_code: string | null;
  failure_message: string | null;
  recommendation_ids_json: string;
  superseded_ids_json: string;
  sparse: number;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function rowToRecommendation(row: RecommendationDbRow): Recommendation {
  return Recommendation.parse({
    id: row.id,
    goalId: row.goal_id,
    generationId: row.generation_id,
    type: row.type,
    status: row.status,
    source: row.source,
    title: row.title,
    rationale: row.rationale,
    proposedAction: JSON.parse(row.proposed_action_json) as ProposedAction,
    confidence: row.confidence,
    sources: JSON.parse(row.sources_json) as RecommendationSourceRef[],
    relatedTaskId: row.related_task_id,
    relatedSessionId: row.related_session_id,
    relatedContextPackageId: row.related_context_pkg_id,
    relatedConflictId: row.related_conflict_id,
    fingerprint: row.fingerprint,
    supersededById: row.superseded_by_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToGeneration(row: RecommendationGenerationDbRow): RecommendationGeneration {
  return RecommendationGeneration.parse({
    id: row.id,
    goalId: row.goal_id,
    trigger: row.trigger,
    triggerSourceId: row.trigger_source_id,
    providerId: row.provider_id,
    providerVersion: row.provider_version,
    inputFingerprint: row.input_fingerprint,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    sparse: row.sparse !== 0,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

let _db: Database.Database | null = null;
let _stmts: {
  insertRecommendation: Database.Statement;
  updateStatus: Database.Statement;
  updateSuperseded: Database.Statement;
  updateModify: Database.Statement;
  getById: Database.Statement;
  insertGeneration: Database.Statement;
  updateGenerationRunning: Database.Statement;
  updateGenerationSucceeded: Database.Statement;
  updateGenerationFailed: Database.Statement;
  getGenerationById: Database.Statement;
  getActiveGenerationByFp: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertRecommendation: db.prepare(`
        INSERT INTO recommendations
          (id, goal_id, generation_id, type, status, source, title, rationale,
           proposed_action_json, confidence, sources_json, related_task_id,
           related_session_id, related_context_pkg_id, related_conflict_id,
           fingerprint, superseded_by_id, superseded_reason, created_at, updated_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateStatus: db.prepare(
        'UPDATE recommendations SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?'
      ),
      updateSuperseded: db.prepare(
        'UPDATE recommendations SET status = ?, superseded_by_id = ?, superseded_reason = ?, resolved_at = ?, updated_at = ? WHERE id = ?'
      ),
      updateModify: db.prepare(
        'UPDATE recommendations SET title = ?, rationale = ?, proposed_action_json = ?, source = ?, status = ?, fingerprint = ?, updated_at = ? WHERE id = ?'
      ),
      getById: db.prepare('SELECT * FROM recommendations WHERE id = ?'),
      insertGeneration: db.prepare(`
        INSERT OR IGNORE INTO recommendation_generations
          (id, goal_id, trigger, trigger_source_id, provider_id, provider_version,
           input_fingerprint, request_fingerprint, status, failure_code, failure_message,
           recommendation_ids_json, superseded_ids_json, sparse, requested_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, '[]', '[]', 0, ?, NULL, NULL)
      `),
      updateGenerationRunning: db.prepare(
        "UPDATE recommendation_generations SET status = 'running', started_at = ? WHERE id = ?"
      ),
      updateGenerationSucceeded: db.prepare(
        "UPDATE recommendation_generations SET status = 'succeeded', recommendation_ids_json = ?, superseded_ids_json = ?, sparse = ?, finished_at = ? WHERE id = ?"
      ),
      updateGenerationFailed: db.prepare(
        "UPDATE recommendation_generations SET status = 'failed', failure_code = ?, failure_message = ?, finished_at = ? WHERE id = ?"
      ),
      getGenerationById: db.prepare('SELECT * FROM recommendation_generations WHERE id = ?'),
      getActiveGenerationByFp: db.prepare(`
        SELECT * FROM recommendation_generations
        WHERE goal_id = ? AND request_fingerprint = ? AND status IN ('pending', 'running', 'succeeded')
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

// ── Recommendation helpers ────────────────────────────────────────────────────

export interface InsertRecommendationInput {
  id: string;
  goalId: string;
  generationId: string | null;
  type: string;
  status: string;
  source: string;
  title: string;
  rationale: string;
  proposedActionJson: string;
  confidence: number;
  sourcesJson: string;
  relatedTaskId: string | null;
  relatedSessionId: string | null;
  relatedContextPkgId: string | null;
  relatedConflictId: string | null;
  fingerprint: string;
  supersededById: string | null;
  createdAt: string;
  updatedAt: string;
}

export function insertRecommendation(db: Database.Database, input: InsertRecommendationInput): void {
  ensureStmts(db).insertRecommendation.run(
    input.id,
    input.goalId,
    input.generationId,
    input.type,
    input.status,
    input.source,
    input.title,
    input.rationale,
    input.proposedActionJson,
    input.confidence,
    input.sourcesJson,
    input.relatedTaskId,
    input.relatedSessionId,
    input.relatedContextPkgId,
    input.relatedConflictId,
    input.fingerprint,
    input.supersededById,
    null,
    input.createdAt,
    input.updatedAt,
    null
  );
}

export function updateRecommendationStatusRow(
  db: Database.Database,
  id: string,
  status: string,
  resolvedAt: string,
  updatedAt: string
): void {
  ensureStmts(db).updateStatus.run(status, resolvedAt, updatedAt, id);
}

export function updateRecommendationSupersededRow(
  db: Database.Database,
  id: string,
  supersededById: string | null,
  supersededReason: string,
  resolvedAt: string,
  updatedAt: string
): void {
  ensureStmts(db).updateSuperseded.run('superseded', supersededById, supersededReason, resolvedAt, updatedAt, id);
}

export interface ModifyRowFields {
  title: string;
  rationale: string;
  proposedActionJson: string;
  fingerprint: string;
}

export function updateRecommendationModifyRow(
  db: Database.Database,
  id: string,
  fields: ModifyRowFields,
  updatedAt: string
): void {
  ensureStmts(db).updateModify.run(
    fields.title,
    fields.rationale,
    fields.proposedActionJson,
    'user_modified',
    'modified',
    fields.fingerprint,
    updatedAt,
    id
  );
}

export function getRecommendationById(db: Database.Database, id: string): Recommendation | null {
  const row = ensureStmts(db).getById.get(id) as RecommendationDbRow | undefined;
  return row ? rowToRecommendation(row) : null;
}

export interface ListRecommendationsOptions {
  goalId: string;
  status?: string;
  type?: string;
  relatedTaskId?: string;
  cursor?: string;
  limit?: number;
}

export function listRecommendationsByGoal(
  db: Database.Database,
  opts: ListRecommendationsOptions
): { recommendations: Recommendation[]; nextCursor: string | null } {
  const { goalId, status, type, relatedTaskId, cursor, limit = 50 } = opts;

  const conds: string[] = ['goal_id = ?'];
  const params: unknown[] = [goalId];

  if (status !== undefined) {
    conds.push('status = ?');
    params.push(status);
  }

  if (type !== undefined) {
    conds.push('type = ?');
    params.push(type);
  }

  if (relatedTaskId !== undefined) {
    conds.push('related_task_id = ?');
    params.push(relatedTaskId);
  }

  if (cursor) {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as { c: string; i: string };
    conds.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(decoded.c, decoded.c, decoded.i);
  }

  const cap = Math.min(limit, 200);
  params.push(cap + 1);

  const rows = db
    .prepare(
      `SELECT * FROM recommendations WHERE ${conds.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(...params) as RecommendationDbRow[];

  let nextCursor: string | null = null;
  if (rows.length > cap) {
    rows.pop();
    const last = rows[rows.length - 1];
    nextCursor = Buffer.from(JSON.stringify({ c: last.created_at, i: last.id })).toString('base64');
  }

  return { recommendations: rows.map(rowToRecommendation), nextCursor };
}

// ── Generation helpers ────────────────────────────────────────────────────────

export interface InsertRecommendationGenerationInput {
  id: string;
  goalId: string;
  trigger: string;
  triggerSourceId: string | null;
  providerId: string;
  providerVersion: string;
  inputFingerprint: string;
  requestFingerprint: string;
  requestedAt: string;
}

/** Returns { generation, isNew }. isNew=false when active fingerprint already exists. */
export function insertOrGetPendingRecommendationGeneration(
  db: Database.Database,
  input: InsertRecommendationGenerationInput
): { generation: RecommendationGeneration; isNew: boolean } {
  const stmts = ensureStmts(db);

  let generation!: RecommendationGeneration;
  let isNew = false;

  db.transaction(() => {
    const result = stmts.insertGeneration.run(
      input.id,
      input.goalId,
      input.trigger,
      input.triggerSourceId,
      input.providerId,
      input.providerVersion,
      input.inputFingerprint,
      input.requestFingerprint,
      input.requestedAt
    );
    if (result.changes > 0) {
      isNew = true;
      generation = rowToGeneration(stmts.getGenerationById.get(input.id) as RecommendationGenerationDbRow);
    } else {
      const existing = stmts.getActiveGenerationByFp.get(
        input.goalId,
        input.requestFingerprint
      ) as RecommendationGenerationDbRow;
      generation = rowToGeneration(existing);
    }
  }).immediate();

  return { generation, isNew };
}

export function markRecommendationGenerationRunning(
  db: Database.Database,
  id: string,
  startedAt: string
): void {
  ensureStmts(db).updateGenerationRunning.run(startedAt, id);
}

export function markRecommendationGenerationSucceeded(
  db: Database.Database,
  id: string,
  recommendationIds: string[],
  supersededIds: string[],
  sparse: boolean,
  finishedAt: string
): void {
  ensureStmts(db).updateGenerationSucceeded.run(
    JSON.stringify(recommendationIds),
    JSON.stringify(supersededIds),
    sparse ? 1 : 0,
    finishedAt,
    id
  );
}

export function markRecommendationGenerationFailed(
  db: Database.Database,
  id: string,
  failureCode: string,
  failureMessage: string | null,
  finishedAt: string
): void {
  ensureStmts(db).updateGenerationFailed.run(failureCode, failureMessage, finishedAt, id);
}

export function getRecommendationGenerationById(
  db: Database.Database,
  id: string
): RecommendationGeneration | null {
  const row = ensureStmts(db).getGenerationById.get(id) as RecommendationGenerationDbRow | undefined;
  return row ? rowToGeneration(row) : null;
}

export function getActiveRecommendationGenerationByFp(
  db: Database.Database,
  goalId: string,
  requestFingerprint: string
): RecommendationGeneration | null {
  const row = ensureStmts(db).getActiveGenerationByFp.get(
    goalId,
    requestFingerprint
  ) as RecommendationGenerationDbRow | undefined;
  return row ? rowToGeneration(row) : null;
}

export function listRecommendationGenerationsByGoal(
  db: Database.Database,
  goalId: string,
  limit = 5
): RecommendationGeneration[] {
  const rows = db
    .prepare(
      'SELECT * FROM recommendation_generations WHERE goal_id = ? ORDER BY requested_at DESC LIMIT ?'
    )
    .all(goalId, limit) as RecommendationGenerationDbRow[];
  return rows.map(rowToGeneration);
}

/** Returns proposed+modified (non-terminal active) recommendations for a goal. */
export function listActiveRecommendationsByGoal(
  db: Database.Database,
  goalId: string,
  limit = 20
): Recommendation[] {
  const rows = db
    .prepare(
      `SELECT * FROM recommendations WHERE goal_id = ? AND status IN ('proposed', 'modified') ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(goalId, limit) as RecommendationDbRow[];
  return rows.map(rowToRecommendation);
}

/** Returns ids of currently proposed recommendations for a goal (for supersede logic). */
export function listProposedRecommendationsByGoalAndFingerprints(
  db: Database.Database,
  goalId: string,
  fingerprints: string[]
): Recommendation[] {
  if (fingerprints.length === 0) return [];
  const placeholders = fingerprints.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM recommendations WHERE goal_id = ? AND status = 'proposed' AND fingerprint IN (${placeholders})`
    )
    .all(goalId, ...fingerprints) as RecommendationDbRow[];
  return rows.map(rowToRecommendation);
}

