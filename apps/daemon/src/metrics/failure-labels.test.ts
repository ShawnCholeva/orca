import { describe, expect, it } from "vitest";
import { FailureCode } from "@orca/contracts";
import { labelForFailure } from "./failure-labels.js";

const BANNED = /\b(oracle|sensor|verdict|refute|veto)\b/i;

describe("labelForFailure", () => {
  it("has a curated, human-readable label for every FailureCode", () => {
    for (const code of FailureCode.options) {
      const label = labelForFailure(code);
      // Not the raw-ish fallback (code with underscores swapped for spaces)
      expect(label, code).not.toBe(code.replace(/_/g, " "));
      expect(label, code).not.toMatch(BANNED);
      expect(label.length, code).toBeGreaterThan(10);
    }
  });
  it("null → Unclassified problem", () => {
    expect(labelForFailure(null)).toBe("Unclassified problem");
  });
  it("unknown codes fall back to a de-underscored token", () => {
    expect(labelForFailure("weird_future_code")).toBe("weird future code");
  });
});
