# Tmux-Backed Worker Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run per-step worker agents as headless tmux sessions (like the orchestrator shadow) so the daemon can reliably deliver and submit input to them — replacing the flaky node-pty delivery whose Enter-keystrokes get dropped.

**Architecture:** A worker becomes a second headless `tmux` claude session, reusing the proven primitives from `orchestrator-llm/shadow-session.ts` (`capture-pane` to read the screen, `paste-buffer`+`send-keys` to submit). Completion/judging stays hook-driven (Claude Stop hook → daemon), which is transport-agnostic. The node-pty session runtime is left intact for manual/legacy sessions but is no longer the worker-dispatch path.

**Tech stack:** TypeScript, Node.js daemon, `tmux`, Claude Code CLI, better-sqlite3, vitest, Fastify.

**Design source:** `docs/superpowers/specs/2026-05-30-agent-input-transport-design.md` (Option B, decided). Reuses patterns from `docs/superpowers/specs/2026-05-28-orchestrator-mediated-workflows-design.md`.

**Phasing note:** This is large and sequential. Phases 0–5 deliver the working transport; Phases 6–7 (reattach, UI cleanup) are independently shippable and may be split into follow-on plans if desired. Each phase ends green and committable.

---

## Key facts (verified against the codebase, 2026-05-30)

- **The shadow already does all of this for the brain.** `ShadowSessionManager` (`apps/daemon/src/orchestrator-llm/shadow-session.ts`) spawns `tmux new-session -d -x 220 -y 50 -c <dir> claude`, polls `capture-pane -t <name> -p` for readiness, submits via `load-buffer`/`paste-buffer -p`/`send-keys Enter`, and resolves on a Stop hook. We reuse these primitives verbatim.
- **Completion is hook-based and transport-agnostic.** Claude's Stop hook POSTs `{ last_assistant_message }` to an HTTP hook URL (see `orchestrator-hooks/routes.ts:15`). The shadow hook config is `buildShadowHookSettings` (`orchestrator-llm/shadow-hook-settings.ts`). Worker judging already exists: `/v1/agent-hooks/response-done` → `OrchestratorService.onAgentResponseDone` → `judgeAgentResponse`. We add the worker-side Stop hook that feeds it.
- **Worker output must still reach the output store.** `OrchestratorService.onWorkflowSessionCompleted` synthesizes step output from the session tail, and memory extraction reads it. node-pty does this via `pty.onData → broadcastOutput`. tmux needs `pipe-pane` plumbing (new — used nowhere yet).
- **Repo-pollution hazard.** The shadow writes `.claude/settings.local.json` into its *private* cwd. A worker's cwd is the user's workspace, so we must install hook settings somewhere private (Phase 0 spike: `CLAUDE_CONFIG_DIR`).
- **Current worker dispatch** = `OrchestratorService.spawnStepAgent` → `this.launcher.launch` (`ProductionWorkflowSessionLauncher`, node-pty) → `deliverInitialPrompt` (node-pty heuristic). `forward_to_agent` / `revise_step` call `this.agentInput` (node-pty plain write). These are the call sites we re-point.
- **tmux survives daemon restart** → real reattach (Phase 6), fixing today's respawn-only limitation.

---

## File structure

**Create:**
- `apps/daemon/src/tmux/runner.ts` — shared `TmuxRunner` + tmux helper fns (extracted from shadow).
- `apps/daemon/src/tmux/runner.test.ts`
- `apps/daemon/src/agent-hooks/hook-settings.ts` — `buildAgentHookSettings` (worker Stop hook → `/v1/agent-hooks/stop`).
- `apps/daemon/src/agent-hooks/hook-settings.test.ts`
- `apps/daemon/src/workflows/orchestrator/worker-session.ts` — `WorkerSessionManager` (tmux-backed worker lifecycle + delivery).
- `apps/daemon/src/workflows/orchestrator/worker-session.test.ts`

**Modify:**
- `apps/daemon/src/orchestrator-llm/shadow-session.ts` — use shared `tmux/runner.ts` (no behavior change).
- `apps/daemon/src/agent-hooks/routes.ts` — add `/v1/agent-hooks/stop` (reads `last_assistant_message`).
- `apps/daemon/src/workflows/orchestrator/service.ts` — `spawnStepAgent` uses `WorkerSessionManager`; `forward_to_agent`/`revise_step` route through it.
- `apps/daemon/src/server.ts` — construct + wire `WorkerSessionManager`; wire `/v1/agent-hooks/stop`.
- `apps/daemon/src/workflows/orchestrator/reconcile`/`resume` paths — reattach surviving tmux workers (Phase 6).
- `apps/desktop/src/goal-detail/GoalDetailView.tsx` — remove `<SessionsPanel>` (Phase 7).

**Leave intact:** `pty/manager.ts`, node-pty `SessionRuntime`, `deliver-initial-prompt.ts` (kept for any node-pty manual session; no longer on the worker path).

---

## Phase 0 — Spikes (RESOLVED 2026-05-30)

Phase 0 is complete. Verified mechanics (also recorded in the design note):

- **Auth/config: reuse the shadow pattern — DO NOT set `CLAUDE_CONFIG_DIR`.** The
  shadow gets auth by inheriting `HOME` (so claude finds real `~/.claude` creds) and
  never relocating the config dir. A spike that set `CLAUDE_CONFIG_DIR=<empty private
  dir>` **broke auth** (claude found no credentials and did not start). Decision:
  worker env inherits `HOME` (already provided by `buildSpawnEnv`); `CLAUDE_CONFIG_DIR`
  is left untouched. This is the previously-shipped pattern (`bc8d794`, shadow).
- **Worker hooks (can't use a private cwd): `claude --settings <private-file>`.** The
  shadow installs hooks via a project-local `.claude/settings.local.json` in its
  *private* cwd. A worker's cwd must be the user's workspace, so that trick would
  pollute the repo. Confirmed via `claude --help`: `--settings <file-or-json>` —
  "load **additional** settings" — layers our hook config on top of real `~/.claude`
  without touching the repo or auth. Worker spawn writes the hook JSON to a daemon-
  private file and adds `--settings <that file>` to the claude command.
- **Output capture: `tmux pipe-pane` — VERIFIED working.** `tmux pipe-pane -o -t <name>
  'cat >> <file>'` streams raw pane bytes to a file (spike confirmed). The daemon tails
  that file into the output store.
- **`tmux -e KEY=VAL` env injection — VERIFIED supported** (tmux 3.4). Used by
  `newSession` to pass the worker's sanitized env.
- **Spike caveat:** claude could not be rendered inside a tmux session spawned from the
  Claude Code Bash tool (blank pane for *both* plain claude and `--settings`; a
  TERM/TTY artifact of the spike harness, not a claude/`--settings` problem — the
  production daemon spawns claude in tmux successfully). Therefore **hook-firing via
  `--settings` is validated at the first real worker spawn** (Task 3.1's live check /
  Phase 5.3 E2E), not by a standalone spike.

No Phase 0 code tasks remain. Proceed to Phase 1.

---

## Phase 1 — Extract shared tmux primitives

Pull the tmux runner + helpers out of `shadow-session.ts` so the worker reuses identical, tested primitives. No behavior change to the shadow.

### Task 1.1: Create the shared tmux runner module

**Files:**
- Create: `apps/daemon/src/tmux/runner.ts`
- Test: `apps/daemon/src/tmux/runner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";
import { capturePane, paste, sendEnter, killSession, type TmuxRunner } from "./runner.js";

function fakeRunner(stdout = ""): TmuxRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: vi.fn(async (args: string[]) => { calls.push(args); return { stdout, stderr: "", code: 0 }; }),
  } as TmuxRunner & { calls: string[][] };
}

describe("tmux runner helpers", () => {
  it("capturePane returns pane stdout", async () => {
    const r = fakeRunner("❯ idle");
    expect(await capturePane(r, "sess")).toBe("❯ idle");
    expect(r.calls[0]).toEqual(["capture-pane", "-t", "sess", "-p"]);
  });

  it("paste loads a buffer then bracketed-pastes it", async () => {
    const r = fakeRunner();
    await paste(r, "sess", "buf", "multi\nline");
    expect(r.calls[0]).toEqual(["load-buffer", "-b", "buf", "-"]);
    expect(r.calls[1]).toEqual(["paste-buffer", "-b", "buf", "-t", "sess", "-d", "-p"]);
  });

  it("sendEnter sends an Enter key", async () => {
    const r = fakeRunner();
    await sendEnter(r, "sess");
    expect(r.calls[0]).toEqual(["send-keys", "-t", "sess", "Enter"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/tmux/runner.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the runner module**

```typescript
import { execFile } from "node:child_process";

export interface TmuxRunner {
  run(args: string[], input?: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export function defaultTmuxRunner(): TmuxRunner {
  return {
    run: (args, input) =>
      new Promise((resolve) => {
        const cp = execFile("tmux", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code : (err ? 1 : 0);
          resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code });
        });
        if (input !== undefined) { try { cp.stdin?.end(input); } catch { /* ignore */ } }
      }),
  };
}

export async function newSession(
  r: TmuxRunner,
  name: string,
  cwd: string,
  command: string,
  env: Record<string, string> = {}
): Promise<{ code: number }> {
  // tmux 3.0+: -e KEY=VAL sets the spawned process env without leaking into the server.
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  await r.run(["kill-session", "-t", name]); // idempotent
  const res = await r.run(["new-session", "-d", "-s", name, "-x", "220", "-y", "50", ...envArgs, "-c", cwd, command]);
  return { code: res.code };
}

export async function capturePane(r: TmuxRunner, name: string): Promise<string> {
  return (await r.run(["capture-pane", "-t", name, "-p"])).stdout;
}

export async function paste(r: TmuxRunner, name: string, buf: string, text: string): Promise<void> {
  await r.run(["load-buffer", "-b", buf, "-"], text);
  await r.run(["paste-buffer", "-b", buf, "-t", name, "-d", "-p"]);
}

export async function sendEnter(r: TmuxRunner, name: string): Promise<void> {
  await r.run(["send-keys", "-t", name, "Enter"]);
}

export async function pipePaneToFile(r: TmuxRunner, name: string, filePath: string): Promise<void> {
  await r.run(["pipe-pane", "-o", "-t", name, `cat >> ${JSON.stringify(filePath)}`]);
}

export async function killSession(r: TmuxRunner, name: string): Promise<void> {
  await r.run(["kill-session", "-t", name]);
}

export async function hasSession(r: TmuxRunner, name: string): Promise<boolean> {
  return (await r.run(["has-session", "-t", name])).code === 0;
}

export async function listOrcaSessions(r: TmuxRunner, prefix: string): Promise<string[]> {
  const out = await r.run(["list-sessions", "-F", "#{session_name}"]);
  if (out.code !== 0) return [];
  return out.stdout.split("\n").map((s) => s.trim()).filter((s) => s.startsWith(prefix));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/tmux/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/tmux/runner.ts apps/daemon/src/tmux/runner.test.ts
git commit -m "feat(daemon): shared tmux runner + helpers"
```

### Task 1.2: Refactor ShadowSessionManager onto the shared runner

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/shadow-session.ts`

- [ ] **Step 1: Replace the inline runner + tmux calls**

In `shadow-session.ts`: delete the local `TmuxRunner` interface and `defaultTmuxRunner`; import from `../tmux/runner.js`. Replace the inline tmux invocations with the helpers:
- `spawn`: `await newSession(this.tmux, name, dir, bin)` (the shadow passes no extra env today — keep that).
- `startup`: `const pane = await capturePane(this.tmux, name);` and `await sendEnter(this.tmux, name);`.
- `askOnce`: `await paste(this.tmux, session.name, buf, text); await sendEnter(this.tmux, session.name);`.
- `terminate`: `await killSession(this.tmux, session.name);`.

Keep `ShadowSessionDeps.tmux?: TmuxRunner` (now imported type).

- [ ] **Step 2: Run the shadow suite to verify no behavior change**

Run: `pnpm --filter @orca/daemon exec vitest run src/orchestrator-llm/shadow-session`
Expected: PASS (14 tests). If a test asserted exact arg arrays via the old inline path, update it to the helper arg arrays (identical contents).

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/shadow-session.ts
git commit -m "refactor(daemon): shadow session uses shared tmux runner"
```

---

## Phase 2 — Worker Stop-hook wiring

Give worker sessions a Stop hook that feeds the existing judging path.

### Task 2.1: buildAgentHookSettings

**Files:**
- Create: `apps/daemon/src/agent-hooks/hook-settings.ts`
- Test: `apps/daemon/src/agent-hooks/hook-settings.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { agentHookUrl, buildAgentHookSettings } from "./hook-settings.js";

describe("agent hook settings", () => {
  it("builds a session-scoped Stop hook URL", () => {
    expect(agentHookUrl(8787, "sess-1", false)).toBe(
      "http://127.0.0.1:8787/v1/agent-hooks/stop?sessionId=sess-1"
    );
    expect(agentHookUrl(8787, "sess-1", true)).toBe(
      "http://127.0.0.1:8787/v1/agent-hooks/stop?sessionId=sess-1&failure=1"
    );
  });

  it("embeds Stop + StopFailure http hooks with bearer auth", () => {
    const s = buildAgentHookSettings({ sessionId: "sess-1", port: 8787, authToken: "tok" });
    expect(s.hooks.Stop[0]!.hooks[0]!.headers).toEqual({ Authorization: "Bearer tok" });
    expect(s.hooks.Stop[0]!.hooks[0]!.url).toContain("sessionId=sess-1");
    expect(s.hooks.StopFailure[0]!.hooks[0]!.url).toContain("failure=1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/agent-hooks/hook-settings.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement (mirrors `orchestrator-llm/shadow-hook-settings.ts`)**

```typescript
export function agentHookUrl(port: number, sessionId: string, failure = false): string {
  const base = `http://127.0.0.1:${port}/v1/agent-hooks/stop?sessionId=${encodeURIComponent(sessionId)}`;
  return failure ? `${base}&failure=1` : base;
}

interface HttpHook { type: "http"; url: string; headers: Record<string, string>; }

export interface AgentHookSettings {
  hooks: {
    Stop: Array<{ hooks: HttpHook[] }>;
    StopFailure: Array<{ hooks: HttpHook[] }>;
  };
}

export function buildAgentHookSettings(args: {
  sessionId: string;
  port: number;
  authToken: string;
}): AgentHookSettings {
  const headers = { Authorization: `Bearer ${args.authToken}` };
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "http", url: agentHookUrl(args.port, args.sessionId, false), headers }] }],
      StopFailure: [{ hooks: [{ type: "http", url: agentHookUrl(args.port, args.sessionId, true), headers }] }],
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/agent-hooks/hook-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/agent-hooks/hook-settings.ts apps/daemon/src/agent-hooks/hook-settings.test.ts
git commit -m "feat(daemon): worker agent Stop-hook settings builder"
```

### Task 2.2: Add the /v1/agent-hooks/stop route

**Files:**
- Modify: `apps/daemon/src/agent-hooks/routes.ts`
- Test: `apps/daemon/src/agent-hooks/routes.test.ts`

- [ ] **Step 1: Write the failing test** (append to existing test file)

```typescript
it("POST /v1/agent-hooks/stop maps last_assistant_message to a response-done call", async () => {
  const calls: AgentResponseDonePayload[] = [];
  const server = Fastify();
  registerAgentHookRoutes(server, {
    onResponseDone: async (p) => { calls.push(p); },
    resolveAdapterForSession: () => "claude-code",
  });
  const res = await server.inject({
    method: "POST",
    url: "/v1/agent-hooks/stop?sessionId=sess-1",
    payload: { last_assistant_message: "all done" },
  });
  expect(res.statusCode).toBe(200);
  expect(calls[0]).toMatchObject({ sessionId: "sess-1", adapterId: "claude-code", responseText: "all done" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/agent-hooks/routes.test.ts`
Expected: FAIL (route 404 / dep not accepted).

- [ ] **Step 3: Implement the route**

In `routes.ts`, extend `AgentHookRouteDeps` and add the route:

```typescript
export interface AgentHookRouteDeps {
  onResponseDone(payload: AgentResponseDonePayload): Promise<void>;
  // Resolve the adapter id for a session (DB lookup in prod); used to tag the response.
  resolveAdapterForSession(sessionId: string): string;
}

// inside registerAgentHookRoutes:
server.post("/v1/agent-hooks/stop", async (request, reply) => {
  const { sessionId, failure } = request.query as { sessionId?: string; failure?: string };
  if (!sessionId) { reply.status(400); return { error: { code: "missing_session" } }; }
  if (failure === "1") { reply.status(200); return { ok: true }; } // StopFailure: no response to judge
  const body = (request.body ?? {}) as { last_assistant_message?: string };
  await deps.onResponseDone({
    sessionId,
    adapterId: deps.resolveAdapterForSession(sessionId),
    responseText: body.last_assistant_message ?? "",
  });
  return { ok: true };
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/agent-hooks/routes.test.ts`
Expected: PASS. (Update the existing `registerAgentHookRoutes` call sites/tests to pass `resolveAdapterForSession`.)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/agent-hooks/routes.ts apps/daemon/src/agent-hooks/routes.test.ts
git commit -m "feat(daemon): /v1/agent-hooks/stop maps Stop hook to response-done"
```

---

## Phase 3 — WorkerSessionManager (tmux lifecycle + output capture)

### Task 3.1: Spawn a worker tmux session with private hook settings + output pipe

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/worker-session.ts`
- Test: `apps/daemon/src/workflows/orchestrator/worker-session.test.ts`

- [ ] **Step 1: Write the failing test (spawn writes private settings, starts tmux, pipes output)**

```typescript
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerSessionManager } from "./worker-session.js";
import type { TmuxRunner } from "../../tmux/runner.js";

function fakeTmux(paneByCall: string[] = []): TmuxRunner & { calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  return {
    calls,
    run: vi.fn(async (args: string[]) => {
      calls.push(args);
      const stdout = args[0] === "capture-pane" ? (paneByCall[Math.min(i++, paneByCall.length - 1)] ?? "") : "";
      return { stdout, stderr: "", code: 0 };
    }),
  } as TmuxRunner & { calls: string[][] };
}

describe("WorkerSessionManager.spawn", () => {
  it("writes hook settings to a private dir and starts tmux in the workspace", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const tmux = fakeTmux(["auto mode on"]);
    const mgr = new WorkerSessionManager({
      privateRoot, daemonPort: 8787, authToken: "tok",
      claudeBin: "claude", tmux, captureSink: () => {}, startupTimeoutMs: 50, pollMs: 1, readyQuietMs: 0,
    });
    await mgr.spawn({ sessionId: "sess-1", workspacePath: "/repo", command: "claude", env: {} });
    // private settings written, NOT under /repo
    expect(existsSync(join(privateRoot, "sess-1", "settings.json"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(privateRoot, "sess-1", "settings.json"), "utf8"));
    expect(settings.hooks.Stop[0].hooks[0].url).toContain("sessionId=sess-1");
    // new-session used the workspace cwd and layered hooks via --settings (NOT CLAUDE_CONFIG_DIR)
    const newSess = tmux.calls.find((c) => c[0] === "new-session")!;
    expect(newSess).toContain("/repo");
    expect(newSess.join(" ")).toContain("--settings");
    expect(newSess.join(" ")).toContain(join(privateRoot, "sess-1", "settings.json"));
    expect(newSess.join(" ")).not.toContain("CLAUDE_CONFIG_DIR");
    // output pipe established
    expect(tmux.calls.some((c) => c[0] === "pipe-pane")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/worker-session.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement spawn**

```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultTmuxRunner, newSession, capturePane, paste, sendEnter, pipePaneToFile, killSession,
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
  env: Record<string, string>; // adapter env (already secret-sanitized by buildSpawnEnv)
}

export interface WorkerSessionDeps {
  privateRoot: string;        // daemon-private dir, e.g. <dataDir>/workers
  daemonPort: number;
  authToken: string;
  claudeBin: string;
  tmux?: TmuxRunner;
  // Appends decoded pane bytes for a session to the output store.
  captureSink: (sessionId: string, chunk: Buffer) => void;
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
    // private-hook-install mechanism verified in Task 0.1 (CLAUDE_CONFIG_DIR):
    writeFileSync(
      join(cfgDir, "settings.json"),
      JSON.stringify(buildAgentHookSettings({ sessionId: input.sessionId, port: this.deps.daemonPort, authToken: this.deps.authToken }), null, 2),
      "utf8",
    );
    const name = this.name(input.sessionId);
    // Auth: inherit input.env (carries HOME from buildSpawnEnv) → real ~/.claude creds.
    // Do NOT set CLAUDE_CONFIG_DIR (it relocates config and breaks auth).
    // Hooks: layer our private settings file via --settings (repo-safe; workspace cwd untouched).
    const settingsPath = join(cfgDir, "settings.json");
    const command = `${input.command} --settings ${JSON.stringify(settingsPath)}`;
    await newSession(this.tmux, name, input.workspacePath, command, input.env);
    // Output capture sink verified in Task 0.2; pipe to a private file, daemon tails it.
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

  // startTail: fs.watch(file) -> read appended bytes -> this.deps.captureSink(sessionId, chunk).
  // Implemented in Task 3.2.
  private startTail(_sessionId: string, _file: string): void { /* Task 3.2 */ }

  async terminate(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    await killSession(this.tmux, s.name);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/worker-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/worker-session.ts apps/daemon/src/workflows/orchestrator/worker-session.test.ts
git commit -m "feat(daemon): WorkerSessionManager spawn (tmux + private hooks)"
```

### Task 3.2: Tail the pipe-pane file into the output store

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/worker-session.ts`
- Test: `apps/daemon/src/workflows/orchestrator/worker-session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("tails appended pane bytes into the capture sink", async () => {
  const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
  const chunks: string[] = [];
  const mgr = new WorkerSessionManager({
    privateRoot, daemonPort: 8787, authToken: "tok", claudeBin: "claude",
    tmux: fakeTmux(["auto mode on"]),
    captureSink: (_sid, buf) => void chunks.push(buf.toString("utf8")),
    startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
  });
  await mgr.spawn({ sessionId: "sess-1", workspacePath: "/repo", command: "claude", env: {} });
  const paneFile = join(privateRoot, "sess-1", "pane.out");
  appendFileSync(paneFile, "hello-pane");
  await new Promise((r) => setTimeout(r, 50));
  expect(chunks.join("")).toContain("hello-pane");
  await mgr.terminate("sess-1");
});
```
(Add `appendFileSync` to the node:fs import in the test.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/worker-session.test.ts -t "tails appended"`
Expected: FAIL (sink never called).

- [ ] **Step 3: Implement startTail + close watcher in terminate**

```typescript
import { watch, openSync, readSync, closeSync, type FSWatcher } from "node:fs";

// field: private readonly tails = new Map<string, { watcher: FSWatcher; fd: number; pos: number }>();

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
  this.tails.set(sessionId, { watcher, fd, pos });
}
```
In `terminate`, before `killSession`: `const t = this.tails.get(sessionId); if (t) { t.watcher.close(); closeSync(t.fd); this.tails.delete(sessionId); }`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/worker-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/worker-session.ts apps/daemon/src/workflows/orchestrator/worker-session.test.ts
git commit -m "feat(daemon): stream worker pane output into the capture sink"
```

---

## Phase 4 — Reliable delivery (initial + forward + revise)

### Task 4.1: deliver() — idle-gated, paste-safe submit with confirm

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/worker-session.ts`
- Test: `apps/daemon/src/workflows/orchestrator/worker-session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("deliver waits for an idle prompt, then pastes + submits", async () => {
  // capture-pane: busy (spinner) twice, then idle prompt.
  const tmux = fakeTmux(["auto mode on", "esc to interrupt", "esc to interrupt", "❯ "]);
  const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
  const mgr = new WorkerSessionManager({
    privateRoot, daemonPort: 8787, authToken: "tok", claudeBin: "claude", tmux,
    captureSink: () => {}, startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
    idleQuietMs: 0, postPasteMs: 0, idleTimeoutMs: 50,
  });
  await mgr.spawn({ sessionId: "sess-1", workspacePath: "/repo", command: "claude", env: {} });
  const result = await mgr.deliver("sess-1", "do the thing\nplease");
  expect(result).toBe("delivered");
  const order = tmux.calls.map((c) => c[0]);
  expect(order).toContain("load-buffer");
  expect(order).toContain("paste-buffer");
  // an Enter was sent after the paste
  const pasteIdx = order.indexOf("paste-buffer");
  expect(order.slice(pasteIdx).includes("send-keys")).toBe(true);
});

it("deliver returns no_session for an unknown session", async () => {
  const mgr = new WorkerSessionManager({
    privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
    daemonPort: 8787, authToken: "tok", claudeBin: "claude", tmux: fakeTmux(), captureSink: () => {},
  });
  expect(await mgr.deliver("nope", "x")).toBe("no_session");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/worker-session.test.ts -t deliver`
Expected: FAIL (`deliver` not a function).

- [ ] **Step 3: Implement deliver (deterministic idle detection via capture-pane)**

```typescript
const BUSY_DEFAULT = /esc to interrupt|\bthinking\b|running .* hook|cooked for|churned for/i;
const PROMPT_IDLE = /\n\s*❯\s*$|❯\s+$/;

export type DeliverResult = "delivered" | "no_session" | "timeout";

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
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/worker-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/worker-session.ts apps/daemon/src/workflows/orchestrator/worker-session.test.ts
git commit -m "feat(daemon): worker deliver() — idle-gated paste-safe submit"
```

---

## Phase 5 — Cut worker dispatch over to tmux

### Task 5.1: Construct + wire WorkerSessionManager in the server

**Files:**
- Modify: `apps/daemon/src/server.ts`

- [ ] **Step 1: Construct the manager and wire the capture sink + hook adapter resolver**

After `sessionOutputStore`/`sessionRuntime` exist:

```typescript
const workerSessions = new WorkerSessionManager({
  privateRoot: path.join(config.dataDir, "workers"),
  daemonPort: 0, // set after listen, like the shadow (see setDaemonPort below)
  authToken: config.authToken,
  claudeBin: process.env["ORCA_CLAUDE_CODE_BIN"] ?? "claude",
  captureSink: (sessionId, chunk) => sessionOutputStore.appendChunk(sessionId, chunk),
});
```
- Mirror the existing shadow `setDaemonPort(actualPort)` call after the server binds its port (search `setDaemonPort` in `server.ts`).
- Wire `registerAgentHookRoutes(server, { onResponseDone: (p) => orchestratorService.onAgentResponseDone(db, daemonContext.now, p, { bus: eventBus, idFactory }), resolveAdapterForSession: (sid) => (db.prepare("SELECT adapter_id FROM sessions WHERE id = ?").get(sid) as { adapter_id: string } | undefined)?.adapter_id ?? "claude-code" })`.

Note: confirm `sessionOutputStore` exposes an append method usable by the sink; if the only entry point is the runtime's `broadcastOutput`, add a thin `appendChunk(sessionId, chunk)` to `output-store.ts` that performs the same persist (without a pty) and reuse it. (Check `output-store.ts` for the existing append path before adding.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @orca/daemon exec tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/sessions/output-store.ts
git commit -m "feat(daemon): wire WorkerSessionManager + agent stop-hook route"
```

### Task 5.2: Route spawnStepAgent + forward/revise through the worker manager

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Modify: `apps/daemon/src/server.ts`
- Test: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts`

- [ ] **Step 1: Add worker capabilities to OrchestratorService**

Add two constructor deps (replacing the node-pty `agentInput` + `deliverInitialPrompt` for the worker path):
```typescript
private readonly workerSpawn?: (input: { sessionId: string; workspacePath: string; command: string; env: Record<string,string> }) => Promise<void>,
private readonly workerDeliver?: (sessionId: string, text: string) => Promise<void>,
```
In `spawnStepAgent`: after creating the session row (still via the launcher's `createSession` for the DB row + workspace resolution — keep `ProductionWorkflowSessionLauncher` ONLY for row creation, or factor a small `createWorkerSessionRow` helper), call `await this.workerSpawn?.({ sessionId, workspacePath, command: spawnResult.command, env: spawnResult.env })` then `await this.workerDeliver?.(sessionId, objective)`.
In `applyOrchestratorAction`: replace `this.agentInput(sessionId, action.translated + "\n")` with `await this.workerDeliver?.(sessionId, action.translated)` and the revise branch `action.feedback` likewise (no trailing `"\n"` — `deliver` submits via Enter).

- [ ] **Step 2: Update the agent-step tests**

The existing forward/revise tests assert `agentInput` calls; switch the spy to `workerDeliver` and assert it receives the translated/feedback text (no trailing newline). Keep the "no session ⇒ ack" behavior: `workerDeliver` returning `"no_session"` drives the same acknowledgment path from `onUserMessage`.

```typescript
const deliver = vi.fn(async (_sid: string, _text: string) => {});
const service = makeJudgeService(fakeMediator({ kind: "forward_to_agent", translated: "please add tests" }), deliver);
// ...
expect(deliver).toHaveBeenCalledWith("sess-judge", "please add tests");
```

- [ ] **Step 3: Wire the real worker capabilities in server.ts**

```typescript
// in the OrchestratorService construction:
(input) => workerSessions.spawn(input),
(sessionId, text) => workerSessions.deliver(sessionId, text).then((r) => {
  if (r !== "delivered") console.warn(`[orchestrator] worker deliver ${r} for ${sessionId}`);
}),
```
Terminate the worker tmux session on step completion / terminal run events (find where the launcher session is currently terminated — `terminate` in `applyOrchestratorAction` approve path / `onWorkflowSessionCompleted` — and add `workerSessions.terminate(sessionId)`).

- [ ] **Step 4: Run the orchestrator + server suites**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator src/server.test.ts`
Expected: PASS (update any launcher-path assertions that no longer apply).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/server.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(daemon): dispatch worker steps via tmux WorkerSessionManager"
```

### Task 5.3: Manual end-to-end verification

- [ ] **Step 1: Run the app, create a goal, say "go"**

Use the `run` skill (or the existing dev daemon). Create a goal, let the orchestrator dispatch the step agent.

- [ ] **Step 2: Confirm the worker submits and works**

```bash
# Worker tmux session exists and is working in the workspace:
tmux list-sessions | grep orca-worker
# DB: session running, output chunks growing, no daemon_restart loop:
sqlite3 ~/.orca/orca.db "SELECT substr(id,1,8), status FROM sessions ORDER BY created_at DESC LIMIT 3;"
```
Expected: a worker submits the objective (no stuck `[Pasted text]`), produces output, and the orchestrator posts a judged reply in chat. Forward a chat message; confirm it submits even if sent while the agent is mid-turn (idle-gate handles it).

- [ ] **Step 3: Commit any fixes found**

---

## Phase 6 — Reattach surviving tmux workers on restart

### Task 6.1: On boot, reattach instead of respawn

**Files:**
- Modify: the boot-resume path in `apps/daemon/src/server.ts` (`resumeActiveRuns` / `reconcileSessionsOnBoot`).
- Modify: `apps/daemon/src/workflows/orchestrator/worker-session.ts` (add `reattach`).
- Test: `apps/daemon/src/workflows/orchestrator/worker-session.test.ts`

- [ ] **Step 1: Write the failing test for reattach**

```typescript
it("reattach adopts a surviving tmux session without re-spawning", async () => {
  const tmux = fakeTmux(["auto mode on"]); // has-session returns code 0 in fakeTmux
  const mgr = new WorkerSessionManager({
    privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
    daemonPort: 8787, authToken: "tok", claudeBin: "claude", tmux, captureSink: () => {},
    startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
  });
  const adopted = await mgr.reattach("sess-1", "/repo");
  expect(adopted).toBe(true);
  expect(tmux.calls.some((c) => c[0] === "new-session")).toBe(false); // did NOT respawn
  expect(tmux.calls.some((c) => c[0] === "pipe-pane")).toBe(true);     // re-established output pipe
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/worker-session.test.ts -t reattach`
Expected: FAIL.

- [ ] **Step 3: Implement reattach**

```typescript
async reattach(sessionId: string, _workspacePath: string): Promise<boolean> {
  if (this.sessions.has(sessionId)) return true;
  const name = this.name(sessionId);
  if (!(await hasSession(this.tmux, name))) return false;
  const cfgDir = join(this.deps.privateRoot, sessionId);
  await pipePaneToFile(this.tmux, name, join(cfgDir, "pane.out"));
  this.startTail(sessionId, join(cfgDir, "pane.out"));
  this.sessions.set(sessionId, { name, ready: Promise.resolve() });
  return true;
}
```
(Import `hasSession` from the runner.)

- [ ] **Step 4: Wire into boot-resume**

In `resumeActiveRuns.respawn` (server.ts), first try `if (await workerSessions.reattach(sessionId, workspacePath)) { mark session running; skip respawn; }`. Only if reattach returns false, fall through to `respawnStepAgent`. Update `reconcileSessionsOnBoot` so a session whose tmux session still exists is NOT marked terminal.

- [ ] **Step 5: Run + commit**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator`
```bash
git add apps/daemon/src/workflows/orchestrator/worker-session.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): reattach surviving tmux workers across daemon restart"
```

---

## Phase 7 — Remove the Sessions panel from Goal Details

### Task 7.1: Remove SessionsPanel from GoalDetailView

**Files:**
- Modify: `apps/desktop/src/goal-detail/GoalDetailView.tsx`
- Test: `apps/desktop/src/goal-detail/GoalDetailView.test.tsx`

- [ ] **Step 1: Update the view test**

Assert the goal detail view no longer renders the Sessions section:
```typescript
it("does not render the Sessions panel", () => {
  render(<GoalDetailView goalId="g1" onBack={() => {}} refreshKey={0} />);
  expect(screen.queryByRole("region", { name: /sessions/i })).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/desktop exec vitest run src/goal-detail/GoalDetailView.test.tsx -t "Sessions panel"`
Expected: FAIL (panel still present).

- [ ] **Step 3: Remove the panel**

Delete the `<SessionsPanel ... />` block (`GoalDetailView.tsx:403-410`) and its now-unused import + any props/state only it used (`sessionsRefreshKey`, `createSessionPrefill` wiring) flagged by the compiler. Leave `SessionsPanel`, `SessionTerminalView`, `useSessionStream`, `CreateSessionDialog` files in place (dormant — reused by the future read-only debug drawer, L370) unless the compiler shows they are now wholly unreferenced AND you choose to delete them; default is keep dormant.

- [ ] **Step 4: Run desktop typecheck + tests**

Run: `pnpm --filter @orca/desktop exec tsc --noEmit && pnpm --filter @orca/desktop exec vitest run src/goal-detail`
Expected: EXIT 0 / PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/goal-detail/GoalDetailView.tsx apps/desktop/src/goal-detail/GoalDetailView.test.tsx
git commit -m "feat(desktop): remove Sessions panel from Goal Details"
```

---

## Final verification

- [ ] **Full suites green**

Run: `pnpm --filter @orca/daemon exec vitest run && pnpm --filter @orca/desktop exec vitest run && pnpm --filter @orca/contracts exec vitest run`
Expected: all PASS.

- [ ] **Typecheck all**

Run: `pnpm --filter @orca/daemon exec tsc --noEmit && pnpm --filter @orca/desktop exec tsc --noEmit`
Expected: EXIT 0.

- [ ] **Manual smoke (Phase 5.3) re-run** to confirm a real worker submits, judges, and a forwarded mid-turn message lands.

---

## Self-review notes (open items for the implementer)

- **Phase 0 resolved.** Hook install is `claude --settings <private-file>` with `HOME` inherited (no `CLAUDE_CONFIG_DIR`). Hook-firing is confirmed at the first real worker spawn (Task 3.1 live check / Phase 5.3), since claude won't render in the standalone spike harness.
- **`one_shot` steps** (skill/model steps that don't spawn an agent) are unaffected — they never hit `spawnStepAgent`'s worker path.
- **Secret env:** `buildSpawnEnv` already strips secrets; `WorkerSpawnInput.env` carries that sanitized env. Do NOT add the daemon auth token to the worker env — it travels only in the hook header (`buildAgentHookSettings`).
- **Idle heuristics** (`BUSY_DEFAULT`/`PROMPT_IDLE`) are now backed by `capture-pane` (real screen) — tune the regexes against live output in Phase 5.3 if a state is misread; this is deterministic capture, not stream-quiescence guessing.
