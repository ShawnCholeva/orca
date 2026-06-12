import { mkdirSync, writeFileSync, copyFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  defaultTmuxRunner, newSession, capturePane, sendEnter, paste, pipePaneToFile, killSession, hasSession,
  type TmuxRunner,
} from "../../tmux/runner.js";

const TRUST_DEFAULT = /trust this folder|Is this a project you created or one you trust|do you trust/i;
const READY_DEFAULT = /(auto mode on|\? for shortcuts|\n\s*❯)/i;
// Busy = the live, interruptible spinner. Match only signals that are exclusive
// to an in-progress turn. Note: the past-tense summaries Claude Code prints AFTER
// a turn ("Cooked for 12s", "Churned for 36s") are shown while IDLE at the prompt,
// so they must NOT count as busy (every genuinely-busy frame carries "esc to interrupt").
const BUSY_DEFAULT = /esc to interrupt|\bthinking\b|running .* hook/i;
// claude renders the input box (❯) ABOVE its status/footer lines, so the prompt
// is not at end-of-pane. Match an EMPTY prompt line (❯ followed by only spaces)
// anywhere; combined with !busy this means the agent is idle and ready for input.
// NOTE: claude pads the empty input line with a non-breaking space (U+00A0), not
// a normal space — the char class MUST include   or idle is never detected.
const PROMPT_IDLE = /❯[ \t ]*(?:\n|$)/;
// Codex renders its composer prompt with a single right-angle quote (› U+203A,
// distinct from claude's ❯) followed by placeholder/typed text, e.g. "› Summarize
// recent commits". It's present whenever the composer accepts input, so combined
// with !busy it signals idle. (› never appears in claude's TUI, so this is additive.)
const CODEX_PROMPT_IDLE = /(?:\n|^)[ \t]*›[ \t]/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type DeliverResult = "delivered" | "no_session" | "timeout";

export interface WorkerSpawnInput {
  sessionId: string;
  goalId: string;
  adapterId: string;
  workspacePath: string;
  command: string;            // resolved claude binary (from adapter.resolveSpawn)
  env: Record<string, string>; // adapter env (already secret-sanitized; carries HOME for auth)
}

export interface WorkerSessionDeps {
  privateRoot: string;        // daemon-private dir, e.g. <dataDir>/workers
  daemonPort: number;
  authToken: string;
  claudeBin: string;
  resolveProvider: (adapterId: string) => {
    workerHookConfig: (args: { goalId: string; sessionId: string; port: number; authToken: string; configDir: string }) =>
      {
        files: { relPath: string; contents: string }[];
        copyFiles?: { relPath: string; sourcePath: string }[];
        spawnArgs: string[];
        env?: Record<string, string>;
      };
  };
  tmux?: TmuxRunner;
  captureSink: (sessionId: string, chunk: Buffer) => void; // appends pane bytes to the output store
  markRunning?: (sessionId: string) => void; // optional: flip DB session status to running
  trustPattern?: RegExp;
  readyPattern?: RegExp;
  pollMs?: number;
  startupTimeoutMs?: number;
  readyQuietMs?: number;
  postPasteMs?: number;
  idleQuietMs?: number;
  idleTimeoutMs?: number;
}

interface WorkerSession { name: string; ready: Promise<void>; }
interface WorkerTail {
  fd: number;
  closed: boolean;
  stopWatching: () => void;
}

export class WorkerSessionManager {
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly tails = new Map<string, WorkerTail>();
  private readonly tmux: TmuxRunner;
  constructor(private readonly deps: WorkerSessionDeps) {
    this.tmux = deps.tmux ?? defaultTmuxRunner();
  }

  setDaemonPort(port: number): void { this.deps.daemonPort = port; }
  private name(sessionId: string): string { return `orca-worker-${sessionId}`; }

  async spawn(input: WorkerSpawnInput): Promise<void> {
    if (this.sessions.has(input.sessionId)) return;
    const cfgDir = join(this.deps.privateRoot, input.sessionId);
    mkdirSync(cfgDir, { recursive: true });
    const provider = this.deps.resolveProvider(input.adapterId);
    const hookCfg = provider.workerHookConfig({
      goalId: input.goalId,
      sessionId: input.sessionId,
      port: this.deps.daemonPort,
      authToken: this.deps.authToken,
      configDir: cfgDir,
    });
    for (const file of hookCfg.files) {
      const target = join(cfgDir, file.relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.contents, "utf8");
    }
    // Copy in any existing provider files (e.g. Codex credentials). Missing sources
    // are skipped — a worker without credentials degrades to its own auth prompt.
    for (const cp of hookCfg.copyFiles ?? []) {
      if (!existsSync(cp.sourcePath)) continue;
      const target = join(cfgDir, cp.relPath);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(cp.sourcePath, target);
    }
    const name = this.name(input.sessionId);
    // tmux runs this command string via `sh -c`, so quote any token containing
    // whitespace (e.g. a settings path under a data dir with spaces). JSON.stringify
    // matches the quoting the pre-seam code used.
    const command = [input.command, ...hookCfg.spawnArgs]
      .map((token) => (/\s/.test(token) ? JSON.stringify(token) : token))
      .join(" ");
    const env = { ...input.env, ...(hookCfg.env ?? {}) };
    await newSession(this.tmux, name, input.workspacePath, command, env);
    // Output capture: pipe pane to a private file; daemon tails it (Task 3.2).
    await pipePaneToFile(this.tmux, name, join(cfgDir, "pane.out"));
    this.startTail(input.sessionId, join(cfgDir, "pane.out"));
    this.sessions.set(input.sessionId, { name, ready: this.startup(name) });
    this.deps.markRunning?.(input.sessionId);
  }

  private async startup(name: string): Promise<void> {
    const trustRe = this.deps.trustPattern ?? TRUST_DEFAULT;
    const readyRe = this.deps.readyPattern ?? READY_DEFAULT;
    const poll = this.deps.pollMs ?? 300;
    const deadline = Date.now() + (this.deps.startupTimeoutMs ?? 20_000);
    let trustAnswered = false;
    while (Date.now() < deadline) {
      const pane = await capturePane(this.tmux, name);
      if (!trustAnswered && trustRe.test(pane)) {
        await sendEnter(this.tmux, name);
        trustAnswered = true;
        await sleep(this.deps.readyQuietMs ?? 1500);
        return;
      }
      if (!trustRe.test(pane) && (readyRe.test(pane) || CODEX_PROMPT_IDLE.test(pane))) { await sleep(this.deps.readyQuietMs ?? 1500); return; }
      await sleep(poll);
    }
  }

  // startTail: Task 3.2 — tails the pane.out file into captureSink.
  private startTail(sessionId: string, file: string): void {
    this.stopTail(sessionId);
    // Ensure the file exists before watching (pipe-pane may not have created it yet).
    const fd = openSync(file, "a+");
    let pos = 0;
    let tail: WorkerTail;
    const pump = () => {
      if (tail.closed) return;
      try {
        const buf = Buffer.alloc(64 * 1024);
        let n: number;
        do {
          n = readSync(fd, buf, 0, buf.length, pos);
          if (n > 0) {
            pos += n;
            this.deps.captureSink(sessionId, Buffer.from(buf.subarray(0, n)));
          }
        } while (n > 0);
      } catch (err) {
        console.error(`[worker-session] tail capture failed session=${sessionId}`, err);
        this.stopTail(sessionId, tail);
      }
    };
    // Poll the pane file ourselves rather than via fs.watchFile: watchFile takes its
    // baseline stat asynchronously, so bytes appended between setup and that first
    // stat get folded into the baseline and are never reported (flaky under load).
    // A self-driven interval reading pos→EOF is deterministic; pump() is idempotent.
    const timer = setInterval(pump, this.deps.pollMs ?? 300);
    timer.unref?.();
    tail = {
      fd,
      closed: false,
      stopWatching: () => clearInterval(timer),
    };
    this.tails.set(sessionId, tail);
    pump(); // initial pump: catch bytes already present before the first interval tick
  }

  private stopTail(sessionId: string, expected?: WorkerTail): void {
    const tail = this.tails.get(sessionId);
    if (!tail || (expected && tail !== expected)) return;
    this.tails.delete(sessionId);
    if (tail.closed) return;
    tail.closed = true;
    tail.stopWatching();
    closeSync(tail.fd);
  }

  async deliver(sessionId: string, text: string): Promise<DeliverResult> {
    const s = this.sessions.get(sessionId);
    if (!s) return "no_session";
    await s.ready;
    const poll = this.deps.pollMs ?? 300;
    const idleQuiet = this.deps.idleQuietMs ?? 600;
    const deadline = Date.now() + (this.deps.idleTimeoutMs ?? 120_000);

    // Wait until the pane shows an idle prompt (not busy) for idleQuiet ms.
    let idleSince: number | null = null;
    let ready = false;
    while (Date.now() < deadline) {
      const pane = await capturePane(this.tmux, s.name);
      const busy = BUSY_DEFAULT.test(pane);
      const idle = !busy && (PROMPT_IDLE.test(pane) || CODEX_PROMPT_IDLE.test(pane));
      if (idle) {
        if (idleSince === null) idleSince = Date.now();
        if (Date.now() - idleSince >= idleQuiet) { ready = true; break; }
      } else {
        idleSince = null;
      }
      await sleep(poll);
    }
    if (!ready) return "timeout";

    const buf = `orca-worker-${sessionId}`;
    await paste(this.tmux, s.name, buf, text);
    await sleep(this.deps.postPasteMs ?? 250);
    await sendEnter(this.tmux, s.name);

    // Confirm submission: the input box should no longer hold the pasted placeholder.
    await sleep(poll);
    const after = await capturePane(this.tmux, s.name);
    if (/\[Pasted text/i.test(after)) { await sendEnter(this.tmux, s.name); } // retry once
    return "delivered";
  }

  /**
   * True iff the worker's tmux session actually exists. Used by boot-resume to
   * decide reattach vs respawn — a DB row marked 'running' is NOT proof of
   * liveness (the tmux session can die independently of the daemon).
   */
  async isTmuxAlive(sessionId: string): Promise<boolean> {
    if (this.sessions.has(sessionId)) return true;
    return hasSession(this.tmux, this.name(sessionId));
  }

  async reattach(sessionId: string, _workspacePath: string): Promise<boolean> {
    if (this.sessions.has(sessionId)) return true;
    const name = this.name(sessionId);
    if (!(await hasSession(this.tmux, name))) return false;
    const cfgDir = join(this.deps.privateRoot, sessionId);
    // Ensure the private dir exists (it may not if the daemon data dir was wiped).
    mkdirSync(cfgDir, { recursive: true });
    // Re-establish the output pipe + tail; the tmux session + claude survived the restart.
    await pipePaneToFile(this.tmux, name, join(cfgDir, "pane.out"));
    this.startTail(sessionId, join(cfgDir, "pane.out"));
    this.sessions.set(sessionId, { name, ready: Promise.resolve() });
    this.deps.markRunning?.(sessionId);
    return true;
  }

  async terminate(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    this.stopTail(sessionId);
    await killSession(this.tmux, s.name);
  }
}
