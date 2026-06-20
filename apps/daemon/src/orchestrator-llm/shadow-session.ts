import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveShadowProvider } from "./providers/registry.js";
import type { ShadowProvider } from "./providers/types.js";
import {
  type TmuxRunner,
  defaultTmuxRunner,
  newSession,
  capturePane,
  paste,
  sendEnter,
  killSession,
} from "../tmux/runner.js";

export type { ShadowAdapterId } from "./providers/types.js";
import type { ShadowAdapterId } from "./providers/types.js";

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
  authToken: string;                  // daemon Bearer token; used by the HTTP server layer
  hookResolverCommand: string[];      // argv to invoke daemon's hook subcommand (passed to hookConfig)
  isReady: (adapterId?: ShadowAdapterId) => Promise<boolean>; // adapter.checkAuth in prod; ()=>true in tests
  claudeBin?: string;                 // default ORCA_CLAUDE_CODE_BIN ?? "claude"
  codexBin?: string;                  // default ORCA_CODEX_BIN ?? "codex"
  antigravityBin?: string;            // default ORCA_ANTIGRAVITY_BIN ?? "agy"
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
  provider: ShadowProvider;
  name: string;            // tmux session name
  ready: Promise<void>;
  queue: Promise<unknown>;
  pending: Pending | null;
  systemSent: boolean;
}

const TRUST_DEFAULT = /trust this folder|Is this a project you created or one you trust|do you trust/i;
const HOOK_TRUST_PROMPT = /hook needs review|hooks need review|press t to trust|new hook - review required/i;
// Panes matching this are blocking interstitials/menus (e.g. codex's update nag),
// not a real ready input prompt — must NOT satisfy the ready branch.
const BLOCKING_INTERSTITIAL = /update available|press enter to continue|\b\d+\.\s*(update now|skip)\b/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ShadowSessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly tmux: TmuxRunner;

  constructor(private readonly deps: ShadowSessionDeps) {
    this.tmux = deps.tmux ?? defaultTmuxRunner();
  }

  has(goalId: string): boolean { return this.sessions.has(goalId); }

  private tmuxName(goalId: string): string { return `orca-shadow-${goalId}`; }

  /** Spawns the goal's shadow tmux+CLI session (idempotent per adapter). */
  async spawn(goalId: string, adapterId: ShadowAdapterId = "claude-code"): Promise<string> {
    const existing = this.sessions.get(goalId);
    if (existing?.adapterId === adapterId) return shadowSessionId(goalId);
    if (existing) await this.terminate(goalId);
    const provider = resolveShadowProvider(adapterId);
    if (!(await this.deps.isReady(adapterId))) {
      throw new Error(`orchestrator shadow not ready: sign in to ${provider.displayName}`);
    }
    const dir = join(this.deps.shadowRoot, goalId);
    this.writeHookConfig(provider, goalId, dir);
    const name = this.tmuxName(goalId);
    const { bin, args = [] } = provider.launch({ binOverride: this.binOverride(adapterId) });
    // tmux runs this via `sh -c`, so quote any token containing whitespace (e.g. a bin path with spaces).
    const command = [bin, ...args].map((token) => (/\s/.test(token) ? JSON.stringify(token) : token)).join(" ");
    const started = await newSession(this.tmux, name, dir, command);
    dbg(goalId, `tmux new-session code=${started.code} adapter=${adapterId} name=${name} command=${command} dir=${dir}`);
    const ready = this.startup(goalId, name, provider);
    // Prevent an unhandled-rejection warning when nobody is awaiting `ready` yet
    // (askOnce still observes the rejection via `await pre.ready`).
    ready.catch(() => undefined);
    const session: Session = { adapterId, provider, name, ready, queue: Promise.resolve(), pending: null, systemSent: false };
    this.sessions.set(goalId, session);
    return shadowSessionId(goalId);
  }

  /** Polls capture-pane: answer the trust prompt, then settle into the input box. */
  private async startup(goalId: string, name: string, provider: ShadowProvider): Promise<void> {
    const pattern = this.deps.trustPattern ?? TRUST_DEFAULT;
    const poll = this.deps.pollMs ?? 300;
    const timeoutMs = this.deps.startupTimeoutMs ?? 20_000;
    const deadline = Date.now() + timeoutMs;
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
      // But a blocking interstitial/menu (e.g. codex update nag) is NOT ready — keep polling.
      if (
        !pattern.test(pane) &&
        !BLOCKING_INTERSTITIAL.test(pane) &&
        /(auto mode on|\? for shortcuts|\n\s*❯|\n\s*›|\bcodex\b.*\bready\b|\n\s*>)/i.test(pane)
      ) {
        dbg(goalId, "ready (no trust, input box present)");
        return;
      }
      await sleep(poll);
    }
    dbg(goalId, `startup timed out after ${timeoutMs}ms (never reached ready)`);
    throw new Error(
      `shadow orchestrator startup timed out for goal ${goalId}: ${provider.displayName} never reached a ready input prompt within ${timeoutMs}ms`,
    );
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
    if (session.provider.beforeSubmit) {
      await session.provider.beforeSubmit({
        tmux: this.tmux,
        sessionName: session.name,
        dbg: (msg) => dbg(goalId, msg),
      });
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
      const capture = session.provider.captureMode();
      if (capture.kind === "pane-poll") {
        const parser = session.provider.turnParser();
        let polling = false;
        pending.pollTimer = setInterval(() => {
          if (polling) return;
          polling = true;
          void this.tmux.run(["capture-pane", "-t", session.name, "-p"])
            .then((pane) => {
              if (session.pending !== pending) return;
              const turnText = textAfterTurnMarker(pane.stdout, transportMarker);
              if (turnText === null) return;
              const action = parser.parseAction(turnText);
              if (action !== null) {
                this.settlePending(goalId, pending, { text: action });
                return;
              }
              const error = parser.detectError?.(turnText) ?? null;
              if (error !== null) {
                this.settlePending(goalId, pending, { error: new Error(error.message) });
              }
            })
            .finally(() => { polling = false; });
        }, capture.intervalMs);
      }
      session.pending = pending;
    });
  }

  /** Called by the hook endpoint when the goal's shadow session emits Stop/StopFailure. */
  resolvePending(goalId: string, result: { text?: string; failure?: boolean }): void {
    const session = this.getSession(goalId);
    const pending = session?.pending ?? null;
    if (!session || !pending) return; // stray/duplicate hook -> drop
    if (result.failure) {
      this.settlePending(goalId, pending, {
        error: new Error(result.text || "shadow orchestrator StopFailure"),
      });
      return;
    }
    const block = session.provider.turnParser().parseAction(result.text ?? "");
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

  private binOverride(adapterId: ShadowAdapterId): string | undefined {
    const overrides: Record<ShadowAdapterId, string | undefined> = {
      "claude-code": this.deps.claudeBin,
      codex: this.deps.codexBin,
      antigravity: this.deps.antigravityBin,
    };
    return overrides[adapterId];
  }

  private writeHookConfig(provider: ShadowProvider, goalId: string, dir: string): void {
    const { files } = provider.hookConfig({ goalId, resolverCommand: this.deps.hookResolverCommand });
    for (const file of files) {
      const target = join(dir, file.relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.contents, "utf8");
    }
  }
}

export interface AskInput { adapterId?: ShadowAdapterId; systemPrompt: string; userPrompt: string; timeoutMs: number; }

export function shadowSessionId(goalId: string): string { return `orchsess-${goalId}`; }

function textAfterTurnMarker(output: string, marker: string): string | null {
  const idx = output.lastIndexOf(marker);
  if (idx < 0) return null;
  return output.slice(idx + marker.length);
}
