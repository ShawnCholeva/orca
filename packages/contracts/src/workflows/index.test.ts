import { describe, expect, it } from "vitest";
import { RefuteCompletionProposal, RefuteCompletionRequest } from "./index.js";

describe("Refute contracts", () => {
  it("round-trips a refuted proposal", () => {
    const p = { verdict: "refuted", reason: "output ignores the acceptance criteria", issueRefs: ["missing-error-path"], inputsConsidered: ["stepOutput"] };
    expect(RefuteCompletionProposal.parse(p)).toEqual(p);
  });
  it("rejects an unknown verdict", () => {
    expect(RefuteCompletionProposal.safeParse({ verdict: "maybe", reason: "x", issueRefs: [], inputsConsidered: [] }).success).toBe(false);
  });
  it("accepts an upheld verdict with an empty reason (no over-escalation to unavailable)", () => {
    const p = { verdict: "upheld", reason: "", issueRefs: [], inputsConsidered: [] };
    expect(RefuteCompletionProposal.parse(p)).toEqual(p);
  });
  it("accepts a well-formed request with oracle scope", () => {
    const r = { step: { name: "Analyze", instructions: "do X" }, goal: { id: "goal-1", description: "ship" },
      stepOutput: { summary: "done" }, selfReportedScoring: { successScore: 0.9 },
      oracle: { ran: true, verdict: "passed", sensorsRun: [{ kind: "test", summary: "12 passed" }], gaps: ["integration"] } };
    expect(RefuteCompletionRequest.parse(r).oracle.gaps).toEqual(["integration"]);
  });
});
