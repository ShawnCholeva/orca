import type { PtyHandle, PtyManager } from "../pty/types.js";

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
}

interface Session {
  handle: PtyHandle;
  output: string;
  disposeData: () => void;
  systemSent: boolean;
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
    const session: Session = { handle, output: "", disposeData: () => {}, systemSent: false };
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

  /** Internal access for the ask() loop (added in a later task). */
  protected getSession(goalId: string): Session | undefined {
    return this.sessions.get(goalId);
  }
}

export function shadowSessionId(goalId: string): string {
  return `orchsess-${goalId}`;
}
