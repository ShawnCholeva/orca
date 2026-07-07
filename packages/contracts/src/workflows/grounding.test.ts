import { describe, expect, it } from "vitest";
import { GroundingCheck } from "./grounding.js";
import { WorkflowStepTemplate } from "./index.js";

const STEP_BASE = {
  id: "research", ordinal: 0, name: "Research",
  instructions: "Ground the goal in the codebase.",
  outputSchema: [{ key: "files_in_scope", type: "array", itemType: "string", required: true }],
  agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
};

describe("GroundingCheck", () => {
  it("accepts each rule and defaults mode to enforce", () => {
    expect(GroundingCheck.parse({ rule: "paths_exist", field: "files_in_scope" }).mode).toBe("enforce");
    expect(GroundingCheck.parse({ rule: "paths_changed", field: "changes[].file" }).mode).toBe("enforce");
    expect(GroundingCheck.parse({ rule: "member_of", field: "chosen_approach", set: "approaches[].name" }).mode).toBe("enforce");
    expect(GroundingCheck.parse({
      rule: "implies",
      when: { field: "verdict", equals: "needs_work" },
      then: { field: "concerns", nonEmpty: true },
    }).mode).toBe("enforce");
    expect(GroundingCheck.parse({
      rule: "subset_of_prior", field: "delivered_requirements",
      prior: [{ stepId: "execution", field: "completed_requirements" }],
      mode: "observe",
    }).mode).toBe("observe");
  });

  it("supports implies with equals and excludes consequents", () => {
    const c = GroundingCheck.parse({
      rule: "implies",
      when: { field: "verdict", equals: "passed" },
      then: { field: "findings[].severity", excludes: ["critical", "high"] },
    });
    expect(c.rule).toBe("implies");
  });

  it("rejects unknown rules and over-long selectors", () => {
    expect(GroundingCheck.safeParse({ rule: "exists", field: "x" }).success).toBe(false);
    expect(GroundingCheck.safeParse({ rule: "paths_exist", field: "x".repeat(129) }).success).toBe(false);
    expect(GroundingCheck.safeParse({
      rule: "subset_of_prior", field: "a",
      prior: Array.from({ length: 9 }, () => ({ stepId: "s", field: "f" })),
    }).success).toBe(false);
  });
});

describe("WorkflowStepTemplate.grounding", () => {
  it("is optional and absent when unset", () => {
    expect(WorkflowStepTemplate.parse(STEP_BASE).grounding).toBeUndefined();
  });

  it("accepts declared grounding checks and caps them at 16", () => {
    const parsed = WorkflowStepTemplate.parse({
      ...STEP_BASE,
      grounding: [{ rule: "paths_exist", field: "files_in_scope" }],
    });
    expect(parsed.grounding).toHaveLength(1);
    expect(WorkflowStepTemplate.safeParse({
      ...STEP_BASE,
      grounding: Array.from({ length: 17 }, () => ({ rule: "paths_exist", field: "files_in_scope" })),
    }).success).toBe(false);
  });
});
