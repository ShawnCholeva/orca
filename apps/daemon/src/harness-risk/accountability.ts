import type Database from "better-sqlite3";
import type { EventBus } from "../events.js";
import type { Classification } from "./classify.js";
import { createDecision } from "../decisions/usecases.js";

const REMEMBER_THRESHOLD = 3; // mirrors the revise/retry caps convention

export interface AccountabilityCtx { db: Database.Database; bus: EventBus; now?: () => string; }

let _db: Database.Database | null = null;
let _stmts: { get: Database.Statement; upsert: Database.Statement } | null = null;
function ensure(db: Database.Database) {
  if (db !== _db) {
    _db = db;
    _stmts = {
      get: db.prepare("SELECT consecutive_approvals FROM gate_approval_counts WHERE goal_id = ? AND action_class = ?"),
      upsert: db.prepare(
        `INSERT INTO gate_approval_counts (goal_id, action_class, consecutive_approvals, last_decision, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(goal_id, action_class) DO UPDATE SET consecutive_approvals = excluded.consecutive_approvals, last_decision = excluded.last_decision, updated_at = excluded.updated_at`
      ),
    };
  }
  return _stmts!;
}
export function resetPreparedStatements(): void { _db = null; _stmts = null; }

// Retention: drop a goal's approval-streak rows when the goal is archived
// (the table otherwise grows one row per (goal_id, action_class) with no reaper).
export function deleteApprovalCountsForGoal(db: Database.Database, goalId: string): void {
  db.prepare("DELETE FROM gate_approval_counts WHERE goal_id = ?").run(goalId);
}

export function actionClassOf(toolName: string, c: Classification): string {
  return `${toolName}:${c.permissionTier}`;
}

export function recordApprovalOutcome(
  ctx: AccountabilityCtx,
  input: { goalId: string; actionClass: string; decision: "allow" | "deny" }
): { suggestRemember: boolean } {
  const now = ctx.now?.() ?? new Date().toISOString();
  const stmts = ensure(ctx.db);
  const row = stmts.get.get(input.goalId, input.actionClass) as { consecutive_approvals: number } | undefined;
  const prev = row?.consecutive_approvals ?? 0;
  const next = input.decision === "allow" ? prev + 1 : 0;
  stmts.upsert.run(input.goalId, input.actionClass, next, input.decision, now);
  return { suggestRemember: input.decision === "allow" && next >= REMEMBER_THRESHOLD };
}

// Read-only streak check used at message-creation time to advertise canRemember
// once the action class has already accumulated the remember threshold.
export function shouldSuggestRemember(db: Database.Database, goalId: string, actionClass: string): boolean {
  const stmts = ensure(db);
  const row = stmts.get.get(goalId, actionClass) as { consecutive_approvals: number } | undefined;
  return (row?.consecutive_approvals ?? 0) >= REMEMBER_THRESHOLD;
}

// Records an auditable GoalDecision when a gate is relaxed (always-allow remembered).
export function recordRelaxationDecision(
  ctx: AccountabilityCtx,
  input: { goalId: string; actionClass: string }
): string {
  const decision = createDecision(
    { db: ctx.db, bus: ctx.bus, now: ctx.now },
    {
      goalId: input.goalId,
      title: `Gate relaxed: ${input.actionClass}`,
      decisionText: `Always-allow enabled for action class "${input.actionClass}" after repeated approvals.`,
      rationale: "User chose to remember this approval; future matching actions auto-allow per executable accountability.",
      status: "confirmed",
      confirmationRequired: false,
    }
  );
  return decision.id;
}
