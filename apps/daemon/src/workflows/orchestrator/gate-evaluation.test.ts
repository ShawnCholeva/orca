import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GateEvaluationRequest, GateEvaluationProposal } from "@orca/contracts";
import type { ShadowAsk } from "./recover-step-scoring.js";
import { evaluateGate, composeGateEvaluationPrompt, issueRefsEqual, GATE_REJECT_CAP } from "./gate-evaluation.js";

const REQUEST: GateEvaluationRequest = {
  gate: { nodeId: "gate", name: "Review Gate", instructions: "Approve when the deliverable meets the goal." },
  goal: { id: "goal-1", description: "Ship the feature." },
  sourceStepOutput: { summary: "done" },
  priorGateDecisions: [],
  availableOutcomes: ["approved", "rejected"],
  committedLedger: [],
};

function askReturning(text: string): ShadowAsk {
  return { async ask() { return { text }; } };
}
function askThrowing(): ShadowAsk {
  return { async ask() { throw new Error("shadow down"); } };
}

describe("evaluateGate", () => {
  // The failure paths log one [gate-eval] line for observability; mock it so the
  // suite output stays pristine and so the reason can be asserted.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("parses an approved proposal", async () => {
    const proposal: GateEvaluationProposal = {
      outcome: "approved", reason: "Meets the goal.", issueRefs: [], inputsConsidered: ["sourceStepOutput"],
    };
    const result = await evaluateGate(askReturning(JSON.stringify(proposal)), {
      goalId: "goal-1", adapterId: "claude-code", request: REQUEST, timeoutMs: 1000,
    });
    expect(result).toEqual(proposal);
  });

  it("preserves the enumerated issueRefs on a rejected proposal", async () => {
    const proposal: GateEvaluationProposal = {
      outcome: "rejected", reason: "Two gaps.", issueRefs: ["missing-tests", "no-error-handling"], inputsConsidered: ["sourceStepOutput"],
    };
    const result = await evaluateGate(askReturning(JSON.stringify(proposal)), {
      goalId: "goal-1", adapterId: "claude-code", request: REQUEST, timeoutMs: 1000,
    });
    expect(result?.issueRefs).toEqual(["missing-tests", "no-error-handling"]);
  });

  it("returns null when ask throws", async () => {
    const result = await evaluateGate(askThrowing(), {
      goalId: "goal-1", adapterId: "claude-code", request: REQUEST, timeoutMs: 1000,
    });
    expect(result).toBeNull();
  });

  it("returns null on non-JSON and on an invalid proposal", async () => {
    expect(await evaluateGate(askReturning("not json"), { goalId: "g", adapterId: "claude-code", request: REQUEST, timeoutMs: 1000 })).toBeNull();
    expect(await evaluateGate(askReturning(JSON.stringify({ outcome: "maybe" })), { goalId: "g", adapterId: "claude-code", request: REQUEST, timeoutMs: 1000 })).toBeNull();
  });

  it("logs the failure reason (observability) before falling back to null", async () => {
    const result = await evaluateGate(askThrowing(), {
      goalId: "goal-1", adapterId: "claude-code", request: REQUEST, timeoutMs: 1000,
    });
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]![0]);
    expect(msg).toContain("[gate-eval]");
    expect(msg).toContain("gate"); // the gate nodeId from the request
    expect(msg).toContain("shadow down"); // the underlying failure reason is surfaced
  });

  it("retries once, then succeeds on the second turn", async () => {
    let calls = 0;
    const flaky: ShadowAsk = {
      async ask() {
        calls += 1;
        if (calls === 1) return { text: "garbage" };
        return { text: JSON.stringify({ outcome: "approved", reason: "ok", issueRefs: [], inputsConsidered: [] }) };
      },
    };
    const result = await evaluateGate(flaky, { goalId: "g", adapterId: "claude-code", request: REQUEST, timeoutMs: 1000 });
    expect(calls).toBe(2);
    expect(result?.outcome).toBe("approved");
  });

  it("exposes GATE_REJECT_CAP and an evidence-grounded prompt with the request embedded", () => {
    expect(GATE_REJECT_CAP).toBe(3);
    const { systemPrompt, userPrompt } = composeGateEvaluationPrompt(REQUEST);
    expect(systemPrompt).toContain("orca:action");
    // p.31: the evaluator interprets deterministic evidence, it does not replace it.
    expect(systemPrompt).toContain("committedLedger");
    expect(systemPrompt).toContain("do NOT override");
    expect(userPrompt).toContain("Review Gate");
  });

  it("emits reasoning before the outcome in the prompt literal", () => {
    const { systemPrompt } = composeGateEvaluationPrompt(REQUEST);
    expect(systemPrompt.indexOf('"reasoning"')).toBeGreaterThan(-1);
    expect(systemPrompt.indexOf('"reasoning"')).toBeLessThan(systemPrompt.indexOf('"outcome"'));
  });
});

describe("issueRefsEqual", () => {
  it("is order-insensitive and length-sensitive", () => {
    expect(issueRefsEqual(["a", "b"], ["b", "a"])).toBe(true);
    expect(issueRefsEqual(["a"], ["a", "b"])).toBe(false);
    expect(issueRefsEqual([], [])).toBe(true);
  });
});
