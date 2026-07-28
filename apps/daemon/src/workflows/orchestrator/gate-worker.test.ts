import { describe, expect, it } from "vitest";
import { composeGateWorkerPrompt, parseGateDecision } from "./gate-worker.js";

describe("gate-worker", () => {
  it("composeGateWorkerPrompt includes the gate instructions and the output contract", () => {
    const p = composeGateWorkerPrompt({
      gate: { nodeId: "critique", name: "Critique", instructions: "CHALLENGE THE APPROACH" },
      goal: { title: "T", description: "D" }, sourceStepOutput: { chosen: "x" },
      committedLedger: [], priorGateDecisions: [], availableOutcomes: ["approved", "rejected"],
    } as never);
    expect(p).toContain("CHALLENGE THE APPROACH");
    expect(p).toContain("orca:gate-decision");
  });

  it("composeGateWorkerPrompt constrains the outcome to the gate's offered outcomes", () => {
    const approveOnly = composeGateWorkerPrompt({
      gate: { nodeId: "g", name: "G", instructions: "x" },
      goal: { title: "T", description: "D" }, sourceStepOutput: {},
      committedLedger: [], priorGateDecisions: [], availableOutcomes: ["approved"],
    } as never);
    expect(approveOnly).toContain('MUST be exactly one of: "approved".');
    expect(approveOnly).not.toContain('"rejected"');
  });

  it("parseGateDecision extracts a valid rejected decision with issueRefs", () => {
    const out = 'blah\n```orca:gate-decision\n{"reasoning":"r","outcome":"rejected","reason":"why","issueRefs":["lock","purity"],"inputsConsidered":["proposal"]}\n```\n';
    const d = parseGateDecision(out);
    expect(d?.outcome).toBe("rejected");
    expect(d?.issueRefs).toEqual(["lock","purity"]);
  });

  it("parseGateDecision returns null on missing/invalid block", () => {
    expect(parseGateDecision("no block here")).toBeNull();
    expect(parseGateDecision("```orca:gate-decision\n{not json}\n```")).toBeNull();
  });

  it("parseGateDecision returns null on valid JSON that fails the schema", () => {
    // Well-formed JSON, but `outcome` is not an accepted GateEvaluationProposal value.
    const out = '```orca:gate-decision\n{"reasoning":"r","outcome":"maybe","reason":"why","issueRefs":[],"inputsConsidered":[]}\n```';
    expect(parseGateDecision(out)).toBeNull();
  });
});

const req = {
  gate: { nodeId: "n1", name: "G", instructions: "verify" },
  goal: { id: "g1", intent: "x" },
  sourceStepOutput: null, priorGateDecisions: [], availableOutcomes: ["approved"], committedLedger: [],
} as any;

describe("composeGateWorkerPrompt success criteria hint", () => {
  it("worker prompt byte-identical when no criteria (parity)", () => {
    expect(composeGateWorkerPrompt({ ...req, goal: { ...req.goal, successCriteria: [] } }))
      .toBe(composeGateWorkerPrompt(req));
  });

  it("prepends hint when criteria present", () => {
    const withSc = composeGateWorkerPrompt({ ...req, goal: { ...req.goal, successCriteria: ["done"] } });
    expect(withSc.startsWith("The goal's successCriteria")).toBe(true);
  });
});
