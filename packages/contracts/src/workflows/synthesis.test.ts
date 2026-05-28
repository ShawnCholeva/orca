import { describe, expect, it } from "vitest";
import {
  OrchestrationDecisionKind,
  SynthesisRequest,
  SynthesisProposal,
} from "./index.js";

describe("synthesize_step_output", () => {
  it("OrchestrationDecisionKind includes synthesize_step_output", () => {
    expect(OrchestrationDecisionKind.parse("synthesize_step_output")).toBe(
      "synthesize_step_output"
    );
  });

  it("SynthesisRequest accepts sessionResult + outputSchema + stepInput", () => {
    const parsed = SynthesisRequest.parse({
      sessionResult: "ran tests; all green",
      outputSchema: [{ key: "summary", type: "string", required: true }],
      stepInput: {
        goal: { id: "g", description: "x" },
        currentStep: {
          id: "execution",
          ordinal: 4,
          name: "Execution",
          instructions: "do stuff",
          outputSchema: [{ key: "summary", type: "string", required: true }],
        },
        previousStepOutput: null,
        priorStepOutputs: [],
        transcript: [],
      },
    });
    expect(parsed.sessionResult.length).toBeGreaterThan(0);
  });

  it("SynthesisRequest rejects oversize sessionResult (> ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES)", () => {
    const big = "x".repeat(8192);
    expect(() =>
      SynthesisRequest.parse({
        sessionResult: big,
        outputSchema: [{ key: "summary", type: "string", required: true }],
        stepInput: {
          goal: { id: "g", description: "x" },
          currentStep: {
            id: "x",
            ordinal: 0,
            name: "X",
            instructions: "i",
            outputSchema: [{ key: "summary", type: "string", required: true }],
          },
          previousStepOutput: null,
          priorStepOutputs: [],
          transcript: [],
        },
      })
    ).toThrow();
  });

  it("SynthesisProposal carries a record output", () => {
    expect(SynthesisProposal.parse({ output: { summary: "ok" } }).output.summary).toBe("ok");
  });
});
