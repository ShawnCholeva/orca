import {
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  WorkflowStepResult,
  type StepResultScoringFacts,
  type StepResultScoringProposal,
  type WorkflowStepResult as WorkflowStepResultT,
  type WorkflowStepResultStatus,
} from "@orca/contracts";

import { redactSecrets } from "../../memory/normalize.js";

type TerminalStepRunStatus = "passed" | "blocked" | "failed" | "skipped";

export interface StepResultFactsInput {
  stepId: string;
  stepStatus: WorkflowStepResultStatus;
  startedAt: string | null;
  finishedAt: string;
  retries: number;
  producedArtifactsCount: number;
  blockingIssuesCount: number;
  warningsCount: number;
}

export interface EvaluationFailedStepResultInput extends StepResultFactsInput {
  reason: string;
}

export function mapStepRunStatusToResultStatus(status: string): WorkflowStepResultStatus {
  switch (status as TerminalStepRunStatus) {
    case "passed":
      return "completed";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "skipped":
      return "cancelled" as WorkflowStepResultStatus;
    default:
      throw new Error(`non-terminal step status cannot produce step_result: ${status}`);
  }
}

export function durationSeconds(startedAt: string | null, finishedAt: string): number {
  if (!startedAt) return 0;
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started) {
    return 0;
  }
  return Math.floor((finished - started) / 1000);
}

export function sanitizeStepResultReason(reason: string): string {
  const sanitized = redactSecrets(reason.replace(/\s+/g, " ").trim()).slice(
    0,
    WORKFLOW_FAILURE_MAX_MESSAGE_CHARS
  );
  return sanitized.length > 0 ? sanitized : "unknown evaluation failure";
}

export function buildEvaluationFailedStepResult(
  input: EvaluationFailedStepResultInput
): WorkflowStepResultT {
  const reason = `step result evaluation failed: ${sanitizeStepResultReason(input.reason)}`.slice(
    0,
    WORKFLOW_FAILURE_MAX_MESSAGE_CHARS
  );

  return WorkflowStepResult.parse({
    stepId: input.stepId,
    stepStatus: input.stepStatus,
    evaluationStatus: "failed",
    successScore: 0,
    quality: {
      outputCompleteness: 0,
      outputCorrectness: 0,
      instructionAdherence: 0,
      downstreamReadiness: 0,
      riskLevel: 1,
    },
    performance: {
      durationSeconds: durationSeconds(input.startedAt, input.finishedAt),
      retries: input.retries,
    },
    outcome: {
      reason,
      producedArtifactsCount: input.producedArtifactsCount,
      blockingIssuesCount: input.blockingIssuesCount,
      warningsCount: input.warningsCount,
      handoffReady: false,
    },
  });
}

export function sanitizeStepResult(result: WorkflowStepResultT): WorkflowStepResultT {
  return WorkflowStepResult.parse({
    ...result,
    outcome: {
      ...result.outcome,
      reason: sanitizeStepResultReason(result.outcome.reason),
    },
  });
}

export function serializeStepResult(result: WorkflowStepResultT): string {
  return JSON.stringify(WorkflowStepResult.parse(result));
}

export function buildScoredStepResult(
  facts: StepResultScoringFacts,
  proposal: StepResultScoringProposal
): WorkflowStepResultT {
  return WorkflowStepResult.parse({
    stepId: facts.stepId,
    stepStatus: facts.stepStatus,
    evaluationStatus: "scored",
    successScore: proposal.successScore,
    quality: proposal.quality,
    performance: facts.performance,
    outcome: {
      reason: sanitizeStepResultReason(proposal.reason),
      producedArtifactsCount: facts.outcome.producedArtifactsCount,
      blockingIssuesCount: facts.outcome.blockingIssuesCount,
      warningsCount: facts.outcome.warningsCount,
      handoffReady: proposal.handoffReady,
    },
  });
}
