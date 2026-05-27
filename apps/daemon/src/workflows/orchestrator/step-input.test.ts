import { describe, expect, it } from "vitest";
import { buildStepExecutionInput } from "./step-input.js";
import type { WorkflowArtifact, WorkflowStepTemplate } from "@orca/contracts";

const steps: WorkflowStepTemplate[] = [
  { id: "intake", ordinal: 0, name: "Intake", instructions: "i0", outputSchema: [{ key: "problem", type: "string", required: true }] },
  { id: "research", ordinal: 1, name: "Research", instructions: "i1", outputSchema: [{ key: "summary", type: "string", required: true }] },
];
const goal = { id: "g", description: "make it scroll" };

function out(stepRunId: string, ordinalStepId: string, body: object): WorkflowArtifact {
  return {
    id: `art-${ordinalStepId}`, goalId: "g", workflowRunId: "r", stepRunId,
    type: "step_output", title: ordinalStepId, body: JSON.stringify(body),
    source: "orchestrator", linkedSessionId: null, linkedTaskId: null,
    linkedContextPackageId: null, createdAt: "2026-05-27T00:00:00.000Z",
  } as WorkflowArtifact;
}

describe("buildStepExecutionInput", () => {
  it("ordinal 0 has null previousStepOutput and goal description", () => {
    const env = buildStepExecutionInput({ goal, steps, currentStep: steps[0], artifacts: [], transcript: [], stepRunByStepId: {} });
    expect(env.previousStepOutput).toBeNull();
    expect(env.priorStepOutputs).toEqual([]);
    expect(env.goal.description).toBe("make it scroll");
  });
  it("ordinal N exposes previous output + prior outputs", () => {
    const artifacts = [out("sr0", "intake", { problem: "p" })];
    const env = buildStepExecutionInput({
      goal, steps, currentStep: steps[1], artifacts, transcript: [],
      stepRunByStepId: { intake: "sr0" },
    });
    expect(env.previousStepOutput).toEqual({ problem: "p" });
    expect(env.priorStepOutputs).toEqual([{ stepId: "intake", stepName: "Intake", output: { problem: "p" } }]);
  });
});
