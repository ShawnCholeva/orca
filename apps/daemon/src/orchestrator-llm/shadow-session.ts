import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PtyHandle, PtyManager } from "../pty/types.js";
import { extractActionBlock } from "./sentinel.js";
import { buildShadowHookSettings } from "./shadow-hook-settings.js";

export interface ShadowSessionDeps {
  ptyManager: PtyManager;
  shadowRoot: string;                 // e.g. ~/.orca/shadow
  daemonPort: number;                 // bound port; mutable via setDaemonPort
  isReady: () => Promise<boolean>;    // ()=>true in tests; ClaudeCodeAdapter.checkAuth in prod
  resolveSpawnCommand: (cwd: string) => { command: string; args: string[]; env: Record<string, string>; cwd: string };
  cols?: number;
  rows?: number;
  readyQuietMs?: number;             // resolve "ready" after this much output quiescence (default 1200)
  readyMaxMs?: number;               // hard cap: resolve "ready" regardless after this (default 8000)
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
  ready: Promise<void>;
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
    if (this.sessions.has(goalId)) return shadowSessionId(goalId);

    if (!(await this.deps.isReady())) {
      throw new Error("orchestrator shadow not ready: sign in to Claude Code");
    }

    const dir = join(this.deps.shadowRoot, goalId);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.local.json"),
      JSON.stringify(buildShadowHookSettings({ goalId, port: this.deps.daemonPort }), null, 2),
      "utf8",
    );

    const cmd = this.deps.resolveSpawnCommand(dir);
    const { handle, events } = this.deps.ptyManager.start({
      command: cmd.command,
      args: cmd.args,
      cwd: cmd.cwd,
      env: cmd.env,
      cols: this.deps.cols ?? 120,
      rows: this.deps.rows ?? 40,
    });

    // Readiness gate: resolve after quiescence OR a hard cap, whichever comes first.
    let readyDone = false;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => { resolveReady = r; });
    const settleReady = () => {
      if (readyDone) return;
      readyDone = true;
      if (readyTimer) clearTimeout(readyTimer);
      resolveReady();
    };
    const readyHardCap = setTimeout(settleReady, this.deps.readyMaxMs ?? 8000);

    const session: Session = { handle, output: "", disposeData: () => {}, systemSent: false, queue: Promise.resolve(), pending: null, ready };
    let trustAnswered = false;
    session.disposeData = events.onData((chunk) => {
      session.output += chunk.toString("utf8");
      if (session.output.length > 200_000) session.output = session.output.slice(-100_000);
      // Best-effort: answer the one-time folder-trust prompt so the session becomes usable.
      if (!trustAnswered && /trust|do you want to proceed|press enter/i.test(session.output.slice(-2000))) {
        trustAnswered = true;
        try { handle.write(Buffer.from("\r", "utf8")); } catch { /* ignore */ }
      }
      // Quiescence debounce: resolve ready after output goes quiet.
      if (!readyDone) {
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = setTimeout(settleReady, this.deps.readyQuietMs ?? 1200);
      }
    });
    events.onExit(() => {
      clearTimeout(readyHardCap);
      settleReady(); // harmless if already done; ensures ready resolves so askOnce can re-check
      const s = this.sessions.get(goalId);
      if (s) {
        if (s.pending) {
          clearTimeout(s.pending.timer);
          const p = s.pending;
          s.pending = null;
          p.reject(new Error(`shadow session for goal ${goalId} exited`));
        }
        s.disposeData();
      }
      this.sessions.delete(goalId);
    });
    this.sessions.set(goalId, session);
    return shadowSessionId(goalId);
  }

  setDaemonPort(port: number): void {
    this.deps.daemonPort = port;
  }

  async terminate(goalId: string): Promise<void> {
    const session = this.sessions.get(goalId);
    if (!session) return;
    if (session.pending) {
      clearTimeout(session.pending.timer);
      const p = session.pending;
      session.pending = null;
      p.reject(new Error(`shadow session for goal ${goalId} terminated`));
    }
    session.disposeData();
    this.sessions.delete(goalId);
    session.handle.kill("SIGTERM");
  }

  async ask(goalId: string, input: AskInput): Promise<{ text: string }> {
    if (!this.sessions.has(goalId)) {
      await this.spawn(goalId);
    }
    const session = this.getSession(goalId);
    if (!session) throw new Error(`no shadow session for goal ${goalId}`);
    const next = session.queue.then(() => this.askOnce(goalId, input));
    session.queue = next.catch(() => undefined);
    return next;
  }

  private async askOnce(goalId: string, input: AskInput): Promise<{ text: string }> {
    const session = this.getSession(goalId);
    if (!session) throw new Error(`no shadow session for goal ${goalId}`);
    await session.ready;
    const live = this.getSession(goalId);
    if (!live) throw new Error(`shadow session for goal ${goalId} exited during startup`);
    const prelude = live.systemSent ? "" : input.systemPrompt + "\n\n";
    live.systemSent = true;
    live.handle.write(Buffer.from(prelude + input.userPrompt + "\r", "utf8"));
    return new Promise<{ text: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        live.pending = null;
        reject(new Error(`shadow orchestrator timeout for goal ${goalId}`));
      }, input.timeoutMs);
      live.pending = { resolve, reject, timer };
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
