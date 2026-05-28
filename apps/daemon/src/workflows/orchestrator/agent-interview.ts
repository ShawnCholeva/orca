export function formatAnswerForAgentStdin(answer: string): string {
  const stripped = answer.replace(/[\x00-\x1f\x7f]/g, "");
  return `${stripped.trim()}\n`;
}

export interface AgentInterviewDeps {
  getHandle(sessionId: string): { write(data: Buffer): void } | undefined;
}

export function injectAnswerToSession(
  deps: AgentInterviewDeps,
  sessionId: string,
  answer: string
): "injected" | "no_session" {
  const handle = deps.getHandle(sessionId);
  if (!handle) return "no_session";
  handle.write(Buffer.from(formatAnswerForAgentStdin(answer), "utf8"));
  return "injected";
}

const ASK_SENTINEL_RE = /\[orca:ask\]\s+question="([^"]{1,512})"/;

export function detectPendingAgentQuestion(tail: string): string | null {
  const m = tail.match(ASK_SENTINEL_RE);
  return m ? m[1] : null;
}
