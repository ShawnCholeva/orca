import { describe, it, expect } from "vitest";
import { buildAgentObjective } from "./agent-objective.js";

const step = { name: "Implement", instructions: "do X" } as any;

describe("buildAgentObjective", () => {
  it("is byte-identical when no criteria (parity)", () => {
    const none = buildAgentObjective(step, { goal: { intent: "ship" }, stepRun: { id: "s1" } });
    const empty = buildAgentObjective(step, { goal: { intent: "ship", successCriteria: [] }, stepRun: { id: "s1" } });
    expect(empty).toBe(none);
  });
  it("renders the success-criteria block after the Goal line", () => {
    const out = buildAgentObjective(step, { goal: { intent: "ship", successCriteria: ["tests pass"] }, stepRun: { id: "s1" } });
    expect(out).toContain("Goal: ship");
    expect(out).toContain("Success Criteria (the goal is met only if ALL are satisfied):\n1. tests pass");
  });
});
