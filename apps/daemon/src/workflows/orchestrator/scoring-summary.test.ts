import { describe, expect, it } from "vitest";

import { summarizeScoring } from "./scoring-summary.js";

describe("summarizeScoring", () => {
  it("explains what result is awaiting confirmation", () => {
    const summary = summarizeScoring({
      successScore: 0.92,
      quality: {
        outputCompleteness: 0.95,
        outputCorrectness: 0.9,
        instructionAdherence: 0.95,
        downstreamReadiness: 0.9,
        riskLevel: 0.05,
      },
      reason: "The agent traced the scoring paths and identified the test seam.",
      handoffReady: true,
    });

    expect(summary).toContain(
      "The agent traced the scoring paths and identified the test seam.",
    );
    expect(summary).toContain("Completeness 95%");
    expect(summary).toContain("Correctness 90%");
  });
});
