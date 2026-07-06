import type Database from "better-sqlite3";
import type { MetricPeriod, CounterfactualJudgment, JudgeInstructionEditProposal, ModelProviderId } from "@orca/contracts";
import { JudgeInstructionEditRequest, TemplateInstructionProposal } from "@orca/contracts";
import { getTemplateMetricsDetail } from "../metrics/usecases.js";
import { windowStart } from "../metrics/aggregate.js";
import { listRevisionSignalsByTemplate } from "./fetch.js";
import { diagnoseTemplate } from "./diagnose.js";
import { recordEvent, currentTemplateVersion } from "./events.js";
import { proposeInstructionRevision, type BrokerLike } from "./propose.js";
import { serializeSchema } from "./schema-mutation.js";
import { enrichWithRegression } from "./canary.js";
import { buildJudgeCorpus } from "./corpus.js";
import { judgeInstructionEdit } from "./judge.js";
import { StepNotFoundError, ProposalNotPendingError } from "./apply.js";
import type { ShadowAsk } from "../workflows/orchestrator/recover-step-scoring.js";
import type { ShadowAdapterId } from "../orchestrator-llm/shadow-session.js";
import { adapterIdForProvider } from "../orchestrator-llm/model-provider-llm-client.js";
import { SHADOW_LLM_TIMEOUT_MS } from "../orchestrator-llm/shadow-llm-client.js";
import {
  insertProposal, listProposalsByTemplate, pendingProposalForStep, getProposal, setProposalJudgment,
} from "./store.js";

export interface AnalyzeDeps { broker: BrokerLike }

export interface JudgeDeps {
  shadowAsk: ShadowAsk;
  terminateShadow: (key: string) => Promise<void> | void;
}
// Paper §3.5.2: evaluate on held-out traces; 1-vs-1 corpora overfit the diagnosis.
export const SOLVED_MIN = 2;
export const FAILURE_MIN = 2;

function nowOr(nowIso?: string): string { return nowIso ?? new Date().toISOString(); }

// B has no goal of its own; reuse the orchestrator model of the anchor run's goal.
function orchestratorModelForGoal(db: Database.Database, goalId: string): { providerId: string; modelId: string } | null {
  const row = db.prepare(`SELECT orchestrator_provider, orchestrator_model FROM goals WHERE id = ?`).get(goalId) as
    { orchestrator_provider: string | null; orchestrator_model: string | null } | undefined;
  if (!row?.orchestrator_provider || !row.orchestrator_model) return null;
  return { providerId: row.orchestrator_provider, modelId: row.orchestrator_model };
}

function stepMeta(db: Database.Database, templateId: string): Map<string, { instructions: string; outputSchemaJson: string }> {
  const row = db.prepare(`SELECT steps_json FROM workflow_templates WHERE id = ?`).get(templateId) as { steps_json: string } | undefined;
  const map = new Map<string, { instructions: string; outputSchemaJson: string }>();
  if (!row) return map;
  const steps = JSON.parse(row.steps_json) as { id: string; instructions?: string; outputSchema?: unknown }[];
  for (const s of steps) {
    map.set(s.id, { instructions: s.instructions ?? "", outputSchemaJson: JSON.stringify(s.outputSchema ?? [], null, 2) });
  }
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
  const { bundles, skips: diagnoseSkips } = diagnoseTemplate({ detail, signals, stepMeta: stepMeta(db, templateId) });

  const created: TemplateInstructionProposal[] = [];
  const netSkips: { stepTemplateId: string; reason: string }[] = [];
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
      stepTemplateId: bundle.stepTemplateId, component: bundle.component,
      beforeInstructions: "proposedOutputSchema" in fill ? bundle.currentOutputSchemaJson : bundle.currentInstructions,
      afterInstructions: "proposedOutputSchema" in fill ? serializeSchema(fill.proposedOutputSchema) : fill.proposedInstructions,
      targetedFailureMode: bundle.targetedFailureMode,
      predictedImprovement: fill.predictedImprovement, invariantsPreserved: fill.invariantsPreserved,
      falsifier: "version_comparison", rollbackPlan: "revert_to_before",
      evidence: { sampleTransitionIds: bundle.evidence.sampleTransitionIds, revisionSignalIds: bundle.evidence.revisionSignalIds, metricSnapshot: bundle.evidence.metricSnapshot },
      rationale: fill.rationale, humanEdited: false, status: "pending",
      createdAt: now, decidedAt: null, decidedBy: null, appliedAsVersion: null,
    };
    // Structural net: a contract-invalid proposal must never reach the store, regardless
    // of which upstream path produced it (insertProposal is a raw SQL write with no zod
    // gate, and every read uses a hard .parse — a bad row bricks all subsequent reads).
    const validated = TemplateInstructionProposal.safeParse(proposal);
    if (!validated.success) {
      const reason = (validated.error.issues[0]?.message ?? "invalid proposal").slice(0, 300);
      console.warn(`[learning] skipping unpersistable proposal for step ${bundle.stepTemplateId}: ${validated.error.issues[0]?.message}`);
      netSkips.push({ stepTemplateId: bundle.stepTemplateId, reason });
      continue;
    }
    db.transaction(() => {
      insertProposal(db, validated.data);
      recordEvent(db, {
        templateId, proposalId: validated.data.id, stepTemplateId: validated.data.stepTemplateId,
        eventType: "created", templateVersion: currentTemplateVersion(db, templateId),
        payload: { kind: "created", component: validated.data.component, rule: validated.data.targetedFailureMode.rule, failureCode: validated.data.targetedFailureMode.failureCode },
      }, now);
    })();
    created.push(validated.data);
  }
  const skips = [...diagnoseSkips, ...netSkips].slice(0, 20).map((s) => ({ stepTemplateId: s.stepTemplateId, reason: s.reason.slice(0, 300) }));
  recordEvent(db, {
    templateId, proposalId: null, stepTemplateId: null,
    eventType: "analyzed", templateVersion: currentTemplateVersion(db, templateId),
    payload: { kind: "analyzed", stepsDiagnosed: bundles.length + skips.length, proposalsCreated: created.length, skips },
  }, now);
  return created;
}

export function listProposalsEnriched(db: Database.Database, templateId: string, period: MetricPeriod, nowIso?: string): TemplateInstructionProposal[] {
  const detail = getTemplateMetricsDetail(db, templateId, period, nowOr(nowIso));
  const proposals = listProposalsByTemplate(db, templateId);
  return detail ? enrichWithRegression(proposals, detail.summary, detail.steps) : proposals;
}

// The evaluate stage (5.2): counterfactual-judge a proposal against its own solved/failure
// corpus. Deterministic core owns the flow (buckets, thresholds, persistence); the LLM only
// fills the verdict. Write-once + idempotent — never re-runs the shadow once judged.
export async function judgeProposal(
  deps: JudgeDeps, db: Database.Database, proposalId: string, nowIso?: string,
): Promise<TemplateInstructionProposal> {
  const now = nowOr(nowIso);
  const p = getProposal(db, proposalId);
  if (!p) throw new StepNotFoundError(`proposal ${proposalId} not found`);
  if (p.status !== "pending") throw new ProposalNotPendingError(`proposal ${proposalId} is ${p.status}`);
  if (p.judgment) return p; // write-once + idempotent — never clobber the audit record

  const corpus = buildJudgeCorpus(db, p);
  const base = {
    regressionCases: [] as string[],
    solvedCaseIds: corpus.solved.map((c) => c.stepRunId),
    failureCaseIds: corpus.failure.map((c) => c.stepRunId),
    solvedSampleSize: corpus.solved.length,
    failureSampleSize: corpus.failure.length,
    judgedAt: now,
    judgedAgainstVersion: p.templateVersionAtProposal,
  };

  const persist = (j: CounterfactualJudgment): TemplateInstructionProposal => {
    return db.transaction(() => {
      setProposalJudgment(db, proposalId, j);
      recordEvent(db, {
        templateId: p.templateId, proposalId, stepTemplateId: p.stepTemplateId,
        eventType: "judged", templateVersion: currentTemplateVersion(db, p.templateId),
        payload: { kind: "judged", verdict: j.verdict, solvedSampleSize: j.solvedSampleSize, failureSampleSize: j.failureSampleSize },
      }, now);
      return getProposal(db, proposalId)!;
    })();
  };

  if (corpus.solved.length < SOLVED_MIN || corpus.failure.length < FAILURE_MIN) {
    return persist({ verdict: "insufficient_evidence", regressionRisk: null, addressesFailureMode: null, reason: null, reasoning: null, ...base });
  }

  // Resolve the shadow adapter from the anchor run's goal (per-template; no goal of our own).
  const anchor = anchorForStep(db, p.templateId, p.stepTemplateId);
  const model = anchor ? orchestratorModelForGoal(db, anchor.goalId) : null;
  const adapterId: ShadowAdapterId | null = model
    ? (adapterIdForProvider(model.providerId as ModelProviderId) as ShadowAdapterId)
    : null;

  // Controller decision (aligned with 04d1b09 "degrade instead of throw when a request payload
  // is oversized"): safeParse the judge request rather than .parse — an oversized or otherwise
  // invalid request degrades to "unavailable" below instead of throwing a 500. No shadow spawn
  // is attempted when the request can't be built.
  let request: JudgeInstructionEditRequest | null = null;
  if (adapterId) {
    const parsed = JudgeInstructionEditRequest.safeParse({
      step: {
        name: p.stepTemplateId,
        currentInstructions: p.beforeInstructions.slice(0, 8192),
        proposedInstructions: p.afterInstructions.slice(0, 8192),
        component: p.component,
      },
      targetedFailureMode: p.targetedFailureMode,
      solvedCases: corpus.solved,
      failureCases: corpus.failure,
    });
    if (parsed.success) request = parsed.data;
  }

  let fill: JudgeInstructionEditProposal | null = null;
  if (adapterId && request) {
    const key = `${p.templateId}::judge`;
    try {
      fill = await judgeInstructionEdit(deps.shadowAsk, { judgeSessionKey: key, adapterId, request, timeoutMs: SHADOW_LLM_TIMEOUT_MS });
    } finally {
      await deps.terminateShadow(key); // spawn + teardown per judgment (maximal independence)
    }
  }

  return persist(fill
    ? { verdict: fill.verdict, regressionRisk: fill.regressionRisk, addressesFailureMode: fill.addressesFailureMode,
        regressionCases: fill.regressionCases, reason: fill.reason, reasoning: fill.reasoning ?? null, solvedCaseIds: base.solvedCaseIds,
        failureCaseIds: base.failureCaseIds, solvedSampleSize: base.solvedSampleSize,
        failureSampleSize: base.failureSampleSize, judgedAt: now, judgedAgainstVersion: base.judgedAgainstVersion }
    : { verdict: "unavailable", regressionRisk: null, addressesFailureMode: null, reason: null, reasoning: null, ...base });
}
