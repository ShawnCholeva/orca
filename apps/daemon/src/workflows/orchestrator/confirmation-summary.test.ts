import { describe, it, expect } from "vitest";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { buildConfirmationSummary } from "./confirmation-summary.js";

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
});
