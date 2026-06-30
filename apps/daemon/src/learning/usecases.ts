import type Database from "better-sqlite3";
import type { MetricPeriod, TemplateInstructionProposal } from "@orca/contracts";
import { getTemplateMetricsDetail } from "../metrics/usecases.js";
import { windowStart } from "../metrics/aggregate.js";
import { listRevisionSignalsByTemplate } from "./fetch.js";
import { diagnoseTemplate } from "./diagnose.js";
import { proposeInstructionRevision, type BrokerLike } from "./propose.js";
import { enrichWithRegression } from "./canary.js";
import {
  insertProposal, listProposalsByTemplate, pendingProposalForStep,
} from "./store.js";

export interface AnalyzeDeps { broker: BrokerLike }

function nowOr(nowIso?: string): string { return nowIso ?? new Date().toISOString(); }

// B has no goal of its own; reuse the orchestrator model of the anchor run's goal.
function orchestratorModelForGoal(db: Database.Database, goalId: string): { providerId: string; modelId: string } | null {
  const row = db.prepare(`SELECT orchestrator_provider, orchestrator_model FROM goals WHERE id = ?`).get(goalId) as
    { orchestrator_provider: string | null; orchestrator_model: string | null } | undefined;
  if (!row?.orchestrator_provider || !row.orchestrator_model) return null;
  return { providerId: row.orchestrator_provider, modelId: row.orchestrator_model };
}

function stepInstructions(db: Database.Database, templateId: string): Map<string, string> {
  const row = db.prepare(`SELECT steps_json FROM workflow_templates WHERE id = ?`).get(templateId) as { steps_json: string } | undefined;
  const map = new Map<string, string>();
  if (!row) return map;
  const steps = JSON.parse(row.steps_json) as { id: string; instructions?: string }[];
  for (const s of steps) map.set(s.id, s.instructions ?? "");
  return map;
}

// Anchor the broker request to the most recent qualifying evidence transition.
function anchorForStep(db: Database.Database, templateId: string, stepTemplateId: string): { goalId: string; workflowRunId: string; stepRunId: string } | null {
  const row = db.prepare(
    `SELECT ht.goal_id AS goal_id, ht.workflow_run_id AS workflow_run_id, ht.workflow_step_run_id AS step_run_id
     FROM harness_transitions ht
     JOIN workflow_runs wr ON wr.id = ht.workflow_run_id
     JOIN workflow_step_runs wsr ON wsr.id = ht.workflow_step_run_id
     WHERE wr.template_id = ? AND wsr.step_template_id = ?
     ORDER BY ht.created_at DESC LIMIT 1`
  ).get(templateId, stepTemplateId) as { goal_id: string; workflow_run_id: string; step_run_id: string } | undefined;
  return row ? { goalId: row.goal_id, workflowRunId: row.workflow_run_id, stepRunId: row.step_run_id } : null;
}

function uuid(): string {
  // Reuse the daemon's id helper if one exists; crypto.randomUUID is available in Node 18+.
  return (globalThis.crypto as Crypto).randomUUID();
}

export async function analyzeTemplate(
  deps: AnalyzeDeps, db: Database.Database, templateId: string, period: MetricPeriod, nowIso?: string,
): Promise<TemplateInstructionProposal[]> {
  const now = nowOr(nowIso);
  const detail = getTemplateMetricsDetail(db, templateId, period, now);
  if (!detail) return []; // caller maps null template to 404 before this
  const since = windowStart(now, period);
  const signals = listRevisionSignalsByTemplate(db, templateId, since, now);
  const bundles = diagnoseTemplate({ detail, signals, stepInstructions: stepInstructions(db, templateId) });

  const created: TemplateInstructionProposal[] = [];
  for (const bundle of bundles) {
    // Dedupe: keep an existing pending proposal for the step.
    const existing = pendingProposalForStep(db, templateId, bundle.stepTemplateId);
    if (existing) { created.push(existing); continue; }
    const anchor = anchorForStep(db, templateId, bundle.stepTemplateId);
    if (!anchor) continue;
    const model = orchestratorModelForGoal(db, anchor.goalId);
    if (!model) continue; // can't propose without a provider/model
    const fill = await proposeInstructionRevision({ broker: deps.broker, ...model }, anchor, bundle);
    if (!fill) continue;
    const proposal: TemplateInstructionProposal = {
      id: uuid(), templateId, templateVersionAtProposal: detail.summary.latestVersion,
      stepTemplateId: bundle.stepTemplateId, component: "step_instructions",
      beforeInstructions: bundle.currentInstructions, afterInstructions: fill.proposedInstructions,
      targetedFailureMode: bundle.targetedFailureMode,
      predictedImprovement: fill.predictedImprovement, invariantsPreserved: fill.invariantsPreserved,
      falsifier: "version_comparison", rollbackPlan: "revert_to_before",
      evidence: { sampleTransitionIds: bundle.evidence.sampleTransitionIds, revisionSignalIds: bundle.evidence.revisionSignalIds, metricSnapshot: bundle.evidence.metricSnapshot },
      rationale: fill.rationale, humanEdited: false, status: "pending",
      createdAt: now, decidedAt: null, decidedBy: null, appliedAsVersion: null,
    };
    insertProposal(db, proposal);
    created.push(proposal);
  }
  return created;
}

export function listProposalsEnriched(db: Database.Database, templateId: string, period: MetricPeriod, nowIso?: string): TemplateInstructionProposal[] {
  const detail = getTemplateMetricsDetail(db, templateId, period, nowOr(nowIso));
  const proposals = listProposalsByTemplate(db, templateId);
  return detail ? enrichWithRegression(proposals, detail.summary) : proposals;
}
