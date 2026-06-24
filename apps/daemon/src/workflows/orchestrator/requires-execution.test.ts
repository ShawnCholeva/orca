import { describe, expect, it } from "vitest";
import type { WorkflowGuardrailConfig } from "@orca/contracts";
import { stepRequiresExecution } from "./requires-execution.js";

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
