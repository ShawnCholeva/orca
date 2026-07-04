import { RefuteCompletionProposal, type RefuteCompletionRequest } from "@orca/contracts";
import type { ShadowAdapterId } from "../../orchestrator-llm/shadow-session.js";
import type { ShadowAsk } from "./recover-step-scoring.js";

export function composeRefutePrompt(
  request: RefuteCompletionRequest
): { systemPrompt: string; userPrompt: string } {
  // p.37 anti-circularity + p.47 integrate-both: the refute is an INDEPENDENT
  // adversarial check that targets only the scope the deterministic oracle did
  // NOT cover. Default to "uncertain" over a guessed "refuted" (p.31 calibrated).
  const oracleLine = request.oracle.ran
    ? [
        `Deterministic sensors ALREADY verified this step (verdict: ${request.oracle.verdict ?? "n/a"}).`,
        `They did NOT cover: ${request.oracle.gaps.length ? request.oracle.gaps.join(", ") : "(no declared gaps)"}.`,
        "Do NOT re-litigate what the sensors verified — judge only the unverified scope:",
        "semantic correctness, instruction adherence, and downstream readiness.",
      ].join("\n")
    : "No deterministic verification ran for this step — you are the only check on its correctness.";
  const systemPrompt = [
    "You are an INDEPENDENT reviewer. Adversarially try to REFUTE that the step output",
    "satisfies the step's instructions toward the goal. Actively look for a concrete,",
    "evidence-grounded reason it does NOT — do not re-affirm the author's own scoring.",
    oracleLine,
    "Return one of three verdicts: 'refuted' (you found a concrete failure), 'upheld'",
    "(no concrete reason to refute), or 'uncertain' (plausible but you genuinely cannot",
    "tell — do NOT guess 'refuted'). On 'refuted', issueRefs is a short enumerated list of",
    "the specific, addressable failures ('fix only these'); on 'upheld'/'uncertain' it is [].",
    "List in inputsConsidered exactly which evidence you used.",
    "Emit exactly one RefuteCompletionProposal JSON object in one fenced block, nothing after:",
    "```orca:action",
    '{ "verdict": "...", "reason": "...", "issueRefs": [...], "inputsConsidered": [...] }',
    "```",
  ].join("\n");
  return { systemPrompt, userPrompt: JSON.stringify(request) };
}

export async function refuteStepCompletion(
  deps: ShadowAsk,
  input: { refuteSessionKey: string; adapterId: ShadowAdapterId; request: RefuteCompletionRequest; timeoutMs: number }
): Promise<RefuteCompletionProposal | null> {
  const { systemPrompt, userPrompt } = composeRefutePrompt(input.request);
  let lastFailure = "no attempts made";
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      ({ text } = await deps.ask(input.refuteSessionKey, {
        adapterId: input.adapterId, systemPrompt, userPrompt, timeoutMs: input.timeoutMs,
      }));
    } catch (err) {
      lastFailure = `shadow ask failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { lastFailure = "response was not JSON"; continue; }
    const parsed = RefuteCompletionProposal.safeParse(raw);
    if (parsed.success) return parsed.data;
    lastFailure = `invalid RefuteCompletionProposal: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 200)}`;
  }
  // Caller escalates to a human on null; surface WHY for observability (p.33).
  console.warn(`[refute] step-completion refute failed for session ${input.refuteSessionKey}: ${lastFailure}`);
  return null;
}
