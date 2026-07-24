import type Database from "better-sqlite3";
import { HARNESS_FACETS, HarnessTransition } from "@orca/contracts";

export type TemplateTransition = {
  transition: HarnessTransition;
  templateVersion: number;
  stepTemplateId: string | null;
};
export type TemplateStepRun = {
  workflowRunId: string;
  stepTemplateId: string;
  attempt: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  blockedReason: string | null;
  templateVersion: number;
};
export type TemplateRunInfo = { templateId: string; name: string; latestVersion: number };
export type GateDecisionRow = {
  id: string;
  workflowRunId: string;
  nodeId: string;
  traversalSeq: number;
  outcome: "approved" | "rejected";
  reason: string;
  selectedEdgeTo: string;
  issueRefs: string[];
  recommendedOutcome: "approved" | "rejected" | null;
  recommendedReason: string | null;
  createdAt: string;
  templateVersion: number;
};
export type SplitDecisionRow = {
  id: string;
  workflowRunId: string;
  nodeId: string;
  traversalSeq: number;
  selectedBranch: string;
  selectedEdgeTo: string;
  createdAt: string;
  templateVersion: number;
};

const FACET_COLS = HARNESS_FACETS.map((f) => `ht.${f.column}`).join(", ");

interface TransitionJoinRow {
  id: string; goal_id: string; workflow_run_id: string | null; workflow_step_run_id: string | null;
  boundary: string; created_at: string; template_version: number; step_template_id: string | null;
  [facetColumn: string]: unknown;
}

function rowToTemplateTransition(row: TransitionJoinRow): TemplateTransition {
  const facets: Record<string, unknown> = {};
  for (const f of HARNESS_FACETS) {
    const raw = row[f.column] as string | null;
    facets[f.key] = raw == null ? null : JSON.parse(raw);
  }
  const transition = HarnessTransition.parse({
    id: row.id, goalId: row.goal_id, workflowRunId: row.workflow_run_id,
    workflowStepRunId: row.workflow_step_run_id, boundary: row.boundary,
    ...facets, createdAt: row.created_at,
  });
  return { transition, templateVersion: row.template_version, stepTemplateId: row.step_template_id };
}

// Portable, JSON-free join (F2): no json_extract, no SQLite-specific ops. The facet
// columns are selected as opaque TEXT and parsed in TS.
export function listTransitionsByTemplate(
  db: Database.Database, templateId: string, sinceIso: string, untilIso: string
): TemplateTransition[] {
  const rows = db.prepare(
    `SELECT ht.id, ht.goal_id, ht.workflow_run_id, ht.workflow_step_run_id, ht.boundary, ht.created_at,
            ${FACET_COLS}, wr.template_version AS template_version, wsr.step_template_id AS step_template_id
     FROM harness_transitions ht
     JOIN workflow_runs wr ON wr.id = ht.workflow_run_id
     LEFT JOIN workflow_step_runs wsr ON wsr.id = ht.workflow_step_run_id
     WHERE wr.template_id = ? AND ht.created_at >= ? AND ht.created_at < ?
     ORDER BY ht.created_at ASC, ht.id ASC`
  ).all(templateId, sinceIso, untilIso) as TransitionJoinRow[];
  return rows.map(rowToTemplateTransition);
}

export function listStepRunsByTemplate(
  db: Database.Database, templateId: string, sinceIso: string, untilIso: string
): TemplateStepRun[] {
  const rows = db.prepare(
    `SELECT wsr.workflow_run_id, wsr.step_template_id, wsr.attempt, wsr.status,
            wsr.started_at, wsr.finished_at, wsr.blocked_reason, wr.template_version
     FROM workflow_step_runs wsr
     JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
     WHERE wr.template_id = ? AND wsr.started_at >= ? AND wsr.started_at < ?
     ORDER BY wsr.started_at ASC, wsr.id ASC`
  ).all(templateId, sinceIso, untilIso) as {
    workflow_run_id: string; step_template_id: string; attempt: number; status: string;
    started_at: string | null; finished_at: string | null; blocked_reason: string | null; template_version: number;
  }[];
  return rows.map((r) => ({
    workflowRunId: r.workflow_run_id, stepTemplateId: r.step_template_id, attempt: r.attempt,
    status: r.status, startedAt: r.started_at, finishedAt: r.finished_at,
    blockedReason: r.blocked_reason, templateVersion: r.template_version,
  }));
}

export function listGateDecisionsByTemplate(
  db: Database.Database, templateId: string, sinceIso: string, untilIso: string
): GateDecisionRow[] {
  const rows = db.prepare(
    `SELECT gd.id, gd.workflow_run_id, gd.node_id, gd.traversal_seq, gd.outcome, gd.reason,
            gd.selected_edge_to, gd.issue_refs_json, gd.recommended_outcome, gd.recommended_reason,
            gd.created_at, wr.template_version
     FROM workflow_gate_decisions gd
     JOIN workflow_runs wr ON wr.id = gd.workflow_run_id
     WHERE wr.template_id = ? AND gd.created_at >= ? AND gd.created_at < ?
     ORDER BY gd.created_at ASC, gd.id ASC`
  ).all(templateId, sinceIso, untilIso) as {
    id: string; workflow_run_id: string; node_id: string; traversal_seq: number;
    outcome: "approved" | "rejected"; reason: string; selected_edge_to: string; issue_refs_json: string;
    recommended_outcome: "approved" | "rejected" | null; recommended_reason: string | null;
    created_at: string; template_version: number;
  }[];
  return rows.map((r) => ({
    id: r.id, workflowRunId: r.workflow_run_id, nodeId: r.node_id, traversalSeq: r.traversal_seq,
    outcome: r.outcome, reason: r.reason, selectedEdgeTo: r.selected_edge_to,
    issueRefs: JSON.parse(r.issue_refs_json) as string[],
    recommendedOutcome: r.recommended_outcome, recommendedReason: r.recommended_reason,
    createdAt: r.created_at, templateVersion: r.template_version,
  }));
}

export function listSplitDecisionsByTemplate(
  db: Database.Database, templateId: string, sinceIso: string, untilIso: string
): SplitDecisionRow[] {
  const rows = db.prepare(
    `SELECT sd.id, sd.workflow_run_id, sd.node_id, sd.traversal_seq, sd.selected_branch,
            sd.selected_edge_to, sd.created_at, wr.template_version
     FROM workflow_split_decisions sd
     JOIN workflow_runs wr ON wr.id = sd.workflow_run_id
     WHERE wr.template_id = ? AND sd.created_at >= ? AND sd.created_at < ?
     ORDER BY sd.created_at ASC, sd.id ASC`
  ).all(templateId, sinceIso, untilIso) as Array<{
    id: string; workflow_run_id: string; node_id: string; traversal_seq: number;
    selected_branch: string; selected_edge_to: string; created_at: string; template_version: number;
  }>;
  return rows.map((r) => ({
    id: r.id, workflowRunId: r.workflow_run_id, nodeId: r.node_id, traversalSeq: r.traversal_seq,
    selectedBranch: r.selected_branch, selectedEdgeTo: r.selected_edge_to,
    createdAt: r.created_at, templateVersion: r.template_version,
  }));
}

export function listTemplatesWithRuns(db: Database.Database): TemplateRunInfo[] {
  const rows = db.prepare(
    `SELECT t.id AS template_id, t.name AS name, t.version AS latest_version
     FROM workflow_templates t
     WHERE EXISTS (SELECT 1 FROM workflow_runs r WHERE r.template_id = t.id)
     ORDER BY t.name ASC`
  ).all() as { template_id: string; name: string; latest_version: number }[];
  return rows.map((r) => ({ templateId: r.template_id, name: r.name, latestVersion: r.latest_version }));
}
