import { describe, it, expect } from "vitest";
import { EvidenceFacet } from "@orca/contracts";
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
      { reasoning: "problem, outcome, and constraints are all filled in", successScore: 0.9, quality: { outputCompleteness: 0.95, outputCorrectness: 0.95, instructionAdherence: 0.9, downstreamReadiness: 0.9, riskLevel: 0.1 }, reason: "Frame is complete and unambiguous.", handoffReady: true },
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

    it("uses the could-not-be-completed phrase for unavailable with no reason clause and no literal null", () => {
      const lead = confirmationLead("Looks good", null, { verdict: "unavailable", reason: null, issueRefs: [] });
      expect(lead).toContain("could not be completed");
      expect(lead).not.toContain("null");
      expect(lead.endsWith("Looks good")).toBe(true);
    });

    it("never interpolates a null reason for a non-upheld verdict", () => {
      const lead = confirmationLead("Looks good", null, { verdict: "refuted", reason: null, issueRefs: [] });
      expect(lead).toContain("Independent review disputes this completion");
      expect(lead).not.toContain("null");
      expect(lead).not.toContain(": null");
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

describe("buildConfirmationSummary evidence bundle", () => {
  const schema2: WorkflowStepOutputSchema = [{ key: "summary", type: "string", required: true }];

  it("omits the bundle when evidence is not provided (persisted result card)", () => {
    const out = buildConfirmationSummary(schema2, { summary: "x" }, null, null);
    expect(out.evidence).toBeUndefined();
  });

  it("reasoning step (evidence null): executed=false, one structural check, no gaps", () => {
    const out = buildConfirmationSummary(schema2, { summary: "x" }, null, null, null, null, null);
    expect(out.evidence).toEqual({
      executed: false,
      checks: [{ name: "Output structure", status: "passed", kind: "structural", detail: "all required fields present" }],
      cantVerify: [],
    });
  });

  it("exec step: executed=true, one check per sensor with mapped status, gaps in cantVerify", () => {
    const facet = EvidenceFacet.parse({
      sensorsRun: [
        { kind: "typecheck", command: "tsc", exitCode: 0, durationMs: 5, result: "passed", summary: "no type errors", artifactRef: null },
        { kind: "unit", command: "vitest", exitCode: 1, durationMs: 9, result: "failed", summary: "2 failing tests", artifactRef: null },
      ],
      verdict: "failed",
      oracleAdequacy: { sufficient: false, gaps: ["no e2e coverage for order-fill"] },
    });
    const out = buildConfirmationSummary(schema2, { summary: "x" }, null, null, null, null, facet);
    expect(out.evidence?.executed).toBe(true);
    expect(out.evidence?.checks).toEqual([
      { name: "typecheck", status: "passed", kind: "execution", detail: "no type errors" },
      { name: "unit", status: "failed", kind: "execution", detail: "2 failing tests" },
    ]);
    expect(out.evidence?.cantVerify).toEqual(["no e2e coverage for order-fill"]);
  });
});
