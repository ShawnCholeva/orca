import type { PtyHandle, PtyManager } from "../pty/types.js";
import { extractActionBlock } from "./sentinel.js";

export interface ShadowSpawnCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface ShadowSessionDeps {
  ptyManager: PtyManager;
  /** Resolves the spawn command for the goal's orchestrator adapter (claude-code). */
  resolveSpawn: (goalId: string) => ShadowSpawnCommand;
  cols?: number;
  rows?: number;
  pollIntervalMs?: number;
}

interface Session {
  handle: PtyHandle;
  output: string;
  disposeData: () => void;
  systemSent: boolean;
  queue: Promise<unknown>;
  consumedUpTo: number;
}

export interface AskInput {
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
}

export class ShadowSessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: ShadowSessionDeps) {}

  has(goalId: string): boolean {
    return this.sessions.has(goalId);
  }

  /** Spawns the goal's shadow PTY (idempotent). Returns a stable session id. */
  async spawn(goalId: string): Promise<string> {
    const existing = this.sessions.get(goalId);
    if (existing) return shadowSessionId(goalId);

    const cmd = this.deps.resolveSpawn(goalId);
    const { handle, events } = this.deps.ptyManager.start({
      command: cmd.command,
      args: cmd.args,
      cwd: cmd.cwd,
      env: cmd.env,
      cols: this.deps.cols ?? 120,
      rows: this.deps.rows ?? 40,
    });
    const session: Session = { handle, output: "", disposeData: () => {}, systemSent: false, queue: Promise.resolve(), consumedUpTo: 0 };
    session.disposeData = events.onData((chunk) => {
      session.output += chunk.toString("utf8");
    });
    events.onExit(() => {
      this.sessions.delete(goalId);
    });
    this.sessions.set(goalId, session);
    return shadowSessionId(goalId);
  }

  async terminate(goalId: string): Promise<void> {
    const session = this.sessions.get(goalId);
    if (!session) return;
    session.disposeData();
    session.handle.kill("SIGTERM");
    this.sessions.delete(goalId);
  }

  async ask(goalId: string, input: AskInput): Promise<{ text: string }> {
    const session = this.getSession(goalId);
    if (!session) throw new Error(`no shadow session for goal ${goalId}`);
    // Serialize: each ask waits for the previous one to settle.
    const run = session.queue.then(() => this.askOnce(goalId, session, input));
    session.queue = run.catch(() => undefined);
    return run;
  }

  private async askOnce(
    goalId: string,
    session: Session,
    input: AskInput
  ): Promise<{ text: string }> {
    const prelude = session.systemSent ? "" : input.systemPrompt + "\n\n";
    session.systemSent = true;
    session.handle.write(Buffer.from(prelude + input.userPrompt + "\n", "utf8"));

    const interval = this.deps.pollIntervalMs ?? 50;
    const deadline = Date.now() + input.timeoutMs;
    const FENCE_CLOSE = "```";
    for (;;) {
      const fresh = session.output.slice(session.consumedUpTo);
      const block = extractActionBlock(fresh);
      if (block !== null) {
        // Advance the high-water mark past this block so a later ask never re-reads it.
        const closeIdx = fresh.lastIndexOf(FENCE_CLOSE);
        session.consumedUpTo += closeIdx >= 0 ? closeIdx + FENCE_CLOSE.length : fresh.length;
        return { text: block };
      }
      if (Date.now() >= deadline) {
        throw new Error(`shadow orchestrator timeout for goal ${goalId}`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /** Internal access for the ask() loop. */
  protected getSession(goalId: string): Session | undefined {
    return this.sessions.get(goalId);
  }
}

export function shadowSessionId(goalId: string): string {
  return `orchsess-${goalId}`;
}
