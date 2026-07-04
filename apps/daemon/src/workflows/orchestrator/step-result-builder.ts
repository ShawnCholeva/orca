import type Database from "better-sqlite3";
import {
  StoredStepResultScoring,
  type StepResultScoringFacts,
  type WorkflowRun as WorkflowRunT,
  type WorkflowStepResult,
  type WorkflowStepTemplate,
} from "@orca/contracts";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";
import {
  buildEvaluationFailedStepResult,
  buildScoredStepResult,
  durationSeconds,
  mapStepRunStatusToResultStatus,
} from "../steps/step-result.js";
import { scoreStepResult } from "./step-result-scoring.js";
import type { GoalRow, StepRunRow } from "./db-rows.js";

export interface StepResultBuilderDeps {
  broker: Pick<OrchestrationTransportBroker, "propose">;
  readStepOutputAsRecord: (db: Database.Database, runId: string, stepRunId: string) => Record<string, unknown> | null;
  retryCount: (stepRun: StepRunRow) => number;
  artifactCountForStep: (db: Database.Database, stepRunId: string) => number;
}

/** Clamps a display string to a schema char limit, marking truncation with an
 *  ellipsis so the cutoff is visible. Returns the input unchanged when it fits. */
function clampToLimit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function scoringFacts(
  deps: StepResultBuilderDeps,
  db: Database.Database,
  stepRun: StepRunRow,
  terminalStatus: "passed" | "blocked" | "failed" | "skipped",
  finishedAt: string
): StepResultScoringFacts {
  return {
    stepId: stepRun.id,
    stepStatus: mapStepRunStatusToResultStatus(terminalStatus),
    performance: {
      durationSeconds: durationSeconds(stepRun.started_at, finishedAt),
      retries: deps.retryCount(stepRun),
    },
    outcome: {
      producedArtifactsCount: deps.artifactCountForStep(db, stepRun.id),
      blockingIssuesCount: terminalStatus === "blocked" || terminalStatus === "failed" ? 1 : 0,
      warningsCount: 0,
    },
  };
}

/**
 * Builds the terminal step result for a normal approval. Scoring is owned by
 * the shadow orchestrator and arrives on the approve_step_complete action;
 * the daemon owns the measured facts. Missing or invalid scoring yields a
 * non-blocking evaluation-failure result.
 */
export function buildApprovalStepResult(
  deps: StepResultBuilderDeps,
  db: Database.Database,
  ctx: { stepRun: StepRunRow },
  scoring: unknown,
  finishedAt: string
): WorkflowStepResult {
  const facts = scoringFacts(deps, db, ctx.stepRun, "passed", finishedAt);
  const proposal = StoredStepResultScoring.safeParse(scoring);
  if (proposal.success) {
    const result = buildScoredStepResult(facts, proposal.data);
    return withResultSummary(deps, db, ctx.stepRun, result);
  }
  if (scoring !== undefined) {
    // Field paths + codes only (never values) so a rejected score is debuggable
    // without leaking model-authored content into the logs.
    console.warn("[scoring] approval scoring rejected", {
      stepRunId: ctx.stepRun.id,
      issues: proposal.error.issues.map((i) => `${i.path.join(".")}:${i.code}`),
    });
  }
  return buildEvaluationFailedStepResult({
    stepId: ctx.stepRun.id,
    stepStatus: facts.stepStatus,
    startedAt: ctx.stepRun.started_at,
    finishedAt,
    retries: facts.performance.retries,
    producedArtifactsCount: facts.outcome.producedArtifactsCount,
    blockingIssuesCount: facts.outcome.blockingIssuesCount,
    warningsCount: facts.outcome.warningsCount,
    reason: scoring === undefined ? "approval omitted scoring proposal" : "invalid step result scoring proposal",
  });
}

/** Attaches the step's own output summary + primary artifact to a built result,
 *  so the result card can lead with the result rather than the scoring reason. */
export function withResultSummary(
  deps: StepResultBuilderDeps,
  db: Database.Database,
  stepRun: StepRunRow,
  result: WorkflowStepResult,
): WorkflowStepResult {
  const output = deps.readStepOutputAsRecord(db, stepRun.workflow_run_id, stepRun.id);
  if (!output) return result;
  // These are denormalized display fields; the full text lives in the
  // step_output artifact. Clamp to the WorkflowStepResult schema's own limits
  // so an over-length agent summary can't fail validation and strand the step.
  const summary =
    typeof output.summary === "string" ? clampToLimit(output.summary, 2000) : undefined;
  const artifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
  const chosen =
    artifacts.find((a) => a && typeof a === "object" && (a as { type?: unknown }).type === "spec") ??
    artifacts[0];
  let primaryArtifact: { reference: string; description: string } | undefined;
  if (chosen && typeof chosen === "object") {
    const ref = (chosen as { reference?: unknown }).reference;
    const desc = (chosen as { description?: unknown }).description;
    if (typeof ref === "string") {
      primaryArtifact = {
        reference: clampToLimit(ref, 1024),
        description: clampToLimit(typeof desc === "string" ? desc : "", 512),
      };
    }
  }
  return {
    ...result,
    ...(summary ? { resultSummary: summary } : {}),
    ...(primaryArtifact ? { primaryArtifact } : {}),
  };
}

/**
 * Replay/reconciliation: step_output already exists but step_result_json is
 * null (crash between artifact write and result persistence). There is no
 * live approval turn or worker session to score against, so we write a
 * deterministic evaluation-failure result from measured facts — no model call.
 */
export function replayEvaluationFailedResult(
  deps: StepResultBuilderDeps,
  db: Database.Database,
  stepRun: StepRunRow,
  finishedAt: string
): WorkflowStepResult {
  const facts = scoringFacts(deps, db, stepRun, "passed", finishedAt);
  return buildEvaluationFailedStepResult({
    stepId: stepRun.id,
    stepStatus: facts.stepStatus,
    startedAt: stepRun.started_at,
    finishedAt,
    retries: facts.performance.retries,
    producedArtifactsCount: facts.outcome.producedArtifactsCount,
    blockingIssuesCount: facts.outcome.blockingIssuesCount,
    warningsCount: facts.outcome.warningsCount,
    reason: "result recovered on replay without live scoring",
  });
}

export async function scoreCompletedStepResult(
  deps: StepResultBuilderDeps,
  db: Database.Database,
  ctx: {
    run: WorkflowRunT;
    stepRun: StepRunRow;
    stepTpl: WorkflowStepTemplate;
    goal: GoalRow;
  },
  output: Record<string, unknown> | null,
  finishedAt: string
): Promise<WorkflowStepResult> {
  const facts = scoringFacts(deps, db, ctx.stepRun, "passed", finishedAt);
  if (!ctx.goal.orchestrator_provider || !ctx.goal.orchestrator_model) {
    return buildEvaluationFailedStepResult({
      stepId: ctx.stepRun.id,
      stepStatus: facts.stepStatus,
      startedAt: ctx.stepRun.started_at,
      finishedAt,
      retries: facts.performance.retries,
      producedArtifactsCount: facts.outcome.producedArtifactsCount,
      blockingIssuesCount: facts.outcome.blockingIssuesCount,
      warningsCount: facts.outcome.warningsCount,
      reason: "orchestrator model not configured",
    });
  }

  let result;
  try {
    result = await scoreStepResult(
      { broker: deps.broker },
      {
        goalId: ctx.goal.id,
        workflowRunId: ctx.run.id,
        stepRunId: ctx.stepRun.id,
        providerId: ctx.goal.orchestrator_provider,
        modelId: ctx.goal.orchestrator_model,
        goal: { id: ctx.goal.id, description: ctx.goal.description },
        step: {
          id: ctx.stepRun.id,
          templateId: ctx.stepTpl.id,
          name: ctx.stepTpl.name,
          instructions: ctx.stepTpl.instructions,
          status: "passed",
        },
        output,
        facts,
      }
    );
  } catch (err) {
    return buildEvaluationFailedStepResult({
      stepId: ctx.stepRun.id,
      stepStatus: facts.stepStatus,
      startedAt: ctx.stepRun.started_at,
      finishedAt,
      retries: facts.performance.retries,
      producedArtifactsCount: facts.outcome.producedArtifactsCount,
      blockingIssuesCount: facts.outcome.blockingIssuesCount,
      warningsCount: facts.outcome.warningsCount,
      reason: err instanceof Error ? err.message : "step result scoring threw",
    });
  }

  if (result.ok) return result.stepResult;

  return buildEvaluationFailedStepResult({
    stepId: ctx.stepRun.id,
    stepStatus: facts.stepStatus,
    startedAt: ctx.stepRun.started_at,
    finishedAt,
    retries: facts.performance.retries,
    producedArtifactsCount: facts.outcome.producedArtifactsCount,
    blockingIssuesCount: facts.outcome.blockingIssuesCount,
    warningsCount: facts.outcome.warningsCount,
    reason: result.reason,
  });
}
