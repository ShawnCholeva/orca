# Worker Permission Modes — Phase 1A (Daemon Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the daemon side of per-goal worker tool-permission modes (Auto-run / Ask-in-chat) for the **Claude** provider, routed through a consolidated provider seam so workers stop being a Claude-hardcoded path — eliminating the unattended-permission-prompt deadlock.

**Architecture:** A catch-all `PermissionRequest` hook on each worker calls a new daemon endpoint. The daemon reads the goal's `workerPermissionMode`: `auto` → allow immediately; `ask` → post a chat approval card and hold the hook open (reusing the existing worker-question hold/answer machinery) until answered or a long timeout, which **denies**. Worker hook injection moves from the hardcoded `buildAgentHookSettings` into a provider `workerHookConfig()` method consumed by `WorkerSessionManager`.

**Tech Stack:** TypeScript, Fastify (daemon HTTP), better-sqlite3 + SQL file migrations, Zod (`@orca/contracts`), Vitest. Claude Code hooks (`PermissionRequest`, HTTP handler, Bearer auth).

**Correctness priority:** This is a security-sensitive subsystem. Every decision path is tested, and the default on any ambiguity (timeout, unknown session, malformed input) is **deny**, never silent-allow.

**Scope note:** This plan is Phase 1A (daemon) of the spec `docs/superpowers/specs/2026-06-03-orca-worker-permission-modes-design.md`. The desktop UI (toggle control + approval card) is Phase 1B, a separate plan. Codex/Antigravity providers and "Always allow" are later phases. In this plan, Codex/Antigravity `workerHookConfig` returns an empty config (no behavior change for them) so the interface is satisfied without implementing their permission flow yet.

---

## Key codebase facts (verified — do not re-derive)

- **Goal contract:** `packages/contracts/src/index.ts:26-39`. `autonomyLevel` (line 31) is the pattern for a defaulted scalar field.
- **OrchestratorChatMessage + PendingQuestion:** `packages/contracts/src/index.ts:1003-1027`. `pendingQuestion: PendingQuestion.optional()` is the pattern to mirror with `pendingApproval`.
- **Goal DB mapping:** `apps/daemon/src/goals.ts` — `GoalRow` (~line 55-69), `rowToGoal` (line 67-79), create-goal return object (~line 304-318, includes `autonomyLevel: 1`).
- **Migrations:** SQL files in `apps/daemon/migrations/`, registered in the `migrationFiles` array `apps/daemon/src/migrations.ts:14-36` (latest entry `"0022_workflow_step_result.sql"`). Each file runs in a transaction.
- **Message insert/read:** `insertMessageWithEvent` (`apps/daemon/src/orchestrator-chat/usecases.ts:215`) writes `orchestrator_messages` incl. `pending_question`. `listOrchestratorMessagesByGoal` (`apps/daemon/src/orchestrator-chat/projection.ts:8-45`) reads them back and parses `pending_question`.
- **Worker-question machinery to clone:** `apps/daemon/src/workflows/orchestrator/worker-questions.ts` (`WorkerQuestionStore`: record/get/resolveAnswers, dedupe by `toolUseId`). Wired in `server.ts:1106-1142` (`onWorkerQuestion`) with the held-promise + `ELICIT_ANSWER_TIMEOUT_MS = 590_000` (`server.ts:523`) timeout, and the answer route `server.ts:1146-1160`.
- **Agent hook routes:** `apps/daemon/src/agent-hooks/routes.ts` — `registerAgentHookRoutes(server, deps)` with `onResponseDone`, `resolveAdapterForSession`, `onWorkerQuestion`. Wired at `server.ts:1097-1142`. Session→goal lookup: `db.prepare("SELECT goal_id FROM sessions WHERE id = ?")`.
- **Claude worker hook settings (today):** `apps/daemon/src/agent-hooks/hook-settings.ts` — `buildAgentHookSettings({sessionId, port, authToken})` returns `{hooks:{Stop, StopFailure, PreToolUse:[{matcher:"AskUserQuestion", ...}]}}`. `agentHookUrl(port, sessionId, failure)` and `elicitHookUrl(port, sessionId)` build URLs.
- **Worker spawn:** `WorkerSessionManager.spawn({sessionId, workspacePath, command, env})` (`apps/daemon/src/workflows/orchestrator/worker-session.ts:60-79`) writes `settings.json` under `cfgDir = join(privateRoot, sessionId)` and launches `${command} --settings <path>`. Called from `server.ts:561` inside `workerSpawn`, which **already has `goalId` and `adapterId` in scope** (`server.ts:555`).
- **Provider seam (shadow):** `apps/daemon/src/orchestrator-llm/providers/types.ts` (`ShadowProvider` interface), `registry.ts` (`resolveShadowProvider(id)`), `claude.ts` (`ClaudeShadowProvider`). `shadow-session.ts:287` writes `provider.hookConfig().files`.
- **Test commands:** daemon `cd apps/daemon && pnpm vitest run <path>`; contracts `cd packages/contracts && pnpm vitest run <path>`.

---

## File structure

- **Contracts** (`packages/contracts/src/index.ts`): `WorkerPermissionMode`, `Goal.workerPermissionMode`, `PendingApproval`, `OrchestratorChatMessage.pendingApproval`, `SubmitPermissionDecisionRequest`, `UpdateWorkerPermissionModeRequest`.
- **Migration** (`apps/daemon/migrations/0023_worker_permission_mode.sql` + registration): adds `goals.worker_permission_mode` and `orchestrator_messages.pending_approval`.
- **Goal mapping** (`apps/daemon/src/goals.ts`): row↔contract for the new field.
- **Message persistence** (`apps/daemon/src/orchestrator-chat/usecases.ts`, `projection.ts`): write/read `pending_approval`.
- **Approval store** (new `apps/daemon/src/workflows/orchestrator/permission-approvals.ts`): clone of `WorkerQuestionStore`.
- **Provider seam** (`providers/types.ts`, `claude.ts`, `codex.ts`, `antigravity.ts`, `hook-settings.ts`): `workerHookConfig()` + Claude `PermissionRequest`.
- **Worker session** (`worker-session.ts`): consume `workerHookConfig` from an injected `resolveProvider`.
- **Hook endpoint + answer route + mode toggle** (`agent-hooks/routes.ts`, `server.ts`): the decision flow.

---

## Task 1: Contracts — mode enum, goal field, pendingApproval, request schemas

**Files:**
- Modify: `packages/contracts/src/index.ts` (Goal ~26-39; chat message ~1003-1027)
- Test: `packages/contracts/src/__tests__/worker-permission-modes.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/__tests__/worker-permission-modes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  Goal,
  PendingApproval,
  OrchestratorChatMessage,
  SubmitPermissionDecisionRequest,
  UpdateWorkerPermissionModeRequest,
} from "../index.js";

const baseGoal = {
  id: "g1", title: "t", description: "d", status: "active" as const,
  createdAt: "2026-06-03T00:00:00.000Z", updatedAt: "2026-06-03T00:00:00.000Z",
  archivedAt: null,
};

describe("worker permission modes contracts", () => {
  it("Goal defaults workerPermissionMode to 'ask'", () => {
    expect(Goal.parse(baseGoal).workerPermissionMode).toBe("ask");
  });

  it("Goal accepts 'auto' and rejects unknown modes", () => {
    expect(Goal.parse({ ...baseGoal, workerPermissionMode: "auto" }).workerPermissionMode).toBe("auto");
    expect(Goal.safeParse({ ...baseGoal, workerPermissionMode: "yolo" }).success).toBe(false);
  });

  it("PendingApproval round-trips and is strict", () => {
    const ok = { approvalId: "a1", sessionId: "s1", toolName: "Bash", summary: "rm -rf x", detail: "rm -rf x --force" };
    expect(PendingApproval.parse(ok)).toMatchObject(ok);
    expect(PendingApproval.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    // detail is optional
    expect(PendingApproval.safeParse({ approvalId: "a1", sessionId: "s1", toolName: "Bash", summary: "ls" }).success).toBe(true);
  });

  it("OrchestratorChatMessage carries an optional pendingApproval", () => {
    const msg = {
      id: "m1", goalId: "g1", role: "orchestrator" as const, kind: "message" as const,
      body: "The agent wants to run a command.", correlationId: "c1",
      createdAt: "2026-06-03T00:00:00.000Z",
      pendingApproval: { approvalId: "a1", sessionId: "s1", toolName: "Bash", summary: "ls" },
    };
    expect(OrchestratorChatMessage.parse(msg).pendingApproval?.approvalId).toBe("a1");
  });

  it("SubmitPermissionDecisionRequest validates decision + remember default", () => {
    expect(SubmitPermissionDecisionRequest.parse({ decision: "allow" })).toEqual({ decision: "allow", remember: false });
    expect(SubmitPermissionDecisionRequest.parse({ decision: "deny", remember: true })).toEqual({ decision: "deny", remember: true });
    expect(SubmitPermissionDecisionRequest.safeParse({ decision: "maybe" }).success).toBe(false);
  });

  it("UpdateWorkerPermissionModeRequest validates the mode", () => {
    expect(UpdateWorkerPermissionModeRequest.parse({ workerPermissionMode: "auto" }).workerPermissionMode).toBe("auto");
    expect(UpdateWorkerPermissionModeRequest.safeParse({ workerPermissionMode: "x" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/contracts && pnpm vitest run src/__tests__/worker-permission-modes.test.ts`
Expected: FAIL — `PendingApproval`, `SubmitPermissionDecisionRequest`, `UpdateWorkerPermissionModeRequest`, `workerPermissionMode` are not exported.

- [ ] **Step 3: Add the schemas**

In `packages/contracts/src/index.ts`, just before `export const Goal = z.object({` (line 26), add:

```ts
export const WorkerPermissionMode = z.enum(["ask", "auto"]);
export type WorkerPermissionMode = z.infer<typeof WorkerPermissionMode>;
```

Inside the `Goal` object, add the field right after `autonomyLevel` (line 31):

```ts
  workerPermissionMode: WorkerPermissionMode.default("ask"),
```

After the `OrchestratorChatMessage` block (after line 1027), add:

```ts
export const PendingApproval = z
  .object({
    approvalId: z.string().min(1),
    sessionId: z.string().min(1),
    toolName: z.string().min(1).max(100),
    summary: z.string().min(1).max(4000),
    detail: z.string().max(20_000).optional(),
  })
  .strict();
export type PendingApproval = z.infer<typeof PendingApproval>;

export const SubmitPermissionDecisionRequest = z
  .object({
    decision: z.enum(["allow", "deny"]),
    remember: z.boolean().default(false),
  })
  .strict();
export type SubmitPermissionDecisionRequest = z.infer<typeof SubmitPermissionDecisionRequest>;

export const UpdateWorkerPermissionModeRequest = z
  .object({ workerPermissionMode: WorkerPermissionMode })
  .strict();
export type UpdateWorkerPermissionModeRequest = z.infer<typeof UpdateWorkerPermissionModeRequest>;
```

Add `pendingApproval` to the `OrchestratorChatMessage` object, right after `pendingQuestion: PendingQuestion.optional()` (line 1024) — change it to:

```ts
    pendingQuestion: PendingQuestion.optional(),
    pendingApproval: PendingApproval.optional()
```

Note: `PendingApproval` is referenced by `OrchestratorChatMessage` (defined above it). Zod evaluates `.optional()` lazily enough for top-level consts declared after, **but** to avoid a temporal-dead-zone reference error, move the three new `export const`s (`PendingApproval`, `SubmitPermissionDecisionRequest`, `UpdateWorkerPermissionModeRequest`) to **just before** `export const OrchestratorChatMessage = z` (line 1012) instead of after. Define `PendingApproval` first, then `OrchestratorChatMessage` can reference it directly.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/contracts && pnpm vitest run src/__tests__/worker-permission-modes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full contracts suite (guard against breaking existing Goal consumers)**

Run: `cd packages/contracts && pnpm vitest run`
Expected: PASS. (If a fixture builds a `Goal` without `workerPermissionMode`, the `.default("ask")` keeps it valid — no breakage expected.)

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/__tests__/worker-permission-modes.test.ts
git commit -m "feat(contracts): worker permission mode, pendingApproval, decision request schemas"
```

---

## Task 2: DB migration + goal mapping for `workerPermissionMode`

**Files:**
- Create: `apps/daemon/migrations/0023_worker_permission_mode.sql`
- Modify: `apps/daemon/src/migrations.ts:36` (register), `apps/daemon/src/goals.ts` (GoalRow, rowToGoal, createGoal return)
- Test: `apps/daemon/src/goals.test.ts` (add a case — or create `goals.permission-mode.test.ts` if the file is large)

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/goals.test.ts` (follow the existing in-memory-db setup in that file; if it uses a helper like `makeDb()`/`migrate()`, reuse it). The assertion:

```ts
it("new goals default workerPermissionMode to 'ask' and round-trip through the DB", () => {
  const db = makeMigratedDb(); // existing helper in this test file
  const created = createGoal({ db, bus: stubBus() }, { title: "G", description: "" });
  expect(created.workerPermissionMode).toBe("ask");
  const fetched = getGoal(db, created.id);
  expect(fetched.workerPermissionMode).toBe("ask");
});
```

(If `goals.test.ts` exposes different helper names, adapt to them — the behavior asserted is: created goal and re-fetched goal both have `workerPermissionMode: "ask"`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/goals.test.ts -t "workerPermissionMode"`
Expected: FAIL — column missing / property `undefined`.

- [ ] **Step 3: Create the migration SQL**

Create `apps/daemon/migrations/0023_worker_permission_mode.sql`:

```sql
-- Per-goal worker tool-permission mode: 'ask' (relay residual permission prompts
-- to chat) or 'auto' (auto-allow). Default 'ask' (safe by default).
ALTER TABLE goals
  ADD COLUMN worker_permission_mode TEXT NOT NULL DEFAULT 'ask'
  CHECK (worker_permission_mode IN ('ask', 'auto'));

-- Chat messages can carry a pending permission-approval payload (JSON), parallel
-- to the existing pending_question column.
ALTER TABLE orchestrator_messages
  ADD COLUMN pending_approval TEXT;
```

- [ ] **Step 4: Register the migration**

In `apps/daemon/src/migrations.ts`, add to the `migrationFiles` array immediately after `"0022_workflow_step_result.sql",` (line 35):

```ts
  "0023_worker_permission_mode.sql",
```

- [ ] **Step 5: Map the field in `goals.ts`**

In `GoalRow` (the interface near line 55-69), add after `archived_at: string | null;`:

```ts
  worker_permission_mode: string;
```

In `rowToGoal` (line 67-79), add to the `Goal.parse({ ... })` object after `archivedAt: row.archived_at,`:

```ts
    workerPermissionMode: row.worker_permission_mode,
```

In the create-goal return object (~line 304-318), add after `archivedAt: null,`:

```ts
    workerPermissionMode: "ask",
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/daemon && pnpm vitest run src/goals.test.ts -t "workerPermissionMode"`
Expected: PASS.

- [ ] **Step 7: Run the goals + migrations suites**

Run: `cd apps/daemon && pnpm vitest run src/goals.test.ts src/migrations.test.ts`
Expected: PASS. (If `migrations.test.ts` asserts the exact `migrationFiles` length/contents, update that expectation to include `0023_worker_permission_mode.sql`.)

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/migrations/0023_worker_permission_mode.sql apps/daemon/src/migrations.ts apps/daemon/src/goals.ts apps/daemon/src/goals.test.ts
git commit -m "feat(daemon): persist worker_permission_mode and pending_approval column"
```

---

## Task 3: Persist + project `pendingApproval` on chat messages

**Files:**
- Modify: `apps/daemon/src/orchestrator-chat/usecases.ts:215-245` (`insertMessageWithEvent`), `apps/daemon/src/orchestrator-chat/projection.ts:8-45`
- Test: `apps/daemon/src/orchestrator-chat/projection.test.ts` (add a case; create if absent)

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/orchestrator-chat/projection.test.ts` (reuse the file's migrated-db helper; if none, create the file using better-sqlite3 + `runMigrations`):

```ts
it("round-trips a message's pendingApproval payload", () => {
  const db = makeMigratedDb();
  insertGoalRow(db, "g1"); // helper that inserts a minimal goals row
  const approval = { approvalId: "a1", sessionId: "s1", toolName: "Bash", summary: "ls" };
  insertMessageWithEvent(
    { db, bus: stubBus(), now: () => "2026-06-03T00:00:00.000Z", idFactory: () => "m1" },
    { id: "m1", goalId: "g1", role: "orchestrator", body: "The agent wants to run a command.",
      correlationId: "c1", createdAt: "2026-06-03T00:00:00.000Z", pendingApproval: approval },
  );
  const messages = listOrchestratorMessagesByGoal(db, "g1");
  expect(messages[0].pendingApproval).toMatchObject(approval);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/orchestrator-chat/projection.test.ts -t "pendingApproval"`
Expected: FAIL — `insertMessageWithEvent` rejects `pendingApproval` / column not written / not parsed back.

- [ ] **Step 3: Extend `insertMessageWithEvent`**

In `apps/daemon/src/orchestrator-chat/usecases.ts`, import the type at the top (next to `PendingQuestionT`):

```ts
import type { PendingApproval as PendingApprovalT } from "@orca/contracts";
```

Extend the `message` param type (after `pendingQuestion?: PendingQuestionT;`):

```ts
    pendingApproval?: PendingApprovalT;
```

Update the INSERT (the SQL at line ~231 and the `.run(...)` args) to include `pending_approval`:

```ts
      .prepare(
        `INSERT INTO orchestrator_messages
          (id, goal_id, role, kind, body, correlation_id, created_at, pending_question, pending_approval)
         VALUES (?, ?, ?, 'message', ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.goalId,
        message.role,
        message.body,
        message.correlationId,
        message.createdAt,
        message.pendingQuestion != null ? JSON.stringify(message.pendingQuestion) : null,
        message.pendingApproval != null ? JSON.stringify(message.pendingApproval) : null
      );
```

- [ ] **Step 4: Project it back in `projection.ts`**

In `apps/daemon/src/orchestrator-chat/projection.ts`, add `PendingApproval` to the import from `@orca/contracts`, add `pending_approval` to the SELECT column list, and parse it. Change the SELECT to:

```ts
      `SELECT id, goal_id, role, kind, body, correlation_id, created_at, raw_agent_text, why_rationale, internal_kind, pending_question, pending_approval
         FROM orchestrator_messages
        WHERE goal_id = ?
        ORDER BY created_at ASC, id ASC`
```

Inside `rows.map`, after the `pendingQuestion` parsing block, add:

```ts
    let pendingApproval: unknown = undefined;
    if (typeof row.pending_approval === "string" && row.pending_approval) {
      try {
        const parsed = JSON.parse(row.pending_approval);
        if (PendingApproval.safeParse(parsed).success) pendingApproval = parsed;
      } catch { /* ignore malformed */ }
    }
```

And add to the `OrchestratorChatMessage.parse({ ... })` spread (after the pendingQuestion spread):

```ts
      ...(pendingApproval !== undefined ? { pendingApproval } : {}),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/daemon && pnpm vitest run src/orchestrator-chat/projection.test.ts -t "pendingApproval"`
Expected: PASS.

- [ ] **Step 6: Run the orchestrator-chat suite**

Run: `cd apps/daemon && pnpm vitest run src/orchestrator-chat/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/orchestrator-chat/usecases.ts apps/daemon/src/orchestrator-chat/projection.ts apps/daemon/src/orchestrator-chat/projection.test.ts
git commit -m "feat(daemon): persist and project pendingApproval on chat messages"
```

---

## Task 4: `PermissionApprovalStore` (held-decision store)

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/permission-approvals.ts`
- Test: `apps/daemon/src/workflows/orchestrator/permission-approvals.test.ts`

This is a near-clone of `worker-questions.ts` (`WorkerQuestionStore`), specialized for a single allow/deny decision.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/orchestrator/permission-approvals.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PermissionApprovalStore } from "./permission-approvals.js";

describe("PermissionApprovalStore", () => {
  it("records a pending approval and resolves it with a decision", async () => {
    const store = new PermissionApprovalStore(() => "fixed-id");
    const handle = store.record({ toolUseId: "t1", sessionId: "s1", goalId: "g1", toolName: "Bash", summary: "ls" });
    expect(handle.isNew).toBe(true);
    expect(handle.approvalId).toBe("fixed-id");
    const ok = store.resolveDecision("fixed-id", "allow");
    expect(ok).toBe(true);
    await expect(handle.answered).resolves.toBe("allow");
  });

  it("dedupes a duplicate toolUseId to the same pending approval (isNew=false)", () => {
    const store = new PermissionApprovalStore();
    const first = store.record({ toolUseId: "dup", sessionId: "s1", goalId: "g1", toolName: "Bash", summary: "ls" });
    const second = store.record({ toolUseId: "dup", sessionId: "s1", goalId: "g1", toolName: "Bash", summary: "ls" });
    expect(second.isNew).toBe(false);
    expect(second.approvalId).toBe(first.approvalId);
  });

  it("resolveDecision returns false for an unknown or already-resolved approval", () => {
    const store = new PermissionApprovalStore(() => "x");
    expect(store.resolveDecision("nope", "deny")).toBe(false);
    store.record({ toolUseId: "t", sessionId: "s", goalId: "g", toolName: "Bash", summary: "ls" });
    expect(store.resolveDecision("x", "deny")).toBe(true);
    expect(store.resolveDecision("x", "deny")).toBe(false); // already resolved
  });

  it("get returns the pending approval's goalId for scope checks", () => {
    const store = new PermissionApprovalStore(() => "x");
    store.record({ toolUseId: "t", sessionId: "s", goalId: "g9", toolName: "Bash", summary: "ls" });
    expect(store.get("x")?.goalId).toBe("g9");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/workflows/orchestrator/permission-approvals.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the store**

Create `apps/daemon/src/workflows/orchestrator/permission-approvals.ts`:

```ts
export type PermissionDecision = "allow" | "deny";

export interface PendingPermissionApproval {
  toolUseId: string;
  sessionId: string;
  goalId: string;
  toolName: string;
  summary: string;
  detail?: string;
  resolve: (decision: PermissionDecision) => void;
  answered: Promise<PermissionDecision>;
}

export interface RecordApprovalInput {
  toolUseId: string;
  sessionId: string;
  goalId: string;
  toolName: string;
  summary: string;
  detail?: string;
}

export interface ApprovalHandle {
  approvalId: string;
  answered: Promise<PermissionDecision>;
  /** False when a duplicate hook fire (same toolUseId) reuses an existing approval. */
  isNew: boolean;
}

export class PermissionApprovalStore {
  private readonly pending = new Map<string, PendingPermissionApproval>();
  private readonly byToolUseId = new Map<string, string>();

  constructor(private readonly idFactory: () => string = () => Math.random().toString(36).slice(2)) {}

  record(input: RecordApprovalInput): ApprovalHandle {
    const existingId = this.byToolUseId.get(input.toolUseId);
    if (existingId) {
      const existing = this.pending.get(existingId);
      if (existing) return { approvalId: existingId, answered: existing.answered, isNew: false };
    }
    const approvalId = this.idFactory();
    let resolve!: (decision: PermissionDecision) => void;
    const answered = new Promise<PermissionDecision>((res) => { resolve = res; });
    this.pending.set(approvalId, { ...input, resolve, answered });
    this.byToolUseId.set(input.toolUseId, approvalId);
    return { approvalId, answered, isNew: true };
  }

  get(approvalId: string): PendingPermissionApproval | undefined {
    return this.pending.get(approvalId);
  }

  /** Resolves the held hook with the decision. Returns false if absent/already resolved. */
  resolveDecision(approvalId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    this.pending.delete(approvalId);
    this.byToolUseId.delete(entry.toolUseId);
    entry.resolve(decision);
    return true;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/daemon && pnpm vitest run src/workflows/orchestrator/permission-approvals.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/permission-approvals.ts apps/daemon/src/workflows/orchestrator/permission-approvals.test.ts
git commit -m "feat(daemon): PermissionApprovalStore for held allow/deny decisions"
```

---

## Task 5: Provider seam — `workerHookConfig` + Claude `PermissionRequest`

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/providers/types.ts` (interface), `claude.ts`, `codex.ts`, `antigravity.ts` (implement), `apps/daemon/src/agent-hooks/hook-settings.ts` (add PermissionRequest + the worker config builder)
- Test: `apps/daemon/src/agent-hooks/hook-settings.test.ts` (add cases; create if absent), `apps/daemon/src/orchestrator-llm/providers/worker-hook-config.test.ts` (create)

- [ ] **Step 1: Write the failing test (hook settings include PermissionRequest)**

Add to `apps/daemon/src/agent-hooks/hook-settings.test.ts`:

```ts
import { buildAgentHookSettings, permissionHookUrl } from "./hook-settings.js";

it("permissionHookUrl points at the permission endpoint with the session id", () => {
  expect(permissionHookUrl(1234, "s1")).toBe("http://127.0.0.1:1234/v1/agent-hooks/permission?sessionId=s1");
});

it("worker hook settings include a catch-all PermissionRequest hook", () => {
  const s = buildAgentHookSettings({ sessionId: "s1", port: 1234, authToken: "tok" });
  const pr = s.hooks.PermissionRequest;
  expect(pr).toBeDefined();
  expect(pr![0].matcher).toBe("*");
  expect(pr![0].hooks[0]).toMatchObject({
    type: "http",
    url: "http://127.0.0.1:1234/v1/agent-hooks/permission?sessionId=s1",
  });
  // long timeout so the daemon can hold the decision open
  expect(pr![0].hooks[0].timeout).toBeGreaterThanOrEqual(600);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/agent-hooks/hook-settings.test.ts -t "PermissionRequest"`
Expected: FAIL — `permissionHookUrl` undefined / no `PermissionRequest` key.

- [ ] **Step 3: Add the PermissionRequest hook to `hook-settings.ts`**

In `apps/daemon/src/agent-hooks/hook-settings.ts`, add the URL helper near `elicitHookUrl`:

```ts
export function permissionHookUrl(port: number, sessionId: string): string {
  return `http://127.0.0.1:${port}/v1/agent-hooks/permission?sessionId=${encodeURIComponent(sessionId)}`;
}
```

Extend the `AgentHookSettings` interface's `hooks` with:

```ts
    PermissionRequest?: Array<{ matcher: string; hooks: HttpHook[] }>;
```

In `buildAgentHookSettings`, add to the returned `hooks` object (after the `PreToolUse` entry):

```ts
      PermissionRequest: [
        {
          matcher: "*",
          hooks: [{ type: "http", url: permissionHookUrl(args.port, args.sessionId), headers, timeout: 1800 }],
        },
      ],
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/daemon && pnpm vitest run src/agent-hooks/hook-settings.test.ts -t "PermissionRequest"`
Expected: PASS.

- [ ] **Step 5: Write the failing test (provider workerHookConfig)**

Create `apps/daemon/src/orchestrator-llm/providers/worker-hook-config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveShadowProvider } from "./registry.js";

describe("workerHookConfig", () => {
  it("Claude returns a settings.json file (with PermissionRequest) and a --settings spawn arg", () => {
    const provider = resolveShadowProvider("claude-code");
    const cfg = provider.workerHookConfig({ goalId: "g1", sessionId: "s1", port: 1234, authToken: "tok", configDir: "/tmp/cfg" });
    const settings = cfg.files.find((f) => f.relPath === "settings.json");
    expect(settings).toBeDefined();
    expect(settings!.contents).toContain("PermissionRequest");
    expect(cfg.spawnArgs).toEqual(["--settings", "/tmp/cfg/settings.json"]);
  });

  it("Codex and Antigravity return an empty worker config (no permission flow yet)", () => {
    for (const id of ["codex", "antigravity"] as const) {
      const cfg = resolveShadowProvider(id).workerHookConfig({ goalId: "g", sessionId: "s", port: 1, authToken: "t", configDir: "/tmp" });
      expect(cfg.files).toEqual([]);
      expect(cfg.spawnArgs).toEqual([]);
    }
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/orchestrator-llm/providers/worker-hook-config.test.ts`
Expected: FAIL — `workerHookConfig` not on the provider.

- [ ] **Step 7: Add `workerHookConfig` to the interface**

In `apps/daemon/src/orchestrator-llm/providers/types.ts`, add to the `ShadowProvider` interface (after `hookConfig(...)`):

```ts
  /**
   * Hook config for a workflow-step **worker** session of this provider. Returns
   * files to write under the worker's private config dir plus spawn args/env to
   * append. (Generalizes the provider seam to workers; future: rename to AgentProvider.)
   */
  workerHookConfig(args: {
    goalId: string;
    sessionId: string;
    port: number;
    authToken: string;
    configDir: string;
  }): { files: { relPath: string; contents: string }[]; spawnArgs: string[]; env?: Record<string, string> };
```

- [ ] **Step 8: Implement it per provider**

In `apps/daemon/src/orchestrator-llm/providers/claude.ts`, import the builder and add the method:

```ts
import { join } from "node:path";
import { buildAgentHookSettings } from "../../agent-hooks/hook-settings.js";
```
```ts
  workerHookConfig(args: { goalId: string; sessionId: string; port: number; authToken: string; configDir: string }) {
    const settings = buildAgentHookSettings({ sessionId: args.sessionId, port: args.port, authToken: args.authToken });
    return {
      files: [{ relPath: "settings.json", contents: JSON.stringify(settings, null, 2) }],
      spawnArgs: ["--settings", join(args.configDir, "settings.json")],
    };
  }
```

In `codex.ts` and `antigravity.ts`, add a no-op implementation (permission flow lands in later phases):

```ts
  workerHookConfig(_args: { goalId: string; sessionId: string; port: number; authToken: string; configDir: string }) {
    return { files: [], spawnArgs: [] };
  }
```

- [ ] **Step 9: Run both provider/hook tests to verify pass**

Run: `cd apps/daemon && pnpm vitest run src/orchestrator-llm/providers/worker-hook-config.test.ts src/agent-hooks/hook-settings.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/daemon/src/agent-hooks/hook-settings.ts apps/daemon/src/agent-hooks/hook-settings.test.ts apps/daemon/src/orchestrator-llm/providers/types.ts apps/daemon/src/orchestrator-llm/providers/claude.ts apps/daemon/src/orchestrator-llm/providers/codex.ts apps/daemon/src/orchestrator-llm/providers/antigravity.ts apps/daemon/src/orchestrator-llm/providers/worker-hook-config.test.ts
git commit -m "feat(daemon): provider workerHookConfig seam + Claude PermissionRequest hook"
```

---

## Task 6: `WorkerSessionManager` consumes the provider seam

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/worker-session.ts` (spawn signature + deps), `apps/daemon/src/server.ts:510-521` (inject `resolveProvider`), `server.ts:561` (pass goalId/adapterId)
- Test: `apps/daemon/src/workflows/orchestrator/worker-session.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/workflows/orchestrator/worker-session.test.ts` (this file already mocks tmux; follow its existing harness for capturing the launched command). Assert that spawn writes the provider's files and appends its spawn args:

```ts
it("writes worker hook files from the provider and appends its spawn args", async () => {
  const fakeProvider = {
    workerHookConfig: (a: { configDir: string }) => ({
      files: [{ relPath: "settings.json", contents: "{\"hooks\":{}}" }],
      spawnArgs: ["--settings", `${a.configDir}/settings.json`],
    }),
  };
  const tmux = makeFakeTmux(); // existing helper that records new-session commands
  const mgr = new WorkerSessionManager({
    privateRoot: tmpDir(), daemonPort: 4000, authToken: "tok",
    claudeBin: "claude", captureSink: () => {}, tmux,
    resolveProvider: () => fakeProvider as any,
  });
  await mgr.spawn({ sessionId: "s1", goalId: "g1", adapterId: "claude-code", workspacePath: tmpDir(), command: "claude", env: {} });
  const cmd = tmux.lastNewSessionCommand(); // helper returning the command string passed to newSession
  expect(cmd).toContain("--settings");
  expect(cmd).toContain("/s1/settings.json");
});
```

(Adapt helper names to the test file's existing harness. The behavior asserted: `spawn` resolves the provider by `adapterId`, writes `workerHookConfig.files` under `privateRoot/<sessionId>`, and the launched command includes the provider's `spawnArgs`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/workflows/orchestrator/worker-session.test.ts -t "provider"`
Expected: FAIL — `resolveProvider` not a dep / `spawn` doesn't accept `goalId`/`adapterId`.

- [ ] **Step 3: Update `WorkerSessionDeps` and `WorkerSpawnInput`**

In `apps/daemon/src/workflows/orchestrator/worker-session.ts`:

Add to the deps interface (`WorkerSessionDeps`):

```ts
  resolveProvider: (adapterId: string) => {
    workerHookConfig: (args: { goalId: string; sessionId: string; port: number; authToken: string; configDir: string }) =>
      { files: { relPath: string; contents: string }[]; spawnArgs: string[]; env?: Record<string, string> };
  };
```

Add to `WorkerSpawnInput` (the `spawn` input type): `goalId: string;` and `adapterId: string;`.

Replace the hook-writing portion of `spawn` (the block that builds `settingsPath`, writes `buildAgentHookSettings`, and forms `command`) with:

```ts
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
      writeFileSync(join(cfgDir, file.relPath), file.contents, "utf8");
    }
    const name = this.name(input.sessionId);
    const command = [input.command, ...hookCfg.spawnArgs].join(" ");
    const env = { ...input.env, ...(hookCfg.env ?? {}) };
    await newSession(this.tmux, name, input.workspacePath, command, env);
```

Remove the now-unused `buildAgentHookSettings` import from this file (it now lives in the Claude provider).

- [ ] **Step 4: Inject `resolveProvider` and pass goalId/adapterId in `server.ts`**

In `apps/daemon/src/server.ts`, add to the `new WorkerSessionManager({ ... })` deps (line 510-521):

```ts
    resolveProvider: (adapterId) => resolveShadowProvider(adapterId as ShadowAdapterId),
```

(Add the import at the top of `server.ts` if not present: `import { resolveShadowProvider } from "./orchestrator-llm/providers/registry.js";` and `import type { ShadowAdapterId } from "./orchestrator-llm/providers/types.js";`.)

Update the `workerSessions.spawn` call (line 561) to pass the new fields:

```ts
      await workerSessions.spawn({ sessionId, goalId, adapterId, workspacePath: wsRow.path, command: spawn.command, env: spawn.env });
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/daemon && pnpm vitest run src/workflows/orchestrator/worker-session.test.ts`
Expected: PASS (new case + existing cases; if an existing case calls `spawn` without `goalId`/`adapterId`, update it to pass `goalId: "g", adapterId: "claude-code"` and provide a `resolveProvider` stub in its manager construction).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/worker-session.ts apps/daemon/src/workflows/orchestrator/worker-session.test.ts apps/daemon/src/server.ts
git commit -m "refactor(daemon): worker sessions consume provider workerHookConfig (no Claude hardcoding)"
```

---

## Task 7: `/v1/agent-hooks/permission` decision endpoint

**Files:**
- Modify: `apps/daemon/src/agent-hooks/routes.ts` (add the route + dep)
- Test: `apps/daemon/src/agent-hooks/routes.test.ts` (add cases)

The route returns Claude's `PermissionRequest` response shape:
`{ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" | "deny" } } }`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/daemon/src/agent-hooks/routes.test.ts` (the file already builds a Fastify app via `registerAgentHookRoutes`; extend its deps):

```ts
it("permission route returns allow when onPermissionRequest resolves allow", async () => {
  const app = fastify();
  registerAgentHookRoutes(app, {
    onResponseDone: async () => {}, resolveAdapterForSession: () => "claude-code",
    onWorkerQuestion: async () => "x",
    onPermissionRequest: async () => "allow",
  });
  const res = await app.inject({ method: "POST", url: "/v1/agent-hooks/permission?sessionId=s1",
    payload: { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  });
});

it("permission route returns deny when onPermissionRequest resolves deny", async () => {
  const app = fastify();
  registerAgentHookRoutes(app, {
    onResponseDone: async () => {}, resolveAdapterForSession: () => "claude-code",
    onWorkerQuestion: async () => "x",
    onPermissionRequest: async () => "deny",
  });
  const res = await app.inject({ method: "POST", url: "/v1/agent-hooks/permission?sessionId=s1",
    payload: { tool_name: "Bash", tool_input: { command: "rm -rf /" }, tool_use_id: "t2" } });
  expect(res.json().hookSpecificOutput.decision.behavior).toBe("deny");
});

it("permission route denies (safe default) when sessionId is missing", async () => {
  const app = fastify();
  const onPermissionRequest = vi.fn(async () => "allow" as const);
  registerAgentHookRoutes(app, {
    onResponseDone: async () => {}, resolveAdapterForSession: () => "claude-code",
    onWorkerQuestion: async () => "x", onPermissionRequest,
  });
  const res = await app.inject({ method: "POST", url: "/v1/agent-hooks/permission",
    payload: { tool_name: "Bash", tool_input: {}, tool_use_id: "t3" } });
  expect(res.json().hookSpecificOutput.decision.behavior).toBe("deny");
  expect(onPermissionRequest).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/agent-hooks/routes.test.ts -t "permission route"`
Expected: FAIL — no `/permission` route / `onPermissionRequest` not in deps.

- [ ] **Step 3: Add the dep + route**

In `apps/daemon/src/agent-hooks/routes.ts`, extend `AgentHookRouteDeps`:

```ts
  /**
   * Decide a worker tool-permission request. Returns "allow" or "deny". Resolves
   * immediately for auto-mode goals; otherwise holds until the user answers in
   * chat or a long timeout elapses (then "deny").
   */
  onPermissionRequest(
    sessionId: string,
    payload: { toolName: string; toolInput: unknown; toolUseId: string },
  ): Promise<"allow" | "deny">;
```

Add the route inside `registerAgentHookRoutes` (after the `stop` route):

```ts
  server.post("/v1/agent-hooks/permission", async (request) => {
    const { sessionId } = request.query as { sessionId?: string };
    const body = (request.body ?? {}) as { tool_name?: string; tool_input?: unknown; tool_use_id?: string };
    // Safe default: anything we cannot attribute to a session is denied, never allowed.
    let behavior: "allow" | "deny" = "deny";
    if (sessionId) {
      behavior = await deps.onPermissionRequest(sessionId, {
        toolName: body.tool_name ?? "",
        toolInput: body.tool_input ?? {},
        toolUseId: body.tool_use_id ?? "",
      });
    }
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior } } };
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/daemon && pnpm vitest run src/agent-hooks/routes.test.ts -t "permission route"`
Expected: PASS.

- [ ] **Step 5: Run the full routes suite**

Run: `cd apps/daemon && pnpm vitest run src/agent-hooks/routes.test.ts`
Expected: PASS. (Existing `registerAgentHookRoutes` callers in the test file now need an `onPermissionRequest` — add `onPermissionRequest: async () => "deny"` to those deps objects.)

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/agent-hooks/routes.ts apps/daemon/src/agent-hooks/routes.test.ts
git commit -m "feat(daemon): /v1/agent-hooks/permission route (safe-deny default)"
```

---

## Task 8: Wire the decision flow + answer route + mode toggle in `server.ts`

**Files:**
- Modify: `apps/daemon/src/server.ts` (instantiate store; implement `onPermissionRequest`; add answer + mode-toggle routes)
- Test: `apps/daemon/src/server.permission-flow.test.ts` (create — integration test via injected server)

This task assembles Tasks 2-7 into the live decision flow:
- `auto` goal → allow immediately (no chat message).
- `ask` goal → post a `pendingApproval` chat message, hold open, resolve via the answer route, else deny after `PERMISSION_DECISION_TIMEOUT_MS`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/daemon/src/server.permission-flow.test.ts`. Use the project's existing server-test harness (mirror `agent-hooks`/orchestrator-chat integration tests: build the server with an in-memory migrated DB, seed a goal + a session row). Assert:

```ts
it("auto-mode goal: permission hook is allowed immediately with no chat message", async () => {
  const { app, db } = await buildTestServer();
  seedGoal(db, { id: "g1", workerPermissionMode: "auto" });
  seedSession(db, { id: "s1", goalId: "g1", adapterId: "claude-code" });
  const res = await app.inject({ method: "POST", url: "/v1/agent-hooks/permission?sessionId=s1",
    payload: { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" } });
  expect(res.json().hookSpecificOutput.decision.behavior).toBe("allow");
  expect(listOrchestratorMessagesByGoal(db, "g1")).toHaveLength(0);
});

it("ask-mode goal: posts a pendingApproval message and allows once the answer route says allow", async () => {
  const { app, db } = await buildTestServer();
  seedGoal(db, { id: "g1", workerPermissionMode: "ask" });
  seedSession(db, { id: "s1", goalId: "g1", adapterId: "claude-code" });

  const hookPromise = app.inject({ method: "POST", url: "/v1/agent-hooks/permission?sessionId=s1",
    payload: { tool_name: "Bash", tool_input: { command: "rm x" }, tool_use_id: "t1" } });

  // The pendingApproval message appears; grab its approvalId.
  await vi.waitFor(() => expect(listOrchestratorMessagesByGoal(db, "g1").some((m) => m.pendingApproval)).toBe(true));
  const approvalId = listOrchestratorMessagesByGoal(db, "g1").find((m) => m.pendingApproval)!.pendingApproval!.approvalId;

  const answer = await app.inject({ method: "POST", url: `/v1/goals/g1/permission-approvals/${approvalId}`,
    payload: { decision: "allow" } });
  expect(answer.statusCode).toBe(200);
  const hookRes = await hookPromise;
  expect(hookRes.json().hookSpecificOutput.decision.behavior).toBe("allow");
});

it("answer route rejects an approvalId scoped to a different goal (404)", async () => {
  const { app, db } = await buildTestServer();
  seedGoal(db, { id: "g1", workerPermissionMode: "ask" });
  seedGoal(db, { id: "g2", workerPermissionMode: "ask" });
  seedSession(db, { id: "s1", goalId: "g1", adapterId: "claude-code" });
  const hookPromise = app.inject({ method: "POST", url: "/v1/agent-hooks/permission?sessionId=s1",
    payload: { tool_name: "Bash", tool_input: {}, tool_use_id: "t1" } });
  await vi.waitFor(() => expect(listOrchestratorMessagesByGoal(db, "g1").some((m) => m.pendingApproval)).toBe(true));
  const approvalId = listOrchestratorMessagesByGoal(db, "g1").find((m) => m.pendingApproval)!.pendingApproval!.approvalId;
  const wrong = await app.inject({ method: "POST", url: `/v1/goals/g2/permission-approvals/${approvalId}`, payload: { decision: "allow" } });
  expect(wrong.statusCode).toBe(404);
  // resolve correctly so the held hook doesn't dangle the test
  await app.inject({ method: "POST", url: `/v1/goals/g1/permission-approvals/${approvalId}`, payload: { decision: "deny" } });
  await hookPromise;
});

it("mode toggle route updates the goal's workerPermissionMode", async () => {
  const { app, db } = await buildTestServer();
  seedGoal(db, { id: "g1", workerPermissionMode: "ask" });
  const res = await app.inject({ method: "PUT", url: "/v1/goals/g1/worker-permission-mode", payload: { workerPermissionMode: "auto" } });
  expect(res.statusCode).toBe(200);
  expect(getGoal(db, "g1").workerPermissionMode).toBe("auto");
});
```

(Adapt `buildTestServer`/`seedGoal`/`seedSession` to the repo's existing server-test helpers. If the repo has no server-injection harness, build a minimal one in the test using `createServer` from `server.ts` with an in-memory DB — follow whatever `*.integration`/server test already does.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/server.permission-flow.test.ts`
Expected: FAIL — `onPermissionRequest` not implemented; answer/toggle routes absent.

- [ ] **Step 3: Instantiate the store + timeout constant**

In `apps/daemon/src/server.ts`, near `const workerQuestions = new WorkerQuestionStore(...)` (line 522), add:

```ts
  const permissionApprovals = new PermissionApprovalStore(daemonContext.idFactory);
  const PERMISSION_DECISION_TIMEOUT_MS = 1_790_000; // ~under the 1800s PermissionRequest hook timeout; then deny
```

Add the import: `import { PermissionApprovalStore } from "./workflows/orchestrator/permission-approvals.js";`

- [ ] **Step 4: Implement `onPermissionRequest` in the `registerAgentHookRoutes` deps**

In the `registerAgentHookRoutes(server, { ... })` call (line 1097-1142), add an `onPermissionRequest` property:

```ts
    onPermissionRequest: async (sessionId, payload) => {
      const sessionRow = db.prepare("SELECT goal_id FROM sessions WHERE id = ?").get(sessionId) as { goal_id: string } | undefined;
      if (!sessionRow) return "deny"; // safe default: unknown session
      const goalId = sessionRow.goal_id;
      const goalRow = db.prepare("SELECT worker_permission_mode FROM goals WHERE id = ?").get(goalId) as { worker_permission_mode: string } | undefined;
      if (!goalRow) return "deny";
      if (goalRow.worker_permission_mode === "auto") return "allow";

      // ask-mode: relay to chat and hold the hook open.
      const summary = summarizePermission(payload.toolName, payload.toolInput);
      const { approvalId, answered, isNew } = permissionApprovals.record({
        toolUseId: payload.toolUseId, sessionId, goalId,
        toolName: payload.toolName, summary,
      });
      if (isNew) {
        insertMessageWithEvent(
          { db, bus: eventBus, modelProviderRegistry: daemonContext.modelProviderRegistry, now: daemonContext.now, idFactory: daemonContext.idFactory },
          {
            id: daemonContext.idFactory(), goalId, role: "orchestrator",
            body: `The agent wants to run ${payload.toolName}.`,
            correlationId: daemonContext.idFactory(), createdAt: daemonContext.now(),
            pendingApproval: { approvalId, sessionId, toolName: payload.toolName, summary },
          }
        );
      }
      let timerId: ReturnType<typeof setTimeout>;
      const timed = new Promise<"deny">((res) => { timerId = setTimeout(() => res("deny"), PERMISSION_DECISION_TIMEOUT_MS); });
      const decision = await Promise.race([answered, timed]);
      clearTimeout(timerId!);
      permissionApprovals.resolveDecision(approvalId, decision); // no-op if the answer route already resolved
      return decision;
    },
```

Add a small helper near the bottom of `server.ts` (or beside other local helpers):

```ts
function summarizePermission(toolName: string, toolInput: unknown): string {
  if (toolName === "Bash" && toolInput && typeof toolInput === "object" && "command" in toolInput) {
    const cmd = String((toolInput as { command: unknown }).command ?? "").trim();
    if (cmd) return cmd.length > 200 ? `${cmd.slice(0, 200)}…` : cmd;
  }
  return toolName;
}
```

- [ ] **Step 5: Add the answer route (mirror the worker-question answer route at server.ts:1146)**

After the worker-question answer route (line 1160), add:

```ts
  server.post("/v1/goals/:goalId/permission-approvals/:approvalId", async (request, reply) => {
    const { goalId, approvalId } = request.params as { goalId: string; approvalId: string };
    const parsed = SubmitPermissionDecisionRequest.safeParse(request.body);
    if (!parsed.success) { reply.status(400); return { error: "validation_failed", issues: parsed.error.issues }; }
    const pending = permissionApprovals.get(approvalId);
    // Not-found OR goal mismatch both read as "not found" for this goal.
    if (!pending || pending.goalId !== goalId) { reply.status(404); return { error: { code: "approval_not_found" } }; }
    const ok = permissionApprovals.resolveDecision(approvalId, parsed.data.decision);
    if (!ok) { reply.status(409); return { error: { code: "already_answered" } }; }
    // NOTE: parsed.data.remember (Always-allow native-config write) lands in Phase 2.
    return { ok: true };
  });
```

Add the import: `SubmitPermissionDecisionRequest` (and `UpdateWorkerPermissionModeRequest` for the next route) to the existing `@orca/contracts` import block in `server.ts`.

- [ ] **Step 6: Add the mode-toggle route**

Add near the goal routes (or beside the answer route):

```ts
  server.put("/v1/goals/:goalId/worker-permission-mode", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const parsed = UpdateWorkerPermissionModeRequest.safeParse(request.body);
    if (!parsed.success) { reply.status(400); return { error: "validation_failed", issues: parsed.error.issues }; }
    const info = db.prepare("UPDATE goals SET worker_permission_mode = ?, updated_at = ? WHERE id = ?")
      .run(parsed.data.workerPermissionMode, daemonContext.now(), goalId);
    if (info.changes === 0) { reply.status(404); return { error: { code: "goal_not_found" } }; }
    eventBus.publish({ type: "goal.worker_permission_mode_changed", goalId, payload: { workerPermissionMode: parsed.data.workerPermissionMode } });
    return { ok: true, workerPermissionMode: parsed.data.workerPermissionMode };
  });
```

(If the event bus requires registering the event type, add `goal.worker_permission_mode_changed` to the event union in contracts/daemon event definitions following the existing `goal.orchestrator_model_changed` pattern — grep `goal.orchestrator_model_changed` to find the registration site and mirror it. If the bus accepts arbitrary typed events, no registration is needed.)

- [ ] **Step 7: Run the integration test to verify it passes**

Run: `cd apps/daemon && pnpm vitest run src/server.permission-flow.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Typecheck + full daemon suite**

Run: `cd apps/daemon && pnpm tsc --noEmit`
Expected: no errors.

Run: `cd apps/daemon && pnpm vitest run`
Expected: PASS. (Fix any existing test that constructed `WorkerSessionManager`, `registerAgentHookRoutes`, or a `Goal` fixture without the new fields/deps — update them to supply `resolveProvider`, `onPermissionRequest: async () => "deny"`, and rely on the `workerPermissionMode` default.)

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.permission-flow.test.ts
git commit -m "feat(daemon): wire permission decision flow, answer route, and mode toggle"
```

---

## Final Verification

- [ ] **Full monorepo gates** (correctness-critical subsystem — all must be green):

Run: `cd packages/contracts && pnpm vitest run && cd ../../apps/daemon && pnpm vitest run && pnpm tsc --noEmit`
Expected: all PASS, no type errors.

Run (repo lint, per project config): `pnpm -w lint` (or the configured lint command)
Expected: clean.

- [ ] **Manual daemon smoke (optional, high-value):** With a goal in `auto` mode, `curl -XPOST 'localhost:<port>/v1/agent-hooks/permission?sessionId=<s>' -H 'Authorization: Bearer <tok>' -d '{"tool_name":"Bash","tool_input":{"command":"ls"},"tool_use_id":"t"}'` → `{"...decision":{"behavior":"allow"}}`. Flip to `ask` via `PUT /v1/goals/<id>/worker-permission-mode {"workerPermissionMode":"ask"}`, repeat the curl (it will hang), confirm a `pendingApproval` chat message exists, then `POST /v1/goals/<id>/permission-approvals/<approvalId> {"decision":"deny"}` and confirm the hung curl returns `behavior:"deny"`.

---

## Spec coverage check (Phase 1A scope)

- Per-goal mode + live toggle (daemon side) → Tasks 2, 8 (`worker_permission_mode` + toggle route; read fresh per hook call).
- Auto-run / Ask-in-chat decision, respecting native approvals (residual hook) → Tasks 5 (PermissionRequest hook), 7-8 (decision flow).
- Consolidated provider seam, no bespoke worker path → Tasks 5-6 (`workerHookConfig` + `WorkerSessionManager` refactor).
- Safe-by-default (timeout/unknown session → deny) → Tasks 7 (route default), 8 (`onPermissionRequest` guards + timeout).
- `pendingApproval` chat relay reusing worker-question machinery → Tasks 3, 4, 8.

**Out of Phase 1A (later plans):** desktop UI toggle + approval card (Phase 1B); "Always allow" native-config writer (Phase 2); Codex/Antigravity `workerHookConfig` + capture migration (Phases 3-4). The `remember` flag is accepted and validated now but not yet acted on (noted in Task 8 Step 5).
