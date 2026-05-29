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
  resolveSpawn: (goalId: string) => ShadowSpawnCommand | Promise<ShadowSpawnCommand>;
  cols?: number;
  rows?: number;
}

interface Pending {
  resolve: (r: { text: string }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  handle: PtyHandle;
  output: string;
  disposeData: () => void;
  systemSent: boolean;
  queue: Promise<unknown>;
  pending: Pending | null;
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

    const cmd = await this.deps.resolveSpawn(goalId);
    const { handle, events } = this.deps.ptyManager.start({
      command: cmd.command,
      args: cmd.args,
      cwd: cmd.cwd,
      env: cmd.env,
      cols: this.deps.cols ?? 120,
      rows: this.deps.rows ?? 40,
    });
    const session: Session = { handle, output: "", disposeData: () => {}, systemSent: false, queue: Promise.resolve(), pending: null };
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
    const next = session.queue.then(() => this.askOnce(goalId, input));
    session.queue = next.catch(() => undefined);
    return next;
  }

  private askOnce(goalId: string, input: AskInput): Promise<{ text: string }> {
    const session = this.getSession(goalId);
    if (!session) return Promise.reject(new Error(`no shadow session for goal ${goalId}`));
    const prelude = session.systemSent ? "" : input.systemPrompt + "\n\n";
    session.systemSent = true;
    session.handle.write(Buffer.from(prelude + input.userPrompt + "\r", "utf8"));
    return new Promise<{ text: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending = null;
        reject(new Error(`shadow orchestrator timeout for goal ${goalId}`));
      }, input.timeoutMs);
      session.pending = { resolve, reject, timer };
    });
  }

  /** Called by the hook endpoint when the goal's shadow session emits Stop/StopFailure. */
  resolvePending(goalId: string, result: { text?: string; failure?: boolean }): void {
    const session = this.getSession(goalId);
    const pending = session?.pending ?? null;
    if (!session || !pending) return; // stray/duplicate hook -> drop
    clearTimeout(pending.timer);
    session.pending = null;
    if (result.failure) { pending.reject(new Error("shadow orchestrator StopFailure")); return; }
    const block = extractActionBlock(result.text ?? "");
    if (block === null) { pending.reject(new Error("shadow orchestrator: no orca:action block (unparseable)")); return; }
    pending.resolve({ text: block });
  }

  /** Internal access for the ask() loop. */
  protected getSession(goalId: string): Session | undefined {
    return this.sessions.get(goalId);
  }
}

export function shadowSessionId(goalId: string): string {
  return `orchsess-${goalId}`;
}
