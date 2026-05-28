import { describe, expect, it, vi } from "vitest";
import {
  synthesizeStepOutput,
  type SynthesisDeps,
  type SynthesisInput,
} from "./synthesize.js";

const schema = [
  { key: "summary", type: "string", required: true },
] as const;

function deps(overrides: Partial<SynthesisDeps> = {}): SynthesisDeps {
  return {
    broker: {
      propose: vi.fn(async () => ({
        status: "proposed" as const,
        attemptId: "att",
        transport: "one_shot" as const,
        parsed: { output: { summary: "from model" } },
        rawTextLength: 0,
        latencyMs: 0,
      })),
    },
    ...overrides,
  };
}

const input: SynthesisInput = {
  goalId: "g",
  workflowRunId: "r",
  stepRunId: "sr",
  providerId: "orca/anthropic",
  modelId: "claude-sonnet-4-6",
  outputSchema: schema as unknown as SynthesisInput["outputSchema"],
  stepInput: { goal: { id: "g", description: "" }, currentStep: { id: "execution", ordinal: 4, name: "Execution", instructions: "i", outputSchema: schema as unknown as SynthesisInput["outputSchema"] }, previousStepOutput: null, priorStepOutputs: [], transcript: [] },
  sessionResult: "",
};

describe("synthesizeStepOutput", () => {
  it("parse path: valid orca-output block bypasses the model", async () => {
    const d = deps();
    const text = "noise\n```orca-output\n{\"summary\":\"from agent\"}\n```\n";
    const r = await synthesizeStepOutput(d, { ...input, sessionResult: text });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.source).toBe("agent");
    expect(r.ok === true && r.output).toEqual({ summary: "from agent" });
    expect(d.broker.propose).not.toHaveBeenCalled();
  });

  it("synthesize path: missing block falls back to model", async () => {
    const d = deps();
    const r = await synthesizeStepOutput(d, { ...input, sessionResult: "no block" });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.source).toBe("orchestrator");
    expect(r.ok === true && r.output).toEqual({ summary: "from model" });
    expect(d.broker.propose).toHaveBeenCalledTimes(1);
  });

  it("synthesize path: invalid block falls back to model", async () => {
    const d = deps();
    const r = await synthesizeStepOutput(d, {
      ...input,
      sessionResult: "```orca-output\n{\"wrong\":1}\n```",
    });
    expect(r.ok === true && r.source).toBe("orchestrator");
  });

  it("synthesise retries once on non-proposed broker result, then errors", async () => {
    const propose = vi
      .fn()
      .mockResolvedValueOnce({ status: "needs_human_review", attemptId: "a", reviewPayloadId: "h" })
      .mockResolvedValueOnce({ status: "needs_human_review", attemptId: "a", reviewPayloadId: "h" });
    const r = await synthesizeStepOutput({ broker: { propose } }, { ...input, sessionResult: "" });
    expect(r.ok).toBe(false);
    expect(propose).toHaveBeenCalledTimes(2);
    expect(r.ok === false && r.reason).toMatch(/schema/i);
  });

  it("transport failure surfaces as error", async () => {
    const propose = vi.fn().mockResolvedValue({ status: "needs_human_review", attemptId: "a", reviewPayloadId: "h" });
    const r = await synthesizeStepOutput({ broker: { propose } }, { ...input, sessionResult: "" });
    expect(r.ok).toBe(false);
  });
});
