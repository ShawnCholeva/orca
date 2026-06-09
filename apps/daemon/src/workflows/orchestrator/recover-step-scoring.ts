import {
  StepResultScoringProposal,
  type StepResultScoringFacts,
  type WorkflowStepResult,
} from "@orca/contracts";
import type { ShadowAdapterId } from "../../orchestrator-llm/shadow-session.js";
import { buildEvaluationFailedStepResult, buildScoredStepResult } from "../steps/step-result.js";

export interface ShadowAsk {
  ask(
    goalId: string,
    input: {
      adapterId: ShadowAdapterId;
      systemPrompt: string;
      userPrompt: string;
      timeoutMs: number;
    }
  ): Promise<{ text: string }>;
}

export interface RecoverStepScoringInput {
  goalId: string;
  adapterId: ShadowAdapterId;
  timeoutMs: number;
  facts: StepResultScoringFacts;
  prompt: { systemPrompt: string; userPrompt: string };
  startedAt?: string | null;
  finishedAt?: string;
}

export async function recoverStepScoring(
  deps: ShadowAsk,
  input: RecoverStepScoringInput
): Promise<WorkflowStepResult> {
  const fail = (reason: string): WorkflowStepResult =>
    buildEvaluationFailedStepResult({
      stepId: input.facts.stepId,
      stepStatus: input.facts.stepStatus,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? new Date().toISOString(),
      retries: input.facts.performance.retries,
      producedArtifactsCount: input.facts.outcome.producedArtifactsCount,
      blockingIssuesCount: input.facts.outcome.blockingIssuesCount,
      warningsCount: input.facts.outcome.warningsCount,
      reason,
    });

  let text: string;
  try {
    ({ text } = await deps.ask(input.goalId, {
      adapterId: input.adapterId,
      systemPrompt: input.prompt.systemPrompt,
      userPrompt: input.prompt.userPrompt,
      timeoutMs: input.timeoutMs,
    }));
  } catch (err) {
    return fail(err instanceof Error ? err.message : "shadow recovery turn failed");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("shadow recovery returned non-JSON");
  }

  const proposal = StepResultScoringProposal.safeParse(raw);
  if (!proposal.success) return fail("shadow recovery returned invalid scoring proposal");
  return buildScoredStepResult(input.facts, proposal.data);
}
