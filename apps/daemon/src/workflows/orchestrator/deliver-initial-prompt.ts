// Delivers a workflow step's composed objective to an interactive agent
// session's stdin, per the orchestrator-mediated-workflows design
// (2026-05-28): the engine writes to the per-step session stdin and the agent
// runs as an interactive subscription session (not `-p`). Two hazards the spec
// flags implicitly and the tmux shadow path already handles:
//   1. Readiness — claude's TUI boots in ~1-2s and may show a first-run
//      folder-trust prompt; input written before the box is ready is dropped.
//   2. Multi-line submit — the composed prompt spans many lines; sent raw,
//      claude submits on the first newline. Bracketed paste makes the TUI treat
//      the whole blob as one pasted input, then a single Enter submits.

interface InitialPromptHandle {
  write(data: Buffer): void;
}

export interface DeliverInitialPromptDeps {
  /** Live pty handle for the session, or undefined once it has exited. */
  getHandle(sessionId: string): InitialPromptHandle | undefined;
  /** Recent rendered pty output, used to detect trust/ready state. */
  readTailText(sessionId: string): string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  readyTimeoutMs?: number;
  /** Settle delay after answering the trust prompt before submitting. */
  readyQuietMs?: number;
  trustPattern?: RegExp;
  readyPattern?: RegExp;
  /** Delay between the bracketed paste and the submit Enter. The TUI processes
   *  a paste asynchronously; an Enter in the same tick is dropped and the prompt
   *  sits unsubmitted in the input box. */
  postPasteMs?: number;
}

const TRUST_DEFAULT = /trust this folder|Is this a project you created or one you trust|do you trust/i;
const READY_DEFAULT = /(auto mode on|\? for shortcuts|\n\s*❯)/i;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export type DeliverInitialPromptResult = "delivered" | "no_session" | "timeout";

/** Max recent output bytes scanned for readiness — enough to see the input box. */
const TAIL_SCAN_BYTES = 16 * 1024;

/**
 * Decodes a session output snapshot's base64 chunks into the recent rendered
 * text used for readiness detection (trust prompt / input box).
 */
export function renderSessionTailText(snapshot: {
  chunks: Array<{ dataBase64: string }>;
}): string {
  const text = snapshot.chunks
    .map((c) => Buffer.from(c.dataBase64, "base64").toString("utf8"))
    .join("");
  return text.length > TAIL_SCAN_BYTES ? text.slice(-TAIL_SCAN_BYTES) : text;
}

export async function deliverInitialPrompt(
  deps: DeliverInitialPromptDeps,
  sessionId: string,
  prompt: string
): Promise<DeliverInitialPromptResult> {
  if (!deps.getHandle(sessionId)) return "no_session";

  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const poll = deps.pollMs ?? 300;
  const readyQuiet = deps.readyQuietMs ?? 3000;
  const trustRe = deps.trustPattern ?? TRUST_DEFAULT;
  const readyRe = deps.readyPattern ?? READY_DEFAULT;
  const deadline = now() + (deps.readyTimeoutMs ?? 20_000);

  let ready = false;
  let trustAnswered = false;
  while (now() < deadline) {
    const pane = deps.readTailText(sessionId);
    if (!trustAnswered && trustRe.test(pane)) {
      // Default highlight on the trust prompt is "Yes, I trust"; Enter accepts.
      deps.getHandle(sessionId)?.write(Buffer.from("\r", "utf8"));
      trustAnswered = true;
      ready = true;
      break;
    }
    if (!trustRe.test(pane) && readyRe.test(pane)) {
      ready = true;
      break;
    }
    await sleep(poll);
  }
  if (!ready) return "timeout";

  // Settle: the input box appears before claude finishes booting (MCP servers,
  // session-start hooks). Keystrokes sent during init are silently dropped, so
  // the paste lands but the submit Enter is lost. node-pty gives only a
  // cumulative byte stream (no tmux-style screen capture), so we can't confirm
  // the box is quiescent — wait a fixed settle instead.
  await sleep(readyQuiet);

  // Re-fetch: the session may have exited while we waited for readiness.
  const handle = deps.getHandle(sessionId);
  if (!handle) return "no_session";
  handle.write(Buffer.from(PASTE_START + prompt + PASTE_END, "utf8"));
  await sleep(deps.postPasteMs ?? 250);
  deps.getHandle(sessionId)?.write(Buffer.from("\r", "utf8"));
  return "delivered";
}
