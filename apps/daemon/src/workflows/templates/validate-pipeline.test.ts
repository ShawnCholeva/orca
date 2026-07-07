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

  it("accepts grounding checks whose selectors match the schema", () => {
    const steps: WorkflowStepTemplate[] = [
      { ...step("exec", 0, ["completed"]) },
      {
        ...step("done", 1, ["delivered", "verdict", "concerns"]),
        grounding: [
          { rule: "paths_exist", field: "delivered", mode: "enforce" },
          { rule: "member_of", field: "verdict", set: "concerns", mode: "enforce" },
          { rule: "implies", when: { field: "verdict", equals: "bad" }, then: { field: "concerns", nonEmpty: true }, mode: "enforce" },
          { rule: "subset_of_prior", field: "delivered", prior: [{ stepId: "exec", field: "completed" }], mode: "observe" },
        ],
      },
    ];
    expect(validateTemplatePipeline(steps)).toEqual([]);
  });

  it("warns when a grounding selector's head key is not in the step's output schema", () => {
    const steps: WorkflowStepTemplate[] = [
      { ...step("a", 0, ["x"]), grounding: [{ rule: "paths_exist", field: "nope[].file", mode: "enforce" }] },
    ];
    const w = validateTemplatePipeline(steps);
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/nope/);
  });

  it("warns when member_of's set selector or subset_of_prior's step do not resolve", () => {
    const steps: WorkflowStepTemplate[] = [
      { ...step("a", 0, ["v"]), grounding: [{ rule: "member_of", field: "v", set: "missing[].name", mode: "enforce" }] },
      { ...step("b", 1, ["d"]), grounding: [{ rule: "subset_of_prior", field: "d", prior: [{ stepId: "later", field: "k" }], mode: "observe" }] },
    ];
    const w = validateTemplatePipeline(steps);
    expect(w.some((x) => x.includes("missing"))).toBe(true);
    expect(w.some((x) => x.includes("later"))).toBe(true);
  });
});
