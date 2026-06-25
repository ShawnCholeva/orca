import type Database from "better-sqlite3";
import { HarnessTransition, HARNESS_FACETS } from "@orca/contracts";

interface TransitionRow {
  id: string;
  goal_id: string;
  workflow_run_id: string | null;
  workflow_step_run_id: string | null;
  boundary: string;
  risk_json: string | null;
  evidence_json: string | null;
  state_deps_json: string | null;
  telemetry_json: string | null;
  created_at: string;
}

const ENVELOPE_COLS = ["id", "goal_id", "workflow_run_id", "workflow_step_run_id", "boundary"];
const FACET_COLS = HARNESS_FACETS.map((f) => f.column);
const ALL_COLS = [...ENVELOPE_COLS, ...FACET_COLS, "created_at"];
const COLS = ALL_COLS.join(", ");
const PLACEHOLDERS = ALL_COLS.map(() => "?").join(", ");

let _db: Database.Database | null = null;
let _stmts: {
  insert: Database.Statement;
  listByGoal: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insert: db.prepare(
        `INSERT INTO harness_transitions (${COLS}) VALUES (${PLACEHOLDERS})`
      ),
      listByGoal: db.prepare(
        `SELECT ${COLS} FROM harness_transitions
         WHERE goal_id = ? ORDER BY created_at DESC, id ASC LIMIT ?`
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

function parseFacet(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  return JSON.parse(value) as Record<string, unknown>;
}

function rowToTransition(row: TransitionRow): HarnessTransition {
  const facets: Record<string, unknown> = {};
  for (const f of HARNESS_FACETS) {
    facets[f.key] = parseFacet(row[f.column as keyof TransitionRow] as string | null);
  }
  return HarnessTransition.parse({
    id: row.id,
    goalId: row.goal_id,
    workflowRunId: row.workflow_run_id,
    workflowStepRunId: row.workflow_step_run_id,
    boundary: row.boundary,
    ...facets,
    createdAt: row.created_at,
  });
}

export function insertTransition(db: Database.Database, row: HarnessTransition): void {
  const stmts = ensureStmts(db);
  const facetArgs = HARNESS_FACETS.map((f) => {
    const v = (row as Record<string, unknown>)[f.key];
    return v == null ? null : JSON.stringify(v);
  });
  stmts.insert.run(
    row.id,
    row.goalId,
    row.workflowRunId,
    row.workflowStepRunId,
    row.boundary,
    ...facetArgs,
    row.createdAt
  );
}

export function listTransitionsByGoal(
  db: Database.Database,
  goalId: string,
  limit = 100
): HarnessTransition[] {
  const stmts = ensureStmts(db);
  const rows = stmts.listByGoal.all(goalId, limit) as TransitionRow[];
  return rows.map(rowToTransition);
}
