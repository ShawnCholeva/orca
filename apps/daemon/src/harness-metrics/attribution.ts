import type Database from "better-sqlite3";

export interface FailureCluster {
  failure_code: string | null;
  boundary: string;
  count: number;
  sample_transition_ids: string[];
}

interface ClusterRow {
  failure_code: string | null;
  boundary: string;
  count: number;
}

interface SampleRow {
  id: string;
}

// Statuses that represent a non-successful outcome worth attributing.
const FAILED_STATUSES = "('failed','escalated','denied')";

let _db: Database.Database | null = null;
let _stmts: {
  clusters: Database.Statement;
  samples: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      // Cluster FAILED transitions by the categorical failure code (read out of
      // the telemetry facet JSON) and the boundary, ordered most-frequent-first.
      clusters: db.prepare(
        `SELECT json_extract(telemetry_json, '$.outcome.failure_code') AS failure_code,
                boundary,
                COUNT(*) AS count
         FROM harness_transitions
         WHERE goal_id = ?
           AND json_extract(telemetry_json, '$.outcome.status') IN ${FAILED_STATUSES}
         GROUP BY failure_code, boundary
         ORDER BY count DESC, failure_code ASC, boundary ASC`
      ),
      // Up to 3 representative transition ids for one (failure_code, boundary)
      // cluster, oldest-first for a stable sample.
      samples: db.prepare(
        `SELECT id FROM harness_transitions
         WHERE goal_id = ?
           AND json_extract(telemetry_json, '$.outcome.status') IN ${FAILED_STATUSES}
           AND boundary = ?
           AND json_extract(telemetry_json, '$.outcome.failure_code') IS ?
         ORDER BY created_at ASC, id ASC
         LIMIT 3`
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

/**
 * Read-only failure attribution. Clusters this goal's non-successful harness
 * transitions (`failed` / `escalated` / `denied`) by `(failure_code, boundary)`,
 * reading the categorical `failure_code` out of the telemetry facet JSON via
 * `json_extract`. Clusters are ordered by count descending; each carries up to
 * 3 sample transition ids. A goal with no failures yields `[]`.
 */
export function attributeFailures(db: Database.Database, goalId: string): FailureCluster[] {
  const stmts = ensureStmts(db);
  const rows = stmts.clusters.all(goalId) as ClusterRow[];
  return rows.map((row) => {
    const samples = stmts.samples.all(goalId, row.boundary, row.failure_code) as SampleRow[];
    return {
      failure_code: row.failure_code,
      boundary: row.boundary,
      count: row.count,
      sample_transition_ids: samples.map((s) => s.id),
    };
  });
}
