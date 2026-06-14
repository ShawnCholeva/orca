import {
  GateEvaluationProposal,
  GateEvaluationRequest,
  OrchestrationRequest,
  type ModelProviderId,
} from "@orca/contracts";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";

export interface GateEvaluationDeps {
  broker: Pick<OrchestrationTransportBroker, "propose">;
}

export interface GateEvaluationInput {
  goalId: string;
  workflowRunId: string;
  providerId: ModelProviderId;
  modelId: string;
  goal: { id: string; description: string };
  gate: { nodeId: string; name: string; instructions: string };
  sourceStepOutput: Record<string, unknown> | null;
  priorGateDecisions: { nodeId: string; outcome: "approved" | "rejected"; reason: string }[];
  availableOutcomes: ReadonlyArray<"approved" | "rejected">;
  committedLedger: { id: string; recordType: string; status: string; note: string }[];
}

export type GateEvaluationResult =
  | { ok: true; decision: GateEvaluationProposal & { issueRefs: string[] } }
  | { ok: false; reason: string };

export async function evaluateGate(
  deps: GateEvaluationDeps,
  input: GateEvaluationInput
): Promise<GateEvaluationResult> {
  const requestPayload = GateEvaluationRequest.parse({
    gate: input.gate,
    goal: input.goal,
    sourceStepOutput: input.sourceStepOutput,
    priorGateDecisions: input.priorGateDecisions,
    availableOutcomes: [...input.availableOutcomes],
    committedLedger: input.committedLedger,
  });

  const request = OrchestrationRequest.parse({
    kind: "evaluate_gate",
    goalId: input.goalId,
    workflowRunId: input.workflowRunId,
    stepRunId: null,
    providerId: input.providerId,
    modelId: input.modelId,
    payload: requestPayload,
  });

  const permitted = new Set(input.availableOutcomes);
  let lastFailure: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await deps.broker.propose(request, {
      validateProposal: (raw) => {
        const parsed = GateEvaluationProposal.safeParse(raw);
        if (!parsed.success) {
          lastFailure = "invalid gate proposal structure";
          return { accepted: false, failureMessage: lastFailure };
        }
        if (!permitted.has(parsed.data.outcome)) {
          lastFailure = `outcome '${parsed.data.outcome}' is not permitted`;
          return { accepted: false, failureMessage: lastFailure };
        }
        return {
          accepted: true,
          parsed: { ...parsed.data, issueRefs: parsed.data.issueRefs ?? [] },
        };
      },
    });
    if (result.status !== "proposed") continue;
    return { ok: true, decision: result.parsed as GateEvaluationProposal & { issueRefs: string[] } };
  }

  return { ok: false, reason: lastFailure ?? "gate evaluation produced no proposal" };
}
