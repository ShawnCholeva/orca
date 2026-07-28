import { describe, it, expect } from "vitest";
import { successCriteriaBlock, successCriteriaHint } from "./success-criteria-prompt.js";

describe("successCriteriaBlock", () => {
  it("returns '' for empty/undefined (parity)", () => {
    expect(successCriteriaBlock([])).toBe("");
    expect(successCriteriaBlock(undefined)).toBe("");
  });
  it("renders a numbered block ending in a blank line", () => {
    expect(successCriteriaBlock(["a", "b"])).toBe(
      "Success Criteria (the goal is met only if ALL are satisfied):\n1. a\n2. b\n\n",
    );
  });
});

describe("successCriteriaHint", () => {
  it("returns '' for empty/undefined (parity)", () => {
    expect(successCriteriaHint([])).toBe("");
    expect(successCriteriaHint(undefined)).toBe("");
  });
  it("returns a one-line pointer when present", () => {
    expect(successCriteriaHint(["a"])).toMatch(/successCriteria/);
    expect(successCriteriaHint(["a"]).endsWith("\n\n")).toBe(true);
  });
});
