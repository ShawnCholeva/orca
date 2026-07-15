import type Database from "better-sqlite3";
import { WorkflowRun, type WorkflowRun as WorkflowRunT } from "@orca/contracts";

interface WorkflowRunRow {
  id: string;
  goal_id: string;
  template_id: string;
  template_version: number;
  status: string;
  current_step_run_id: string | null;
  started_at: string;
  finished_at: string | null;
  blocked_reason: string | null;
  current_node_id: string | null;
  current_node_kind: string | null;
  traversal_seq: number;
  pending_split_route_json: string | null;
  pending_gate_route_json: string | null;
}

const RUN_COLUMNS =
  "id, goal_id, template_id, template_version, status, current_step_run_id, started_at, finished_at, blocked_reason, current_node_id, current_node_kind, traversal_seq, pending_split_route_json, pending_gate_route_json";

let _db: Database.Database | null = null;
let _stmts: {
  getById: Database.Statement;
  listByGoal: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (_db !== db) {
    _db = db;
    _stmts = {
      getById: db.prepare(
        `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE id = ?`
      ),
      listByGoal: db.prepare(
        `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE goal_id = ? ORDER BY started_at DESC`
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

function rowToRun(row: WorkflowRunRow): WorkflowRunT {
  // Surface a pending human routing choice (set when a splitter parked because it
  // could not be routed deterministically and the orchestrator gave no decision).
  let pendingSplitChoice: WorkflowRunT["pendingSplitChoice"] = null;
  if (row.pending_split_route_json) {
    try {
      const s = JSON.parse(row.pending_split_route_json) as {
        needsHumanChoice?: boolean;
        splitterNodeId?: string;
        prompt?: string;
        options?: Array<{ branch: string; label: string }>;
      };
      if (s.needsHumanChoice && s.splitterNodeId && Array.isArray(s.options) && s.options.length > 0) {
        pendingSplitChoice = {
          splitterNodeId: s.splitterNodeId,
          prompt: s.prompt ?? "Choose the next step.",
          options: s.options.map((o) => ({ branch: o.branch, label: o.label })),
        };
      }
    } catch {
      // ignore malformed stash; leave pendingSplitChoice null
    }
  }
  // Surface a worker-gate's recommendation while parked awaiting a human decision
  // (Task 4c stores it on the gate stash). The card renders reasoning + issueRefs.
  let pendingGateReview: WorkflowRunT["pendingGateReview"] = null;
  if (row.pending_gate_route_json) {
    try {
      const g = JSON.parse(row.pending_gate_route_json) as {
        awaitingHumanDecision?: boolean;
        gateNodeId?: string;
        recommendedOutcome?: "approved" | "rejected";
        reasoning?: string | null;
        issueRefs?: string[];
      };
      if (g.awaitingHumanDecision && g.gateNodeId && (g.recommendedOutcome === "approved" || g.recommendedOutcome === "rejected")) {
        pendingGateReview = {
          gateNodeId: g.gateNodeId,
          recommendedOutcome: g.recommendedOutcome,
          reasoning: g.reasoning ?? null,
          issueRefs: Array.isArray(g.issueRefs) ? g.issueRefs : [],
        };
      }
    } catch {
      // ignore malformed stash; leave pendingGateReview null
    }
  }
  return WorkflowRun.parse({
    id: row.id,
    goalId: row.goal_id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    status: row.status,
    currentStepRunId: row.current_step_run_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    blockedReason: row.blocked_reason,
    currentNodeId: row.current_node_id,
    currentNodeKind: row.current_node_kind,
    traversalSeq: row.traversal_seq,
    pendingSplitChoice,
    pendingGateReview,
  });
}

export function getWorkflowRunById(
  db: Database.Database,
  id: string
): WorkflowRunT | null {
  const row = ensureStmts(db).getById.get(id) as WorkflowRunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listWorkflowRunsForGoal(
  db: Database.Database,
  goalId: string
): WorkflowRunT[] {
  const rows = ensureStmts(db).listByGoal.all(goalId) as WorkflowRunRow[];
  return rows.map(rowToRun);
}
