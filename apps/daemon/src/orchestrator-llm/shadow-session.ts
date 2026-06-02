import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractActionBlock } from "./sentinel.js";
import { buildShadowHookSettings } from "./shadow-hook-settings.js";
import {
  type TmuxRunner,
  defaultTmuxRunner,
  newSession,
  capturePane,
  paste,
  sendEnter,
  killSession,
} from "../tmux/runner.js";

export type ShadowAdapterId = "claude-code" | "codex";

// TEMP diagnostics (kept during bring-up; strip later).
function dbg(goalId: string, msg: string): void {
  if (process.env["ORCA_SHADOW_DEBUG"] === "0") return;
  try {
    appendFileSync(join(homedir(), ".orca", "shadow-debug.log"),
      `${new Date().toISOString()} ${goalId.slice(0, 8)} ${msg}\n`, "utf8");
  } catch { /* ignore */ }
}

export interface ShadowSessionDeps {
  shadowRoot: string;                 // e.g. ~/.orca/shadow
  daemonPort: number;                 // bound port; mutable via setDaemonPort
  authToken: string;                  // daemon Bearer token; injected into hook headers so the Stop hook clears auth
  isReady: (adapterId?: ShadowAdapterId) => Promise<boolean>; // adapter.checkAuth in prod; ()=>true in tests
  claudeBin?: string;                 // default ORCA_CLAUDE_CODE_BIN ?? "claude"
  codexBin?: string;                  // default ORCA_CODEX_BIN ?? "codex"
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
  pollTimer?: ReturnType<typeof setInterval>;
}

interface Session {
  adapterId: ShadowAdapterId;
  name: string;            // tmux session name
  ready: Promise<void>;
  queue: Promise<unknown>;
  pending: Pending | null;
  systemSent: boolean;
}

const TRUST_DEFAULT = /trust this folder|Is this a project you created or one you trust|do you trust/i;
const HOOK_TRUST_PROMPT = /hook needs review|hooks need review|press t to trust|new hook - review required/i;
const CODEX_MODEL_SWITCH_PROMPT = /approaching rate limits[\s\S]*switch to .*for lower credit usage/i;
const CODEX_USAGE_LIMIT =
  /hit your usage limit|less than \d+% of your 5h limit|purchase more credits|try again at \d{1,2}:\d{2}\s*(?:AM|PM)?/i;
const CODEX_AUTH_LOST =
  /\bnot\s+(?:signed|logged)\s+in\b|\blogin required\b|\bauth(?:entication)?\s+(?:required|expired|failed)\b/i;
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

  /** Spawns the goal's shadow tmux+CLI session (idempotent per adapter). */
  async spawn(goalId: string, adapterId: ShadowAdapterId = "claude-code"): Promise<string> {
    const existing = this.sessions.get(goalId);
    if (existing?.adapterId === adapterId) return shadowSessionId(goalId);
    if (existing) await this.terminate(goalId);
    if (!(await this.deps.isReady(adapterId))) {
      throw new Error(`orchestrator shadow not ready: sign in to ${adapterDisplayName(adapterId)}`);
    }
    const dir = join(this.deps.shadowRoot, goalId);
    this.writeHookConfig(adapterId, goalId, dir);
    const name = this.tmuxName(goalId);
    const bin = this.binFor(adapterId);
    const started = await newSession(this.tmux, name, dir, bin);
    dbg(goalId, `tmux new-session code=${started.code} adapter=${adapterId} name=${name} bin=${bin} dir=${dir} port=${this.deps.daemonPort}`);
    const session: Session = { adapterId, name, ready: this.startup(goalId, name), queue: Promise.resolve(), pending: null, systemSent: false };
    this.sessions.set(goalId, session);
    return shadowSessionId(goalId);
  }

  /** Polls capture-pane: answer the trust prompt, then settle into the input box. */
  private async startup(goalId: string, name: string): Promise<void> {
    const pattern = this.deps.trustPattern ?? TRUST_DEFAULT;
    const poll = this.deps.pollMs ?? 300;
    const deadline = Date.now() + (this.deps.startupTimeoutMs ?? 20_000);
    let trustAnswered = false;
    let hookTrustAnswered = false;
    while (Date.now() < deadline) {
      const pane = await capturePane(this.tmux, name);
      if (!trustAnswered && pattern.test(pane)) {
        await sendEnter(this.tmux, name); // default highlight = "1. Yes, I trust"
        trustAnswered = true;
        await sleep(this.deps.readyQuietMs ?? 1500);
        continue;
      }
      if (!hookTrustAnswered && HOOK_TRUST_PROMPT.test(pane)) {
        await this.tmux.run(["send-keys", "-t", name, "t"]);
        await sleep(this.deps.readyQuietMs ?? 1500);
        await this.tmux.run(["send-keys", "-t", name, "Escape"]);
        await sleep(250);
        await this.tmux.run(["send-keys", "-t", name, "Escape"]);
        hookTrustAnswered = true;
        dbg(goalId, "hook trust answered (t, Escape, Escape)");
        await sleep(this.deps.readyQuietMs ?? 1500);
        continue;
      }
      // No trust prompt + an input box / status line present => ready.
      if (!pattern.test(pane) && /(auto mode on|\? for shortcuts|\n\s*❯|\n\s*›|\bcodex\b.*\bready\b|\n\s*>)/i.test(pane)) {
        dbg(goalId, "ready (no trust, input box present)");
        return;
      }
      await sleep(poll);
    }
  }

  async ask(goalId: string, input: AskInput): Promise<{ text: string }> {
    const adapterId = input.adapterId ?? "claude-code";
    if (this.sessions.get(goalId)?.adapterId !== adapterId) await this.spawn(goalId, adapterId);
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
    const turnId = randomUUID();
    const transportMarker = `ORCA_TURN_ID=${turnId}`;
    const baseText = session.systemSent ? input.userPrompt : input.systemPrompt + "\n\n" + input.userPrompt;
    const text = [
      baseText,
      "",
      `Internal transport marker: ${transportMarker}. Do not include this marker in your response.`,
    ].join("\n");
    session.systemSent = true;
    const buf = `orca-${goalId}`;
    if (session.adapterId === "codex") {
      await this.dismissCodexModelSwitchPrompt(goalId, session.name);
    }
    // Inject as a bracketed paste so multi-line content is treated as input (not submitted early),
    // then a single Enter submits.
    await paste(this.tmux, session.name, buf, text);
    await sendEnter(this.tmux, session.name);
    return new Promise<{ text: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.pending?.pollTimer) clearInterval(session.pending.pollTimer);
        session.pending = null;
        reject(new Error(`shadow orchestrator timeout for goal ${goalId}`));
      }, input.timeoutMs);
      const pending: Pending = { resolve, reject, timer };
      if (session.adapterId === "codex") {
        let polling = false;
        pending.pollTimer = setInterval(() => {
          if (polling) return;
          polling = true;
          void this.tmux.run(["capture-pane", "-t", session.name, "-p"])
            .then((pane) => {
              if (session.pending !== pending) return;
              const text = pane.stdout;
              const turnText = textAfterTurnMarker(text, transportMarker);
              if (turnText === null) return;
              const action = extractActionBlock(turnText);
              if (action !== null) {
                this.settlePending(goalId, pending, { text: action });
                return;
              }
              const codexAction = extractCodexPaneAction(turnText);
              if (codexAction !== null) {
                this.settlePending(goalId, pending, { text: codexAction });
                return;
              }
              if (CODEX_USAGE_LIMIT.test(turnText)) {
                this.settlePending(goalId, pending, {
                  error: new Error("codex usage limit reached; retry when Codex quota resets"),
                });
                return;
              }
              if (CODEX_AUTH_LOST.test(turnText)) {
                this.settlePending(goalId, pending, {
                  error: new Error("codex authentication required; run codex login"),
                });
              }
            })
            .finally(() => { polling = false; });
        }, 1000);
      }
      session.pending = pending;
    });
  }

  private async dismissCodexModelSwitchPrompt(goalId: string, name: string): Promise<void> {
    const pane = (await this.tmux.run(["capture-pane", "-t", name, "-p"])).stdout;
    if (!CODEX_MODEL_SWITCH_PROMPT.test(pane)) return;
    await this.tmux.run(["send-keys", "-t", name, "2"]);
    await this.tmux.run(["send-keys", "-t", name, "Enter"]);
    dbg(goalId, "codex model-switch prompt dismissed (keep current model)");
    await sleep(250);
  }

  /** Called by the hook endpoint when the goal's shadow session emits Stop/StopFailure. */
  resolvePending(goalId: string, result: { text?: string; failure?: boolean }): void {
    const session = this.getSession(goalId);
    const pending = session?.pending ?? null;
    if (!session || !pending) return; // stray/duplicate hook -> drop
    if (result.failure) {
      this.settlePending(goalId, pending, { error: new Error("shadow orchestrator StopFailure") });
      return;
    }
    const block = extractActionBlock(result.text ?? "");
    if (block === null) {
      this.settlePending(goalId, pending, {
        error: new Error("shadow orchestrator: no orca:action block (unparseable)"),
      });
      return;
    }
    this.settlePending(goalId, pending, { text: block });
  }

  async terminate(goalId: string): Promise<void> {
    const session = this.sessions.get(goalId);
    if (!session) return;
    if (session.pending) {
      clearTimeout(session.pending.timer);
      if (session.pending.pollTimer) clearInterval(session.pending.pollTimer);
      const p = session.pending; session.pending = null;
      p.reject(new Error(`shadow session for goal ${goalId} terminated`));
    }
    this.sessions.delete(goalId);
    await killSession(this.tmux, session.name);
  }

  protected getSession(goalId: string): Session | undefined { return this.sessions.get(goalId); }

  private settlePending(
    goalId: string,
    pending: Pending,
    result: { text: string } | { error: Error },
  ): void {
    const session = this.getSession(goalId);
    if (!session || session.pending !== pending) return;
    clearTimeout(pending.timer);
    if (pending.pollTimer) clearInterval(pending.pollTimer);
    session.pending = null;
    if ("error" in result) {
      dbg(goalId, `pending rejected: ${result.error.message}`);
      pending.reject(result.error);
      return;
    }
    pending.resolve({ text: result.text });
  }

  private binFor(adapterId: ShadowAdapterId): string {
    if (adapterId === "codex") return this.deps.codexBin ?? process.env["ORCA_CODEX_BIN"] ?? "codex";
    return this.deps.claudeBin ?? process.env["ORCA_CLAUDE_CODE_BIN"] ?? "claude";
  }

  private writeHookConfig(adapterId: ShadowAdapterId, goalId: string, dir: string): void {
    if (adapterId === "codex") {
      mkdirSync(join(dir, ".codex"), { recursive: true });
      writeFileSync(
        join(dir, ".codex", "config.toml"),
        "[features]\nhooks = true\n",
        "utf8",
      );
      writeFileSync(
        join(dir, ".codex", "hooks.json"),
        JSON.stringify(buildCodexHookSettings({ goalId, port: this.deps.daemonPort, authToken: this.deps.authToken }), null, 2),
        "utf8",
      );
      return;
    }
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.local.json"),
      JSON.stringify(buildShadowHookSettings({ goalId, port: this.deps.daemonPort, authToken: this.deps.authToken }), null, 2),
      "utf8",
    );
  }
}

export interface AskInput { adapterId?: ShadowAdapterId; systemPrompt: string; userPrompt: string; timeoutMs: number; }

export function shadowSessionId(goalId: string): string { return `orchsess-${goalId}`; }

function adapterDisplayName(adapterId: ShadowAdapterId): string {
  return adapterId === "codex" ? "Codex" : "Claude Code";
}

function buildCodexHookSettings(args: { goalId: string; port: number; authToken: string }): unknown {
  const commandFor = (failure: boolean) => [
    "curl",
    "-fsS",
    "-X", "POST",
    "-H", shellArg(`Authorization: Bearer ${args.authToken}`),
    "-H", shellArg("Content-Type: application/json"),
    "--data-binary", "@-",
    shellArg(
      `http://127.0.0.1:${args.port}/v1/orchestrator-hooks/stop?goalId=${encodeURIComponent(args.goalId)}${failure ? "&failure=1" : ""}`,
    ),
  ].join(" ");
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: commandFor(false) }] }],
      StopFailure: [{ hooks: [{ type: "command", command: commandFor(true) }] }],
    },
  };
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function textAfterTurnMarker(output: string, marker: string): string | null {
  const idx = output.lastIndexOf(marker);
  if (idx < 0) return null;
  return output.slice(idx + marker.length);
}

function extractCodexPaneAction(output: string): string | null {
  const starts = [...output.matchAll(/(?:^|\n)\s*•\s*\{/g)];
  for (let i = starts.length - 1; i >= 0; i--) {
    const match = starts[i];
    if (match?.index === undefined) continue;
    const braceStart = output.indexOf("{", match.index);
    if (braceStart < 0) continue;
    const raw = output.slice(braceStart);
    const promptIdx = raw.search(/\n\s*›/);
    const nextBulletIdx = raw.slice(1).search(/\n\s*•\s*\{/) + 1;
    const endCandidates = [promptIdx, nextBulletIdx].filter((idx) => idx > 0);
    const candidate = raw
      .slice(0, endCandidates.length > 0 ? Math.min(...endCandidates) : undefined)
      .trim();
    const compact = candidate.replace(/\n\s*/g, " ");
    const end = compact.lastIndexOf("}");
    if (end < 0) continue;
    const json = compact.slice(0, end + 1);
    try {
      JSON.parse(json);
      return json;
    } catch {
      continue;
    }
  }
  return null;
}
