import { describe, it, expect } from "vitest";
import { sanitizeNarration } from "./sanitize-narration.js";

describe("sanitizeNarration", () => {
  it("rewrites a sentence-leading 'The Step N (role) agent' to a neutral subject", () => {
    expect(sanitizeNarration("The Step 1 (triage) agent reports that the gap holds.")).toBe(
      "This step reports that the gap holds."
    );
  });

  it("rewrites a mid-sentence 'Step N agent' without capitalizing it", () => {
    expect(sanitizeNarration("Now Step 2 agent is running the tests.")).toBe(
      "Now this step is running the tests."
    );
  });

  it("preserves possessive and consumes a lowercase leading article", () => {
    expect(sanitizeNarration("Step 1 agent's output is ready.")).toBe("This step's output is ready.");
    expect(sanitizeNarration("...and the Step 3 agent finished.")).toBe("...and this step finished.");
  });

  it("capitalizes after a sentence boundary", () => {
    expect(sanitizeNarration("Done. Step 1 agent will continue.")).toBe("Done. This step will continue.");
  });

  it("leaves clean activity narration untouched", () => {
    const clean = "Confirming the readiness brief — the gap holds, no code changed.";
    expect(sanitizeNarration(clean)).toBe(clean);
  });
});
