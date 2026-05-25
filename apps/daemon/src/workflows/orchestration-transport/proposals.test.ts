import type {
  OperatorDescriptor,
  OperatorSelection,
  WorkflowGuardrailConfig,
} from "@orca/contracts";
import { describe, expect, it } from "vitest";

import {
  parseOrchestrationProposal,
  validateOperatorSelectionProposal,
} from "./proposals.js";

const READY_OPERATORS: OperatorDescriptor[] = [
  {
    id: "agent:codex",
    kind: "agent",
    displayName: "Codex",
    capabilities: ["implementation", "code_editing"],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  },
  {
    id: "human",
    kind: "human",
    displayName: "Human",
    capabilities: ["judgment"],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  },
];

function selection(patch: Partial<OperatorSelection> = {}): OperatorSelection {
  return {
    operatorId: "agent:codex",
    operatorKind: "agent",
    reason: "best match",
    requiredCapabilities: ["implementation"],
    alternativesConsidered: ["human"],
    confidence: 0.82,
    requiresUserApproval: false,
    ...patch,
  };
}

function envelope(payload: unknown = selection(), kind = "select_operator"): string {
  return JSON.stringify({
    orcaProposalVersion: 1,
    kind,
    payload,
  });
}

function allowedOperators(allowed: string[]): WorkflowGuardrailConfig {
  return {
    id: "allowed-operators",
    kind: "allowed_operators",
    label: "Allowed operators",
    configJson: { allowed },
  };
}

function approvalRequired(): WorkflowGuardrailConfig {
  return {
    id: "approval-required",
    kind: "approval_required",
    label: "Approval required",
    configJson: { actions: ["select_operator"] },
  };
}

describe("orchestration proposal parser", () => {
  it("rejects raw text with no JSON envelope", () => {
    const raw = "not json token=secret";

    const result = parseOrchestrationProposal(raw, { expectedKind: "select_operator" });

    expect(result).toEqual({
      ok: false,
      failureReason: "one_shot_parse_failed",
      failureMessage: "no proposal envelope found",
      rawTextLength: raw.length,
    });
  });

  it("rejects multiple proposal envelopes", () => {
    const raw = `${envelope()} ${envelope(selection({ operatorId: "human", operatorKind: "human" }))}`;

    const result = parseOrchestrationProposal(raw, { expectedKind: "select_operator" });

    expect(result).toMatchObject({
      ok: false,
      failureReason: "one_shot_parse_failed",
      failureMessage: "multiple proposal envelopes found",
      rawTextLength: raw.length,
    });
  });

  it("rejects unsupported proposal envelope versions", () => {
    const raw = JSON.stringify({
      orcaProposalVersion: 2,
      kind: "select_operator",
      payload: selection(),
    });

    const result = parseOrchestrationProposal(raw, {
      expectedKind: "select_operator",
      malformedFailureReason: "interactive_output_invalid",
    });

    expect(result).toMatchObject({
      ok: false,
      failureReason: "interactive_output_invalid",
      failureMessage: "unsupported proposal envelope version",
      rawTextLength: raw.length,
    });
  });

  it("rejects kind mismatches", () => {
    const raw = envelope({}, "repair_artifact");

    const result = parseOrchestrationProposal(raw, { expectedKind: "select_operator" });

    expect(result).toMatchObject({
      ok: false,
      failureReason: "one_shot_parse_failed",
      failureMessage: "proposal kind mismatch",
      rawTextLength: raw.length,
    });
  });

  it("rejects select_operator payload schema mismatches", () => {
    const raw = envelope({ operatorId: "agent:codex" });

    const result = parseOrchestrationProposal(raw, { expectedKind: "select_operator" });

    expect(result).toMatchObject({
      ok: false,
      failureReason: "one_shot_parse_failed",
      failureMessage: "proposal payload schema mismatch",
      rawTextLength: raw.length,
    });
  });

  it("parses exactly one valid operator-selection envelope without returning raw text", () => {
    const raw = `prefix ${envelope()} suffix`;

    const result = parseOrchestrationProposal(raw, { expectedKind: "select_operator" });

    expect(result).toMatchObject({
      ok: true,
      parsed: selection(),
      rawTextLength: raw.length,
    });
    expect(JSON.stringify(result)).not.toContain(raw);
  });
});

describe("operator-selection proposal semantic validation", () => {
  it("accepts registered ready operators and applies approval guardrails", () => {
    const result = validateOperatorSelectionProposal({
      selection: selection(),
      goalId: "goal-1",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepTemplateId: "execution",
      readyOperators: READY_OPERATORS,
      guardrails: [approvalRequired()],
    });

    expect(result).toEqual({
      valid: true,
      selection: selection({ requiresUserApproval: true }),
    });
  });

  it("rejects selections outside the ready operator registry", () => {
    const result = validateOperatorSelectionProposal({
      selection: selection({ operatorId: "agent:missing" }),
      goalId: "goal-1",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      readyOperators: READY_OPERATORS,
      guardrails: [],
    });

    expect(result).toEqual({
      valid: false,
      failureReason: "proposal_rejected",
      failureMessage: "selected operator is not ready or not registered",
    });
  });

  it("rejects selections denied by guardrails", () => {
    const result = validateOperatorSelectionProposal({
      selection: selection(),
      goalId: "goal-1",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepTemplateId: "execution",
      readyOperators: READY_OPERATORS,
      guardrails: [allowedOperators(["human"])],
    });

    expect(result).toEqual({
      valid: false,
      failureReason: "proposal_rejected",
      failureMessage: "operator selection rejected by guardrails",
    });
  });
});
