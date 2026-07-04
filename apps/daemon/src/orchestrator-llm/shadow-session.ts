import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveAgentProvider } from "./providers/registry.js";
import type { AgentProvider } from "./providers/types.js";
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
  startupTimeoutMs?: number;          // max wait for trust+ready (default 45000; env ORCA_SHADOW_STARTUP_TIMEOUT_MS)
  readyQuietMs?: number;              // settle delay after trust before "ready" (default 1500)
  submitSettleMs?: number;            // delay after paste before Enter, so a bracketed paste is ingested (default 200)
  submitConfirmMs?: number;           // max wait for the turn to start before re-sending Enter (default 2000)
  // PROVISIONAL: receives the full orchestrator turn text before parseAction strips it to
  // the action block. This in-process tap moves to the Runner Protocol boundary at the
  // control/execution-plane split.
  onOrchestratorTurn?: (goalId: string, fullText: string) => void;
}

interface Pending {
  resolve: (r: { text: string }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  pollTimer?: ReturnType<typeof setInterval>;
}

interface Session {
  adapterId: ShadowAdapterId;
  provider: AgentProvider;
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

// Cold-starting an interactive Claude Code session (trust prompt -> hook trust ->
// ready input box) routinely needs well over 20s, especially a SECOND concurrent
// session (e.g. the refute's `${goalId}::refute`) on a busy machine. A too-tight
// budget makes the refute time out -> "unavailable" -> a needless human pause and a
// no-verification metrics hit. Default 45s; tunable per-deps or via env.
export const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
export function resolveStartupTimeoutMs(
  depsValue: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof depsValue === "number" && Number.isFinite(depsValue) && depsValue > 0) return depsValue;
  const raw = env.ORCA_SHADOW_STARTUP_TIMEOUT_MS;
  if (raw != null) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_STARTUP_TIMEOUT_MS;
}

export class ShadowSessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly tmux: TmuxRunner;

  constructor(private readonly deps: ShadowSessionDeps) {
    this.tmux = deps.tmux ?? defaultTmuxRunner();
  }

  has(goalId: string): boolean { return this.sessions.has(goalId); }

  private tmuxName(goalId: string): string { return tmuxSessionName(goalId); }

  /** Spawns the goal's shadow tmux+CLI session (idempotent per adapter). */
  async spawn(goalId: string, adapterId: ShadowAdapterId = "claude-code"): Promise<string> {
    const existing = this.sessions.get(goalId);
    if (existing?.adapterId === adapterId) return shadowSessionId(goalId);
    if (existing) await this.terminate(goalId);
    const provider = resolveAgentProvider(adapterId);
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
  private async startup(goalId: string, name: string, provider: AgentProvider): Promise<void> {
    const pattern = this.deps.trustPattern ?? TRUST_DEFAULT;
    const poll = this.deps.pollMs ?? 300;
    const timeoutMs = resolveStartupTimeoutMs(this.deps.startupTimeoutMs);
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
    const capture = session.provider.captureMode();
    const parser = session.provider.turnParser();

    // Register `pending` before submitting so a fast Stop hook / pane poll always
    // has somewhere to land, then submit out-of-band (see submitPrompt).
    const result = new Promise<{ text: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.pending?.pollTimer) clearInterval(session.pending.pollTimer);
        session.pending = null;
        reject(new Error(`shadow orchestrator timeout for goal ${goalId}`));
      }, input.timeoutMs);
      const pending: Pending = { resolve, reject, timer };
      if (capture.kind === "pane-poll") {
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

    void this.submitPrompt(session, goalId, buf, text).catch((err) =>
      dbg(goalId, `submit failed: ${err instanceof Error ? err.message : String(err)}`)
    );

    return result;
  }

  /**
   * Paste the prompt and submit it, confirming the turn actually started. A
   * bracketed paste plus a single Enter can fail to submit on a freshly-spawned
   * CLI — the welcome/release-notes interstitial swallows the Enter, or the Enter
   * races the paste ingest — which strands the turn until it times out (the
   * symptom after a daemon restart spawns a fresh shadow session). So re-send
   * Enter until the provider reports the turn started (detectTurnStarted), or the
   * pending ask is already settled/timed out.
   */
  private async submitPrompt(session: Session, goalId: string, buf: string, text: string): Promise<void> {
    if (session.provider.beforeSubmit) {
      await session.provider.beforeSubmit({
        tmux: this.tmux,
        sessionName: session.name,
        dbg: (msg) => dbg(goalId, msg),
      });
    }
    await paste(this.tmux, session.name, buf, text);
    const parser = session.provider.turnParser();
    const detectStarted = parser.detectTurnStarted?.bind(parser);
    const settle = this.deps.submitSettleMs ?? 200;
    const confirmMs = this.deps.submitConfirmMs ?? 2000;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (session.pending === null) return; // already settled / timed out
      await sleep(settle);
      await sendEnter(this.tmux, session.name);
      if (!detectStarted) return; // provider can't confirm — best-effort single submit
      const deadline = Date.now() + confirmMs;
      while (Date.now() < deadline) {
        if (session.pending === null) return;
        await sleep(150);
        const pane = await capturePane(this.tmux, session.name);
        if (detectStarted(pane)) {
          dbg(goalId, `submit confirmed (attempt ${attempt})`);
          return;
        }
      }
      dbg(goalId, `submit not confirmed after ${confirmMs}ms (attempt ${attempt}); re-sending Enter`);
    }
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
    // PROVISIONAL: capture the orchestrator's full turn text for the auditable
    // activity trajectory before parseAction strips it to the action block. This
    // in-process tap moves to the Runner Protocol boundary at the plane split.
    try { this.deps.onOrchestratorTurn?.(goalId, result.text ?? ""); } catch { /* never break the loop */ }
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

  private writeHookConfig(provider: AgentProvider, goalId: string, dir: string): void {
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

// Derive the tmux session name from a shadow session key. tmux session names may
// not contain ':' or '.' — tmux silently rewrites them on create, but uses them as
// `session:window.pane` target syntax on capture-pane/send-keys. An isolated key
// like `${goalId}::refute` would therefore be CREATED as `…__refute` but TARGETED as
// session `orca-shadow-${goalId}` window `refute`, so its trust prompt is never
// answered (startup times out). Sanitize once here so create/capture/send/kill agree.
export function tmuxSessionName(sessionKey: string): string {
  return `orca-shadow-${sessionKey}`.replace(/[:.]/g, "_");
}

function textAfterTurnMarker(output: string, marker: string): string | null {
  const idx = output.lastIndexOf(marker);
  if (idx < 0) return null;
  return output.slice(idx + marker.length);
}
