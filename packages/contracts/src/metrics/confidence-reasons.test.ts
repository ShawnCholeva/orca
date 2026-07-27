import { describe, it, expect } from "vitest";
import { CONFIDENCE_REASON_CODES, labelForConfidenceReason } from "./confidence-reasons";

describe("labelForConfidenceReason", () => {
  it("returns a non-empty, jargon-free label for every code", () => {
    for (const code of CONFIDENCE_REASON_CODES) {
      const label = labelForConfidenceReason({ code, nodeName: "Critique" });
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
    }
  });

  it("interpolates the node name for weak_verifier", () => {
    expect(labelForConfidenceReason({ code: "weak_verifier", nodeName: "Critique" }))
      .toBe("Critique approved this, but that hasn't held up downstream yet.");
  });

  it("has a sensible fallback when weak_verifier has no node name", () => {
    expect(labelForConfidenceReason({ code: "weak_verifier" }))
      .toBe("A review approved this, but that hasn't held up downstream yet.");
  });

  it("ignores nodeName for codes that don't use it", () => {
    expect(labelForConfidenceReason({ code: "no_check_yet", nodeName: "Critique" }))
      .toBe("Nothing independent has checked this step yet.");
  });
});
