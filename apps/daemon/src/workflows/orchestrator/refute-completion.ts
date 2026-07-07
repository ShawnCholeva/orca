import { REASONING_MAX, RefuteCompletionProposal, type RefuteCompletionRequest } from "@orca/contracts";
import type { ShadowAdapterId } from "../../orchestrator-llm/shadow-session.js";
import type { ShadowAsk } from "./recover-step-scoring.js";

// Free-text fields are audit trail, not gate inputs: a reviewer who answered
// with an overlong `reasoning` still delivered a verdict, and discarding it
// (parse → null → "unavailable") forces a needless human pause. Clamp the
// text to the schema caps before validation; genuinely malformed proposals
// (wrong verdict, missing fields) still fail parse as they should.
function clampFreeText(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = { ...(raw as Record<string, unknown>) };
  const clampStr = (v: unknown, max: number) => (typeof v === "string" && v.length > max ? v.slice(0, max) : v);
  const clampList = (v: unknown, itemMax: number) =>
    Array.isArray(v) ? v.slice(0, 50).map((item) => clampStr(item, itemMax)) : v;
  r.reasoning = clampStr(r.reasoning, REASONING_MAX);
  r.reason = clampStr(r.reason, 1024);
  r.issueRefs = clampList(r.issueRefs, 128);
  r.inputsConsidered = clampList(r.inputsConsidered, 512);
  return r;
}

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
    "Judge ONLY from the step output, oracle summary, and instructions provided in THIS message.",
    "Do NOT use any tools — do not read files, run commands, or search the workspace; you already",
    "have everything you need. Reason from the provided data and emit the verdict directly.",
    oracleLine,
    "Return one of three verdicts: 'refuted' (you found a concrete failure), 'upheld'",
    "(no concrete reason to refute), or 'uncertain' (plausible but you genuinely cannot",
    "tell — do NOT guess 'refuted'). On 'refuted', issueRefs is a short enumerated list of",
    "the specific, addressable failures ('fix only these'); on 'upheld'/'uncertain' it is [].",
    "List in inputsConsidered exactly which evidence you used.",
    "Work through the evidence in `reasoning` FIRST, THEN commit to the verdict — do not restate the verdict as the reasoning.",
    "Emit exactly one RefuteCompletionProposal JSON object in one fenced block, nothing after:",
    "```orca:action",
    '{ "reasoning": "...", "verdict": "...", "reason": "...", "issueRefs": [...], "inputsConsidered": [...] }',
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
    const parsed = RefuteCompletionProposal.safeParse(clampFreeText(raw));
    if (parsed.success) return parsed.data;
    lastFailure = `invalid RefuteCompletionProposal: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 200)}`;
  }
  // Caller escalates to a human on null; surface WHY for observability (p.33).
  console.warn(`[refute] step-completion refute failed for session ${input.refuteSessionKey}: ${lastFailure}`);
  return null;
}
