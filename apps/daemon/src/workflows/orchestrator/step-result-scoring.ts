import {
  OrchestrationRequest,
  StepResultScoringProposal,
  StepResultScoringRequest,
  WorkflowStepResult,
  type ModelProviderId,
  type StepResultScoringFacts,
  type WorkflowStepResult as WorkflowStepResultT,
  type WorkflowStepRunStatus,
} from "@orca/contracts";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";

export interface StepResultScoringDeps {
  broker: Pick<OrchestrationTransportBroker, "propose">;
}

export interface StepResultScoringInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  providerId: ModelProviderId;
  modelId: string;
  goal: {
    id: string;
    description: string;
  };
  step: {
    id: string;
    templateId: string;
    name: string;
    instructions: string;
    status: WorkflowStepRunStatus;
  };
  output: Record<string, unknown> | null;
  facts: StepResultScoringFacts;
}

export type StepResultScoringResult =
  | { ok: true; stepResult: WorkflowStepResultT }
  | { ok: false; reason: string };

export async function scoreStepResult(
  deps: StepResultScoringDeps,
  input: StepResultScoringInput
): Promise<StepResultScoringResult> {
  const requestPayload = StepResultScoringRequest.parse({
    step: input.step,
    goal: input.goal,
    output: input.output,
    facts: input.facts,
  });

  const request = OrchestrationRequest.parse({
    kind: "score_step_result",
    goalId: input.goalId,
    workflowRunId: input.workflowRunId,
    stepRunId: input.stepRunId,
    providerId: input.providerId,
    modelId: input.modelId,
    payload: requestPayload,
  });

  let lastValidationFailure: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await deps.broker.propose(request, {
      validateProposal: (raw) => {
        const proposal = StepResultScoringProposal.safeParse(raw);
        if (!proposal.success) {
          lastValidationFailure = "invalid step result scoring proposal structure";
          return {
            accepted: false,
            failureMessage: lastValidationFailure,
          };
        }

        const stepResult = WorkflowStepResult.parse({
          stepId: input.facts.stepId,
          stepStatus: input.facts.stepStatus,
          evaluationStatus: "scored",
          successScore: proposal.data.successScore,
          quality: proposal.data.quality,
          performance: input.facts.performance,
          reasoning: proposal.data.reasoning ?? null,
          outcome: {
            reason: proposal.data.reason,
            producedArtifactsCount: input.facts.outcome.producedArtifactsCount,
            blockingIssuesCount: input.facts.outcome.blockingIssuesCount,
            warningsCount: input.facts.outcome.warningsCount,
            handoffReady: proposal.data.handoffReady,
          },
        });

        return { accepted: true, parsed: stepResult };
      },
    });

    if (result.status !== "proposed") {
      continue;
    }

    const parsed = WorkflowStepResult.safeParse(result.parsed);
    if (!parsed.success) {
      return { ok: false, reason: "invalid step result scoring proposal result" };
    }

    return { ok: true, stepResult: parsed.data };
  }

  if (lastValidationFailure) {
    return {
      ok: false,
      reason: `invalid step result scoring proposal: ${lastValidationFailure}`,
    };
  }

  return { ok: false, reason: "step result scoring did not produce a proposal" };
}
