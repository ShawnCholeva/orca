import { ProposeInstructionRevisionProposal, type OrchestrationRequest } from "@orca/contracts";
import type { DiagnosisBundle } from "./diagnose.js";

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

export function buildProposePayload(bundle: DiagnosisBundle): Record<string, unknown> {
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

export function validateRevisionProposal(currentInstructions: string) {
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
): Promise<ProposeInstructionRevisionProposal | null> {
  const request: OrchestrationRequest = {
    kind: "propose_instruction_revision",
    goalId: ctx.goalId, workflowRunId: ctx.workflowRunId, stepRunId: ctx.stepRunId,
    providerId: deps.providerId, modelId: deps.modelId,
    payload: buildProposePayload(bundle),
  } as OrchestrationRequest;

  const result = await deps.broker.propose(request, { validateProposal: validateRevisionProposal(bundle.currentInstructions) });
  if (result.status !== "proposed") return null;
  const parsed = ProposeInstructionRevisionProposal.safeParse(result.parsed);
  return parsed.success ? parsed.data : null;
}
