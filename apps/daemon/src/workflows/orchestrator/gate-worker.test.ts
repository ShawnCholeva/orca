import { describe, expect, it } from "vitest";
import { composeGateWorkerPrompt, parseGateDecision } from "./gate-worker.js";

describe("gate-worker", () => {
  it("composeGateWorkerPrompt includes the gate instructions and the output contract", () => {
    const p = composeGateWorkerPrompt({
      gate: { nodeId: "critique", name: "Critique", instructions: "CHALLENGE THE APPROACH" },
      goal: { title: "T", description: "D" }, sourceStepOutput: { chosen: "x" },
      committedLedger: [], priorGateDecisions: [],
    } as never);
    expect(p).toContain("CHALLENGE THE APPROACH");
    expect(p).toContain("orca:gate-decision");
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
});
