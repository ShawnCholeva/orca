import { describe, expect, it } from "vitest";
import type { WorkflowGuardrailConfig, WorkflowStepTemplate } from "@orca/contracts";
import { stepCompletionGate, stepRequiresExecution } from "./requires-execution.js";

const guardrails: WorkflowGuardrailConfig[] = [
  {
    id: "validation_required",
    kind: "validation_rule",
    label: "Require tests/typecheck",
    configJson: { appliesToSteps: ["execution"], required: ["unit_tests", "typecheck"] },
  },
];

describe("stepRequiresExecution", () => {
  it("returns required labels for a covered step", () => {
    expect(stepRequiresExecution(guardrails, "execution")).toEqual({
      required: ["unit_tests", "typecheck"],
    });
  });
  it("returns null for an uncovered step", () => {
    expect(stepRequiresExecution(guardrails, "research")).toBeNull();
  });
  it("returns null when there is no validation_rule guardrail", () => {
    expect(stepRequiresExecution([], "execution")).toBeNull();
  });
});

function step(id: string, grounding?: WorkflowStepTemplate["grounding"]): WorkflowStepTemplate {
  return {
    id, ordinal: 0, name: id, instructions: "do it",
    outputSchema: [{ key: "summary", type: "string", required: true }],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
    ...(grounding ? { grounding } : {}),
  };
}

describe("stepCompletionGate", () => {
  const checks: WorkflowStepTemplate["grounding"] = [
    { rule: "paths_exist", field: "files_in_scope", mode: "enforce" },
  ];

  it("gates on sensors only, grounding only, both, or neither", () => {
    expect(stepCompletionGate(guardrails, step("execution"))).toEqual({
      sensors: { required: ["unit_tests", "typecheck"] }, grounding: [], gated: true,
    });
    expect(stepCompletionGate(guardrails, step("research", checks))).toEqual({
      sensors: null, grounding: checks, gated: true,
    });
    expect(stepCompletionGate(guardrails, step("execution", checks))).toEqual({
      sensors: { required: ["unit_tests", "typecheck"] }, grounding: checks, gated: true,
    });
    expect(stepCompletionGate(guardrails, step("clarify"))).toEqual({
      sensors: null, grounding: [], gated: false,
    });
  });
});
