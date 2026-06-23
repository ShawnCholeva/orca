import {
  OperatorSelection,
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  type OperatorDescriptor,
  type OperatorSelection as OperatorSelectionT,
  type OrchestrationDecisionKind,
  type OrchestrationTransportFailureReason,
  type WorkflowGuardrailConfig,
} from "@orca/contracts";

import { redactSecrets } from "../../memory/normalize.js";
import { evaluateGuardrail, type GuardrailContext } from "../guardrails/evaluator.js";

export type MalformedProposalFailureReason = Extract<
  OrchestrationTransportFailureReason,
  "one_shot_parse_failed" | "interactive_output_invalid"
>;

export type ParsedProposal =
  | {
      ok: true;
      parsed: OperatorSelectionT;
      rawTextLength: number;
    }
  | {
      ok: false;
      failureReason: MalformedProposalFailureReason;
      failureMessage: string;
      rawTextLength: number;
    };

export interface ParseProposalOptions {
  expectedKind: OrchestrationDecisionKind;
  malformedFailureReason?: MalformedProposalFailureReason;
}

export interface ValidateOperatorSelectionProposalInput {
  selection: OperatorSelectionT;
  goalId: string;
  workflowRunId: string;
  stepRunId: string | null;
  stepTemplateId?: string;
  readyOperators: OperatorDescriptor[];
  guardrails: WorkflowGuardrailConfig[];
}

export type OperatorSelectionProposalValidation =
  | { valid: true; selection: OperatorSelectionT }
  | {
      valid: false;
      failureReason: Extract<OrchestrationTransportFailureReason, "proposal_rejected">;
      failureMessage: string;
    };

type JsonObject = Record<string, unknown>;

const DEFAULT_MALFORMED_REASON: MalformedProposalFailureReason = "one_shot_parse_failed";

function failure(
  rawText: string,
  reason: MalformedProposalFailureReason,
  message: string
): ParsedProposal {
  return {
    ok: false,
    failureReason: reason,
    failureMessage: sanitizeFailureMessage(message),
    rawTextLength: rawText.length,
  };
}

function sanitizeFailureMessage(message: string): string {
  const sanitized = redactSecrets(message.replace(/\s+/g, " ").trim()).slice(
    0,
    WORKFLOW_FAILURE_MAX_MESSAGE_CHARS
  );
  return sanitized.length > 0 ? sanitized : "invalid proposal envelope";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProposalVersionKey(value: unknown): value is JsonObject {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, "orcaProposalVersion");
}

function findJsonObjectEnd(rawText: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < rawText.length; index += 1) {
    const ch = rawText[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return null;
    }
  }

  return null;
}

function extractProposalEnvelopeCandidates(rawText: string): JsonObject[] {
  const candidates: JsonObject[] = [];

  for (let index = 0; index < rawText.length; index += 1) {
    if (rawText[index] !== "{") continue;
    const end = findJsonObjectEnd(rawText, index);
    if (end === null) continue;

    try {
      const parsed = JSON.parse(rawText.slice(index, end + 1)) as unknown;
      if (hasProposalVersionKey(parsed)) candidates.push(parsed);
    } catch {
      // Keep scanning: malformed JSON near an envelope will be reported if no valid envelope exists.
    }
  }

  return candidates;
}

function validatePayload(
  rawText: string,
  envelope: {
    kind: OrchestrationDecisionKind;
    payload: unknown;
  },
  reason: MalformedProposalFailureReason
): ParsedProposal {
  switch (envelope.kind) {
    case "select_operator": {
      const parsed = OperatorSelection.safeParse(envelope.payload);
      if (!parsed.success) {
        return failure(rawText, reason, "proposal payload schema mismatch");
      }
      return {
        ok: true,
        parsed: parsed.data,
        rawTextLength: rawText.length,
      };
    }
    case "score_transition":
    case "score_step_result":
    case "evaluate_gate":
    case "evaluate_split":
    case "repair_artifact":
    case "run_audit":
    case "run_step_skill":
    case "synthesize_step_output":
      return failure(rawText, reason, "unsupported proposal kind");
  }
}

export function parseOrchestrationProposal(
  rawText: string,
  options: ParseProposalOptions
): ParsedProposal {
  const reason = options.malformedFailureReason ?? DEFAULT_MALFORMED_REASON;
  const candidates = extractProposalEnvelopeCandidates(rawText);

  if (candidates.length === 0) {
    return failure(rawText, reason, "no proposal envelope found");
  }

  if (candidates.length > 1) {
    return failure(rawText, reason, "multiple proposal envelopes found");
  }

  const rawEnvelope = candidates[0]!;
  if (rawEnvelope.orcaProposalVersion !== 1) {
    return failure(rawText, reason, "unsupported proposal envelope version");
  }

  if (rawEnvelope.kind !== options.expectedKind) {
    return failure(rawText, reason, "proposal kind mismatch");
  }

  return validatePayload(
    rawText,
    { kind: options.expectedKind, payload: rawEnvelope.payload },
    reason
  );
}

export function validateOperatorSelectionProposal(
  input: ValidateOperatorSelectionProposalInput
): OperatorSelectionProposalValidation {
  const selectedOperator = input.readyOperators.find(
    (operator) =>
      operator.ready &&
      operator.id === input.selection.operatorId &&
      operator.kind === input.selection.operatorKind
  );
  if (!selectedOperator) {
    return {
      valid: false,
      failureReason: "proposal_rejected",
      failureMessage: "selected operator is not ready or not registered",
    };
  }

  const ctx: GuardrailContext = {
    goalId: input.goalId,
    workflowRunId: input.workflowRunId,
    stepRunId: input.stepRunId,
    stepTemplateId: input.stepTemplateId,
    candidateAction: { kind: "select_operator", operatorId: input.selection.operatorId },
  };
  const results = input.guardrails.map((guardrail) => evaluateGuardrail(guardrail, ctx));

  if (results.some((result) => result.result === "deny")) {
    return {
      valid: false,
      failureReason: "proposal_rejected",
      failureMessage: "operator selection rejected by guardrails",
    };
  }

  const requiresUserApproval =
    input.selection.requiresUserApproval ||
    results.some((result) => result.result === "require_approval");

  return {
    valid: true,
    selection: {
      ...input.selection,
      requiresUserApproval,
    },
  };
}
