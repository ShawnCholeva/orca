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
    '{ "reasoning": "...", "outcome": "approved|rejected", "reason": "...", "issueRefs": [...], "inputsConsidered": [...] }',
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
