import { describe, expect, it } from "vitest";
import {
  StepSkillProposal, OrchestrationDecisionKind, OperatorDescriptor,
  SubmitWorkflowUserInputRequest, WorkflowStepRun,
} from "./index.js";

describe("StepSkillProposal", () => {
  it("parses an ask", () => {
    expect(StepSkillProposal.parse({ action: "ask", question: "why?" }).action).toBe("ask");
  });
  it("parses a complete with self-check", () => {
    const p = StepSkillProposal.parse({
      action: "complete",
      output: { problem: "x" },
      completion: { confidence: "high", assumptions: [], openQuestions: [], whyComplete: "done" },
    });
    expect(p.action).toBe("complete");
  });
});

it("adds run_step_skill kind", () => {
  expect(OrchestrationDecisionKind.parse("run_step_skill")).toBe("run_step_skill");
});

it("operator descriptor carries provider/model", () => {
  const d = OperatorDescriptor.parse({
    id: "orca/anthropic:claude-sonnet-4-6", kind: "model", displayName: "Claude",
    capabilities: [], ready: true, supportsRepoEditing: false, supportsTerminal: false,
    providerId: "orca/anthropic", modelId: "claude-sonnet-4-6",
  });
  expect(d.providerId).toBe("orca/anthropic");
});

it("submit request requires questionDecisionId path", () => {
  const r = SubmitWorkflowUserInputRequest.parse({
    stepRunId: "s1", questionDecisionId: "dec-1", answerText: "hello",
  });
  expect(r.questionDecisionId).toBe("dec-1");
});

it("step run drops exit criteria, adds selection fields", () => {
  const s = WorkflowStepRun.parse({
    id: "s1", goalId: "g", workflowRunId: "r", stepTemplateId: "intake",
    ordinal: 0, attempt: 1, status: "active",
    startedAt: null, finishedAt: null, blockedReason: null,
    selectedOperatorId: "orca/anthropic:claude-sonnet-4-6",
    selectedProviderId: "orca/anthropic", selectedModelId: "claude-sonnet-4-6",
    operatorSelectedAt: "2026-05-27T00:00:00.000Z",
    stepResult: null,
  });
  expect(s.selectedModelId).toBe("claude-sonnet-4-6");
  expect("satisfiedExitCriteria" in s).toBe(false);
});
