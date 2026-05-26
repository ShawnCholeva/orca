import { describe, expect, test } from "vitest";
import {
  M8EventType,
  WORKFLOW_EVENT_MAX_PAYLOAD_BYTES,
  WorkflowEvent,
  WorkflowEventType,
} from "@orca/contracts";

const payloadByType: Record<(typeof WorkflowEventType.options)[number], Record<string, unknown>> = {
  "workflow.template.created": { templateId: "custom/1", version: 1 },
  "workflow.template.updated": { templateId: "custom/1", version: 2 },
  "workflow.template.duplicated": { templateId: "custom/2", sourceTemplateId: "orca/engineering" },
  "workflow.run.started": { goalId: "goal-1", workflowRunId: "run-1", templateId: "orca/engineering", templateVersion: 1 },
  "workflow.run.paused": { goalId: "goal-1", workflowRunId: "run-1" },
  "workflow.run.blocked": { goalId: "goal-1", workflowRunId: "run-1", failureCode: "daemon_restart" },
  "workflow.run.completed": { goalId: "goal-1", workflowRunId: "run-1" },
  "workflow.run.failed": { goalId: "goal-1", workflowRunId: "run-1", failureCode: "provider_error" },
  "workflow.run.cancelled": { goalId: "goal-1", workflowRunId: "run-1" },
  "workflow.step.started": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", stepTemplateId: "intake", ordinal: 0 },
  "workflow.step.completed": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", stepTemplateId: "intake" },
  "workflow.step.blocked": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1" },
  "workflow.step.skipped": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1" },
  "workflow.step.failed": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", failureCode: "invalid_output" },
  "workflow.artifact.created": { artifactId: "artifact-1", goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", type: "goal_brief", bodyBytes: 42 },
  "workflow.guardrail.evaluated": { guardrailEvaluationId: "eval-1", goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", guardrailId: "approval", guardrailKind: "approval_required", result: "require_approval" },
  "workflow.operator.selected": { decisionId: "decision-1", goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", operatorId: "human", operatorKind: "human", source: "fallback", requiresApproval: true },
  "workflow.decision.requested": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", stepTemplateId: "intake" },
  "workflow.decision.recorded": { decisionId: "decision-1", goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", decisionType: "select_operator", influencedByCount: 1 },
  "workflow.user.input.requested": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", recommendationId: "rec-1" },
  "workflow.user.input.submitted": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", answerBytes: 32, artifactIds: ["artifact-1"], satisfiedExitCriteriaCount: 1 },
  "workflow.recommendation.created": { recommendationId: "rec-1", goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", type: "request_user_input", decisionId: "decision-1" },
  "workflow.recommendation.accepted": { recommendationId: "rec-1", goalId: "goal-1", type: "request_user_input" },
  "workflow.recommendation.rejected": { recommendationId: "rec-1", goalId: "goal-1", type: "launch_workflow_session" },
  "workflow.task.dag.created": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", taskIds: ["task-1"], count: 1 },
  "workflow.task.dag.updated": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", taskIds: ["task-1"], count: 1, changedFields: ["status"] },
  "workflow.validation.run": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", validationId: "validation-1" },
  "workflow.validation.passed": { goalId: "goal-1", workflowRunId: "run-1", validationId: "validation-1" },
  "workflow.validation.failed": { goalId: "goal-1", workflowRunId: "run-1", failureCode: "test_failed" },
  "workflow.validation.skipped": { goalId: "goal-1", workflowRunId: "run-1", validationId: "validation-1" },
  "workflow.transport.attempt_started": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", attemptId: "attempt-1", providerId: "orca/openai", transport: "one_shot", status: "running" },
  "workflow.transport.attempt_finished": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", attemptId: "attempt-1", providerId: "orca/openai", transport: "one_shot", status: "failed", failureReason: "one_shot_unavailable" },
  "workflow.transport.fallback": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", attemptId: "attempt-1", providerId: "orca/openai", transport: "one_shot", status: "fallback", failureReason: "one_shot_unavailable" },
  "workflow.worker.state_changed": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", attemptId: "attempt-2", workerId: "worker-1", providerId: "orca/openai", transport: "hidden_interactive", status: "ready" },
  "workflow.human_review.requested": { goalId: "goal-1", workflowRunId: "run-1", stepRunId: "step-1", attemptId: "attempt-3", providerId: "orca/openai", transport: "human_review", status: "pending" },
};

const FORBIDDEN_KEYS = new Set([
  "prompt",
  "response",
  "reasoning",
  "modelOutput",
  "artifactBody",
  "terminalOutput",
  "summaryText",
]);

const M9_EVENT_TYPES = new Set([
  "workflow.transport.attempt_started",
  "workflow.transport.attempt_finished",
  "workflow.transport.fallback",
  "workflow.worker.state_changed",
  "workflow.human_review.requested",
]);

const FORBIDDEN_VALUES = [
  "prompt text",
  "{\"orcaProposalVersion\":1,\"kind\":\"select_operator\",\"payload\":{\"reason\":\"raw\"}}",
  "raw worker output line 1",
  "{\"contextPackageId\":\"ctx-1\",\"files\":[{\"path\":\"src/secret.ts\",\"body\":\"sensitive\"}]}",
  "authorization: bearer sk-secret",
  "api_key=abc123",
  "token=abc123",
];

function walk(obj: unknown, fn: (key: string) => void): void {
  if (!obj || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj)) {
    fn(key);
    walk(value, fn);
  }
}

describe("M8 workflow event payload caps", () => {
  test("all M8 workflow literals are in contracts", () => {
    for (const type of M8EventType.options) {
      if (type.startsWith("workflow.")) {
        expect(WorkflowEventType.options).toContain(type);
      }
    }
  });

  test("sample payloads are content-free and within 4 KiB", () => {
    for (const type of WorkflowEventType.options) {
      const payload = payloadByType[type];
      const parsed = WorkflowEvent.parse({ type, payload });
      expect(parsed.type).toBe(type);
      const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      expect(bytes).toBeLessThanOrEqual(WORKFLOW_EVENT_MAX_PAYLOAD_BYTES);
      walk(payload, (key) => {
        expect(FORBIDDEN_KEYS.has(key)).toBe(false);
      });
    }
  });

  test("M9 events reject payloads that exceed cap due to sensitive raw content", () => {
    for (const type of WorkflowEventType.options) {
      if (!M9_EVENT_TYPES.has(type)) continue;
      for (const forbiddenValue of FORBIDDEN_VALUES) {
        const payload = {
          ...payloadByType[type],
          attemptId: forbiddenValue.repeat(512),
        };
        expect(() => WorkflowEvent.parse({ type, payload })).toThrow(
          /at most .* bytes when serialized/
        );
      }
    }
  });
});
