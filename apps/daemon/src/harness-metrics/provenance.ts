import type Database from "better-sqlite3";
import {
  HarnessTransition,
  WorkflowGuardrailEvaluation,
  type WorkflowDecisionInfluence,
  type WorkflowDecisionTrace,
} from "@orca/contracts";
import { getDecisionById } from "../workflows/decisions/usecases.js";

export interface TransitionProvenance {
  transition: HarnessTransition;
  decisions: WorkflowDecisionTrace[];
  alternatives: string[];
  influencedBy: WorkflowDecisionInfluence[];
  guardrailEvals: WorkflowGuardrailEvaluation[];
}

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

interface GuardrailEvalRow {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  step_run_id: string | null;
  guardrail_id: string;
  guardrail_kind: string;
  decision_id: string | null;
  result: string;
  message: string | null;
  created_at: string;
}

function parseFacet(value: string | null): Record<string, unknown> | null {
  return value === null ? null : (JSON.parse(value) as Record<string, unknown>);
}

function loadTransition(db: Database.Database, transitionId: string): HarnessTransition | null {
  const row = db
    .prepare(
      `SELECT id, goal_id, workflow_run_id, workflow_step_run_id, boundary,
              risk_json, evidence_json, state_deps_json, telemetry_json, created_at
       FROM harness_transitions WHERE id = ?`
    )
    .get(transitionId) as TransitionRow | undefined;
  if (!row) return null;
  return HarnessTransition.parse({
    id: row.id,
    goalId: row.goal_id,
    workflowRunId: row.workflow_run_id,
    workflowStepRunId: row.workflow_step_run_id,
    boundary: row.boundary,
    risk: parseFacet(row.risk_json),
    evidence: parseFacet(row.evidence_json),
    stateDeps: parseFacet(row.state_deps_json),
    telemetry: parseFacet(row.telemetry_json),
    createdAt: row.created_at,
  });
}

/**
 * Read-only multi-hop lineage for a single harness transition. From the
 * transition's `workflowRunId` + `workflowStepRunId` we hop to the related
 * `workflow_decisions` (reusing `getDecisionById`, which parses their
 * `influenced_by_json` / `alternatives_considered_json`) and to the related
 * `workflow_guardrail_evaluations`. A transition with a null run/step yields
 * empty hops (not an error). An unknown transition yields `null` (fail-closed;
 * the route maps it to 404).
 *
 * Join key: decisions and guardrail-evals are matched to the transition by
 * `workflow_run_id` AND `step_run_id`. We require both to match so a transition
 * scoped to one step never pulls in sibling-step decisions on the same run.
 */
export function buildProvenance(
  db: Database.Database,
  transitionId: string
): TransitionProvenance | null {
  const transition = loadTransition(db, transitionId);
  if (!transition) return null;

  const empty: TransitionProvenance = {
    transition,
    decisions: [],
    alternatives: [],
    influencedBy: [],
    guardrailEvals: [],
  };

  const { workflowRunId, workflowStepRunId } = transition;
  if (workflowRunId === null || workflowStepRunId === null) return empty;

  const decisionIds = db
    .prepare(
      `SELECT id FROM workflow_decisions
       WHERE workflow_run_id = ? AND step_run_id = ?
       ORDER BY created_at DESC, id ASC`
    )
    .all(workflowRunId, workflowStepRunId) as Array<{ id: string }>;

  const decisions = decisionIds
    .map((d) => getDecisionById(db, d.id))
    .filter((d): d is WorkflowDecisionTrace => d !== null);

  const alternatives = decisions.flatMap((d) => d.alternativesConsidered ?? []);
  const influencedBy = decisions.flatMap((d) => d.influencedBy);

  const guardrailRows = db
    .prepare(
      `SELECT id, goal_id, workflow_run_id, step_run_id, guardrail_id, guardrail_kind,
              decision_id, result, message, created_at
       FROM workflow_guardrail_evaluations
       WHERE workflow_run_id = ? AND step_run_id = ?
       ORDER BY created_at DESC, id ASC`
    )
    .all(workflowRunId, workflowStepRunId) as GuardrailEvalRow[];

  const guardrailEvals = guardrailRows.map((row) =>
    WorkflowGuardrailEvaluation.parse({
      id: row.id,
      goalId: row.goal_id,
      workflowRunId: row.workflow_run_id,
      stepRunId: row.step_run_id,
      guardrailId: row.guardrail_id,
      guardrailKind: row.guardrail_kind,
      decisionId: row.decision_id,
      result: row.result,
      message: row.message,
      createdAt: row.created_at,
    })
  );

  return { transition, decisions, alternatives, influencedBy, guardrailEvals };
}
