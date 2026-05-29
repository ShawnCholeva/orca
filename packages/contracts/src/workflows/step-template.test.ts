import { describe, expect, it } from "vitest";
import { WorkflowStepTemplate, WorkflowArtifactType, InterviewTurn } from "./index.js";

describe("WorkflowStepTemplate (instruction-driven)", () => {
  it("accepts id/ordinal/name/instructions/outputSchema/agentPreference", () => {
    const parsed = WorkflowStepTemplate.parse({
      id: "intake", ordinal: 0, name: "Intake",
      instructions: "Interview the user.",
      outputSchema: [{ key: "problem", type: "string", required: true }],
      agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
    });
    expect(parsed.id).toBe("intake");
  });
  it("rejects removed fields", () => {
    expect(() => WorkflowStepTemplate.parse({
      id: "x", ordinal: 0, name: "X", instructions: "i",
      outputSchema: [{ key: "k", type: "string", required: true }],
      agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
      gateType: "human-input",
    })).toThrow();
  });
  it("requires instructions and a non-empty outputSchema", () => {
    expect(() => WorkflowStepTemplate.parse({ id: "x", ordinal: 0, name: "X", outputSchema: [], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] }))
      .toThrow();
  });
});

describe("artifact types + interview turn", () => {
  it("includes step_output and interview_turn", () => {
    expect(WorkflowArtifactType.parse("step_output")).toBe("step_output");
    expect(WorkflowArtifactType.parse("interview_turn")).toBe("interview_turn");
  });
  it("parses an interview turn body", () => {
    const t = InterviewTurn.parse({
      turnIndex: 0, questionDecisionId: "dec-1",
      question: "q", answer: "a", answeredAt: "2026-05-27T00:00:00.000Z",
    });
    expect(t.turnIndex).toBe(0);
  });
});
