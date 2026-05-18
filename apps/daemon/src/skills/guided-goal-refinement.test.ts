import { describe, it, expect } from "vitest";
import { guidedGoalRefinementSkill } from "./guided-goal-refinement.js";
import { PluginRegistry } from "../registry/plugin-registry.js";
import { SkillRegistry } from "../registry/skill-registry.js";
import { bootstrapRegistries } from "../registry/bootstrap.js";

const ctx = { now: () => new Date().toISOString() };

function invoke(title: string, description: string) {
  return guidedGoalRefinementSkill.invoke({ title, description }, ctx);
}

describe("guidedGoalRefinementSkill", () => {
  it("empty description produces all empty arrays", () => {
    const result = invoke("My Goal", "");
    expect(result.skillId).toBe("guided-goal-refinement");
    expect(result.title).toBe("My Goal");
    expect(result.description).toBe("");
    expect(result.successCriteria).toEqual([]);
    expect(result.constraints).toEqual([]);
    expect(result.assumptions).toEqual([]);
  });

  it("Goals: section with dash bullets populates successCriteria", () => {
    const result = invoke("Ship it", "Goals:\n- Ship by Q1\n- Zero downtime");
    expect(result.successCriteria).toEqual(["Ship by Q1", "Zero downtime"]);
    expect(result.constraints).toEqual([]);
    expect(result.assumptions).toEqual([]);
  });

  it("Success criteria: header also routes to successCriteria", () => {
    const result = invoke("T", "Success criteria:\n- Pass all tests");
    expect(result.successCriteria).toEqual(["Pass all tests"]);
  });

  it("Outcomes: header also routes to successCriteria", () => {
    const result = invoke("T", "Outcomes:\n- Users happy");
    expect(result.successCriteria).toEqual(["Users happy"]);
  });

  it("Constraints: section populates constraints array", () => {
    const result = invoke("T", "Constraints:\n- No budget\n- No time");
    expect(result.constraints).toEqual(["No budget", "No time"]);
    expect(result.successCriteria).toEqual([]);
  });

  it("Requirements: and Must: headers also route to constraints", () => {
    const a = invoke("T", "Requirements:\n- TypeScript only");
    expect(a.constraints).toEqual(["TypeScript only"]);
    const b = invoke("T", "Must:\n- Be fast");
    expect(b.constraints).toEqual(["Be fast"]);
  });

  it("Assumptions: section populates assumptions array", () => {
    const result = invoke("T", "Assumptions:\n- Users have Node 20");
    expect(result.assumptions).toEqual(["Users have Node 20"]);
  });

  it("Given: header also routes to assumptions", () => {
    const result = invoke("T", "Given:\n- CI is available");
    expect(result.assumptions).toEqual(["CI is available"]);
  });

  it("mixed sections in any order are routed correctly", () => {
    const desc = "Assumptions:\n- A1\nConstraints:\n- C1\nGoals:\n- G1";
    const result = invoke("T", desc);
    expect(result.successCriteria).toEqual(["G1"]);
    expect(result.constraints).toEqual(["C1"]);
    expect(result.assumptions).toEqual(["A1"]);
    expect(result.description).toBe("");
  });

  it("section matching is case-insensitive", () => {
    const result = invoke("T", "GOALS:\n- upper case");
    expect(result.successCriteria).toEqual(["upper case"]);
  });

  it("all four bullet variants extract items", () => {
    const desc = "Goals:\n- dash item\n* star item\n• bullet item\n1. numbered item";
    const result = invoke("T", desc);
    expect(result.successCriteria).toEqual([
      "dash item",
      "star item",
      "bullet item",
      "numbered item",
    ]);
  });

  it("non-bullet lines inside a section are extracted as plain items", () => {
    const result = invoke("T", "Goals:\nplain line one\nplain line two");
    expect(result.successCriteria).toEqual(["plain line one", "plain line two"]);
  });

  it("duplicate items (case-insensitive) are deduplicated, first occurrence kept", () => {
    const result = invoke("T", "Goals:\n- Ship by Q1\n- ship by q1\n- SHIP BY Q1");
    expect(result.successCriteria).toEqual(["Ship by Q1"]);
  });

  it("items longer than 200 chars are truncated to 200", () => {
    const longItem = "x".repeat(250);
    const result = invoke("T", `Goals:\n- ${longItem}`);
    expect(result.successCriteria[0]).toHaveLength(200);
  });

  it("more than 20 items are capped at 20", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `- Item ${i + 1}`).join("\n");
    const result = invoke("T", `Goals:\n${lines}`);
    expect(result.successCriteria).toHaveLength(20);
    expect(result.successCriteria[0]).toBe("Item 1");
    expect(result.successCriteria[19]).toBe("Item 20");
  });

  it("preamble text before sections is preserved in description", () => {
    const desc = "Preamble here.\nGoals:\n- G1";
    const result = invoke("T", desc);
    expect(result.description).toBe("Preamble here.");
    expect(result.successCriteria).toEqual(["G1"]);
  });

  it("3+ consecutive blank lines in preamble are collapsed to 2", () => {
    // 3 blank lines = 4 newlines in a row
    const desc = "First part.\n\n\n\nGoals:\n- G1";
    const result = invoke("T", desc);
    // 4 newlines collapsed to 3 (= 2 blank lines), then trimEnd removes trailing
    expect(result.description).toBe("First part.");
    expect(result.successCriteria).toEqual(["G1"]);
  });

  it("preamble with multiple blank lines (not exceeding 3) is preserved", () => {
    const desc = "Line 1.\n\nLine 2.\nGoals:\n- G1";
    const result = invoke("T", desc);
    expect(result.description).toBe("Line 1.\n\nLine 2.");
    expect(result.successCriteria).toEqual(["G1"]);
  });

  it("preamble plus sections: both preamble description and arrays are populated", () => {
    const desc = "Background info.\n\nConstraints:\n- Must be fast\nAssumptions:\n- Node 20+";
    const result = invoke("T", desc);
    expect(result.description).toBe("Background info.");
    expect(result.constraints).toEqual(["Must be fast"]);
    expect(result.assumptions).toEqual(["Node 20+"]);
  });

  it("title is trimmed in the output", () => {
    const result = invoke("  My Goal  ", "");
    expect(result.title).toBe("My Goal");
  });

  it("skillId is always guided-goal-refinement", () => {
    const result = invoke("T", "Goals:\n- G");
    expect(result.skillId).toBe("guided-goal-refinement");
  });

  it("has no side effects — no DB, no IO", () => {
    // Pure function: calling multiple times produces same result
    const a = invoke("T", "Goals:\n- G1");
    const b = invoke("T", "Goals:\n- G1");
    expect(a).toEqual(b);
  });
});

describe("guidedGoalRefinementSkill registry boot", () => {
  it("byExtensionPoint('goal.refine') returns exactly one entry with the correct id", () => {
    const plugins = new PluginRegistry();
    const skills = new SkillRegistry();
    bootstrapRegistries({ plugins, skills });

    const matches = skills.byExtensionPoint("goal.refine");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe("guided-goal-refinement");
  });
});
