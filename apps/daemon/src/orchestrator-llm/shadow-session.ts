import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { extractActionBlock } from "./sentinel.js";
import { buildShadowHookSettings } from "./shadow-hook-settings.js";

// TEMP diagnostics (kept during bring-up; strip later).
function dbg(goalId: string, msg: string): void {
  if (process.env["ORCA_SHADOW_DEBUG"] === "0") return;
  try {
    appendFileSync(join(homedir(), ".orca", "shadow-debug.log"),
      `${new Date().toISOString()} ${goalId.slice(0, 8)} ${msg}\n`, "utf8");
  } catch { /* ignore */ }
}

/** Minimal tmux command runner; injectable for tests. */
export interface TmuxRunner {
  run(args: string[], input?: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

function defaultTmuxRunner(): TmuxRunner {
  return {
    run: (args, input) =>
      new Promise((resolve) => {
        const cp = execFile("tmux", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code) : (err ? 1 : 0);
          resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code });
        });
        if (input !== undefined) { try { cp.stdin?.end(input); } catch { /* ignore */ } }
      }),
  };
}

export interface ShadowSessionDeps {
  shadowRoot: string;                 // e.g. ~/.orca/shadow
  daemonPort: number;                 // bound port; mutable via setDaemonPort
  authToken: string;                  // daemon Bearer token; injected into hook headers so the Stop hook clears auth
  isReady: () => Promise<boolean>;    // ClaudeCodeAdapter.checkAuth in prod; ()=>true in tests
  claudeBin?: string;                 // default ORCA_CLAUDE_CODE_BIN ?? "claude"
  tmux?: TmuxRunner;                  // injectable for tests; default shells out to tmux
  trustPattern?: RegExp;              // matches the folder-trust prompt
  pollMs?: number;                    // capture-pane poll interval (default 300)
  startupTimeoutMs?: number;          // max wait for trust+ready (default 20000)
  readyQuietMs?: number;              // settle delay after trust before "ready" (default 1500)
}

interface Pending {
  resolve: (r: { text: string }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  name: string;            // tmux session name
  ready: Promise<void>;
  queue: Promise<unknown>;
  pending: Pending | null;
  systemSent: boolean;
}

const TRUST_DEFAULT = /trust this folder|Is this a project you created or one you trust|do you trust/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ShadowSessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly tmux: TmuxRunner;

  constructor(private readonly deps: ShadowSessionDeps) {
    this.tmux = deps.tmux ?? defaultTmuxRunner();
  }

  has(goalId: string): boolean { return this.sessions.has(goalId); }
  setDaemonPort(port: number): void { this.deps.daemonPort = port; }

  private tmuxName(goalId: string): string { return `orca-shadow-${goalId}`; }

  /** Spawns the goal's shadow tmux+claude session (idempotent). */
  async spawn(goalId: string): Promise<string> {
    if (this.sessions.has(goalId)) return shadowSessionId(goalId);
    if (!(await this.deps.isReady())) {
      throw new Error("orchestrator shadow not ready: sign in to Claude Code");
    }
    const dir = join(this.deps.shadowRoot, goalId);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.local.json"),
      JSON.stringify(buildShadowHookSettings({ goalId, port: this.deps.daemonPort, authToken: this.deps.authToken }), null, 2),
      "utf8",
    );
    const name = this.tmuxName(goalId);
    const bin = this.deps.claudeBin ?? process.env["ORCA_CLAUDE_CODE_BIN"] ?? "claude";
    await this.tmux.run(["kill-session", "-t", name]); // idempotent; ignore failure
    const started = await this.tmux.run(["new-session", "-d", "-s", name, "-x", "220", "-y", "50", "-c", dir, bin]);
    dbg(goalId, `tmux new-session code=${started.code} name=${name} bin=${bin} dir=${dir} port=${this.deps.daemonPort}`);
    const session: Session = { name, ready: this.startup(goalId, name), queue: Promise.resolve(), pending: null, systemSent: false };
    this.sessions.set(goalId, session);
    return shadowSessionId(goalId);
  }

  /** Polls capture-pane: answer the trust prompt, then settle into the input box. */
  private async startup(goalId: string, name: string): Promise<void> {
    const pattern = this.deps.trustPattern ?? TRUST_DEFAULT;
    const poll = this.deps.pollMs ?? 300;
    const deadline = Date.now() + (this.deps.startupTimeoutMs ?? 20_000);
    let trustAnswered = false;
    while (Date.now() < deadline) {
      const pane = (await this.tmux.run(["capture-pane", "-t", name, "-p"])).stdout;
      if (!trustAnswered && pattern.test(pane)) {
        await this.tmux.run(["send-keys", "-t", name, "Enter"]); // default highlight = "1. Yes, I trust"
        trustAnswered = true;
        dbg(goalId, "trust answered (Enter)");
        await sleep(this.deps.readyQuietMs ?? 1500);
        return;
      }
      // No trust prompt + an input box / status line present => ready.
      if (!pattern.test(pane) && /(auto mode on|\? for shortcuts|\n\s*❯)/i.test(pane)) {
        dbg(goalId, "ready (no trust, input box present)");
        return;
      }
      await sleep(poll);
    }
    dbg(goalId, "startup timeout (proceeding anyway)");
  }

  async ask(goalId: string, input: AskInput): Promise<{ text: string }> {
    if (!this.sessions.has(goalId)) await this.spawn(goalId);
    const session = this.getSession(goalId);
    if (!session) throw new Error(`no shadow session for goal ${goalId}`);
    const next = session.queue.then(() => this.askOnce(goalId, input));
    session.queue = next.catch(() => undefined);
    return next;
  }

  private async askOnce(goalId: string, input: AskInput): Promise<{ text: string }> {
    const pre = this.getSession(goalId);
    if (!pre) throw new Error(`no shadow session for goal ${goalId}`);
    await pre.ready;
    const session = this.getSession(goalId);
    if (!session) throw new Error(`shadow session for goal ${goalId} exited during startup`);
    const text = session.systemSent ? input.userPrompt : input.systemPrompt + "\n\n" + input.userPrompt;
    session.systemSent = true;
    const buf = `orca-${goalId}`;
    // Inject as a bracketed paste so multi-line content is treated as input (not submitted early),
    // then a single Enter submits.
    await this.tmux.run(["load-buffer", "-b", buf, "-"], text);
    await this.tmux.run(["paste-buffer", "-b", buf, "-t", session.name, "-d", "-p"]);
    await this.tmux.run(["send-keys", "-t", session.name, "Enter"]);
    dbg(goalId, `prompt injected (${text.length} chars) via paste-buffer; timeoutMs=${input.timeoutMs}`);
    return new Promise<{ text: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending = null;
        dbg(goalId, "TIMEOUT waiting for Stop hook");
        reject(new Error(`shadow orchestrator timeout for goal ${goalId}`));
      }, input.timeoutMs);
      session.pending = { resolve, reject, timer };
    });
  }

  /** Called by the hook endpoint when the goal's shadow session emits Stop/StopFailure. */
  resolvePending(goalId: string, result: { text?: string; failure?: boolean }): void {
    const session = this.getSession(goalId);
    const pending = session?.pending ?? null;
    dbg(goalId, `resolvePending hook: hasSession=${!!session} hasPending=${!!pending} failure=${!!result.failure} textLen=${(result.text ?? "").length}`);
    if (!session || !pending) return; // stray/duplicate hook -> drop
    clearTimeout(pending.timer);
    session.pending = null;
    if (result.failure) { pending.reject(new Error("shadow orchestrator StopFailure")); return; }
    const block = extractActionBlock(result.text ?? "");
    if (block === null) { pending.reject(new Error("shadow orchestrator: no orca:action block (unparseable)")); return; }
    pending.resolve({ text: block });
  }

  async terminate(goalId: string): Promise<void> {
    const session = this.sessions.get(goalId);
    if (!session) return;
    if (session.pending) {
      clearTimeout(session.pending.timer);
      const p = session.pending; session.pending = null;
      p.reject(new Error(`shadow session for goal ${goalId} terminated`));
    }
    this.sessions.delete(goalId);
    await this.tmux.run(["kill-session", "-t", session.name]);
  }

  protected getSession(goalId: string): Session | undefined { return this.sessions.get(goalId); }
}

export interface AskInput { systemPrompt: string; userPrompt: string; timeoutMs: number; }

export function shadowSessionId(goalId: string): string { return `orchsess-${goalId}`; }
