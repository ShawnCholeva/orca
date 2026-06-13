import { describe, expect, it, vi } from "vitest";
import type { GateEvaluationDeps } from "./gate-evaluation.js";
import { evaluateGate } from "./gate-evaluation.js";

function fakeBroker(raw: unknown): GateEvaluationDeps["broker"] {
  return {
    propose: vi.fn(async (_req, options) => {
      const v = await options?.validateProposal?.(raw) as { accepted: boolean; parsed?: unknown } | undefined;
      if (v?.accepted) {
        return { status: "proposed" as const, attemptId: "a", transport: "one_shot" as const, parsed: v.parsed, rawTextLength: null, latencyMs: 1 };
      }
      return { status: "needs_human_review" as const, attemptId: "a", reviewPayloadId: "r" };
    }),
  };
}

const baseInput = {
  goalId: "g",
  workflowRunId: "r",
  providerId: "orca/anthropic" as const,
  modelId: "claude-opus-4-8",
  goal: { id: "g", description: "build" },
  gate: { nodeId: "gate", name: "Release Readiness", instructions: "approve when passed" },
  sourceStepOutput: { verdict: "passed" },
  priorGateDecisions: [],
  availableOutcomes: ["approved", "rejected"] as const,
};

describe("evaluateGate", () => {
  it("returns the validated approved outcome", async () => {
    const broker = fakeBroker({ outcome: "approved", reason: "all green", inputsConsidered: ["validation"] });
    const res = await evaluateGate({ broker }, baseInput);
    expect(res).toEqual({ ok: true, decision: { outcome: "approved", reason: "all green", issueRefs: [], inputsConsidered: ["validation"] } });
  });

  it("fails when the model returns an unpermitted outcome", async () => {
    const broker = fakeBroker({ outcome: "maybe", reason: "x", inputsConsidered: [] });
    const res = await evaluateGate({ broker }, baseInput);
    expect(res.ok).toBe(false);
  });
});
