import { describe, expect, it } from "vitest";
import { validateTemplatePipeline } from "./validate-pipeline.js";
import type { WorkflowStepTemplate } from "@orca/contracts";

const step = (id: string, ordinal: number, outputKeys: string[]): WorkflowStepTemplate => ({
  id,
  ordinal,
  name: id,
  instructions: "x",
  outputSchema: outputKeys.map((k) => ({ key: k, type: "string" as const, required: true })),
  agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
});

describe("validateTemplatePipeline", () => {
  it("returns no warnings when no instructions reference later-step keys", () => {
    const w = validateTemplatePipeline([step("a", 0, ["x"]), step("b", 1, ["y"])]);
    expect(w).toEqual([]);
  });

  it("warns when a later step's instructions reference an unknown earlier key", () => {
    const steps: WorkflowStepTemplate[] = [
      step("a", 0, ["alpha"]),
      { ...step("b", 1, ["y"]), instructions: "Use the {{beta}} from step a." },
    ];
    const w = validateTemplatePipeline(steps);
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/beta/);
  });
});
