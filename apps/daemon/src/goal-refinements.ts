import type Database from "better-sqlite3";
import { GoalRefinement, GuidedRefinementOutput } from "@orca/contracts";
import { z } from "zod";

interface GoalRefinementRow {
  goal_id: string;
  skill_id: string;
  success_criteria: string;
  constraints: string;
  assumptions: string;
  refined_at: string;
}

export interface GoalRefinementInsertRow {
  goalId: string;
  skillId: string;
  successCriteria: string[];
  constraints: string[];
  assumptions: string[];
  refinedAt: string;
}

const StoredRefinementShape = z.object({
  skillId: GuidedRefinementOutput.shape.skillId,
  successCriteria: GuidedRefinementOutput.shape.successCriteria,
  constraints: GuidedRefinementOutput.shape.constraints,
  assumptions: GuidedRefinementOutput.shape.assumptions,
});

let _db: Database.Database | null = null;
let _stmts: {
  upsertGoalRefinement: Database.Statement;
  selectGoalRefinement: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      upsertGoalRefinement: db.prepare(
        "INSERT OR REPLACE INTO goal_refinements (goal_id, skill_id, success_criteria, constraints, assumptions, refined_at) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      selectGoalRefinement: db.prepare(
        "SELECT goal_id, skill_id, success_criteria, constraints, assumptions, refined_at FROM goal_refinements WHERE goal_id = ?",
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

export function insertGoalRefinement(db: Database.Database, row: GoalRefinementInsertRow): void {
  const stmts = ensureStmts(db);
  stmts.upsertGoalRefinement.run(
    row.goalId,
    row.skillId,
    JSON.stringify(row.successCriteria),
    JSON.stringify(row.constraints),
    JSON.stringify(row.assumptions),
    row.refinedAt,
  );
}

function parseArrayField(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

export function getGoalRefinement(db: Database.Database, goalId: string): GoalRefinement | null {
  const stmts = ensureStmts(db);
  const row = stmts.selectGoalRefinement.get(goalId) as GoalRefinementRow | undefined;
  if (!row) {
    return null;
  }

  const parsed = StoredRefinementShape.parse({
    skillId: row.skill_id,
    successCriteria: parseArrayField(row.success_criteria),
    constraints: parseArrayField(row.constraints),
    assumptions: parseArrayField(row.assumptions),
  });

  return GoalRefinement.parse({
    goalId: row.goal_id,
    skillId: parsed.skillId,
    successCriteria: parsed.successCriteria,
    constraints: parsed.constraints,
    assumptions: parsed.assumptions,
    refinedAt: row.refined_at,
  });
}
