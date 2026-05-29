# Orchestrator Shadow-Session Production Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the goal-scoped orchestrator-LLM a real interactive Claude Code shadow session (subscription auth, no `ANTHROPIC_API_KEY`), so chat replies and the step mediator actually respond — finishing the production wiring of sub-plan 3 of the 2026-05-28 orchestrator-mediated-workflows design.

**Architecture:** A new `ShadowSessionLlmClient` implements the existing `OrchestratorLlmClient` interface by writing a prompt to a long-lived Claude Code PTY's stdin and resolving with the JSON the orchestrator emits inside a fenced `orca:action` sentinel block (detected by watching accumulated PTY output). One shadow session per goal, spawned at goal-create and torn down at run completion. The same client backs (a) the `OrchestratorMediator` (replacing the `undefined` passed in `server.ts`) and (b) the freeform chat reply in `createOrchestratorMessage` for `orca/anthropic` goals. SDK `ModelProvider.complete` is retained for `orca/openai` / `orca/google-gemini` (one-shot) goals.

**Tech Stack:** TypeScript, Node.js, `node-pty` (via `PtyManager`), fastify, better-sqlite3, zod, vitest.

---

## Background: why this work exists (read first)

The 2026-05-28 design is implemented **except** the production wiring of the orchestrator-LLM session + mediator. Concretely, today:

- `apps/daemon/src/server.ts:462` passes `undefined` as the `orchestratorMediator` → `OrchestratorService.onAgentResponseDone` (`service.ts:454`) and `onUserMessage` (`service.ts:576`) early-return. No agent paraphrase, no mediated user reply.
- `apps/daemon/src/server.ts:553` `spawnOrchestratorSessionFn` is a placeholder returning `orchsess-${goalId}` — no shadow PTY is ever spawned.
- `apps/daemon/src/orchestrator-chat/usecases.ts:104` `createOrchestratorMessage` calls the SDK `ModelProvider.complete`, which throws `ProviderError("missing_api_key", "ANTHROPIC_API_KEY not set")` → HTTP 500 → the "internal server error" flash the user saw.
- The execution-mode seed (`apps/daemon/src/adapters/execution-modes.ts`) already matches the design: `claude-code` → `shadow_session` preferred, `one_shot` **disabled** ("the -p flag bills against API budget; shadow_session uses interactive subscription"). So we must NOT use `claude -p`; we use an interactive PTY.
- No production `OrchestratorSessionManager` or `OrchestratorLlmClient` is instantiated anywhere (grep returns nothing outside tests).

The interfaces already exist and are stable — we are filling in implementations and wiring:
- `OrchestratorLlmClient` — `apps/daemon/src/orchestrator-llm/mediator.ts:9`
- `OrchestratorMediator` (synchronous `request(...) → {text}` abstraction, 2-attempt parse + backoff) — `apps/daemon/src/orchestrator-llm/mediator.ts:38`
- `composeOrchestratorPrompt` / `OrchestratorPromptInput` — `apps/daemon/src/orchestrator-llm/prompts.ts:60`
- `buildOrchestratorContext` / `OrchestratorContextInput` — `apps/daemon/src/orchestrator-llm/context.ts:49`
- `OrchestratorAction` discriminated union — `packages/contracts/src/workflows/index.ts:1512`
- `PtyManager` / `PtyHandle` / `PtyEvents` — `apps/daemon/src/pty/types.ts`
- `OrchestratorService` constructor `orchestratorMediator?` param — `apps/daemon/src/workflows/orchestrator/service.ts:191`

## Core design decision: synchronous request over an async interactive session

The mediator wants `request({systemPrompt, userPrompt}) → {text}`. A shadow session is an async interactive PTY. We bridge them with a **sentinel protocol + output watcher**:

1. The orchestrator system prompt instructs the model to emit its one JSON object wrapped in a fenced block:

   ````
   ```orca:action
   {"kind":"answer_user_directly","body":"..."}
   ```
   ````

2. `ShadowSessionLlmClient.request()` writes `userPrompt` (preceded, once per session, by `systemPrompt`) to the session's PTY stdin, then waits until the accumulated session output contains a **complete** `orca:action` fenced block, extracts the inner text, and resolves `{ text: <inner JSON string> }`.
3. Requests on one session are **serialized** (FIFO queue, one outstanding at a time) so a captured block is unambiguously the answer to the current prompt.
4. A per-request timeout rejects; `OrchestratorMediator.invokeWithBackoff` already retries with exponential backoff, and `onUserMessage`/`onAgentResponseDone` already surface persistent failure as a chat "orchestrator unavailable" message.

This reuses the project's existing fenced-block convention (cf. `orca:step-complete` in `apps/daemon/src/workflows/orchestrator/orca-output.ts`) and depends on nothing that isn't already built (notably it does NOT require the unbuilt Claude Code `Stop`-hook install — capture is done by reading PTY output the daemon already streams into `PtyEvents.onData`).

## Chat-reply vs mediator (avoiding double replies)

`orchestrator-chat/routes.ts` currently calls BOTH `createOrchestratorMessage` (synchronous SDK reply) AND, best-effort, `onUserMessage` (the mediator). To keep one voice:

- **No active workflow run** → `createOrchestratorMessage` produces the freeform guidance reply synchronously (via shadow session for `orca/anthropic`, via SDK for one-shot providers). `onUserMessage` no-ops (it already early-returns when there's no active run — `service.ts:585`).
- **Active workflow run** → `createOrchestratorMessage` inserts the user message and returns `reply: null`; the mediator (`onUserMessage`) posts the orchestrator's response asynchronously (the desktop already refreshes on the `orchestrator.message.created` SSE event — `OrcaChat.tsx:206`).

This requires `CreateOrchestratorMessageResponse.reply` to become nullable (Task 7).

## File structure

- **Create** `apps/daemon/src/orchestrator-llm/sentinel.ts` — pure functions: extract a complete `orca:action` block from accumulated text; the system-prompt sentinel instruction string. (Task 1)
- **Create** `apps/daemon/src/orchestrator-llm/shadow-session.ts` — `ShadowSessionManager`: spawns/stores/terminates one Claude Code PTY per goal, buffers its output, and exposes `ask(goalId, {systemPrompt, userPrompt, timeoutMs}) → Promise<{text}>` with per-session FIFO serialization. (Tasks 2–4)
- **Create** `apps/daemon/src/orchestrator-llm/shadow-llm-client.ts` — `ShadowSessionLlmClient implements OrchestratorLlmClient`, adapting `ask` to `request`. (Task 5)
- **Create** `apps/daemon/src/orchestrator-llm/build-context.ts` — DB-backed `buildOrchestratorContext` producing `OrchestratorInvocationContext` from goal/run/step/chat/artifacts. (Task 6)
- **Modify** `packages/contracts/src/workflows/index.ts` — `CreateOrchestratorMessageResponse.reply` nullable. (Task 7)
- **Modify** `apps/daemon/src/orchestrator-chat/usecases.ts` — branch chat reply by provider/run; shadow path for `orca/anthropic`; graceful unavailable. (Task 7)
- **Modify** `apps/daemon/src/orchestrator-llm/prompts.ts` — append sentinel instruction to the orchestrator system prompt. (Task 8)
- **Modify** `apps/daemon/src/server.ts` — construct `ShadowSessionManager`, `ShadowSessionLlmClient`, `OrchestratorMediator`; real `spawnOrchestratorSessionFn`; pass the mediator into `OrchestratorService`; terminate the shadow session on run completion; wire the shadow manager into chat routes. (Task 9)
- **Modify** `apps/daemon/src/daemon-context.ts` — expose the goal's resolved orchestrator adapter id + the `PtyManager` for shadow spawn. (Task 9, supporting)

---

### Task 1: Sentinel protocol (pure functions)

**Files:**
- Create: `apps/daemon/src/orchestrator-llm/sentinel.ts`
- Test: `apps/daemon/src/orchestrator-llm/sentinel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/orchestrator-llm/sentinel.test.ts
import { describe, it, expect } from "vitest";
import { extractActionBlock, SENTINEL_INSTRUCTION } from "./sentinel.js";

describe("extractActionBlock", () => {
  it("returns null when no closing fence yet", () => {
    expect(extractActionBlock("```orca:action\n{\"kind\":\"answer")).toBeNull();
  });

  it("extracts inner JSON between the orca:action fences", () => {
    const out = "chatter\n```orca:action\n{\"kind\":\"answer_user_directly\",\"body\":\"hi\"}\n```\nmore";
    expect(extractActionBlock(out)).toBe('{"kind":"answer_user_directly","body":"hi"}');
  });

  it("returns the LAST complete block when several appear", () => {
    const out =
      "```orca:action\n{\"a\":1}\n```\n```orca:action\n{\"b\":2}\n```\n";
    expect(extractActionBlock(out)).toBe('{"b":2}');
  });

  it("instruction string mentions the fence token", () => {
    expect(SENTINEL_INSTRUCTION).toContain("```orca:action");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- sentinel`
Expected: FAIL — `Cannot find module './sentinel.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/daemon/src/orchestrator-llm/sentinel.ts
const FENCE_OPEN = "```orca:action";
const FENCE_CLOSE = "```";

/**
 * Returns the inner text of the LAST complete ```orca:action ... ``` block in
 * `text`, or null if no complete block is present yet. Used to detect that the
 * orchestrator shadow session has finished emitting its structured action.
 */
export function extractActionBlock(text: string): string | null {
  let result: string | null = null;
  let searchFrom = 0;
  for (;;) {
    const open = text.indexOf(FENCE_OPEN, searchFrom);
    if (open < 0) break;
    const afterOpen = open + FENCE_OPEN.length;
    const close = text.indexOf(FENCE_CLOSE, afterOpen);
    if (close < 0) break; // open fence without a close yet → incomplete
    result = text.slice(afterOpen, close).trim();
    searchFrom = close + FENCE_CLOSE.length;
  }
  return result;
}

/** Appended to the orchestrator system prompt so output is machine-extractable. */
export const SENTINEL_INSTRUCTION = [
  "Output protocol (MANDATORY):",
  "Emit your single structured action as compact JSON wrapped in a fenced block:",
  "```orca:action",
  '{ ...one OrchestratorAction object... }',
  "```",
  "Emit exactly one such block per turn and nothing after the closing fence.",
].join("\n");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- sentinel`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/sentinel.ts apps/daemon/src/orchestrator-llm/sentinel.test.ts
git commit -m "feat(daemon): orca:action sentinel extraction for shadow orchestrator"
```

---

### Task 2: ShadowSessionManager — spawn + output buffering

**Files:**
- Create: `apps/daemon/src/orchestrator-llm/shadow-session.ts`
- Test: `apps/daemon/src/orchestrator-llm/shadow-session.test.ts`

The manager depends only on the `PtyManager` interface (`apps/daemon/src/pty/types.ts`) so it is unit-testable with `apps/daemon/src/pty/fake.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/orchestrator-llm/shadow-session.test.ts
import { describe, it, expect } from "vitest";
import { FakePtyManager } from "../pty/fake.js";
import { ShadowSessionManager } from "./shadow-session.js";

function mgr() {
  const pty = new FakePtyManager();
  const m = new ShadowSessionManager({
    ptyManager: pty,
    resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
  });
  return { pty, m };
}

describe("ShadowSessionManager spawn", () => {
  it("spawns one PTY per goal and is idempotent", async () => {
    const { pty, m } = mgr();
    const a = await m.spawn("G1");
    const b = await m.spawn("G1");
    expect(a).toBe(b);
    expect(pty.startedCount).toBe(1);
  });

  it("has() reflects lifecycle; terminate kills the handle", async () => {
    const { pty, m } = mgr();
    await m.spawn("G1");
    expect(m.has("G1")).toBe(true);
    await m.terminate("G1");
    expect(m.has("G1")).toBe(false);
    expect(pty.killedCount).toBe(1);
  });
});
```

> Note: `apps/daemon/src/pty/fake.ts` already exists. If it does not expose `startedCount`/`killedCount`, add those counters in this task (small additive change) and keep its existing API intact.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- shadow-session`
Expected: FAIL — `Cannot find module './shadow-session.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/daemon/src/orchestrator-llm/shadow-session.ts
import type { PtyHandle, PtyManager } from "../pty/types.js";

export interface ShadowSpawnCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface ShadowSessionDeps {
  ptyManager: PtyManager;
  /** Resolves the spawn command for the goal's orchestrator adapter (claude-code). */
  resolveSpawn: (goalId: string) => ShadowSpawnCommand;
  cols?: number;
  rows?: number;
}

interface Session {
  handle: PtyHandle;
  output: string;
  disposeData: () => void;
  systemSent: boolean;
}

export class ShadowSessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: ShadowSessionDeps) {}

  has(goalId: string): boolean {
    return this.sessions.has(goalId);
  }

  /** Spawns the goal's shadow PTY (idempotent). Returns a stable session id. */
  async spawn(goalId: string): Promise<string> {
    const existing = this.sessions.get(goalId);
    if (existing) return shadowSessionId(goalId);

    const cmd = this.deps.resolveSpawn(goalId);
    const { handle, events } = this.deps.ptyManager.start({
      command: cmd.command,
      args: cmd.args,
      cwd: cmd.cwd,
      env: cmd.env,
      cols: this.deps.cols ?? 120,
      rows: this.deps.rows ?? 40,
    });
    const session: Session = { handle, output: "", disposeData: () => {}, systemSent: false };
    session.disposeData = events.onData((chunk) => {
      session.output += chunk.toString("utf8");
    });
    events.onExit(() => {
      this.sessions.delete(goalId);
    });
    this.sessions.set(goalId, session);
    return shadowSessionId(goalId);
  }

  async terminate(goalId: string): Promise<void> {
    const session = this.sessions.get(goalId);
    if (!session) return;
    session.disposeData();
    session.handle.kill("SIGTERM");
    this.sessions.delete(goalId);
  }

  /** Internal access for the ask() loop (Task 3). */
  protected getSession(goalId: string): Session | undefined {
    return this.sessions.get(goalId);
  }
}

export function shadowSessionId(goalId: string): string {
  return `orchsess-${goalId}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- shadow-session`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/shadow-session.ts apps/daemon/src/orchestrator-llm/shadow-session.test.ts apps/daemon/src/pty/fake.ts
git commit -m "feat(daemon): ShadowSessionManager spawn/terminate + output buffering"
```

---

### Task 3: ShadowSessionManager.ask — prompt + sentinel capture

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/shadow-session.ts`
- Test: `apps/daemon/src/orchestrator-llm/shadow-session.ask.test.ts`

`ask` writes the prompt to stdin and polls the buffered output for a complete `orca:action` block. It records a high-water mark so a block from a previous turn is never re-returned. Polling uses a small interval; tests inject a fast clock by emitting fake output then awaiting.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/orchestrator-llm/shadow-session.ask.test.ts
import { describe, it, expect } from "vitest";
import { FakePtyManager } from "../pty/fake.js";
import { ShadowSessionManager } from "./shadow-session.js";

describe("ShadowSessionManager.ask", () => {
  it("writes the prompt and resolves with the captured action JSON", async () => {
    const pty = new FakePtyManager();
    const m = new ShadowSessionManager({
      ptyManager: pty,
      resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
      pollIntervalMs: 1,
    });
    await m.spawn("G1");
    const handle = pty.handles[0];

    const p = m.ask("G1", { systemPrompt: "SYS", userPrompt: "hello", timeoutMs: 1000 });
    // Simulate the orchestrator emitting an action block.
    await new Promise((r) => setTimeout(r, 5));
    handle.emitData('```orca:action\n{"kind":"answer_user_directly","body":"hi"}\n```\n');

    const res = await p;
    expect(res.text).toBe('{"kind":"answer_user_directly","body":"hi"}');
    expect(handle.writes.join("")).toContain("hello");
    expect(handle.writes.join("")).toContain("SYS"); // system sent on first ask
  });

  it("does not re-return a previous turn's block", async () => {
    const pty = new FakePtyManager();
    const m = new ShadowSessionManager({
      ptyManager: pty,
      resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
      pollIntervalMs: 1,
    });
    await m.spawn("G1");
    const handle = pty.handles[0];

    handle.emitData('```orca:action\n{"kind":"answer_user_directly","body":"one"}\n```\n');
    const r1 = await m.ask("G1", { systemPrompt: "S", userPrompt: "q1", timeoutMs: 1000 });
    expect(r1.text).toContain("one");

    const p2 = m.ask("G1", { systemPrompt: "S", userPrompt: "q2", timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    handle.emitData('```orca:action\n{"kind":"answer_user_directly","body":"two"}\n```\n');
    const r2 = await p2;
    expect(r2.text).toContain("two");
  });

  it("rejects on timeout", async () => {
    const pty = new FakePtyManager();
    const m = new ShadowSessionManager({
      ptyManager: pty,
      resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
      pollIntervalMs: 1,
    });
    await m.spawn("G1");
    await expect(
      m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 10 })
    ).rejects.toThrow(/timeout/i);
  });
});
```

> Note: `FakePtyManager` must expose `handles[]` with `emitData(str)` and `writes[]`. If absent, add them in this task — `emitData` feeds the registered `onData` handlers; `writes` records `handle.write()` payloads as strings. Keep existing behavior intact.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- shadow-session.ask`
Expected: FAIL — `m.ask is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `ShadowSessionManager` (and extend `ShadowSessionDeps` with `pollIntervalMs?`). Reuse `extractActionBlock` from Task 1.

```ts
// add import at top of shadow-session.ts
import { extractActionBlock } from "./sentinel.js";

// add to ShadowSessionDeps:
//   pollIntervalMs?: number;

// add to the Session interface:
//   queue: Promise<unknown>;
//   consumedUpTo: number; // length of output already accounted for by a prior ask

// in spawn(), initialise the new Session fields:
//   const session: Session = { handle, output: "", disposeData: () => {}, systemSent: false, queue: Promise.resolve(), consumedUpTo: 0 };

export interface AskInput {
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
}

// method on ShadowSessionManager:
async ask(goalId: string, input: AskInput): Promise<{ text: string }> {
  const session = this.getSession(goalId);
  if (!session) throw new Error(`no shadow session for goal ${goalId}`);
  // Serialize: each ask waits for the previous one to settle.
  const run = session.queue.then(() => this.askOnce(goalId, session, input));
  session.queue = run.catch(() => undefined);
  return run;
}

private async askOnce(
  goalId: string,
  session: Session,
  input: AskInput
): Promise<{ text: string }> {
  // Only consider output produced after this point.
  session.consumedUpTo = session.output.length;
  const prelude = session.systemSent ? "" : input.systemPrompt + "\n\n";
  session.systemSent = true;
  session.handle.write(Buffer.from(prelude + input.userPrompt + "\n", "utf8"));

  const interval = this.deps.pollIntervalMs ?? 50;
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    const fresh = session.output.slice(session.consumedUpTo);
    const block = extractActionBlock(fresh);
    if (block !== null) return { text: block };
    if (Date.now() >= deadline) {
      throw new Error(`shadow orchestrator timeout for goal ${goalId}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- shadow-session.ask`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/shadow-session.ts apps/daemon/src/orchestrator-llm/shadow-session.ask.test.ts apps/daemon/src/pty/fake.ts
git commit -m "feat(daemon): ShadowSessionManager.ask with sentinel capture + serialization"
```

---

### Task 4: Serialization stress test (two concurrent asks)

**Files:**
- Test: `apps/daemon/src/orchestrator-llm/shadow-session.serial.test.ts`

This locks in the FIFO guarantee that two overlapping `ask` calls each get their own block in order. No production code changes if Task 3 is correct.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/orchestrator-llm/shadow-session.serial.test.ts
import { describe, it, expect } from "vitest";
import { FakePtyManager } from "../pty/fake.js";
import { ShadowSessionManager } from "./shadow-session.js";

describe("ShadowSessionManager serialization", () => {
  it("two overlapping asks resolve in FIFO order with distinct blocks", async () => {
    const pty = new FakePtyManager();
    const m = new ShadowSessionManager({
      ptyManager: pty,
      resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
      pollIntervalMs: 1,
    });
    await m.spawn("G1");
    const handle = pty.handles[0];

    const p1 = m.ask("G1", { systemPrompt: "S", userPrompt: "first", timeoutMs: 1000 });
    const p2 = m.ask("G1", { systemPrompt: "S", userPrompt: "second", timeoutMs: 1000 });

    await new Promise((r) => setTimeout(r, 5));
    handle.emitData('```orca:action\n{"n":1}\n```\n');
    expect((await p1).text).toBe('{"n":1}');

    await new Promise((r) => setTimeout(r, 5));
    handle.emitData('```orca:action\n{"n":2}\n```\n');
    expect((await p2).text).toBe('{"n":2}');
  });
});
```

- [ ] **Step 2: Run test to verify it passes (no new impl expected)**

Run: `pnpm --filter @orca/daemon test -- shadow-session.serial`
Expected: PASS. If it fails, the serialization in Task 3 is wrong — fix `ask`'s queue chaining before proceeding.

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/shadow-session.serial.test.ts
git commit -m "test(daemon): shadow session FIFO serialization guarantee"
```

---

### Task 5: ShadowSessionLlmClient (implements OrchestratorLlmClient)

**Files:**
- Create: `apps/daemon/src/orchestrator-llm/shadow-llm-client.ts`
- Test: `apps/daemon/src/orchestrator-llm/shadow-llm-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/orchestrator-llm/shadow-llm-client.test.ts
import { describe, it, expect } from "vitest";
import { ShadowSessionLlmClient } from "./shadow-llm-client.js";

describe("ShadowSessionLlmClient", () => {
  it("delegates request() to the manager's ask() keyed by goalId", async () => {
    const calls: any[] = [];
    const fakeManager = {
      ask: async (goalId: string, input: any) => {
        calls.push({ goalId, input });
        return { text: '{"kind":"answer_user_directly","body":"ok"}' };
      },
    };
    const client = new ShadowSessionLlmClient(fakeManager as any, { timeoutMs: 5000 });
    const res = await client.request({
      goalId: "G1",
      adapterId: "claude-code",
      modelId: "claude-haiku-4-5",
      systemPrompt: "SYS",
      userPrompt: "USR",
    });
    expect(res.text).toContain("answer_user_directly");
    expect(calls[0].goalId).toBe("G1");
    expect(calls[0].input.timeoutMs).toBe(5000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- shadow-llm-client`
Expected: FAIL — module not found.

- [ ] **Step 3: Extend OrchestratorLlmClient.request input with goalId, then implement**

First, extend the interface in `apps/daemon/src/orchestrator-llm/mediator.ts` so the client knows which session to target. Change `OrchestratorLlmClient.request` input to include `goalId`:

```ts
// apps/daemon/src/orchestrator-llm/mediator.ts (interface change)
export interface OrchestratorLlmClient {
  request(input: {
    goalId: string;            // ADDED: selects the goal's shadow session
    adapterId: string;
    modelId: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ text: string }>;
}
```

Then update both call sites in `mediator.ts` (`invoke`, lines ~63 and ~70) to pass `goalId: input.goalId`:

```ts
const res1 = await this.deps.llm.request({
  goalId: input.goalId,
  adapterId: input.adapterId,
  modelId: input.modelId,
  ...prompt,
});
// ...identical for res2
```

Now the client:

```ts
// apps/daemon/src/orchestrator-llm/shadow-llm-client.ts
import type { OrchestratorLlmClient } from "./mediator.js";
import type { ShadowSessionManager } from "./shadow-session.js";

export class ShadowSessionLlmClient implements OrchestratorLlmClient {
  constructor(
    private readonly manager: Pick<ShadowSessionManager, "ask">,
    private readonly opts: { timeoutMs: number }
  ) {}

  async request(input: {
    goalId: string;
    adapterId: string;
    modelId: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ text: string }> {
    return this.manager.ask(input.goalId, {
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      timeoutMs: this.opts.timeoutMs,
    });
  }
}
```

- [ ] **Step 4: Run tests (client + mediator regression)**

Run: `pnpm --filter @orca/daemon test -- shadow-llm-client mediator`
Expected: PASS. The existing mediator tests inject a fake `llm.request`; update those fakes if the added `goalId` field breaks a strict assertion (they typically ignore extra fields).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/shadow-llm-client.ts apps/daemon/src/orchestrator-llm/shadow-llm-client.test.ts apps/daemon/src/orchestrator-llm/mediator.ts
git commit -m "feat(daemon): ShadowSessionLlmClient + goalId on OrchestratorLlmClient.request"
```

---

### Task 6: DB-backed buildOrchestratorContext

**Files:**
- Create: `apps/daemon/src/orchestrator-llm/build-context.ts`
- Test: `apps/daemon/src/orchestrator-llm/build-context.test.ts`

Produces an `OrchestratorInvocationContext` (shape in `context.ts`) by reading the goal, run, current step, recent chat messages, current-step agent turns, and prior validated step artifacts, then delegating to the existing `buildOrchestratorContext(input)` for budget truncation.

- [ ] **Step 1: Write the failing test (in-memory sqlite)**

```ts
// apps/daemon/src/orchestrator-llm/build-context.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { buildContextFromDb } from "./build-context.js";

function seed(db: Database.Database) {
  db.exec(`
    CREATE TABLE goals (id TEXT, title TEXT, description TEXT);
    CREATE TABLE orchestrator_messages (id TEXT, goal_id TEXT, role TEXT, kind TEXT, body TEXT, created_at TEXT);
    INSERT INTO goals VALUES ('G1','T','D');
    INSERT INTO orchestrator_messages VALUES ('m1','G1','user','message','hello','2026-05-29T00:00:00Z');
  `);
}

describe("buildContextFromDb", () => {
  it("includes goal metadata and recent chat messages", () => {
    const db = new Database(":memory:");
    seed(db);
    const ctx = buildContextFromDb(db, {
      goalId: "G1",
      runId: null,
      stepRunId: null,
      payloadBudgetBytes: 64 * 1024,
    });
    expect(ctx.goal.title).toBe("T");
    expect(ctx.conversation.chatMessages.some((m) => m.body === "hello")).toBe(true);
  });
});
```

> Note: the real schema has more columns; the test seeds the minimum the reader touches. The implementation MUST select only columns it uses and tolerate a missing/null run/step (freeform-chat case). Mirror the read patterns already in `orchestrator-chat/usecases.ts:147` (goal) and `service.ts:596` (goal+step) — do not invent column names.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- build-context`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (reuse existing readers + buildOrchestratorContext)**

```ts
// apps/daemon/src/orchestrator-llm/build-context.ts
import type Database from "better-sqlite3";
import {
  buildOrchestratorContext,
  type OrchestratorInvocationContext,
  type OrchestratorContextInput,
} from "./context.js";

const RECENT_CHAT_LIMIT = 40;

export function buildContextFromDb(
  db: Database.Database,
  args: { goalId: string; runId: string | null; stepRunId: string | null; payloadBudgetBytes: number }
): OrchestratorInvocationContext {
  const goal = db
    .prepare("SELECT id, title, description FROM goals WHERE id = ?")
    .get(args.goalId) as { id: string; title: string; description: string } | undefined;
  if (!goal) throw new Error(`goal not found: ${args.goalId}`);

  const chatRows = db
    .prepare(
      `SELECT role, body, created_at FROM orchestrator_messages
        WHERE goal_id = ? AND kind = 'message'
        ORDER BY created_at DESC LIMIT ?`
    )
    .all(args.goalId, RECENT_CHAT_LIMIT) as Array<{ role: string; body: string; created_at: string }>;

  const chatMessages: OrchestratorContextInput["chatMessages"] = chatRows
    .reverse()
    .map((r) => ({
      role: r.role === "user" ? "user" : r.role === "agent_paraphrased" ? "agent_paraphrased" : "orchestrator",
      body: r.body,
      ts: r.created_at,
    }));

  // Current step + prior artifacts are only available with an active run.
  // Freeform-chat (no run) yields placeholder currentStep that the prompt treats as "no active step".
  const input: OrchestratorContextInput = {
    goal: { id: goal.id, title: goal.title, description: goal.description, attachedWorkspaces: [] },
    run: { templateId: "", templateVersion: 0, ordinal: 0, status: "active" },
    currentStep: { id: "", instructions: "", outputSchema: [], agentAdapterId: "claude-code", executionMode: "shadow_session" },
    chatMessages,
    currentStepAgentTurns: [],
    priorStepArtifacts: [],
    payloadBudgetBytes: args.payloadBudgetBytes,
  };
  return buildOrchestratorContext(input);
}
```

> Implementer extension (with active run): when `args.runId`/`args.stepRunId` are non-null, populate `run`, `currentStep`, `currentStepAgentTurns`, and `priorStepArtifacts` by reusing `getWorkflowRunById`, the step-run read, and `collectPriorStepArtifacts` logic already in `service.ts`. Keep each reader to columns those existing queries use. This task ships the freeform path first (covered by the test); the active-run population is folded in during Task 9 wiring where the run/step ids are available, OR add a follow-up test here if implementing now.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- build-context`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/build-context.ts apps/daemon/src/orchestrator-llm/build-context.test.ts
git commit -m "feat(daemon): DB-backed buildOrchestratorContext"
```

---

### Task 7: Route chat reply through shadow session; nullable reply

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts` (find `CreateOrchestratorMessageResponse`)
- Modify: `apps/daemon/src/orchestrator-chat/usecases.ts`
- Test: `apps/daemon/src/orchestrator-chat/usecases.shadow.test.ts`

- [ ] **Step 1: Make `reply` nullable in the contract**

Locate `CreateOrchestratorMessageResponse` in `packages/contracts/src/workflows/index.ts` (or wherever orchestrator-chat contracts live — grep `CreateOrchestratorMessageResponse`). Change its `reply` field to `OrchestratorChatMessage.nullable()`:

```ts
export const CreateOrchestratorMessageResponse = z.object({
  message: OrchestratorChatMessage,
  reply: OrchestratorChatMessage.nullable(),
});
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/daemon/src/orchestrator-chat/usecases.shadow.test.ts
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { createOrchestratorMessage } from "./usecases.js";

// Minimal schema + a goal whose provider is orca/anthropic and which has NO active run.
function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE goals (id TEXT PRIMARY KEY, title TEXT, description TEXT,
      orchestrator_provider TEXT, orchestrator_model TEXT, active_workflow_run_id TEXT, archived_at TEXT);
    CREATE TABLE orchestrator_messages (id TEXT PRIMARY KEY, goal_id TEXT, role TEXT, kind TEXT,
      body TEXT, correlation_id TEXT, created_at TEXT);
    CREATE TABLE events (id TEXT, type TEXT, goal_id TEXT, payload TEXT, created_at TEXT);
    INSERT INTO goals VALUES ('G1','T','D','orca/anthropic','claude-haiku-4-5',NULL,NULL);
  `);
  return db;
}

describe("createOrchestratorMessage shadow path", () => {
  it("uses the shadow ask() (not the SDK) for orca/anthropic and returns a reply", async () => {
    const db = setup();
    const shadow = { ask: vi.fn().mockResolvedValue({ text: '{"replyText":"hi from shadow"}' }) };
    const res = await createOrchestratorMessage(
      {
        db,
        bus: { publish: vi.fn() } as any,
        modelProviderRegistry: { get: vi.fn() } as any, // must NOT be used on this path
        shadowAsk: shadow.ask,
        now: () => "2026-05-29T00:00:00Z",
        idFactory: (() => { let n = 0; return () => `id${++n}`; })(),
      },
      "G1",
      { body: "hello" }
    );
    expect(shadow.ask).toHaveBeenCalledTimes(1);
    expect(res.reply?.body).toBe("hi from shadow");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- usecases.shadow`
Expected: FAIL — `shadowAsk` not accepted / SDK path taken.

- [ ] **Step 4: Implement the branch in `createOrchestratorMessage`**

Add `shadowAsk?` to `OrchestratorChatCtx` and branch:

```ts
// OrchestratorChatCtx gains:
//   shadowAsk?: (goalId: string, input: { systemPrompt: string; userPrompt: string; timeoutMs: number }) => Promise<{ text: string }>;

// inside createOrchestratorMessage, AFTER inserting the user message and reading goal/currentStep:

const hasActiveRun = Boolean(goal.active_workflow_run_id);
if (hasActiveRun) {
  // Defer to the mediator (onUserMessage) which posts the reply asynchronously.
  return CreateOrchestratorMessageResponse.parse({ message: userMessage, reply: null });
}

let replyText: string;
if (goal.orchestrator_provider === "orca/anthropic") {
  if (!ctx.shadowAsk) throw new OrchestratorChatProviderUnavailableError(goal.orchestrator_provider);
  const sys = [
    "You are Orca's goal orchestrator.",
    "Answer the user's freeform guidance message for the current goal.",
    "This is chat-only guidance: do not claim that recommendations, workflow steps, artifacts, or decisions were changed.",
    'Return JSON: {"replyText":"..."}.',
    "Output protocol: wrap that JSON in a fenced ```orca:action block and emit nothing after the closing fence.",
  ].join("\n");
  const usr = JSON.stringify({
    goal: { id: goal.id, title: goal.title, description: goal.description },
    userMessage: parsed.body,
  });
  const out = await ctx.shadowAsk(goalId, { systemPrompt: sys, userPrompt: usr, timeoutMs: 60_000 });
  replyText = GuidanceReply.parse(JSON.parse(out.text)).replyText;
} else {
  // one-shot SDK providers (orca/openai, orca/google-gemini) keep the existing path.
  const provider = ctx.modelProviderRegistry.get(goal.orchestrator_provider);
  if (!provider) throw new OrchestratorChatProviderUnavailableError(goal.orchestrator_provider);
  const completion = await provider.complete<unknown>({ /* existing args unchanged */ } as any);
  replyText = GuidanceReply.parse(completion.parsed).replyText;
}

const replyMessage = insertMessageWithEvent(ctx, {
  id: idFactory(),
  goalId,
  role: "orchestrator",
  body: replyText,
  correlationId,
  createdAt: now(),
});
return CreateOrchestratorMessageResponse.parse({ message: userMessage, reply: replyMessage });
```

Keep the existing `provider.complete` argument object intact for the SDK branch (do not delete it — move it under the `else`). Preserve the early `GoalOrchestratorModelMissingError` guard (a goal still needs a provider+model selected).

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @orca/daemon test -- usecases.shadow orchestrator-chat`
Expected: PASS. Update any existing `createOrchestratorMessage` test that asserted a non-null `reply` shape if it now exercises the active-run path.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/workflows/index.ts apps/daemon/src/orchestrator-chat/usecases.ts apps/daemon/src/orchestrator-chat/usecases.shadow.test.ts
git commit -m "feat(daemon): route orca/anthropic chat reply through shadow session; nullable reply"
```

---

### Task 8: Append sentinel instruction to orchestrator system prompt

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/prompts.ts:60`
- Test: `apps/daemon/src/orchestrator-llm/prompts.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/orchestrator-llm/prompts.test.ts
import { describe, it, expect } from "vitest";
import { composeOrchestratorPrompt } from "./prompts.js";
import { SENTINEL_INSTRUCTION } from "./sentinel.js";

describe("composeOrchestratorPrompt", () => {
  it("system prompt includes the orca:action sentinel instruction", () => {
    const p = composeOrchestratorPrompt({
      triggerKind: "user_message",
      context: {
        goal: { id: "G1", title: "T", description: "D", attachedWorkspaces: [] },
        workflowRun: { templateId: "", templateVersion: 0, ordinal: 0, status: "active" },
        currentStep: { id: "", instructions: "", outputSchema: [], agentAdapterId: "claude-code", executionMode: "shadow_session" },
        conversation: { chatMessages: [], currentStepAgentTurns: [] },
        priorStepArtifacts: [],
      },
      triggerPayload: { userMessage: "hi" },
    });
    expect(p.systemPrompt).toContain(SENTINEL_INSTRUCTION);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- prompts`
Expected: FAIL — sentinel text absent from systemPrompt.

- [ ] **Step 3: Implement**

In `composeOrchestratorPrompt`, import and append:

```ts
import { SENTINEL_INSTRUCTION } from "./sentinel.js";
// ...
const systemPrompt = [
  "You are the orchestrator-LLM for an Orca workflow run.",
  // ...existing lines unchanged...
  "Return exactly one structured action.",
  "",
  SENTINEL_INSTRUCTION,
].join("\n");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- prompts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/prompts.ts apps/daemon/src/orchestrator-llm/prompts.test.ts
git commit -m "feat(daemon): orchestrator system prompt emits orca:action sentinel block"
```

---

### Task 9: Production wiring in server.ts + daemon-context

**Files:**
- Modify: `apps/daemon/src/server.ts` (lines ~451–466 mediator/spawn; ~534–560 bootstrap; ~980–994 chat routes; run-completion teardown)
- Modify: `apps/daemon/src/daemon-context.ts` (expose `ptyManager` + orchestrator adapter spawn resolver)
- Test: `apps/daemon/src/orchestrator-shadow-wiring.test.ts` (integration-style with fakes)

This task has no new algorithm — it connects Tasks 1–8. Because `createServer` is large, the test asserts the wiring contract via a focused harness rather than booting the whole server.

- [ ] **Step 1: Construct the shadow manager + client + mediator, replace the placeholders**

In `createDaemonContext` (`daemon-context.ts`), expose a `ptyManager` (the same `NodePtyManager` the `SessionRuntime` uses) and a resolver that builds the claude-code spawn command for a goal. The Claude Code adapter already resolves its binary via `ClaudeCodeAdapter.resolveSpawn` (`adapters/claude-code.ts:43`); reuse it:

```ts
// daemon-context.ts — add to DaemonContext and createDaemonContext return:
//   ptyManager: PtyManager;
// construct once:
const ptyManager = new NodePtyManager();
// ...return { ...existing, ptyManager };
```

In `server.ts`, before constructing `orchestratorService`:

```ts
import { ShadowSessionManager } from "./orchestrator-llm/shadow-session.js";
import { ShadowSessionLlmClient } from "./orchestrator-llm/shadow-llm-client.js";
import { OrchestratorMediator } from "./orchestrator-llm/mediator.js";
import { composeOrchestratorPrompt } from "./orchestrator-llm/prompts.js";
import { buildContextFromDb } from "./orchestrator-llm/build-context.js";

const claudeAdapter = daemonContext.adapterRegistry?.get?.("claude-code"); // see note
const shadowSessions = new ShadowSessionManager({
  ptyManager: daemonContext.ptyManager,
  resolveSpawn: (goalId) => {
    // claude-code adapter resolves binary/env; cwd = goal's first workspace root.
    const ws = firstWorkspaceRootForGoal(db, goalId) ?? process.cwd();
    const spawn = resolveClaudeShadowSpawn(goalId, ws); // small helper below
    return spawn;
  },
});

const shadowClient = new ShadowSessionLlmClient(shadowSessions, { timeoutMs: 60_000 });

const orchestratorMediator = new OrchestratorMediator({
  llm: shadowClient,
  buildContext: ({ goalId, runId, stepRunId }) =>
    buildContextFromDb(db, { goalId, runId, stepRunId, payloadBudgetBytes: 64 * 1024 }),
  composePrompt: composeOrchestratorPrompt,
});
```

Then change the `new OrchestratorService(...)` call (`server.ts:451`) to pass `orchestratorMediator` instead of `undefined` at the mediator position (line 462).

> Note on `adapterRegistry`: if it is not already on `daemonContext`, resolve the claude binary directly in `resolveClaudeShadowSpawn` using the same `ORCA_CLAUDE_CODE_BIN`/`"claude"` candidates as `adapters/claude-code.ts:161`. Add `resolveClaudeShadowSpawn(goalId, cwd)` as a small local helper in `server.ts` that returns `{ command, args: [], env: buildSpawnEnv(...)|process.env subset, cwd }`. Keep env minimal; never include `ORCA_*` mutation tokens (mirror the deny-list in `hidden-worker/runtime.ts:30`).

- [ ] **Step 2: Real `spawnOrchestratorSessionFn`**

Replace the placeholder (`server.ts:553`):

```ts
spawnOrchestratorSessionFn: async (goalId, _runId) => {
  return shadowSessions.spawn(goalId);
},
```

- [ ] **Step 3: Wire shadow ask into chat routes**

In `registerOrchestratorChatRoutes(...)` deps (`server.ts:980`), add:

```ts
shadowAsk: (goalId, input) => shadowSessions.ask(goalId, input),
```

and thread `shadowAsk` from `OrchestratorChatRouteDeps` into the `createOrchestratorMessage` ctx (Task 7 added the ctx field; add the matching field to `OrchestratorChatRouteDeps` and pass it in `routes.ts`).

- [ ] **Step 4: Terminate the shadow session on run completion**

Find where a run transitions to `complete` (the mark-done path / `commitAdvanceOrComplete` terminal branch in `service.ts`). The service does not own the shadow manager, so expose a teardown hook: add an optional `onRunComplete?: (goalId: string) => void` to `OrchestratorService` options/constructor, and in `server.ts` pass `onRunComplete: (goalId) => void shadowSessions.terminate(goalId)`. If adding that hook is out of scope for this task, instead terminate in the same place `server.ts` observes `workflow.run.completed` events on the bus:

```ts
eventBus.subscribe?.((event) => {
  if (event.type === "workflow.run.completed" && event.goalId) {
    void shadowSessions.terminate(event.goalId);
  }
});
```

Use whichever subscription pattern the codebase already uses for `eventBus` (grep `eventBus.subscribe` / `bus.on`). Do not invent a new bus API.

- [ ] **Step 5: Respawn on boot resume**

In the existing `resumeActiveRuns` block (`server.ts:475`), add a shadow respawn for each active run alongside the agent respawn:

```ts
// inside respawn / per active run handling:
await shadowSessions.spawn(goalId);
```

- [ ] **Step 6: Write the wiring test**

```ts
// apps/daemon/src/orchestrator-shadow-wiring.test.ts
import { describe, it, expect } from "vitest";
import { ShadowSessionManager } from "./orchestrator-llm/shadow-session.js";
import { ShadowSessionLlmClient } from "./orchestrator-llm/shadow-llm-client.js";
import { OrchestratorMediator } from "./orchestrator-llm/mediator.js";
import { composeOrchestratorPrompt } from "./orchestrator-llm/prompts.js";
import { FakePtyManager } from "./pty/fake.js";

describe("shadow orchestrator wiring", () => {
  it("mediator.invoke drives a paraphrase action end-to-end via the shadow session", async () => {
    const pty = new FakePtyManager();
    const mgr = new ShadowSessionManager({
      ptyManager: pty,
      resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
      pollIntervalMs: 1,
    });
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
      triggerKind: "user_message",
      goalId: "G1", runId: "R1", stepRunId: "S1",
      adapterId: "claude-code", modelId: "claude-haiku-4-5",
      triggerPayload: { userMessage: "hi" },
    });
    await new Promise((r) => setTimeout(r, 5));
    pty.handles[0].emitData('```orca:action\n{"kind":"answer_user_directly","body":"hello"}\n```\n');

    const action = await p;
    expect(action.kind).toBe("answer_user_directly");
    if (action.kind === "answer_user_directly") expect(action.body).toBe("hello");
  });
});
```

- [ ] **Step 7: Run the wiring test + typecheck**

Run: `pnpm --filter @orca/daemon test -- orchestrator-shadow-wiring`
Expected: PASS.
Run: `pnpm -r typecheck`
Expected: PASS (resolve any signature mismatches from the `goalId` field added in Task 5 and the nullable `reply` from Task 7).

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/daemon-context.ts apps/daemon/src/orchestrator-chat/routes.ts apps/daemon/src/orchestrator-shadow-wiring.test.ts
git commit -m "feat(daemon): wire production shadow orchestrator session + mediator"
```

---

### Task 10: Full-suite gate + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full daemon + contracts suites**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: PASS across all packages. Fix regressions before proceeding (most likely: tests that constructed `OrchestratorService` with `undefined` mediator and asserted the no-op early-return — update them to inject a fake mediator or assert the new behavior).

- [ ] **Step 2: Manual smoke (requires a logged-in Claude Code CLI, NO `ANTHROPIC_API_KEY`)**

1. Ensure `claude auth status --json` reports `loggedIn: true`.
2. Ensure `ANTHROPIC_API_KEY` is **unset** in the daemon env (this is the point — subscription auth).
3. Start the app, create a goal with the Anthropic orchestrator model selected.
4. Type a message in the orchestrator chat and Send.
5. Expected: no 500 flash; an orchestrator reply appears (sourced from the shadow Claude Code session). Daemon log shows no `ANTHROPIC_API_KEY not set` `ProviderError`.

- [ ] **Step 3: Commit any test fixups**

```bash
git add -A
git commit -m "test(daemon): update orchestrator suites for live shadow mediator"
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** This plan implements sub-plan 3 production wiring (shadow session + mediator) and the chat-reply re-route. It does NOT change the step-agent dispatch, template v4, UI, or M9 hidden-worker transport — those are already implemented per the 2026-05-28 design.
- **Known sequencing risk:** Task 5 changes `OrchestratorLlmClient.request` to add `goalId`. Every fake `llm.request` in existing mediator/judgement tests must accept the extra field. Grep `request: ` / `llm:` in `apps/daemon/src/**/*.test.ts` and fix before Task 10.
- **Quiescence vs sentinel:** capture relies on the orchestrator emitting the `orca:action` fence. If a model ignores the protocol, `ask` times out → `invokeWithBackoff` retries → persistent failure surfaces as the existing "orchestrator unavailable" chat message. That is the correct degradation; do not add a second heuristic in this plan.
- **Out of scope (follow-ups):** installing the Claude Code `Stop` hook for lower-latency response detection; PTY-tail quiescence as an alternate capture; settings UI for switching a goal's orchestrator provider; multi-workspace cwd selection for the shadow session (uses the first attached workspace).
```

