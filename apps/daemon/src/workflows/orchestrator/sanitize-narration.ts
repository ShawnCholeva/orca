// Deterministic backstop for the user-facing orchestrator narration. The voice
// rule in the orchestrator prompt forbids internal identifiers, but a prompt is
// a tendency, not a guarantee. This strips the canonical internal-actor label
// the system used to inject — "Step N agent" / "Step N (role) agent" — so it can
// never reach the user even if the model emits it anyway, rewriting it to a
// neutral subject ("this step").
//
// Boundary: sub-agent names embedded in a raw agent transcript (e.g.
// "explore-agent") are not a fixed, system-injected pattern, so they are
// governed by the voice rule and context source-starving, not by this backstop.
const STEP_AGENT = /\b(the\s+)?step\s+\d+\s*(\([^)]*\))?\s+agents?\b/gi;

export function sanitizeNarration(body: string): string {
  return body.replace(STEP_AGENT, (_match, _article, _paren, offset: number, full: string) => {
    const atSentenceStart = offset === 0 || /[.!?]\s+$/.test(full.slice(0, offset));
    return atSentenceStart ? "This step" : "this step";
  });
}
