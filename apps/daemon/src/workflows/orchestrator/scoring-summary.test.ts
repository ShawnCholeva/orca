import { describe, expect, it } from "vitest";

import { extractProposal, summarizeScoring } from "./scoring-summary.js";

describe("extractProposal", () => {
  it("returns the agent's substantive proposal line, stripping fences and preamble", () => {
    const text = [
      "I now have a complete picture. Here's my plan.",
      "Add Active and Archived sections to the goal list, frontend-only, mirroring WorkflowsPage.",
      "```orca:step-complete",
      '{"plan":"..."}',
      "```",
    ].join("\n");
    expect(extractProposal(text)).toBe(
      "Add Active and Archived sections to the goal list, frontend-only, mirroring WorkflowsPage.",
    );
  });
  it("is empty when the response is only a structured block", () => {
    expect(extractProposal("```orca:step-complete\n{}\n```")).toBe("");
  });
});

describe("summarizeScoring", () => {
  it("leads with the agent's proposal when one is provided", () => {
    const summary = summarizeScoring(
      {
        reasoning: "all required sections and fields are present",
        successScore: 0.92,
        quality: {
          outputCompleteness: 0.95,
          outputCorrectness: 0.9,
          instructionAdherence: 0.95,
          downstreamReadiness: 0.9,
          riskLevel: 0.05,
        },
        reason: "Looks complete.",
        handoffReady: true,
      },
      "Add Active/Archived sections to the goal list.",
    );
    expect(summary).toContain("Add Active/Archived sections to the goal list.");
    expect(summary).not.toContain("Proposed result: Looks complete.");
    expect(summary).toContain("Completeness 95%");
  });

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
      reasoning: "traced the scoring paths and located the test seam",
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
