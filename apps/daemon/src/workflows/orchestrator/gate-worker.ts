import { GateEvaluationProposal, type GateEvaluationRequest } from "@orca/contracts";

export function composeGateWorkerPrompt(request: GateEvaluationRequest): string {
  return [
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
      goal: request.goal,
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
