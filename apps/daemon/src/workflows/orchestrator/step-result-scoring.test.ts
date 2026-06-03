import { describe, expect, it, vi } from "vitest";
import { scoreStepResult, type StepResultScoringInput } from "./step-result-scoring.js";

const input: StepResultScoringInput = {
  goalId: "goal-1",
  workflowRunId: "run-1",
  stepRunId: "step-1",
  providerId: "orca/anthropic",
  modelId: "claude-sonnet-4-6",
  goal: { id: "goal-1", description: "Build the feature." },
  step: {
    id: "step-1",
    templateId: "execution",
    name: "Execution",
    instructions: "Implement the plan.",
    status: "passed",
  },
  output: { summary: "Done." },
  facts: {
    stepId: "step-1",
    stepStatus: "completed",
    performance: { durationSeconds: 30, retries: 0 },
    outcome: {
      producedArtifactsCount: 1,
      blockingIssuesCount: 0,
      warningsCount: 0,
    },
  },
};

describe("scoreStepResult", () => {
  it("returns a strict scored step result", async () => {
    const propose = vi.fn(async (_req, options) => {
      const proposal = {
        successScore: 0.8,
        quality: {
          outputCompleteness: 0.8,
          outputCorrectness: 0.75,
          instructionAdherence: 0.9,
          downstreamReadiness: 0.85,
          riskLevel: 0.2,
        },
        reason: "Ready for handoff.",
        handoffReady: true,
      };
      const validated = await options.validateProposal(proposal);
      return {
        status: "proposed" as const,
        attemptId: "attempt-1",
        transport: "one_shot" as const,
        parsed: validated.accepted ? validated.parsed : proposal,
        rawTextLength: 10,
        latencyMs: 1,
      };
    });

    const result = await scoreStepResult({ broker: { propose } }, input);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.stepResult).toMatchObject({
      stepId: "step-1",
      stepStatus: "completed",
      evaluationStatus: "scored",
      successScore: 0.8,
      outcome: {
        reason: "Ready for handoff.",
        handoffReady: true,
        producedArtifactsCount: 1,
      },
    });
  });

  it("returns failure for invalid proposals", async () => {
    const propose = vi.fn(async (_req, options) => {
      await options.validateProposal({ successScore: 2 });
      return {
        status: "needs_human_review" as const,
        attemptId: "attempt-1",
        reviewPayloadId: "review-1",
      };
    });

    const result = await scoreStepResult({ broker: { propose } }, input);

    expect(result.ok).toBe(false);
    expect(propose).toHaveBeenCalledTimes(2);
    expect(result.ok === false && result.reason).toMatch(
      /invalid step result scoring proposal: invalid step result scoring proposal structure/i
    );
  });

  it("returns failure for non-proposed broker result", async () => {
    const propose = vi.fn(async () => ({
      status: "needs_human_review" as const,
      attemptId: "attempt-1",
      reviewPayloadId: "review-1",
    }));

    const result = await scoreStepResult({ broker: { propose } }, input);

    expect(result.ok).toBe(false);
    expect(propose).toHaveBeenCalledTimes(2);
    expect(result.ok === false && result.reason).toMatch(/step result scoring did not produce/i);
  });
});
