import { describe, it, expect } from "vitest";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { buildConfirmationSummary, confirmationLead } from "./confirmation-summary.js";

const schema: WorkflowStepOutputSchema = [
  { key: "problem", type: "string", required: true },
  { key: "success_outcome", type: "string", required: true },
  { key: "constraints", type: "array", itemType: "string", required: true },
  { key: "open_questions", type: "array", itemType: "string", required: false },
];

describe("buildConfirmationSummary", () => {
  it("renders humanized labels, skips empty/missing fields, leads with scoring.reason", () => {
    const out = buildConfirmationSummary(
      schema,
      { problem: "Can't rename workspaces", success_outcome: "  ", constraints: ["unique names", " "], open_questions: [] },
      { successScore: 0.9, quality: { outputCompleteness: 0.95, outputCorrectness: 0.95, instructionAdherence: 0.9, downstreamReadiness: 0.9, riskLevel: 0.1 }, reason: "Frame is complete and unambiguous.", handoffReady: true },
      "ignored when scoring.reason present"
    );
    expect(out.lead).toBe("Frame is complete and unambiguous.");
    expect(out.fields).toEqual([
      { label: "Problem", value: "Can't rename workspaces" },
      { label: "Constraints", value: ["unique names"] },
    ]);
    expect(out.scoring?.successScore).toBe(0.9);
  });

  it("falls back to proposal then a generic lead when scoring is null", () => {
    expect(buildConfirmationSummary(schema, {}, null, "  Proposed the frame  ").lead).toBe("Proposed the frame");
    expect(buildConfirmationSummary(schema, {}, null, null).lead).toBe("Step complete.");
  });

  const nestedSchema: WorkflowStepOutputSchema = [
    {
      key: "decision",
      type: "object",
      required: true,
      fields: [
        { key: "tier", type: "string", required: true },
        { key: "reason", type: "string", required: true },
      ],
    },
    {
      key: "candidates",
      type: "array",
      itemType: "object",
      required: false,
      fields: [
        { key: "file", type: "string", required: true },
        { key: "risk", type: "string", required: false },
      ],
    },
  ];

  it("flattens a nested object decision into composite-labeled rows (no silent drop)", () => {
    const out = buildConfirmationSummary(
      nestedSchema,
      { decision: { tier: "ground_and_design", reason: "single justified tier" }, candidates: [] },
      null,
      null
    );
    expect(out.fields).toEqual([
      { label: "Decision · Tier", value: "ground_and_design" },
      { label: "Decision · Reason", value: "single justified tier" },
    ]);
  });

  it("renders an array of objects as one compact line per item", () => {
    const out = buildConfirmationSummary(
      nestedSchema,
      { decision: { tier: "x", reason: "y" }, candidates: [{ file: "a.ts", risk: "low" }, { file: "b.ts" }] },
      null,
      null
    );
    expect(out.fields.find((f) => f.label === "Candidates")?.value).toEqual([
      "File: a.ts · Risk: low",
      "File: b.ts",
    ]);
  });

  describe("splitter-branch field", () => {
    const tierSchema: WorkflowStepOutputSchema = [
      { key: "recommended_tier", type: "string", required: true },
    ];
    const routing = {
      branchKey: "recommended_tier",
      branchToName: { clarify_first: "Clarify", ground_and_design: "Research", approach_only: "Proposal" },
    };

    it("shows the destination step name instead of the raw branch token", () => {
      const out = buildConfirmationSummary(tierSchema, { recommended_tier: "approach_only" }, null, null, routing);
      expect(out.fields).toEqual([{ label: "Recommended step", value: "Proposal" }]);
    });

    it("falls back to the raw value when the branch has no mapped destination", () => {
      const out = buildConfirmationSummary(tierSchema, { recommended_tier: "unknown_tier" }, null, null, routing);
      expect(out.fields).toEqual([{ label: "Recommended tier", value: "unknown_tier" }]);
    });

    it("renders the raw value when no routing is supplied", () => {
      const out = buildConfirmationSummary(tierSchema, { recommended_tier: "approach_only" }, null, null);
      expect(out.fields).toEqual([{ label: "Recommended tier", value: "approach_only" }]);
    });
  });

  describe("buildConfirmationSummary refute threading", () => {
    it("threads a non-upheld refute into the lead and the returned payload", () => {
      const out = buildConfirmationSummary(schema, { problem: "x" }, null, "Proposed", null, {
        verdict: "refuted",
        reason: "misses error paths",
        issueRefs: ["x"],
      });
      expect(out.lead).toContain("Independent review disputes");
      expect(out.refute).toEqual({ verdict: "refuted", reason: "misses error paths", issueRefs: ["x"] });
    });

    it("carries a null refute through untouched when the verdict is upheld", () => {
      const out = buildConfirmationSummary(schema, { problem: "x" }, null, "Proposed", null, {
        verdict: "upheld",
        reason: null,
        issueRefs: [],
      });
      expect(out.lead).toBe("Proposed");
      expect(out.refute).toEqual({ verdict: "upheld", reason: null, issueRefs: [] });
    });

    it("defaults refute to null when omitted", () => {
      const out = buildConfirmationSummary(schema, { problem: "x" }, null, "Proposed");
      expect(out.refute ?? null).toBeNull();
    });
  });

  describe("confirmationLead refute advisory", () => {
    it("prepends a refute advisory when the verdict is refuted", () => {
      const lead = confirmationLead("Looks good", null, {
        verdict: "refuted",
        reason: "misses error paths",
        issueRefs: ["x"],
      });
      expect(lead).toContain("Independent review");
      expect(lead).toContain("disputes");
      expect(lead).toContain("misses error paths");
      expect(lead.endsWith("Looks good")).toBe(true);
    });

    it("prepends an uncertain advisory with different wording", () => {
      const lead = confirmationLead("Looks good", null, {
        verdict: "uncertain",
        reason: "can't tell",
        issueRefs: [],
      });
      expect(lead).toContain("is uncertain about");
      expect(lead).toContain("can't tell");
    });

    it("does not prepend an advisory when the verdict is upheld", () => {
      const lead = confirmationLead("Looks good", null, { verdict: "upheld", reason: null, issueRefs: [] });
      expect(lead).toBe("Looks good");
    });

    it("does not prepend an advisory when refute is null", () => {
      expect(confirmationLead("Looks good", null, null)).toBe("Looks good");
    });

    it("does not prepend an advisory when refute is omitted", () => {
      expect(confirmationLead("Looks good", null)).toBe("Looks good");
    });
  });
});
