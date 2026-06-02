import { mkdirSync, writeFileSync, watch, openSync, readSync, closeSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  defaultTmuxRunner, newSession, capturePane, sendEnter, paste, pipePaneToFile, killSession, hasSession,
  type TmuxRunner,
} from "../../tmux/runner.js";
import { buildAgentHookSettings } from "../../agent-hooks/hook-settings.js";

const TRUST_DEFAULT = /trust this folder|Is this a project you created or one you trust|do you trust/i;
const READY_DEFAULT = /(auto mode on|\? for shortcuts|\n\s*❯)/i;
const BUSY_DEFAULT = /esc to interrupt|\bthinking\b|running .* hook|cooked for|churned for/i;
// claude renders the input box (❯) ABOVE its status/footer lines, so the prompt
// is not at end-of-pane. Match an EMPTY prompt line (❯ followed by only spaces)
// anywhere; combined with !busy this means the agent is idle and ready for input.
// NOTE: claude pads the empty input line with a non-breaking space (U+00A0), not
// a normal space — the char class MUST include   or idle is never detected.
const PROMPT_IDLE = /❯[ \t ]*(?:\n|$)/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type DeliverResult = "delivered" | "no_session" | "timeout";

export interface WorkerSpawnInput {
  sessionId: string;
  workspacePath: string;
  command: string;            // resolved claude binary (from adapter.resolveSpawn)
  env: Record<string, string>; // adapter env (already secret-sanitized; carries HOME for auth)
}

export interface WorkerSessionDeps {
  privateRoot: string;        // daemon-private dir, e.g. <dataDir>/workers
  daemonPort: number;
  authToken: string;
  claudeBin: string;
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

export class WorkerSessionManager {
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly tails = new Map<string, { watcher: FSWatcher; fd: number; pos: number }>();
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
    const settingsPath = join(cfgDir, "settings.json");
    // Hooks via private --settings file (repo-safe; workspace stays the cwd).
    writeFileSync(
      settingsPath,
      JSON.stringify(buildAgentHookSettings({ sessionId: input.sessionId, port: this.deps.daemonPort, authToken: this.deps.authToken }), null, 2),
      "utf8",
    );
    const name = this.name(input.sessionId);
    // Auth: inherit input.env (carries HOME → real ~/.claude). Do NOT set CLAUDE_CONFIG_DIR.
    const command = `${input.command} --settings ${JSON.stringify(settingsPath)}`;
    await newSession(this.tmux, name, input.workspacePath, command, input.env);
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
      if (!trustRe.test(pane) && readyRe.test(pane)) { await sleep(this.deps.readyQuietMs ?? 1500); return; }
      await sleep(poll);
    }
  }

  // startTail: Task 3.2 — tails the pane.out file into captureSink.
  private startTail(sessionId: string, file: string): void {
    // Ensure the file exists before watching (pipe-pane may not have created it yet).
    const fd = openSync(file, "a+");
    let pos = 0;
    const pump = () => {
      const buf = Buffer.alloc(64 * 1024);
      let n: number;
      do {
        n = readSync(fd, buf, 0, buf.length, pos);
        if (n > 0) { pos += n; this.deps.captureSink(sessionId, Buffer.from(buf.subarray(0, n))); }
      } while (n > 0);
    };
    const watcher = watch(file, { persistent: false }, () => pump());
    pump(); // initial pump: catch bytes written before the watcher was established
    this.tails.set(sessionId, { watcher, fd, pos });
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
      const idle = !busy && PROMPT_IDLE.test(pane);
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
    const t = this.tails.get(sessionId);
    if (t) { t.watcher.close(); closeSync(t.fd); this.tails.delete(sessionId); }
    await killSession(this.tmux, s.name);
  }
}
