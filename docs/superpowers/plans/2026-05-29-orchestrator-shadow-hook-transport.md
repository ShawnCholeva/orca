# Orchestrator Shadow-Session Hook Transport — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken stdout-scraping orchestrator transport with Stop/StopFailure-hook capture against a persistent interactive `claude` session per goal, and make the chat reply sync (one_shot providers) or async (shadow_session) based on the orchestrator adapter's execution mode.

**Architecture:** Each goal gets a persistent interactive `claude` PTY in a daemon-private dir (`~/.orca/shadow/<goalId>/`) whose `.claude/settings.local.json` installs `Stop`+`StopFailure` hooks that POST `/v1/orchestrator-hooks/stop?goalId=…`. `ask()` writes `prompt+\r` and registers a pending resolver; the hook POST delivers `last_assistant_message`, from which `extractActionBlock` pulls the JSON action and resolves the resolver. The chat usecase picks sync vs async from `resolveMode(orchestratorAdapter)`.

**Tech Stack:** TypeScript, Node, node-pty (`PtyManager`), fastify, better-sqlite3, zod, vitest. Claude Code CLI (interactive, subscription auth).

**Spec:** `docs/superpowers/specs/2026-05-29-orchestrator-shadow-hook-transport-design.md`. Read it.

---

## Background: what's there now (read first)

The current `apps/daemon/src/orchestrator-llm/shadow-session.ts` spawns claude and `ask()` **polls the PTY stdout buffer** for an `orca:action` fence — this does not work against an interactive TUI (it emits ANSI, not JSON) and hangs 60s. Verified facts from spikes (2026-05-29):

- `CLAUDE_CONFIG_DIR` relocation **loses login** → use default `~/.claude` auth + a project `.claude/settings.local.json` for the hook.
- A `Stop` hook fires in interactive mode; its POST body (when using a `command` hook that reads stdin) is exactly:
  `{"session_id":"…","transcript_path":"…","cwd":"…","permission_mode":"auto","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"<the reply text>", …}`
- Driving the PTY: write `prompt` then `\r` submits; the folder-trust prompt is answered with `\r`.
- `StopFailure` is a real event. A native `http` hook type exists.

Reusable, unchanged: `sentinel.ts` (`extractActionBlock`, `SENTINEL_INSTRUCTION`), `shadow-llm-client.ts`, `mediator.ts`, `prompts.ts`, `build-context.ts`.

Existing facts the plan relies on (verified):
- `AdapterDispatcher.resolveMode(adapterId)` → `{adapterId, mode, fallbacks}`; `getAdapterExecutionModeConfig(db, adapterId)` reads `adapter_execution_modes`. claude-code seed = `shadow_session` preferred.
- Provider→adapter: `orca/anthropic` → `claude-code` (used in `orchestration-transport/hidden-worker/hooks.ts:113`).
- `daemonContext.stepDispatchCapabilities.resolveMode(adapterId)` is available in `server.ts`.
- Daemon port is dynamic in dev; get the bound port via `server.server.address()` after `listen`.
- `insertMessageWithEvent(ctx, {...})` in `orchestrator-chat/usecases.ts` inserts an `orchestrator_messages` row + publishes `orchestrator.message.created` (drives the desktop SSE refresh).
- `FakePtyManager` (`apps/daemon/src/pty/fake.ts`) exposes `handles: PtyHandle[]` and `controlFakePty(handle)` → `{emitData(Buffer), writtenChunks, isDead}`.

---

### Task 1: Hook-settings builder + verify hook payload mechanism

**Files:**
- Create: `apps/daemon/src/orchestrator-llm/shadow-hook-settings.ts`
- Test: `apps/daemon/src/orchestrator-llm/shadow-hook-settings.test.ts`

- [ ] **Step 1: Verify the hook mechanism (one-time spike, no code committed)**

Run this to confirm which hook type delivers the payload, before choosing `http` vs `command`:

```bash
WS=$(mktemp -d); mkdir -p "$WS/.claude"
cat > "$WS/.claude/stop.sh" <<'EOF'
#!/usr/bin/env bash
cat > /tmp/orca-hook-verify.json
EOF
chmod +x "$WS/.claude/stop.sh"
cat > "$WS/.claude/settings.local.json" <<EOF
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "$WS/.claude/stop.sh" } ] } ] } }
EOF
( cd "$WS" && timeout 90 claude -p "reply with exactly: VERIFY_OK" --output-format json </dev/null )
echo "--- hook payload ---"; cat /tmp/orca-hook-verify.json
```
Expected: payload JSON contains `session_id` and `last_assistant_message:"VERIFY_OK"`. This confirms the `command`-hook contract. (The spec prefers the native `http` hook; if you can confirm `http` POSTs the same JSON body, use it. If unsure, **use the `command` hook** — it is verified — with a tiny bundled poster script. This task's builder supports `command`.)

- [ ] **Step 2: Write the failing test**

```ts
// apps/daemon/src/orchestrator-llm/shadow-hook-settings.test.ts
import { describe, it, expect } from "vitest";
import { buildShadowHookSettings, shadowHookUrl } from "./shadow-hook-settings.js";

describe("shadow hook settings", () => {
  it("builds a Stop + StopFailure http hook config with goalId and port in the URL", () => {
    const cfg = buildShadowHookSettings({ goalId: "G1", port: 8787 });
    const stopUrl = cfg.hooks.Stop[0].hooks[0].url as string;
    const failUrl = cfg.hooks.StopFailure[0].hooks[0].url as string;
    expect(cfg.hooks.Stop[0].hooks[0].type).toBe("http");
    expect(stopUrl).toBe("http://127.0.0.1:8787/v1/orchestrator-hooks/stop?goalId=G1");
    expect(failUrl).toBe("http://127.0.0.1:8787/v1/orchestrator-hooks/stop?goalId=G1&failure=1");
  });

  it("shadowHookUrl encodes the goalId", () => {
    expect(shadowHookUrl(8787, "a/b")).toBe("http://127.0.0.1:8787/v1/orchestrator-hooks/stop?goalId=a%2Fb");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- shadow-hook-settings`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// apps/daemon/src/orchestrator-llm/shadow-hook-settings.ts
export function shadowHookUrl(port: number, goalId: string, failure = false): string {
  const base = `http://127.0.0.1:${port}/v1/orchestrator-hooks/stop?goalId=${encodeURIComponent(goalId)}`;
  return failure ? `${base}&failure=1` : base;
}

export interface ShadowHookSettings {
  hooks: {
    Stop: Array<{ hooks: Array<{ type: "http"; url: string }> }>;
    StopFailure: Array<{ hooks: Array<{ type: "http"; url: string }> }>;
  };
}

export function buildShadowHookSettings(args: { goalId: string; port: number }): ShadowHookSettings {
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "http", url: shadowHookUrl(args.port, args.goalId, false) }] }],
      StopFailure: [{ hooks: [{ type: "http", url: shadowHookUrl(args.port, args.goalId, true) }] }],
    },
  };
}
```

> If Step 1 showed `http` does NOT deliver the body, change the hook entries to `{ type: "command", command: "<node poster> <url>" }` and add a tiny `shadow-hook-poster.mjs` that reads stdin and POSTs it. Keep `shadowHookUrl` unchanged.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- shadow-hook-settings`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/shadow-hook-settings.ts apps/daemon/src/orchestrator-llm/shadow-hook-settings.test.ts
git commit -m "feat(daemon): shadow hook settings builder (Stop/StopFailure -> daemon)"
```

---

### Task 2: Rewrite ShadowSessionManager — pending-resolver ask + resolvePending

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/shadow-session.ts`
- Test: `apps/daemon/src/orchestrator-llm/shadow-session.ask.test.ts` (replace stdout-poll tests)

This rips out stdout polling. `ask()` writes `prompt+\r` and returns a promise settled by `resolvePending` (called by the hook endpoint) or a timeout. Keep `spawn`/`terminate`/`has`/output-buffering (still useful for debugging) but the response no longer comes from `output`.

- [ ] **Step 1: Replace the ask test file**

```ts
// apps/daemon/src/orchestrator-llm/shadow-session.ask.test.ts
import { describe, it, expect } from "vitest";
import { FakePtyManager, controlFakePty } from "../pty/fake.js";
import { ShadowSessionManager } from "./shadow-session.js";

function mgr() {
  const pty = new FakePtyManager();
  const m = new ShadowSessionManager({
    ptyManager: pty,
    resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
  });
  return { pty, m };
}

describe("ShadowSessionManager.ask (hook-resolved)", () => {
  it("writes prompt+CR and resolves when resolvePending delivers text", async () => {
    const { pty, m } = mgr();
    await m.spawn("G1");
    const p = m.ask("G1", { systemPrompt: "SYS", userPrompt: "hello", timeoutMs: 1000 });
    // prompt written to the PTY
    const written = controlFakePty(pty.handles[0]).writtenChunks.map((b) => b.toString()).join("");
    expect(written).toContain("hello");
    expect(written).toContain("SYS");
    expect(written).toContain("\r");
    // hook delivers the assistant message containing a fenced action
    m.resolvePending("G1", { text: '```orca:action\n{"kind":"answer_user_directly","body":"hi"}\n```' });
    expect((await p).text).toBe('{"kind":"answer_user_directly","body":"hi"}');
  });

  it("FIFO serializes: second ask waits for first to settle", async () => {
    const { pty, m } = mgr();
    await m.spawn("G1");
    const p1 = m.ask("G1", { systemPrompt: "S", userPrompt: "q1", timeoutMs: 1000 });
    const p2 = m.ask("G1", { systemPrompt: "S", userPrompt: "q2", timeoutMs: 1000 });
    m.resolvePending("G1", { text: '```orca:action\n{"n":1}\n```' });
    expect((await p1).text).toBe('{"n":1}');
    m.resolvePending("G1", { text: '```orca:action\n{"n":2}\n```' });
    expect((await p2).text).toBe('{"n":2}');
  });

  it("rejects on timeout", async () => {
    const { m } = mgr();
    await m.spawn("G1");
    await expect(m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 10 })).rejects.toThrow(/timeout/i);
  });

  it("StopFailure (failure=true) rejects the pending ask", async () => {
    const { m } = mgr();
    await m.spawn("G1");
    const p = m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 1000 });
    m.resolvePending("G1", { failure: true });
    await expect(p).rejects.toThrow(/failure|stopfailure/i);
  });

  it("no parseable action block rejects (caller handles re-prompt/escalate)", async () => {
    const { m } = mgr();
    await m.spawn("G1");
    const p = m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 1000 });
    m.resolvePending("G1", { text: "sorry, no json here" });
    await expect(p).rejects.toThrow(/no .*action|unparse/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- shadow-session.ask`
Expected: FAIL — `resolvePending` not a function / old poll behavior.

- [ ] **Step 3: Rewrite the relevant parts of `shadow-session.ts`**

Add `extractActionBlock` import (already imported). Replace the `Session` interface's poll fields and the `askOnce` poll loop with a pending-resolver model:

```ts
import { extractActionBlock } from "./sentinel.js";

interface Pending {
  resolve: (r: { text: string }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  handle: PtyHandle;
  output: string;          // kept for debugging/tail only
  disposeData: () => void;
  systemSent: boolean;
  queue: Promise<unknown>;
  pending: Pending | null; // the one outstanding ask awaiting a hook
}
```
In `spawn()` initialise: `{ ..., systemSent:false, queue: Promise.resolve(), pending: null }`.

Replace `ask`/`askOnce` with:

```ts
export interface AskInput { systemPrompt: string; userPrompt: string; timeoutMs: number; }

async ask(goalId: string, input: AskInput): Promise<{ text: string }> {
  const run = this.getSession(goalId)?.queue ?? Promise.resolve();
  const next = run.then(() => this.askOnce(goalId, input));
  const session = this.getSession(goalId);
  if (session) session.queue = next.catch(() => undefined);
  return next;
}

private askOnce(goalId: string, input: AskInput): Promise<{ text: string }> {
  const session = this.getSession(goalId);
  if (!session) return Promise.reject(new Error(`no shadow session for goal ${goalId}`));
  const prelude = session.systemSent ? "" : input.systemPrompt + "\n\n";
  session.systemSent = true;
  session.handle.write(Buffer.from(prelude + input.userPrompt + "\r", "utf8"));
  return new Promise<{ text: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending = null;
      reject(new Error(`shadow orchestrator timeout for goal ${goalId}`));
    }, input.timeoutMs);
    session.pending = { resolve, reject, timer };
  });
}

/** Called by the hook endpoint when the goal's shadow session emits Stop/StopFailure. */
resolvePending(goalId: string, result: { text?: string; failure?: boolean }): void {
  const session = this.getSession(goalId);
  const pending = session?.pending;
  if (!session || !pending) return; // stray/duplicate hook -> drop
  clearTimeout(pending.timer);
  session.pending = null;
  if (result.failure) { pending.reject(new Error("shadow orchestrator StopFailure")); return; }
  const block = extractActionBlock(result.text ?? "");
  if (block === null) { pending.reject(new Error("shadow orchestrator: no orca:action block (unparseable)")); return; }
  pending.resolve({ text: block });
}
```
Note `ask`'s auto-spawn (from the prior version) can stay if present; if `getSession` is null, `askOnce` rejects (server ensures spawn before ask in this design). Keep `getSession` accessible to these methods (same class). Remove the old `consumedUpTo`/`pollIntervalMs`/poll-loop code and the `pollIntervalMs` dep field.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- shadow-session`
Expected: PASS (spawn tests + the 5 ask tests). Update/remove the old serial test if it referenced poll timing (`shadow-session.serial.test.ts` — keep the FIFO test, it works with resolvePending: resolve once per outstanding ask).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @orca/daemon exec tsc --noEmit` → clean.
```bash
git add apps/daemon/src/orchestrator-llm/shadow-session.ts apps/daemon/src/orchestrator-llm/shadow-session.ask.test.ts apps/daemon/src/orchestrator-llm/shadow-session.serial.test.ts
git commit -m "feat(daemon): hook-resolved shadow ask (replace stdout polling)"
```

---

### Task 3: Spawn integration — daemon-private dir, hook install, readiness, no-tools, trust

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/shadow-session.ts`
- Test: `apps/daemon/src/orchestrator-llm/shadow-session.spawn.test.ts`

`spawn()` currently calls `deps.resolveSpawn(goalId)`. Extend the manager so production spawning: (a) creates `~/.orca/shadow/<goalId>/.claude/`, (b) writes `settings.local.json` from `buildShadowHookSettings({goalId, port})`, (c) resolves the claude spawn with that dir as cwd, no-tools posture, (d) is gated by a readiness check. Keep `resolveSpawn` injectable for tests (FakePty path).

- [ ] **Step 1: Write the failing test (dir + settings written; readiness gate)**

```ts
// apps/daemon/src/orchestrator-llm/shadow-session.spawn.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePtyManager } from "../pty/fake.js";
import { ShadowSessionManager } from "./shadow-session.js";

describe("ShadowSessionManager spawn integration", () => {
  it("writes .claude/settings.local.json with the hook URL into the goal dir before spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-test-"));
    const pty = new FakePtyManager();
    const m = new ShadowSessionManager({
      ptyManager: pty,
      shadowRoot: root,
      daemonPort: 8787,
      isReady: async () => true,
      resolveSpawnCommand: (cwd) => ({ command: "claude", args: [], env: {}, cwd }),
    } as any);
    await m.spawn("G1");
    const settingsPath = join(root, "G1", ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(cfg.hooks.Stop[0].hooks[0].url).toContain("goalId=G1");
  });

  it("readiness gate: spawn rejects when not ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-test-"));
    const pty = new FakePtyManager();
    const m = new ShadowSessionManager({
      ptyManager: pty,
      shadowRoot: root,
      daemonPort: 8787,
      isReady: async () => false,
      resolveSpawnCommand: (cwd) => ({ command: "claude", args: [], env: {}, cwd }),
    } as any);
    await expect(m.spawn("G1")).rejects.toThrow(/not ready|sign in/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- shadow-session.spawn`
Expected: FAIL — new deps/behavior absent.

- [ ] **Step 3: Implement the production spawn deps**

Extend `ShadowSessionDeps` to support production wiring (keep the test `resolveSpawn` form working, OR migrate both tests to the new shape — choose ONE deps shape and update Task 2's test `mgr()` to match). Recommended unified deps:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildShadowHookSettings } from "./shadow-hook-settings.js";

export interface ShadowSessionDeps {
  ptyManager: PtyManager;
  shadowRoot: string;                 // e.g. ~/.orca/shadow
  daemonPort: number;                 // bound port; can be set later via setDaemonPort
  isReady: () => Promise<boolean>;    // ClaudeCodeAdapter.checkAuth().ok in prod; ()=>true in tests
  resolveSpawnCommand: (cwd: string) => { command: string; args: string[]; env: Record<string,string>; cwd: string };
  cols?: number; rows?: number;
}
```
`spawn()`:
```ts
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
    command: cmd.command, args: cmd.args, cwd: cmd.cwd, env: cmd.env,
    cols: this.deps.cols ?? 120, rows: this.deps.rows ?? 40,
  });
  const session: Session = { handle, output: "", disposeData: () => {}, systemSent: false, queue: Promise.resolve(), pending: null };
  session.disposeData = events.onData((chunk) => { session.output += chunk.toString("utf8"); if (session.output.length > 200_000) session.output = session.output.slice(-100_000); });
  events.onExit(() => { this.sessions.delete(goalId); });
  this.sessions.set(goalId, session);
  return shadowSessionId(goalId);
}

setDaemonPort(port: number): void { this.deps.daemonPort = port; }
```

> **Trust/no-tools (verify against Claude Code settings docs at plan execution):** the `settings.local.json` should also disable tool use / set a non-interactive permission posture so the orchestrator session emits text without permission prompts, and the daemon-private dir should be pre-trusted. The spike answered the trust prompt by writing `\r`; if pre-trust via settings is available (e.g. a trusted-folders entry or `permissions`/`disableAllTools` setting), prefer that. The implementer MUST confirm the exact setting keys and add them to `buildShadowHookSettings` output (extend Task 1's builder + its test) — do not guess silently; if unconfirmed, fall back to: on first PTY output matching a trust prompt, write `\r` (detection mirrors `orchestration-transport/hidden-worker/drivers/claude.ts`).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- shadow-session`
Expected: PASS (spawn-integration + ask + spawn tests). Reconcile the deps shape so all shadow-session tests use the unified deps.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @orca/daemon exec tsc --noEmit` → clean.
```bash
git add apps/daemon/src/orchestrator-llm/shadow-session.ts apps/daemon/src/orchestrator-llm/shadow-session.spawn.test.ts apps/daemon/src/orchestrator-llm/shadow-session.ask.test.ts apps/daemon/src/orchestrator-llm/shadow-hook-settings.ts apps/daemon/src/orchestrator-llm/shadow-hook-settings.test.ts
git commit -m "feat(daemon): shadow spawn writes hook settings, readiness-gated, daemon-private dir"
```

---

### Task 4: Hook endpoint POST /v1/orchestrator-hooks/stop

**Files:**
- Create: `apps/daemon/src/orchestrator-hooks/routes.ts`
- Test: `apps/daemon/src/orchestrator-hooks/routes.test.ts`

- [ ] **Step 1: Write the failing test (fastify inject)**

```ts
// apps/daemon/src/orchestrator-hooks/routes.test.ts
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerOrchestratorHookRoutes } from "./routes.js";

function app(resolvePending: any) {
  const f = Fastify();
  registerOrchestratorHookRoutes(f, { resolvePending });
  return f;
}

describe("POST /v1/orchestrator-hooks/stop", () => {
  it("resolves the goal's pending ask with last_assistant_message", async () => {
    const resolvePending = vi.fn();
    const f = app(resolvePending);
    const res = await f.inject({
      method: "POST",
      url: "/v1/orchestrator-hooks/stop?goalId=G1",
      payload: { session_id: "s1", last_assistant_message: "```orca:action\n{\"k\":1}\n```" },
    });
    expect(res.statusCode).toBe(200);
    expect(resolvePending).toHaveBeenCalledWith("G1", { text: "```orca:action\n{\"k\":1}\n```", failure: false });
  });

  it("failure=1 marks failure", async () => {
    const resolvePending = vi.fn();
    const f = app(resolvePending);
    await f.inject({ method: "POST", url: "/v1/orchestrator-hooks/stop?goalId=G1&failure=1", payload: { session_id: "s1" } });
    expect(resolvePending).toHaveBeenCalledWith("G1", { text: "", failure: true });
  });

  it("missing goalId -> 200 no-op (drops stray hook)", async () => {
    const resolvePending = vi.fn();
    const f = app(resolvePending);
    const res = await f.inject({ method: "POST", url: "/v1/orchestrator-hooks/stop", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(resolvePending).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- orchestrator-hooks`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/daemon/src/orchestrator-hooks/routes.ts
import type { FastifyInstance } from "fastify";

export interface OrchestratorHookRouteDeps {
  resolvePending: (goalId: string, result: { text: string; failure: boolean }) => void;
}

export function registerOrchestratorHookRoutes(server: FastifyInstance, deps: OrchestratorHookRouteDeps): void {
  server.post("/v1/orchestrator-hooks/stop", async (request, reply) => {
    const q = request.query as { goalId?: string; failure?: string };
    const goalId = q.goalId;
    if (!goalId) { reply.status(200); return { ok: true, dropped: "no_goal_id" }; }
    const body = (request.body ?? {}) as { last_assistant_message?: string };
    deps.resolvePending(goalId, {
      text: body.last_assistant_message ?? "",
      failure: q.failure === "1",
    });
    reply.status(200);
    return { ok: true };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- orchestrator-hooks`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-hooks/routes.ts apps/daemon/src/orchestrator-hooks/routes.test.ts
git commit -m "feat(daemon): /v1/orchestrator-hooks/stop endpoint -> resolvePending"
```

---

### Task 5: Mode-driven chat — async shadow, sync one_shot

**Files:**
- Modify: `apps/daemon/src/orchestrator-chat/usecases.ts`
- Modify: `apps/daemon/src/orchestrator-chat/routes.ts` (thread `resolveOrchestratorMode` + async poster deps)
- Test: `apps/daemon/src/orchestrator-chat/usecases.shadow.test.ts` (extend)

The current shadow branch (usecases.ts:112-130) is **synchronous**. Change: for `shadow_session` mode, insert the user message, return `reply:null`, and run the orchestrator turn in the background — posting the orchestrator reply via `insertMessageWithEvent` when `shadowAsk` resolves. For `one_shot` mode keep the synchronous SDK path.

- [ ] **Step 1: Write the failing test**

```ts
// add to apps/daemon/src/orchestrator-chat/usecases.shadow.test.ts
it("shadow_session mode: returns reply:null and posts the orchestrator reply asynchronously", async () => {
  const db = setup(); // existing helper; goal G1 provider orca/anthropic, no active run
  const inserted: string[] = [];
  let resolveAsk: (r: { text: string }) => void = () => {};
  const ask = vi.fn(() => new Promise<{ text: string }>((r) => { resolveAsk = r; }));
  let idN = 0;
  const ctx: any = {
    db, bus: { publish: vi.fn() },
    modelProviderRegistry: { get: vi.fn(() => { throw new Error("SDK must not be used"); }) },
    shadowAsk: ask,
    resolveOrchestratorMode: () => "shadow_session",
    now: () => "2026-05-29T00:00:00Z",
    idFactory: () => `id${++idN}`,
    onOrchestratorReply: (goalId: string, body: string) => { inserted.push(body); },
  };
  const res = await createOrchestratorMessage(ctx, "G1", { body: "hello" });
  expect(res.reply).toBeNull();
  expect(ask).toHaveBeenCalledTimes(1);
  expect(inserted).toEqual([]);                       // nothing posted yet
  resolveAsk({ text: '{"replyText":"hi async"}' });   // hook delivers reply (block already extracted by manager in prod)
  await new Promise((r) => setImmediate(r));
  expect(inserted).toEqual(["hi async"]);             // posted after resolution
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- usecases.shadow`
Expected: FAIL — no `resolveOrchestratorMode`/async post path.

- [ ] **Step 3: Implement the mode branch**

Add to `OrchestratorChatCtx`:
```ts
resolveOrchestratorMode?: (provider: string) => "shadow_session" | "one_shot";
onOrchestratorReply?: (goalId: string, body: string) => void; // posts an orchestrator message (insertMessageWithEvent wrapper)
```
Replace the `if (goal.orchestrator_provider === "orca/anthropic")` block (lines ~112-130) with mode-driven dispatch:
```ts
const mode = ctx.resolveOrchestratorMode?.(goal.orchestrator_provider) ?? "one_shot";

if (mode === "shadow_session") {
  if (!ctx.shadowAsk || !ctx.onOrchestratorReply) {
    throw new OrchestratorChatProviderUnavailableError(goal.orchestrator_provider);
  }
  const sys = [
    "You are Orca's goal orchestrator.",
    "Answer the user's freeform guidance message for the current goal.",
    "This is chat-only guidance: do not claim that recommendations, workflow steps, artifacts, or decisions were changed.",
    'Return JSON: {"replyText":"..."}.',
    "Output protocol: wrap that JSON in a fenced ```orca:action block and emit nothing after the closing fence.",
  ].join("\n");
  const usr = JSON.stringify({ goal: { id: goal.id, title: goal.title, description: goal.description }, userMessage: parsed.body });
  // Fire-and-forget: post the reply when the hook resolves the ask.
  void ctx.shadowAsk(goalId, { systemPrompt: sys, userPrompt: usr, timeoutMs: 120_000 })
    .then((out) => {
      let body: string;
      try { body = GuidanceReply.parse(JSON.parse(out.text)).replyText; }
      catch { body = "Orchestrator returned an unreadable reply."; }
      ctx.onOrchestratorReply!(goalId, body);
    })
    .catch(() => ctx.onOrchestratorReply!(goalId, "Orchestrator is unavailable right now. Please try again."));
  return CreateOrchestratorMessageResponse.parse({ message: userMessage, reply: null });
}

// one_shot (SDK) — synchronous (existing path, unchanged)
const provider = ctx.modelProviderRegistry.get(goal.orchestrator_provider);
if (!provider) throw new OrchestratorChatProviderUnavailableError(goal.orchestrator_provider);
const currentStep = readCurrentStep(ctx.db, goal.active_workflow_run_id);
const completion = await provider.complete<unknown>({ /* existing args object, unchanged */ } as any);
const replyText = GuidanceReply.parse(completion.parsed).replyText;
const replyMessage = insertMessageWithEvent(ctx, { id: idFactory(), goalId, role: "orchestrator", body: replyText, correlationId, createdAt: now() });
return CreateOrchestratorMessageResponse.parse({ message: userMessage, reply: replyMessage });
```
(Move the existing SDK `provider.complete({...})` argument object verbatim into the one_shot branch.)

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @orca/daemon test -- usecases.shadow orchestrator-chat`
Expected: PASS. Update the prior synchronous-shadow test (the one asserting `res.reply?.body` for orca/anthropic) — under the new design that goal is `shadow_session` → `reply:null`; change that test to provide `resolveOrchestratorMode: () => "one_shot"` if it intends to exercise the sync path, or assert the async post.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -r typecheck` → clean.
```bash
git add apps/daemon/src/orchestrator-chat/usecases.ts apps/daemon/src/orchestrator-chat/routes.ts apps/daemon/src/orchestrator-chat/usecases.shadow.test.ts
git commit -m "feat(daemon): mode-driven chat reply (async shadow / sync one_shot)"
```

---

### Task 6: Wire it in server.ts + index.ts

**Files:**
- Modify: `apps/daemon/src/server.ts`
- Modify: `apps/daemon/src/index.ts`
- Test: `apps/daemon/src/orchestrator-shadow-wiring.test.ts` (update to hook-resolved flow)

- [ ] **Step 1: Construct the production ShadowSessionManager + wire deps**

In `server.ts`, replace the existing shadow-manager construction with the new deps shape:
```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { ShadowSessionManager, shadowSessionId } from "./orchestrator-llm/shadow-session.js";
import { registerOrchestratorHookRoutes } from "./orchestrator-hooks/routes.js";
import { adapterRegistry } from "./adapters/registry.js";

const claudeAdapter = adapterRegistry.get("claude-code");
const shadowSessions = new ShadowSessionManager({
  ptyManager: new NodePtyManager(),
  shadowRoot: join(homedir(), ".orca", "shadow"),
  daemonPort: config.port,                      // updated post-listen in index.ts via setDaemonPort
  isReady: async () => {
    if (!claudeAdapter) return false;
    const r = await claudeAdapter.checkAuth();
    return r.ok === true;
  },
  resolveSpawnCommand: (cwd) => {
    // interactive claude (no -p); reuse adapter env; cwd = daemon-private goal dir
    const bin = process.env.ORCA_CLAUDE_CODE_BIN ?? "claude";
    return { command: bin, args: [], env: { ...process.env } as Record<string,string>, cwd };
  },
});
```
Keep `ShadowSessionLlmClient`/`OrchestratorMediator` construction as-is (they call `shadowSessions.ask`). Register the hook route:
```ts
registerOrchestratorHookRoutes(server, {
  resolvePending: (goalId, result) => shadowSessions.resolvePending(goalId, result),
});
```
Wire the chat-route mode resolver + async poster. In `registerOrchestratorChatRoutes(server, {...})` deps add:
```ts
shadowAsk: (goalId, input) => shadowSessions.ask(goalId, input),
resolveOrchestratorMode: (provider) => {
  const adapterId = provider === "orca/anthropic" ? "claude-code"
    : provider === "orca/openai" ? "codex"
    : provider === "orca/google-gemini" ? "gemini-cli" : "claude-code";
  return daemonContext.stepDispatchCapabilities.resolveMode(adapterId).mode === "shadow_session" ? "shadow_session" : "one_shot";
},
onOrchestratorReply: (goalId, body) => {
  // ensure shadow session exists before ask happens — spawn on first send:
  // (the chat route handler should `await shadowSessions.spawn(goalId)` before calling createOrchestratorMessage when mode is shadow)
  postOrchestratorChatMessage(getDatabase(), eventBus, daemonContext, goalId, body);
},
```
Add a small helper `postOrchestratorChatMessage(db, bus, ctx, goalId, body)` that inserts an `orchestrator_messages` row (role `orchestrator`, kind `message`) and publishes `orchestrator.message.created` — reuse the existing `insertMessageWithEvent` shape from `orchestrator-chat/usecases.ts` (export it if needed) so the desktop SSE refresh fires.

> **Spawn-before-ask:** because `ask` no longer auto-spawns reliably for the async path, the chat route MUST ensure the shadow session is spawned for shadow_session goals before the background `ask`. Simplest: in `registerOrchestratorChatRoutes`'s POST handler, when the resolved mode is shadow_session, `await shadowSessions.spawn(goalId)` (idempotent) before/at `createOrchestratorMessage`. Confirm placement so a readiness failure surfaces as a clear error (caught → `GoalOrchestratorModelMissingError`-style 409 or a posted system message), not an unhandled rejection.

Remove the boot-time resume shadow spawn (the `void shadowSessions.spawn(goalId)` in `resumeActiveRuns`) — spawn is on-demand now. Keep terminate-on-terminal-run-events + archive.

In `index.ts`, after `await server.listen(...)`, set the real port:
```ts
const addr = server.server.address();
if (addr && typeof addr === "object") shadowSessions.setDaemonPort(addr.port);
```
(Expose `shadowSessions` from `createServer` or set the port inside `createServer` via a `server.ready().then(...)` hook reading `server.server.address()`. Pick whichever fits how `createServer` returns; the address is only valid after listen.)

- [ ] **Step 2: Update the wiring test to the hook-resolved flow**

```ts
// apps/daemon/src/orchestrator-shadow-wiring.test.ts (replace body)
import { describe, it, expect } from "vitest";
import { ShadowSessionManager } from "./orchestrator-llm/shadow-session.js";
import { ShadowSessionLlmClient } from "./orchestrator-llm/shadow-llm-client.js";
import { OrchestratorMediator } from "./orchestrator-llm/mediator.js";
import { composeOrchestratorPrompt } from "./orchestrator-llm/prompts.js";
import { FakePtyManager } from "./pty/fake.js";

describe("shadow orchestrator wiring (hook-resolved)", () => {
  it("mediator.invoke resolves via a simulated Stop-hook resolvePending", async () => {
    const pty = new FakePtyManager();
    const mgr = new ShadowSessionManager({
      ptyManager: pty,
      shadowRoot: "/tmp", daemonPort: 8787,
      isReady: async () => true,
      resolveSpawnCommand: (cwd) => ({ command: "claude", args: [], env: {}, cwd }),
    } as any);
    await mgr.spawn("G1");
    const mediator = new OrchestratorMediator({
      llm: new ShadowSessionLlmClient(mgr, { timeoutMs: 1000 }),
      buildContext: () => ({
        goal: { id: "G1", title: "T", description: "D", attachedWorkspaces: [] },
        workflowRun: { templateId: "", templateVersion: 0, ordinal: 0, status: "active" },
        currentStep: { id: "", instructions: "", outputSchema: [], agentAdapterId: "claude-code", executionMode: "shadow_session" },
        conversation: { chatMessages: [], currentStepAgentTurns: [] },
        priorStepArtifacts: [],
      }),
      composePrompt: composeOrchestratorPrompt,
    });
    const p = mediator.invoke({
      triggerKind: "user_message", goalId: "G1", runId: "R1", stepRunId: "S1",
      adapterId: "claude-code", modelId: "claude-haiku-4-5", triggerPayload: { userMessage: "hi" },
    });
    mgr.resolvePending("G1", { text: '```orca:action\n{"kind":"answer_user_directly","body":"hello"}\n```' });
    const action = await p;
    expect(action.kind).toBe("answer_user_directly");
    if (action.kind === "answer_user_directly") expect(action.body).toBe("hello");
  });
});
```

- [ ] **Step 3: Run + typecheck + full daemon suite**

Run: `pnpm --filter @orca/daemon test -- orchestrator-shadow-wiring` → PASS.
Run: `pnpm -r typecheck` → clean.
Run: `pnpm --filter @orca/daemon test` → green (fix any test that constructed the old shadow deps shape or asserted stdout-poll/sync-shadow behavior).

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/index.ts apps/daemon/src/orchestrator-shadow-wiring.test.ts apps/daemon/src/orchestrator-chat/usecases.ts
git commit -m "feat(daemon): wire hook-transport shadow manager + hook endpoint + dynamic port"
```

---

### Task 7: Desktop "thinking" indicator for async turns

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx` (extend)

When send returns `reply:null`, show a per-goal "thinking" row until the next `orchestrator.message.created` SSE arrives (the component already bumps `refreshNonce` on that event and reloads messages).

- [ ] **Step 1: Write the failing test**

```tsx
// add to apps/desktop/src/orchestrator/OrcaChat.test.tsx
it("shows a thinking indicator after sending when reply is null, until messages refresh", async () => {
  // Arrange: mock createOrchestratorMessage to resolve { message, reply: null }.
  // Act: type + send.
  // Assert: a thinking/awaiting element is visible; after a simulated message refresh containing
  //         an orchestrator reply, the thinking element is gone.
  // (Follow the existing OrcaChat.test.tsx patterns for mocking the api module and SSE refresh.)
});
```
Fill the test body using the file's existing mocking patterns (mock `../api` `createOrchestratorMessage` + `listOrchestratorMessages`). Assert on a stable testid/text you add in Step 3.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/desktop test -- OrcaChat`
Expected: FAIL — no awaiting indicator.

- [ ] **Step 3: Implement**

In `handleSendMessage`, when `response.reply == null`, set an `awaitingReply` state (per selected goal). Render a `ThinkingRow label="orchestrator"` when `awaitingReply` is true and no newer orchestrator message has arrived. Clear `awaitingReply` in the messages-load effect when the latest message is an orchestrator/agent reply newer than the sent user message (or simply clear on each successful `loadMessages` that returns a message with `role !== "user"` as the last entry). Keep it minimal — reuse the existing `ThinkingRow` component.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/desktop test -- OrcaChat` → PASS.
Run: `pnpm --filter @orca/desktop typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): orchestrator thinking indicator for async replies"
```

---

### Task 8: Full-suite gate + manual smoke

**Files:** none (verification)

- [ ] **Step 1: Full gate**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: contracts + daemon + desktop all green. Fix regressions (most likely: tests using the old shadow deps shape, the old sync-shadow chat assertion, or the removed boot-resume spawn).

- [ ] **Step 2: Manual smoke (requires logged-in Claude Code, NO ANTHROPIC_API_KEY)**

1. `claude auth status --json` → `loggedIn: true`; ensure `ANTHROPIC_API_KEY` unset.
2. Start the app; create a goal with the Anthropic orchestrator model.
3. Send a chat message. Expected: composer frees immediately, a "thinking" indicator shows, then an orchestrator reply appears (via the Stop hook). No 500, no 60s hang.
4. `ps aux | grep '[c]laude'` → at most one shadow `claude` per active goal; archive the goal → that shadow process exits.
5. Daemon log shows a `POST /v1/orchestrator-hooks/stop` per turn, no `ANTHROPIC_API_KEY` error.

- [ ] **Step 3: Commit any test fixups**

```bash
git add -A && git commit -m "test: update suites for hook-transport orchestrator"
```

---

## Self-review notes (for the implementer)

- **Deps-shape migration (Task 2↔3):** `ShadowSessionManager` deps change from `{ptyManager, resolveSpawn, pollIntervalMs?}` to `{ptyManager, shadowRoot, daemonPort, isReady, resolveSpawnCommand, cols?, rows?}`. Pick the unified shape in Task 2 or 3 and update ALL shadow-session tests in the same task so the suite stays green between commits. Don't leave two deps shapes.
- **Spawn-before-ask (Task 6):** the async chat path requires the session to exist before the background `ask`; ensure `await shadowSessions.spawn(goalId)` runs for shadow_session goals before `createOrchestratorMessage`, and that a readiness failure surfaces as a clear posted message, not an unhandled rejection.
- **Open questions from the spec resolved at execution:** native `http` hook body shape (Task 1 Step 1 verifies; fall back to `command`), no-tools/trust settings (Task 3 Step 3 note — confirm keys, extend the builder + its test), idle-timeout duration (add an idle timer in Task 3 if desired; default 10 min — optional, not gating).
- **Removed:** stdout polling (`consumedUpTo`, `pollIntervalMs`, poll loop) and boot-time resume shadow spawn.
- **Reused unchanged:** `sentinel.ts`, `shadow-llm-client.ts`, `mediator.ts`, `prompts.ts`, `build-context.ts`.
