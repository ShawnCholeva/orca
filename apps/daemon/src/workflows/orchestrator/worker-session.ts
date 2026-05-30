import { mkdirSync, writeFileSync, watch, openSync, readSync, closeSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  defaultTmuxRunner, newSession, capturePane, sendEnter, pipePaneToFile, killSession,
  type TmuxRunner,
} from "../../tmux/runner.js";
import { buildAgentHookSettings } from "../../agent-hooks/hook-settings.js";

const TRUST_DEFAULT = /trust this folder|Is this a project you created or one you trust|do you trust/i;
const READY_DEFAULT = /(auto mode on|\? for shortcuts|\n\s*❯)/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  async terminate(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    const t = this.tails.get(sessionId);
    if (t) { t.watcher.close(); closeSync(t.fd); this.tails.delete(sessionId); }
    await killSession(this.tmux, s.name);
  }
}
