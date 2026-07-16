import { describe, expect, it } from "vitest";
import { labelForGateFailure, GATE_FAILURE_CODES } from "./gate-failure-labels.js";

describe("labelForGateFailure", () => {
  it("has a readable, jargon-free label for every code", () => {
    for (const code of GATE_FAILURE_CODES) {
      const label = labelForGateFailure(code);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
    }
  });
  it("false acceptance reads plainly", () => {
    expect(labelForGateFailure("overturned_approve")).toMatch(/approved.*a person then/i);
  });
});
