import { ProposeInstructionRevisionProposal, ProposeSchemaRevisionProposal, type OrchestrationRequest } from "@orca/contracts";
import type { DiagnosisBundle } from "./diagnose.js";
import { parseSchema, serializeSchema, validateSchemaTightening } from "./schema-mutation.js";

export type BrokerLike = {
  propose(
    request: OrchestrationRequest,
    options: { validateProposal: (raw: unknown) => { accepted: true; parsed?: unknown } | { accepted: false; failureMessage?: string | null } },
  ): Promise<{ status: "proposed"; parsed: unknown } | { status: "needs_human_review"; reviewPayloadId: string }>;
};

const INSTRUCTION =
  "You are improving one step's instruction text for a workflow template. Produce a MINIMAL, targeted edit " +
  "that addresses the diagnosed failure mode while preserving the listed invariants. Fix the diagnosed failure; " +
  "do not rewrite what already works. Return only the structured proposal.";

const SCHEMA_INSTRUCTION =
  "You are improving one step's REQUIRED OUTPUT STRUCTURE (its output schema) for a workflow template. " +
  "The step passes review but is weakly verified — tighten the schema so the step must show its work: " +
  "add checkable required fields (evidence references, risks, acceptance-criteria mapping). " +
  "TIGHTEN ONLY: you may add fields, make optional fields required, and add descriptions. " +
  "Never remove, rename, or retype a field, and never change an enum. Return only the structured proposal.";

export function buildProposePayload(bundle: DiagnosisBundle): Record<string, unknown> {
  if (bundle.component === "step_output_schema") {
    return {
      instruction: SCHEMA_INSTRUCTION,
      currentOutputSchema: bundle.currentOutputSchemaJson,
      targetedFailureMode: bundle.targetedFailureMode,
      refuteReasons: bundle.evidence.refuteReasons,
      metricSnapshot: bundle.evidence.metricSnapshot,
    };
  }
  return {
    instruction: INSTRUCTION,
    currentInstructions: bundle.currentInstructions,
    targetedFailureMode: bundle.targetedFailureMode,
    revisionFeedbackTexts: bundle.evidence.revisionFeedbackTexts,
    refuteReasons: bundle.evidence.refuteReasons,
    supersededReasons: bundle.evidence.supersededReasons,
    metricSnapshot: bundle.evidence.metricSnapshot,
  };
}

export function validateRevisionProposal(bundle: DiagnosisBundle) {
  if (bundle.component === "step_output_schema") {
    const before = parseSchema(bundle.currentOutputSchemaJson) ?? [];
    return (raw: unknown): { accepted: true; parsed: ProposeSchemaRevisionProposal } | { accepted: false; failureMessage: string } => {
      const parsed = ProposeSchemaRevisionProposal.safeParse(raw);
      if (!parsed.success) return { accepted: false, failureMessage: "proposal failed schema (check field shapes / invariant keys)" };
      const tightening = validateSchemaTightening(before, parsed.data.proposedOutputSchema);
      if (!tightening.ok) return { accepted: false, failureMessage: `not a pure tightening: ${tightening.errors.join("; ").slice(0, 400)}` };
      if (serializeSchema(parsed.data.proposedOutputSchema) === serializeSchema(before)) {
        return { accepted: false, failureMessage: "proposed schema is identical to current (no-op)" };
      }
      return { accepted: true, parsed: parsed.data };
    };
  }
  const currentInstructions = bundle.currentInstructions;
  return (raw: unknown): { accepted: true; parsed: ProposeInstructionRevisionProposal } | { accepted: false; failureMessage: string } => {
    const parsed = ProposeInstructionRevisionProposal.safeParse(raw);
    if (!parsed.success) return { accepted: false, failureMessage: "proposal failed schema (check invariant keys / length)" };
    if (parsed.data.proposedInstructions.trim() === currentInstructions.trim()) {
      return { accepted: false, failureMessage: "proposed instructions are identical to current (no-op)" };
    }
    return { accepted: true, parsed: parsed.data };
  };
}

export async function proposeInstructionRevision(
  deps: { broker: BrokerLike; providerId: string; modelId: string },
  ctx: { goalId: string; workflowRunId: string; stepRunId: string },
  bundle: DiagnosisBundle,
): Promise<ProposeInstructionRevisionProposal | ProposeSchemaRevisionProposal | null> {
  const request: OrchestrationRequest = {
    kind: "propose_instruction_revision",
    goalId: ctx.goalId, workflowRunId: ctx.workflowRunId, stepRunId: ctx.stepRunId,
    providerId: deps.providerId, modelId: deps.modelId,
    payload: buildProposePayload(bundle),
  } as OrchestrationRequest;

  const result = await deps.broker.propose(request, { validateProposal: validateRevisionProposal(bundle) });
  if (result.status !== "proposed") return null;
  if (bundle.component === "step_output_schema") {
    const parsed = ProposeSchemaRevisionProposal.safeParse(result.parsed);
    return parsed.success ? parsed.data : null;
  }
  const parsed = ProposeInstructionRevisionProposal.safeParse(result.parsed);
  return parsed.success ? parsed.data : null;
}
