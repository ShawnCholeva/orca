import { GateEvaluationProposal, type GateEvaluationRequest } from "@orca/contracts";
import { successCriteriaHint } from "./success-criteria-prompt.js";

export function composeGateWorkerPrompt(request: GateEvaluationRequest): string {
  // Normalize an explicit empty successCriteria to the same shape as an omitted
  // one (JSON.stringify drops undefined-valued keys) so the serialized EVIDENCE
  // goal is byte-identical whether the caller passed [] or left the key out —
  // parity for goals without success criteria must not depend on that.
  const goalForEvidence = request.goal.successCriteria?.length
    ? request.goal
    : { ...request.goal, successCriteria: undefined };
  return successCriteriaHint(request.goal.successCriteria) + [
    request.gate.instructions,
    "",
    "Judge the SOURCE STEP OUTPUT against the goal and the instructions above,",
    "grounding your verdict ONLY in the EVIDENCE. Do not invent findings.",
    "On 'rejected', issueRefs MUST enumerate the specific, addressable blocking",
    "failures — 'fix only these; do not rewrite what is correct'. On 'approved', issueRefs is [].",
    "",
    "`residualRisks` MUST list the risks that remain even if you approve — each a short",
    "statement with a severity of \"low\", \"medium\", or \"high\". Use [] only if genuinely none.",
    "",
    // Constrain the verdict to the outcomes this gate actually wires an edge for
    // (a gate may only offer 'approved'); an unoffered outcome would fail routing.
    `\`outcome\` MUST be exactly one of: ${request.availableOutcomes.map((o) => `"${o}"`).join(", ")}.`,
    "",
    "EVIDENCE:",
    JSON.stringify({
      goal: goalForEvidence,
      sourceStepOutput: request.sourceStepOutput,
      committedLedger: request.committedLedger,
      priorGateDecisions: request.priorGateDecisions,
    }),
    "",
    "When done, emit EXACTLY one fenced block, nothing after the closing fence:",
    "```orca:gate-decision",
    `{ "reasoning": "...", "outcome": ${request.availableOutcomes.map((o) => `"${o}"`).join("|")}, "reason": "...", "residualRisks": [{ "risk": "...", "severity": "low|medium|high" }], "issueRefs": [...], "inputsConsidered": [...] }`,
    "```",
  ].join("\n");
}

const BLOCK = /```orca:gate-decision\s*([\s\S]*?)```/;

export function parseGateDecision(workerOutput: string): GateEvaluationProposal | null {
  const m = BLOCK.exec(workerOutput);
  if (!m) return null;
  try {
    const parsed = GateEvaluationProposal.safeParse(JSON.parse(m[1].trim()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
