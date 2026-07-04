import { JudgeInstructionEditProposal, type JudgeInstructionEditRequest } from "@orca/contracts";
import type { ShadowAdapterId } from "../orchestrator-llm/shadow-session.js";
import type { ShadowAsk } from "../workflows/orchestrator/recover-step-scoring.js";

export function composeJudgePrompt(
  request: JudgeInstructionEditRequest
): { systemPrompt: string; userPrompt: string } {
  // Anti-circularity (p.37 AgentCoder Test-Designer / p.46 CANDOR): judge each output
  // against the step INSTRUCTIONS (the spec), NOT any prior scoring (none is given).
  // Criterion (p.33/§3.5.2): improve the targeted failure WITHOUT regressing solved cases.
  const systemPrompt = [
    "You are an INDEPENDENT reviewer evaluating a PROPOSED edit to one workflow step's instruction text.",
    "Judge each past output against the step INSTRUCTIONS (the spec). You are given NO prior scoring —",
    "ground your judgment in the outputs themselves; do not defer to the author.",
    "solvedCases PREVIOUSLY PASSED independent verification and MUST NOT regress under the proposed edit.",
    "failureCases exhibit the targeted failure mode and SHOULD improve under the proposed edit.",
    "For each solved case, would the PROPOSED instructions still yield an output that satisfies the instructions?",
    "Name any that would regress in regressionCases. For the failure cases, would the edit plausibly fix them?",
    "Return 'pass' ONLY if you find no concrete regression AND the edit addresses the failure mode;",
    "'regression_risk' if a previously-solved case would concretely break; 'uncertain' if plausible but you",
    "genuinely cannot tell — do NOT guess. List in inputsConsidered exactly which cases you used.",
    "Emit exactly one JudgeInstructionEditProposal JSON object in one fenced block, nothing after:",
    "```orca:action",
    '{ "verdict": "...", "regressionRisk": "...", "addressesFailureMode": "...", "regressionCases": [...], "reason": "...", "inputsConsidered": [...] }',
    "```",
  ].join("\n");
  return { systemPrompt, userPrompt: JSON.stringify(request) };
}

export async function judgeInstructionEdit(
  deps: ShadowAsk,
  input: { judgeSessionKey: string; adapterId: ShadowAdapterId; request: JudgeInstructionEditRequest; timeoutMs: number }
): Promise<JudgeInstructionEditProposal | null> {
  const { systemPrompt, userPrompt } = composeJudgePrompt(input.request);
  let lastFailure = "no attempts made";
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      ({ text } = await deps.ask(input.judgeSessionKey, {
        adapterId: input.adapterId, systemPrompt, userPrompt, timeoutMs: input.timeoutMs,
      }));
    } catch (err) {
      lastFailure = `shadow ask failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { lastFailure = "response was not JSON"; continue; }
    const parsed = JudgeInstructionEditProposal.safeParse(raw);
    if (parsed.success) return parsed.data;
    lastFailure = `invalid JudgeInstructionEditProposal: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 200)}`;
  }
  // Caller records "unavailable" on null; surface WHY for observability (p.33).
  console.warn(`[judge] instruction-edit judge failed for session ${input.judgeSessionKey}: ${lastFailure}`);
  return null;
}
