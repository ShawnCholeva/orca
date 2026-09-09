import { mkdirSync, writeFileSync, copyFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  defaultTmuxRunner, tmuxSocketPath, newSession, capturePane, sendEnter, sendKey, sendRawBytes, paste, pipePaneToFile, killSession, hasSession,
  WORKER_PANE_COLS, WORKER_PANE_ROWS,
  type TmuxRunner,
  TMUX_OWNER_VAR,
} from "../../tmux/runner.js";
import { shellCommand } from "../../tmux/shell-quote.js";
import { trustPromptMoves } from "../../tmux/trust-prompt.js";

const TRUST_DEFAULT = /trust this folder|Is this a project you created or one you trust|do you trust/i;
const READY_DEFAULT = /(auto mode on|\? for shortcuts|\n\s*❯)/i;
// Busy = the live, interruptible spinner. Match only signals that are exclusive
// to an in-progress turn. Note: the past-tense summaries Claude Code prints AFTER
// a turn ("Cooked for 12s", "Churned for 36s") are shown while IDLE at the prompt,
// so they must NOT count as busy (every genuinely-busy frame carries "esc to interrupt").
// These patterns are matched against liveRegion(), NOT the whole pane — Claude Code's
// welcome/"What's new" panel prints release-note prose that has contained "thinking",
// "hook", and "auto mode", and a whole-pane scan misread that decoration as a live turn
// (it wedged deliver() on a promptless worker for the full 120s). See liveRegion().
const BUSY_DEFAULT = /esc to interrupt|running .* hook/i;
// claude renders the input box (❯) ABOVE its status/footer lines, so the prompt
// is not at end-of-pane. Match an EMPTY prompt line (❯ followed by only spaces)
// anywhere; combined with !busy this means the agent is idle and ready for input.
// NOTE: claude pads the empty input line with a non-breaking space (U+00A0), not
// a normal space — the char class MUST include   or idle is never detected.
const PROMPT_IDLE = /❯[ \t ]*(?:\n|$)/;
// The composer prompt is PRESENT and accepting input — the ❯ line, whether empty
// or bearing text. After a denied AskUserQuestion, Claude Code renders its
// suggested answer as greyed PLACEHOLDER text ("❯ Local web UI, …"); the composer
// is idle and ready, but PROMPT_IDLE (empty-only) is fooled by that placeholder and
// deliver() would time out. The INITIAL idle-wait uses this looser check (with
// !busy); the post-submit confirm-clear keeps the strict empty PROMPT_IDLE so the
// "answer stuck in the box" retry still fires. deliver() sends C-u before pasting
// so any real (non-placeholder) text is cleared and can't be appended to.
const PROMPT_READY = /❯[ \t ]/;
// Codex renders its composer prompt with a single right-angle quote (› U+203A,
// distinct from claude's ❯) followed by placeholder/typed text, e.g. "› Summarize
// recent commits". It's present whenever the composer accepts input, so combined
// with !busy it signals idle. (› never appears in claude's TUI, so this is additive.)
const CODEX_PROMPT_IDLE = /(?:\n|^)[ \t]*›[ \t]/;

// Both providers pin the composer input box near the BOTTOM of the pane and render
// their live spinner ("esc to interrupt") in the status line(s) directly above it.
// Decorative panels — the welcome/"What's new" release notes, tips, MCP notices —
// render in the UPPER pane, tens of (usually blank) lines above the composer. So
// busy/idle detection scans only this "live region": a small lookback above the
// composer down to the pane bottom. That structurally excludes decorative prose,
// which no busy/idle heuristic can safely be trusted against (release notes have
// literally contained "thinking", "hook", and "auto mode"). The lookback is generous
// enough for a multi-line spinner yet far short of the decoration's distance.
const LIVE_REGION_LOOKBACK = 6;
function liveRegion(pane: string): string {
  const lines = pane.split("\n");
  let anchor = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("❯") || lines[i].includes("›")) { anchor = i; break; }
  }
  // No composer rendered yet (early startup): keep the whole pane — there's no idle
  // prompt to match against anyway, and a genuine "running … hook" frame is still busy.
  if (anchor === -1) return pane;
  return lines.slice(Math.max(0, anchor - LIVE_REGION_LOOKBACK)).join("\n");
}

/**
 * Whether a captured pane shows a composer that is ready for input: a prompt is
 * rendered and no turn is in flight. This is exactly the readiness `deliver()`
 * waits for, factored out so a human typing at the embedded terminal is held to
 * the same bar the orchestrator holds itself to.
 */
export function isPaneIdle(pane: string): boolean {
  const region = liveRegion(pane);
  if (BUSY_DEFAULT.test(region)) return false;
  return PROMPT_READY.test(region) || CODEX_PROMPT_IDLE.test(region);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type DeliverResult = "delivered" | "no_session" | "timeout";
export type WriteInputResult = "written" | "no_session" | "busy";

// A capture-pane per keystroke would spawn a tmux process per character, so the
// idle verdict is reused briefly. The window is short enough that a turn
// starting mid-burst blocks the rest of it within a few hundred milliseconds.
const IDLE_CACHE_MS = 400;

// How often the pane file is read for new bytes. Deliberately far shorter than
// `pollMs`, which paces capture-pane — a SUBPROCESS — for the orchestrator's
// idle detection. This is a positional read on an already-open fd, so it is
// cheap enough to run at screen rates, and it is the path a human's own
// keystrokes take back to their terminal: at 300ms that reads as lag.
const TAIL_POLL_MS = 40;

export interface WorkerSpawnInput {
  sessionId: string;
  goalId: string;
  adapterId: string;
  workspacePath: string;
  command: string;            // resolved claude binary (from adapter.resolveSpawn)
  /** Adapter args (model + effort) from resolveSpawn. Empty when none resolved. */
  args: string[];
  env: Record<string, string>; // adapter env (already secret-sanitized; carries HOME for auth)
}

export interface WorkerSessionDeps {
  privateRoot: string;        // daemon-private dir, e.g. <dataDir>/workers
  authToken: string;
  // Daemon loopback OTLP base URL (`http://127.0.0.1:${port}/v1/otlp`); threaded into
  // each worker's hook config so the provider emits token/cost telemetry to the receiver.
  // Optional: when absent (e.g. in tests) providers skip telemetry emission.
  otlpBaseUrl?: string;
  hookResolverCommand: string[];
  claudeBin: string;
  resolveProvider: (adapterId: string) => {
    displayName?: string;
    workerHookConfig: (args: { goalId: string; sessionId: string; resolverCommand: string[]; configDir: string; otlpBaseUrl?: string; authToken?: string }) =>
      {
        files: { relPath: string; contents: string }[];
        copyFiles?: { relPath: string; sourcePath: string }[];
        spawnArgs: string[];
        env?: Record<string, string>;
      };
    waitForLimitReset?: (ctx: {
      tmux: TmuxRunner;
      sessionName: string;
      dbg: (msg: string) => void;
    }) => Promise<void>;
  };
  tmux?: TmuxRunner;
  /** The data dir that owns the sessions this manager creates (see TMUX_OWNER_VAR). Defaults to privateRoot's parent. */
  owner?: string;
  captureSink: (sessionId: string, chunk: Buffer) => void; // appends pane bytes to the output store
  // Optional: flip the DB session row to running, and record the geometry its
  // pane was created at. Without the geometry the row reports NULL size and a
  // viewer has nothing to render at, so it guesses its own — which is what made
  // the embedded terminal illegible.
  markRunning?: (sessionId: string, pane: { cols: number; rows: number }) => void;
  // Optional: flip the DB session row terminal when the manager reaps the
  // worker. Without this, deliberately-terminated workers stay 'running' in
  // the DB forever (dishonest status; observed live 2026-07-07).
  markExited?: (sessionId: string) => void;
  trustPattern?: RegExp;
  readyPattern?: RegExp;
  pollMs?: number;
  /** Overrides how often the pane file is read; see TAIL_POLL_MS. */
  tailPollMs?: number;
  startupTimeoutMs?: number;
  readyQuietMs?: number;
  postPasteMs?: number;
  idleQuietMs?: number;
  idleTimeoutMs?: number;
}

interface WorkerSession { name: string; adapterId: string; ready: Promise<void>; }
interface WriteQueue {
  pending: Buffer[];
  waiters: { resolve: (r: WriteInputResult) => void; reject: (e: unknown) => void }[];
  draining: boolean;
}
interface WorkerTail {
  fd: number;
  closed: boolean;
  stopWatching: () => void;
}

export class WorkerSessionManager {
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly tails = new Map<string, WorkerTail>();
  private readonly idleCache = new Map<string, { idle: boolean; until: number }>();
  // One write at a time per worker: each send is its own tmux process, and
  // concurrent ones finish out of order — typed text arrived scrambled. Bytes
  // that arrive while a send is in flight wait here and go out together.
  private readonly writeQueues = new Map<string, WriteQueue>();
  private readonly tmux: TmuxRunner;
  constructor(private readonly deps: WorkerSessionDeps) {
    this.tmux = deps.tmux ?? defaultTmuxRunner(tmuxSocketPath(this.owner()));
  }

  private name(sessionId: string): string { return `orca-worker-${sessionId}`; }
  private owner(): string { return this.deps.owner ?? dirname(this.deps.privateRoot); }

  async spawn(input: WorkerSpawnInput): Promise<void> {
    if (this.sessions.has(input.sessionId)) return;
    const cfgDir = join(this.deps.privateRoot, input.sessionId);
    mkdirSync(cfgDir, { recursive: true });
    const provider = this.deps.resolveProvider(input.adapterId);
    const hookCfg = provider.workerHookConfig({
      goalId: input.goalId,
      sessionId: input.sessionId,
      resolverCommand: this.deps.hookResolverCommand,
      configDir: cfgDir,
      otlpBaseUrl: this.deps.otlpBaseUrl,
      authToken: this.deps.authToken,
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
    // tmux runs this command string via `sh -c` — see tmux/shell-quote.ts for
    // why the safe-unquoted set is as narrow as it is.
    const command = shellCommand([input.command, ...input.args, ...hookCfg.spawnArgs]);
    const env = { ...input.env, ...(hookCfg.env ?? {}), [TMUX_OWNER_VAR]: this.owner() };
    await newSession(this.tmux, name, input.workspacePath, command, env);
    // Output capture: pipe pane to a private file; daemon tails it (Task 3.2).
    await pipePaneToFile(this.tmux, name, join(cfgDir, "pane.out"));
    this.startTail(input.sessionId, join(cfgDir, "pane.out"));
    this.sessions.set(input.sessionId, { name, adapterId: input.adapterId, ready: this.startup(name) });
    this.deps.markRunning?.(input.sessionId, { cols: WORKER_PANE_COLS, rows: WORKER_PANE_ROWS });
  }

  private async startup(name: string): Promise<void> {
    const trustRe = this.deps.trustPattern ?? TRUST_DEFAULT;
    const readyRe = this.deps.readyPattern ?? READY_DEFAULT;
    const poll = this.deps.pollMs ?? 300;
    const deadline = Date.now() + (this.deps.startupTimeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      const pane = await capturePane(this.tmux, name);
      if (trustRe.test(pane)) {
        const moves = trustPromptMoves(pane);
        // Options not painted yet — keep polling rather than confirming blind.
        // A blind Enter lands on whatever row is highlighted, and Claude Code
        // defaults that to "No, exit", which QUITS the worker ~2s into its life.
        if (moves === null) {
          await sleep(poll);
          continue;
        }
        // Move ONE row per poll and re-read. Keys sent before the TUI attaches
        // its input handler are silently swallowed, so an open-loop burst can
        // leave the highlight parked on "No, exit" while we press Enter on it.
        // Re-reading self-corrects: an unmoved highlight just gets sent again.
        if (moves !== 0) {
          await sendKey(this.tmux, name, moves > 0 ? "Down" : "Up");
          await sleep(poll);
          continue;
        }
        // Confirm only once the pane shows the highlight ON the affirmative row,
        // then keep polling for the ready prompt rather than assuming it arrived.
        await sendEnter(this.tmux, name);
        await sleep(this.deps.readyQuietMs ?? 1500);
        continue;
      }
      // Reached only when the trust prompt is absent, which matters: READY_DEFAULT's
      // `\n\s*❯` branch also matches the trust menu's own highlighted row, so ready
      // and trust are indistinguishable to that pattern alone. The trust branch
      // above `continue`s, so this check never sees a pane bearing the menu.
      if (readyRe.test(pane) || CODEX_PROMPT_IDLE.test(pane)) { await sleep(this.deps.readyQuietMs ?? 1500); return; }
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
    // Never slower than the orchestrator's own loop, so a test that speeds one up
    // gets a tail to match.
    const interval = this.deps.tailPollMs ?? Math.min(this.deps.pollMs ?? 300, TAIL_POLL_MS);
    const timer = setInterval(pump, interval);
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
      const region = liveRegion(await capturePane(this.tmux, s.name));
      const busy = BUSY_DEFAULT.test(region);
      // Ready = a not-busy composer prompt, EMPTY or bearing placeholder/leftover
      // text (PROMPT_READY, not the strict empty PROMPT_IDLE) — see PROMPT_READY.
      const idle = !busy && (PROMPT_READY.test(region) || CODEX_PROMPT_IDLE.test(region));
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
    // Clear the composer before pasting: a placeholder suggestion is ghost text
    // (paste replaces it), but any REAL leftover (e.g. a prior un-submitted answer)
    // would be appended to. C-u kills the line — a no-op on an empty composer, and
    // it never triggers Claude's Esc-Esc rewind menu the way an interrupt would.
    await sendKey(this.tmux, s.name, "C-u");
    await paste(this.tmux, s.name, buf, text);
    await sleep(this.deps.postPasteMs ?? 250);
    // Claude only submits on Enter when the cursor is at the END of the composer.
    // A fresh bracketed paste normally leaves it there, but a re-rendered/reattached
    // pane can park the cursor mid-text, and then Enter inserts a newline instead of
    // submitting — the answer sits in the box and wedges the worker (a non-empty ❯ box
    // never matches the empty-prompt idle check, so every later deliver() times out).
    // Move to the end first; End is a no-op when already there.
    await sendKey(this.tmux, s.name, "End");
    await sendEnter(this.tmux, s.name);

    // Confirm submission: after Enter the composer should clear — the pane returns to
    // an idle (empty) prompt or the agent starts working. If our text is still sitting
    // in the box, the Enter didn't submit (cursor not at end, or a dropped keystroke).
    // A short answer renders inline (not as a "[Pasted text]" placeholder), so the only
    // reliable signal is the box clearing. Re-send End+Enter until it does.
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(poll);
      const after = liveRegion(await capturePane(this.tmux, s.name));
      const cleared =
        BUSY_DEFAULT.test(after) || PROMPT_IDLE.test(after) || CODEX_PROMPT_IDLE.test(after);
      if (cleared) break;
      await sendKey(this.tmux, s.name, "End");
      await sendEnter(this.tmux, s.name);
    }
    return "delivered";
  }

  /**
   * True iff the worker's tmux session actually exists. Used by boot-resume to
   * decide reattach vs respawn — a DB row marked 'running' is NOT proof of
   * liveness (the tmux session can die independently of the daemon).
   */
  async isTmuxAlive(sessionId: string): Promise<boolean> {
    const alive = await hasSession(this.tmux, this.name(sessionId));
    // Self-heal: a DB/map row can outlive the tmux session it names (external
    // kill, crash, tmux server death). Evict the stale entry so the manager's
    // own bookkeeping stops lying about it — respawn/reattach see it as gone.
    if (!alive) this.sessions.delete(sessionId);
    return alive;
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
    this.sessions.set(sessionId, { name, adapterId: "", ready: Promise.resolve() });
    try {
      this.deps.markRunning?.(sessionId, { cols: WORKER_PANE_COLS, rows: WORKER_PANE_ROWS });
      this.startTail(sessionId, join(cfgDir, "pane.out"));
    } catch (error) {
      this.sessions.delete(sessionId);
      this.stopTail(sessionId);
      throw error;
    }
    return true;
  }

  async terminate(sessionId: string, reason = "worker.terminate"): Promise<void> {
    const s = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.idleCache.delete(sessionId);
    this.writeQueues.delete(sessionId);
    this.stopTail(sessionId);
    await killSession(this.tmux, s?.name ?? this.name(sessionId), reason);
    this.deps.markExited?.(sessionId);
  }

  /**
   * Interrupt the agent's current turn by sending Escape to its live tmux
   * session (the same key Claude Code surfaces as "esc to interrupt"). The
   * session is left alive and idle so a follow-up correction can be delivered.
   * Tolerates a session missing from the in-memory map (derives the tmux name)
   * so a live agent can be interrupted after a daemon restart.
   */
  /**
   * Raw keystrokes from a human sitting at this worker's embedded terminal.
   *
   * The orchestrator drives the same pane, and its delivery is not atomic: it
   * waits for idle, sends C-u to clear the composer, pastes, then Enter. Keys
   * arriving inside that window are erased by the C-u or corrupt the paste. So
   * input is admitted only while the pane is idle — the same readiness
   * `deliver()` waits for — and refused, not queued, while a turn is in flight.
   */
  async writeInput(sessionId: string, bytes: Buffer): Promise<WriteInputResult> {
    if (bytes.length === 0) return "written";
    let queue = this.writeQueues.get(sessionId);
    if (!queue) {
      queue = { pending: [], waiters: [], draining: false };
      this.writeQueues.set(sessionId, queue);
    }
    queue.pending.push(bytes);
    const verdict = new Promise<WriteInputResult>((resolve, reject) => {
      queue.waiters.push({ resolve, reject });
    });
    if (!queue.draining) void this.drainWrites(sessionId, queue);
    return verdict;
  }

  /**
   * The first keystroke goes out immediately; everything typed while that send is
   * in flight rides the next one as a single batch. A burst therefore costs one
   * tmux round trip rather than one per character, and typing never falls behind
   * the fingers.
   */
  private async drainWrites(sessionId: string, queue: WriteQueue): Promise<void> {
    queue.draining = true;
    try {
      while (queue.pending.length > 0) {
        const batch = Buffer.concat(queue.pending.splice(0));
        const waiters = queue.waiters.splice(0);
        try {
          const result = await this.writeInputNow(sessionId, batch);
          for (const waiter of waiters) waiter.resolve(result);
        } catch (error) {
          // One failed batch must not strand the keystrokes queued behind it.
          for (const waiter of waiters) waiter.reject(error);
        }
      }
    } finally {
      queue.draining = false;
    }
  }

  private async writeInputNow(sessionId: string, bytes: Buffer): Promise<WriteInputResult> {
    const name = this.sessions.get(sessionId)?.name ?? this.name(sessionId);
    if (!(await this.paneIdle(sessionId, name))) {
      // A pane that is not idle is either mid-turn or gone. Only here, off the
      // typing path, is it worth a second tmux call to tell those apart.
      return (await hasSession(this.tmux, name)) ? "busy" : "no_session";
    }
    return (await sendRawBytes(this.tmux, name, bytes)) ? "written" : "no_session";
  }

  private async paneIdle(sessionId: string, name: string): Promise<boolean> {
    const cached = this.idleCache.get(sessionId);
    if (cached && Date.now() < cached.until) return cached.idle;
    const idle = isPaneIdle(await capturePane(this.tmux, name));
    this.idleCache.set(sessionId, { idle, until: Date.now() + IDLE_CACHE_MS });
    return idle;
  }

  async interrupt(sessionId: string): Promise<void> {
    const name = this.sessions.get(sessionId)?.name ?? this.name(sessionId);
    if (!(await hasSession(this.tmux, name))) return;
    // Two Escapes: the first stops generation, the second clears any leftover
    // composer/menu state so the worker returns to an idle prompt.
    await sendKey(this.tmux, name, "Escape");
    await sendKey(this.tmux, name, "Escape");
  }

  /**
   * Drives the provider's terminal "wait for the limit to reset" interaction
   * against the worker's live tmux session (e.g. Claude Code's Enter selection).
   * Tolerates a session missing from the in-memory map by deriving the
   * deterministic tmux name, so a live session can be controlled after a daemon
   * restart. Throws when the provider cannot preserve a limited session.
   */
  async waitForProviderReset(sessionId: string, adapterId: string): Promise<void> {
    const name = this.sessions.get(sessionId)?.name ?? this.name(sessionId);
    const provider = this.deps.resolveProvider(adapterId);
    if (!provider.waitForLimitReset) {
      throw new Error(`${provider.displayName ?? adapterId} does not support preserving a limited session`);
    }
    await provider.waitForLimitReset({
      tmux: this.tmux,
      sessionName: name,
      dbg: (message) => console.debug(`[worker-session] ${message}`),
    });
  }
}
