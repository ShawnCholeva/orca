import { describe, expect, it } from "vitest";
import { WorkflowStepTemplate, WorkflowArtifactType, InterviewTurn, WorkflowStepResult } from "./index.js";

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
  it("accepts an optional completionPolicy and leaves it absent when unset", () => {
    const base = { id: "x", ordinal: 0, name: "X", instructions: "do it", outputSchema: [{ key: "k", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] };
    const parsed = WorkflowStepTemplate.parse(base);
    expect(parsed.completionPolicy).toBeUndefined();

    const withPolicy = WorkflowStepTemplate.parse({ ...base, completionPolicy: "interview" });
    expect(withPolicy.completionPolicy).toBe("interview");
  });
  it("rejects an unknown completionPolicy value", () => {
    const base = { id: "x", ordinal: 0, name: "X", instructions: "do it", outputSchema: [{ key: "k", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] };
    expect(() => WorkflowStepTemplate.parse({ ...base, completionPolicy: "bogus" })).toThrow();
  });
});

describe("WorkflowStepResult", () => {
  it("accepts an optional resultSummary and primaryArtifact, omitted when unset", () => {
    const base = {
      stepId: "s1", stepStatus: "completed", evaluationStatus: "scored",
      successScore: 0.9,
      quality: { outputCompleteness: 0.9, outputCorrectness: 0.9, instructionAdherence: 0.9, downstreamReadiness: 0.9, riskLevel: 0.1 },
      performance: { durationSeconds: 1, retries: 0 },
      outcome: { reason: "ok", producedArtifactsCount: 1, blockingIssuesCount: 0, warningsCount: 0, handoffReady: true },
    };
    expect(WorkflowStepResult.parse(base).resultSummary).toBeUndefined();
    const withExtras = WorkflowStepResult.parse({
      ...base,
      resultSummary: "Recommends Approach A.",
      primaryArtifact: { reference: ".orca/specs/2026-06-17-x.md", description: "design spec" },
    });
    expect(withExtras.resultSummary).toContain("Approach A");
    expect(withExtras.primaryArtifact?.reference).toContain(".orca/specs");
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
