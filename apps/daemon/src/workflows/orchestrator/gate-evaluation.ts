import { GateEvaluationProposal, type GateEvaluationRequest } from "@orca/contracts";
import type { ShadowAdapterId } from "../../orchestrator-llm/shadow-session.js";
import type { ShadowAsk } from "./recover-step-scoring.js";

/**
 * Deterministic bound on how many times one gate node may reject and re-route
 * before the run is blocked as non-converging. Paired with the accumulated issue
 * evidence on the block reason (agent-harness.pdf p.31/p.46: termination is
 * verification-governed, and a bare iteration cap needs an objective signal).
 * Sibling of REVISE_CAP.
 */
export const GATE_REJECT_CAP = 3;

export function composeGateEvaluationPrompt(
  request: GateEvaluationRequest
): { systemPrompt: string; userPrompt: string } {
  // p.31: a critique should INTERPRET deterministic sensor outputs, not replace
  // them. The committedLedger carries the deterministic evidence (sensor/verify
  // records, decisions); the evaluator grounds its verdict in it and must not
  // override a verdict already present there — this is also how the automated
  // gate composes with composition's verdict-gated join instead of fighting it.
  const systemPrompt = [
    "You are the gate evaluator (the Verify step) for a workflow. Decide whether the source",
    "step output satisfies the gate, judged against the goal and the gate instructions.",
    "Ground your verdict in the supplied EVIDENCE: the committedLedger records (deterministic",
    "sensor results, verifications, and prior decisions) and the sourceStepOutput. Interpret",
    "that evidence — do NOT override a deterministic sensor/verification verdict already present",
    "in it, and do not invent findings the evidence does not support.",
    "Choose an outcome from availableOutcomes only, and list in inputsConsidered exactly which",
    "evidence you used.",
    "On 'rejected', issueRefs MUST be a short enumerated list of specific, addressable failures",
    "— 'fix only these; do not rewrite what is correct'. On 'approved', issueRefs is [].",
    "Produce exactly one GateEvaluationProposal JSON object in one fenced block, nothing after",
    "the closing fence:",
    "```orca:action",
    '{ "outcome": "...", "reason": "...", "issueRefs": [...], "inputsConsidered": [...] }',
    "```",
  ].join("\n");
  return { systemPrompt, userPrompt: JSON.stringify(request) };
}

/**
 * Order-insensitive equality of two issue lists. Powers the objective
 * non-progress (stagnation) termination signal: if a gate re-rejects with the
 * exact same unresolved issues, the loop is not converging (agent-harness.pdf
 * p.46 — a bare iteration cap lacks an objective quality criterion).
 */
export function issueRefsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export async function evaluateGate(
  deps: ShadowAsk,
  input: {
    goalId: string;
    adapterId: ShadowAdapterId;
    request: GateEvaluationRequest;
    timeoutMs: number;
  }
): Promise<GateEvaluationProposal | null> {
  const { systemPrompt, userPrompt } = composeGateEvaluationPrompt(input.request);
  let lastFailure = "no attempts made";
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      ({ text } = await deps.ask(input.goalId, {
        adapterId: input.adapterId,
        systemPrompt,
        userPrompt,
        timeoutMs: input.timeoutMs,
      }));
    } catch (err) {
      lastFailure = `shadow ask failed: ${err instanceof Error ? err.message : String(err)}`;
      continue; // retry once
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      lastFailure = "response was not JSON";
      continue;
    }
    const parsed = GateEvaluationProposal.safeParse(raw);
    if (parsed.success) return parsed.data;
    lastFailure = `invalid GateEvaluationProposal: ${parsed.error.issues
      .map((i) => `${i.path.join(".")} ${i.message}`)
      .join("; ")
      .slice(0, 200)}`;
  }
  // The caller falls back to a human park on null; surface WHY the automated
  // evaluation was abandoned so an L5 gate silently reverting to human review is
  // diagnosable (agent-harness.pdf p.33 — failure traces make progress inspectable).
  console.warn(
    `[gate-eval] evaluation failed for gate ${input.request.gate.nodeId} (goal ${input.goalId}); falling back to human review: ${lastFailure}`
  );
  return null;
}
