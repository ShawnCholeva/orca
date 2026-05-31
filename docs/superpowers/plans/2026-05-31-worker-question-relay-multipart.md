# Worker Question Relay — Hold-Hook(deny) Multi-Part — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-question tmux-menu-driving worker-question relay with a hold-hook(deny) transport that supports multi-question and multiSelect `AskUserQuestion` calls uniformly.

**Architecture:** The `PreToolUse(AskUserQuestion)` http hook is held open by the daemon; the daemon posts all questions to chat, waits for the user's answer, then returns `permissionDecision:"deny"` with `permissionDecisionReason` = the assembled answer. `deny` runs before the tool, so no tmux menu paints and no send-keys driving is needed. Spike-verified 2026-05-31 (see `docs/superpowers/specs/2026-05-31-worker-question-relay-hold-hook-design.md`).

**Tech Stack:** TypeScript, Node.js daemon (Fastify, better-sqlite3, zod), React/TypeScript desktop, vitest.

**Design source:** `docs/superpowers/specs/2026-05-31-worker-question-relay-hold-hook-design.md`. Forward commits on `feat/worker-question-relay` (prior WIP commits left in place; this plan supersedes their guts).

---

## File structure

**Contracts** (`packages/contracts/src/index.ts`):
- `PendingQuestionItem` (new) — one question with `multiSelect` + options.
- `PendingQuestion` — now `{ questionId, toolUseId, questions: PendingQuestionItem[] }` (was single-question).
- `SubmitWorkerAnswersRequest` (new) — `{ answers: { questionIndex, selectedLabels[] }[] }`.
- Remove `SelectWorkerQuestionOptionRequest`.

**Daemon** (`apps/daemon/src`):
- `agent-hooks/hook-settings.ts` — add `timeout: 600` to the PreToolUse http hook.
- `workflows/orchestrator/worker-questions.ts` — store rewritten to hold a deferred per question, keyed by `questionId`, deduped by `toolUseId`.
- `workflows/orchestrator/worker-answer-format.ts` (new) — `validateAnswers` + `assembleAnswerReason` (pure functions).
- `workflows/orchestrator/worker-session.ts` — delete `selectMenuOption`.
- `agent-hooks/routes.ts` — `/elicit` awaits `onWorkerQuestion` and returns `deny` + reason.
- `orchestrator-chat/usecases.ts` — `insertMessageWithEvent` pendingQuestion type → multi shape.
- `orchestrator-chat/projection.ts` — drop a pending_question blob that fails the new schema (back-compat for old rows).
- `server.ts` — `onWorkerQuestion` builds the deferred + posts multi-question chat; new `/answer` route; delete the unsupported gate and the `/select` route.

**Desktop** (`apps/desktop/src`):
- `api.ts` — `submitWorkerAnswers` (replaces `selectWorkerQuestionOption`).
- `orchestrator/OrcaChat.tsx` — multi-question / multiSelect rendering + Submit + inline echo.
- `orchestrator/orca-chat.css` — styling.

**No new migration:** the `pending_question` TEXT column (migration 0019) already stores `pendingQuestion` as JSON; only the JSON shape changes.

---

## Task 1: Contracts — multi-question PendingQuestion + answers request

**Files:**
- Modify: `packages/contracts/src/index.ts:985-1043`
- Test: `packages/contracts/src/__tests__/orchestration-contracts.test.ts`

- [ ] **Step 1: Write failing tests.** Append to `orchestration-contracts.test.ts`:

```typescript
import {
  PendingQuestion,
  SubmitWorkerAnswersRequest,
  OrchestratorChatMessage,
} from "../index.js";

describe("PendingQuestion (multi-question)", () => {
  it("parses multiple questions with multiSelect flags", () => {
    const p = PendingQuestion.parse({
      questionId: "q1",
      toolUseId: "toolu_1",
      questions: [
        { header: "Color", question: "favorite color?", multiSelect: false,
          options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] },
        { header: "Feat", question: "which features?", multiSelect: true,
          options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
      ],
    });
    expect(p.questions).toHaveLength(2);
    expect(p.questions[1]!.multiSelect).toBe(true);
  });

  it("rejects more than 4 questions", () => {
    const q = { header: "h", question: "x", multiSelect: false, options: [{ label: "A", description: "" }] };
    expect(() => PendingQuestion.parse({ questionId: "q", toolUseId: "t", questions: [q, q, q, q, q] })).toThrow();
  });

  it("requires toolUseId", () => {
    expect(() => PendingQuestion.parse({ questionId: "q", questions: [] })).toThrow();
  });

  it("OrchestratorChatMessage accepts a multi-question pendingQuestion", () => {
    const m = OrchestratorChatMessage.parse({
      id: "m1", goalId: "g1", role: "orchestrator", kind: "message", body: "Agent asks",
      correlationId: "c1", createdAt: new Date().toISOString(),
      pendingQuestion: { questionId: "q1", toolUseId: "t1", questions: [
        { header: "H", question: "Q?", multiSelect: false, options: [{ label: "A", description: "" }] },
      ] },
    });
    expect(m.pendingQuestion?.questions[0]!.header).toBe("H");
  });
});

describe("SubmitWorkerAnswersRequest", () => {
  it("parses answers with selected labels", () => {
    const r = SubmitWorkerAnswersRequest.parse({ answers: [{ questionIndex: 0, selectedLabels: ["Red"] }] });
    expect(r.answers[0]!.selectedLabels).toEqual(["Red"]);
  });
  it("rejects an answer with no labels", () => {
    expect(() => SubmitWorkerAnswersRequest.parse({ answers: [{ questionIndex: 0, selectedLabels: [] }] })).toThrow();
  });
  it("rejects empty answers", () => {
    expect(() => SubmitWorkerAnswersRequest.parse({ answers: [] })).toThrow();
  });
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @orca/contracts exec vitest run src/__tests__/orchestration-contracts.test.ts`
  Expected: FAIL (`PendingQuestion`/`SubmitWorkerAnswersRequest` shape mismatch / not exported).

- [ ] **Step 3: Implement.** In `index.ts`, replace the existing `PendingQuestion` block (lines 985-1001) with:

```typescript
export const PendingQuestionItem = z
  .object({
    header: z.string().max(120),
    question: z.string().max(4000),
    multiSelect: z.boolean(),
    options: z
      .array(
        z.object({
          label: z.string().min(1).max(200),
          description: z.string().max(1000)
        })
      )
      .min(1)
      .max(12)
  })
  .strict();
export type PendingQuestionItem = z.infer<typeof PendingQuestionItem>;

export const PendingQuestion = z
  .object({
    questionId: z.string().min(1),
    toolUseId: z.string().min(1),
    questions: z.array(PendingQuestionItem).min(1).max(4)
  })
  .strict();
export type PendingQuestion = z.infer<typeof PendingQuestion>;
```

Replace the `SelectWorkerQuestionOptionRequest` block (lines 1038-1043) with:

```typescript
export const WorkerAnswer = z
  .object({
    questionIndex: z.number().int().min(0),
    selectedLabels: z.array(z.string().min(1)).min(1)
  })
  .strict();
export type WorkerAnswer = z.infer<typeof WorkerAnswer>;

export const SubmitWorkerAnswersRequest = z
  .object({ answers: z.array(WorkerAnswer).min(1) })
  .strict();
export type SubmitWorkerAnswersRequest = z.infer<typeof SubmitWorkerAnswersRequest>;
```

- [ ] **Step 4: Run → pass.** Same vitest command → PASS. Then `pnpm --filter @orca/contracts exec tsc --noEmit`.

- [ ] **Step 5: Find stale references.** `grep -rn "SelectWorkerQuestionOptionRequest" packages apps` — every hit is rewired in a later task (daemon Task 5, desktop Task 7). Note them; do not fix yet.

- [ ] **Step 6: Commit.**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/__tests__/orchestration-contracts.test.ts
git commit -m "feat(contracts): multi-question PendingQuestion + SubmitWorkerAnswersRequest"
```

---

## Task 2: Daemon — long hook timeout so Claude blocks for a human

**Files:**
- Modify: `apps/daemon/src/agent-hooks/hook-settings.ts:10-36`
- Test: `apps/daemon/src/agent-hooks/hook-settings.test.ts`

- [ ] **Step 1: Write failing test.** Append:

```typescript
it("PreToolUse AskUserQuestion hook has a long timeout for human response", () => {
  const s = buildAgentHookSettings({ sessionId: "sess-1", port: 8787, authToken: "tok" });
  const pre = s.hooks.PreToolUse!;
  expect(pre[0]!.hooks[0]!.timeout).toBe(600);
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @orca/daemon exec vitest run src/agent-hooks/hook-settings.test.ts`
  Expected: FAIL (`timeout` undefined).

- [ ] **Step 3: Implement.** In `hook-settings.ts`, add `timeout?: number;` to the `HttpHook` interface (line 10-14). In `buildAgentHookSettings`, change the PreToolUse hook entry (line 34) to include the timeout:

```typescript
PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "http", url: elicitHookUrl(args.port, args.sessionId), headers, timeout: 600 }] }],
```

- [ ] **Step 4: Run → pass.** Same command → PASS. `pnpm --filter @orca/daemon exec tsc --noEmit`.

- [ ] **Step 5: Commit.**

```bash
git add apps/daemon/src/agent-hooks/hook-settings.ts apps/daemon/src/agent-hooks/hook-settings.test.ts
git commit -m "feat(daemon): 600s timeout on AskUserQuestion elicit hook"
```

---

## Task 3: Daemon — pure answer-format helpers (validate + assemble)

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/worker-answer-format.ts`
- Test: `apps/daemon/src/workflows/orchestrator/worker-answer-format.test.ts`

- [ ] **Step 1: Write failing tests.**

```typescript
import { describe, expect, it } from "vitest";
import type { PendingQuestionItem, WorkerAnswer } from "@orca/contracts";
import { validateAnswers, assembleAnswerReason } from "./worker-answer-format.js";

const single: PendingQuestionItem = {
  header: "Color", question: "favorite color?", multiSelect: false,
  options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }],
};
const multi: PendingQuestionItem = {
  header: "Feat", question: "which features?", multiSelect: true,
  options: [{ label: "A", description: "" }, { label: "B", description: "" }],
};

describe("validateAnswers", () => {
  it("accepts a valid single-select answer", () => {
    expect(validateAnswers([single], [{ questionIndex: 0, selectedLabels: ["Red"] }])).toBeNull();
  });
  it("rejects a missing answer for a question", () => {
    expect(validateAnswers([single, multi], [{ questionIndex: 0, selectedLabels: ["Red"] }])).toBe("incomplete_answers");
  });
  it("rejects an out-of-range questionIndex", () => {
    expect(validateAnswers([single], [{ questionIndex: 1, selectedLabels: ["Red"] }])).toBe("question_index_out_of_range");
  });
  it("rejects a label not in the options", () => {
    expect(validateAnswers([single], [{ questionIndex: 0, selectedLabels: ["Green"] }])).toBe("unknown_label");
  });
  it("rejects >1 label on a single-select question", () => {
    expect(validateAnswers([single], [{ questionIndex: 0, selectedLabels: ["Red", "Blue"] }])).toBe("too_many_labels");
  });
  it("accepts multiple labels on a multiSelect question", () => {
    expect(validateAnswers([multi], [{ questionIndex: 0, selectedLabels: ["A", "B"] }])).toBeNull();
  });
});

describe("assembleAnswerReason", () => {
  it("produces a deterministic, answer-bearing deny reason", () => {
    const reason = assembleAnswerReason(
      [single, multi],
      [{ questionIndex: 0, selectedLabels: ["Red"] }, { questionIndex: 1, selectedLabels: ["A", "B"] }],
    );
    expect(reason).toContain("Q1 'Color': Red");
    expect(reason).toContain("Q2 'Feat': A, B");
    expect(reason).toContain("Do not call AskUserQuestion again");
  });
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/worker-answer-format.test.ts`
  Expected: FAIL (module not found).

- [ ] **Step 3: Implement `worker-answer-format.ts`.**

```typescript
import type { PendingQuestionItem, WorkerAnswer } from "@orca/contracts";

export type AnswerValidationError =
  | "incomplete_answers"
  | "question_index_out_of_range"
  | "unknown_label"
  | "too_many_labels";

/** Returns null when answers are valid for the questions, else an error code. */
export function validateAnswers(
  questions: PendingQuestionItem[],
  answers: WorkerAnswer[],
): AnswerValidationError | null {
  if (answers.length !== questions.length) return "incomplete_answers";
  const seen = new Set<number>();
  for (const a of answers) {
    if (a.questionIndex < 0 || a.questionIndex >= questions.length) return "question_index_out_of_range";
    seen.add(a.questionIndex);
    const q = questions[a.questionIndex]!;
    if (!q.multiSelect && a.selectedLabels.length !== 1) return "too_many_labels";
    const labels = new Set(q.options.map((o) => o.label));
    for (const label of a.selectedLabels) if (!labels.has(label)) return "unknown_label";
  }
  if (seen.size !== questions.length) return "incomplete_answers";
  return null;
}

/** Deterministic deny-reason text carrying the user's selections. */
export function assembleAnswerReason(
  questions: PendingQuestionItem[],
  answers: WorkerAnswer[],
): string {
  const byIndex = new Map(answers.map((a) => [a.questionIndex, a]));
  const parts = questions.map((q, i) => {
    const labels = byIndex.get(i)?.selectedLabels ?? [];
    return `Q${i + 1} '${q.header}': ${labels.join(", ")}.`;
  });
  return (
    "User answered via Orca chat. " +
    parts.join(" ") +
    " These are the user's final answers — treat the AskUserQuestion as fully answered with " +
    "exactly these selections and continue. Do not call AskUserQuestion again."
  );
}
```

- [ ] **Step 4: Run → pass.** Same command → PASS. `pnpm --filter @orca/daemon exec tsc --noEmit`.

- [ ] **Step 5: Commit.**

```bash
git add apps/daemon/src/workflows/orchestrator/worker-answer-format.ts apps/daemon/src/workflows/orchestrator/worker-answer-format.test.ts
git commit -m "feat(daemon): pure worker-answer validate + deny-reason assembly"
```

---

## Task 4: Daemon — WorkerQuestionStore holds a deferred per question

**Files:**
- Modify (rewrite): `apps/daemon/src/workflows/orchestrator/worker-questions.ts`
- Test: `apps/daemon/src/workflows/orchestrator/worker-questions.test.ts`

- [ ] **Step 1: Replace the test file.** `worker-questions.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { PendingQuestionItem } from "@orca/contracts";
import { WorkerQuestionStore } from "./worker-questions.js";

const q: PendingQuestionItem = {
  header: "Color", question: "favorite color?", multiSelect: false,
  options: [{ label: "Red", description: "" }],
};
const base = { toolUseId: "toolu_1", sessionId: "s1", goalId: "g1", questions: [q] };

describe("WorkerQuestionStore", () => {
  it("records a question and exposes its data by questionId", () => {
    let n = 0;
    const store = new WorkerQuestionStore(() => `q-${++n}`);
    const { questionId } = store.record(base);
    expect(questionId).toBe("q-1");
    expect(store.get(questionId)).toMatchObject({ sessionId: "s1", goalId: "g1" });
  });

  it("resolveAnswers resolves the deferred once and removes the entry", async () => {
    const store = new WorkerQuestionStore(() => "q-1");
    const { questionId, answered } = store.record(base);
    expect(store.resolveAnswers(questionId, "ANSWER")).toBe(true);
    await expect(answered).resolves.toBe("ANSWER");
    expect(store.get(questionId)).toBeUndefined();
    expect(store.resolveAnswers(questionId, "AGAIN")).toBe(false); // already resolved
  });

  it("dedupes by toolUseId: a repeat fire reuses the same questionId + deferred", () => {
    let n = 0;
    const store = new WorkerQuestionStore(() => `q-${++n}`);
    const first = store.record(base);
    const second = store.record(base); // same toolUseId
    expect(second.questionId).toBe(first.questionId);
    expect(second.answered).toBe(first.answered);
  });
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/worker-questions.test.ts`
  Expected: FAIL (`record` shape changed, `resolveAnswers` missing).

- [ ] **Step 3: Replace `worker-questions.ts`.**

```typescript
import type { PendingQuestionItem } from "@orca/contracts";

export interface PendingWorkerQuestion {
  toolUseId: string;
  sessionId: string;
  goalId: string;
  questions: PendingQuestionItem[];
  resolve: (reason: string) => void;
  answered: Promise<string>;
}

export interface RecordInput {
  toolUseId: string;
  sessionId: string;
  goalId: string;
  questions: PendingQuestionItem[];
}

export interface RecordHandle {
  questionId: string;
  answered: Promise<string>;
}

export class WorkerQuestionStore {
  private readonly pending = new Map<string, PendingWorkerQuestion>();
  private readonly byToolUseId = new Map<string, string>();

  constructor(private readonly idFactory: () => string = () => Math.random().toString(36).slice(2)) {}

  record(input: RecordInput): RecordHandle {
    const existingId = this.byToolUseId.get(input.toolUseId);
    if (existingId) {
      const existing = this.pending.get(existingId);
      if (existing) return { questionId: existingId, answered: existing.answered };
    }
    const questionId = this.idFactory();
    let resolve!: (reason: string) => void;
    const answered = new Promise<string>((res) => { resolve = res; });
    this.pending.set(questionId, { ...input, resolve, answered });
    this.byToolUseId.set(input.toolUseId, questionId);
    return { questionId, answered };
  }

  get(questionId: string): PendingWorkerQuestion | undefined {
    return this.pending.get(questionId);
  }

  /** Resolves the held hook with `reason`. Returns false if already resolved/absent. */
  resolveAnswers(questionId: string, reason: string): boolean {
    const entry = this.pending.get(questionId);
    if (!entry) return false;
    this.pending.delete(questionId);
    this.byToolUseId.delete(entry.toolUseId);
    entry.resolve(reason);
    return true;
  }
}
```

- [ ] **Step 4: Run → pass.** Same command → PASS.

- [ ] **Step 5: Delete `selectMenuOption`** from `worker-session.ts` (lines 156-167) — no longer used. Also remove `sendKey` from the import on line 4 if nothing else uses it: run `grep -n "sendKey" apps/daemon/src/workflows/orchestrator/worker-session.ts` first; if `selectMenuOption` was the only user, drop `sendKey` from the import list. Remove the matching `selectMenuOption` test block in `worker-session.test.ts` (the `describe("WorkerSessionManager.selectMenuOption", …)` block).

- [ ] **Step 6: Run → pass + typecheck.** `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/worker-session.test.ts` and `pnpm --filter @orca/daemon exec tsc --noEmit`.

- [ ] **Step 7: Commit.**

```bash
git add apps/daemon/src/workflows/orchestrator/worker-questions.ts apps/daemon/src/workflows/orchestrator/worker-questions.test.ts apps/daemon/src/workflows/orchestrator/worker-session.ts apps/daemon/src/workflows/orchestrator/worker-session.test.ts
git commit -m "feat(daemon): worker question store holds a deferred; drop menu selection"
```

---

## Task 5: Daemon — message pendingQuestion type + projection back-compat

**Files:**
- Modify: `apps/daemon/src/orchestrator-chat/usecases.ts:203-213`
- Modify: `apps/daemon/src/orchestrator-chat/projection.ts:20-38`
- Test: `apps/daemon/src/orchestrator-chat/usecases.shadow.test.ts` (typecheck-only change; no new test needed here — projection back-compat tested below)
- Test: add to `apps/daemon/src/orchestrator-chat/projection.test.ts` if it exists; else create it.

- [ ] **Step 1: Update `insertMessageWithEvent` pendingQuestion type.** In `usecases.ts`, change the `pendingQuestion?` field type (line 212) from the single-question shape to import the contract type. At the top imports (line 5-14) add `type PendingQuestion as PendingQuestionT` from `@orca/contracts`, then:

```typescript
    pendingQuestion?: PendingQuestionT;
```

(The persistence on line 230 already does `JSON.stringify(message.pendingQuestion)` — no SQL change.)

- [ ] **Step 2: Write failing projection test.** Create/append `apps/daemon/src/orchestrator-chat/projection.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../migrations.js";
import { listOrchestratorMessagesByGoal } from "./projection.js";

function seedGoal(db: Database.Database, goalId: string) {
  db.prepare("INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(goalId, "t", "d", "active", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

describe("listOrchestratorMessagesByGoal pendingQuestion", () => {
  it("parses a multi-question pending_question blob", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    seedGoal(db, "g1");
    const pq = JSON.stringify({ questionId: "q1", toolUseId: "t1", questions: [
      { header: "H", question: "Q?", multiSelect: false, options: [{ label: "A", description: "" }] },
    ] });
    db.prepare("INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_question) VALUES (?,?,?,?,?,?,?,?)")
      .run("m1", "g1", "orchestrator", "message", "Agent asks", "c1", "2026-01-01T00:00:01.000Z", pq);
    const msgs = listOrchestratorMessagesByGoal(db, "g1");
    expect(msgs[0]!.pendingQuestion?.questions).toHaveLength(1);
  });

  it("drops a legacy single-shape pending_question instead of throwing", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    seedGoal(db, "g1");
    const legacy = JSON.stringify({ questionId: "q1", header: "Color", question: "c?", options: [{ label: "Red", description: "" }] });
    db.prepare("INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_question) VALUES (?,?,?,?,?,?,?,?)")
      .run("m1", "g1", "orchestrator", "message", "old", "c1", "2026-01-01T00:00:01.000Z", legacy);
    const msgs = listOrchestratorMessagesByGoal(db, "g1");
    expect(msgs[0]!.pendingQuestion).toBeUndefined(); // dropped, row still returned
  });
});
```

(Check the actual migration runner export name with `grep -n "export function runMigrations\|export const runMigrations" apps/daemon/src/migrations.ts` and adjust the import + the `goals` insert columns to match the real schema if this seed shape differs — read `migrations/0001*` for the goals columns.)

- [ ] **Step 3: Run → fail.** `pnpm --filter @orca/daemon exec vitest run src/orchestrator-chat/projection.test.ts`
  Expected: the legacy-shape test FAILS (current code passes the blob straight into `OrchestratorChatMessage.parse`, which throws on the new strict schema).

- [ ] **Step 4: Implement projection back-compat.** In `projection.ts`, replace the parse block (lines 20-38) so an invalid `pendingQuestion` is dropped, not fatal:

```typescript
  return rows.map((row) => {
    let pendingQuestion: unknown = undefined;
    if (typeof row.pending_question === "string" && row.pending_question) {
      try {
        const parsed = JSON.parse(row.pending_question);
        if (PendingQuestion.safeParse(parsed).success) pendingQuestion = parsed;
      } catch { /* ignore malformed */ }
    }
    return OrchestratorChatMessage.parse({
      id: row.id,
      goalId: row.goal_id,
      role: row.role,
      kind: row.kind,
      body: row.body,
      correlationId: row.correlation_id ?? null,
      rawAgentText: row.raw_agent_text ?? null,
      whyRationale: row.why_rationale ?? null,
      internalKind: row.internal_kind ?? null,
      createdAt: row.created_at,
      ...(pendingQuestion !== undefined ? { pendingQuestion } : {}),
    });
  });
```

Add `PendingQuestion` to the imports at the top of `projection.ts`:

```typescript
import { OrchestratorChatMessage, PendingQuestion, type OrchestratorChatMessage as OrchestratorChatMessageT } from "@orca/contracts";
```

- [ ] **Step 5: Run → pass + typecheck.** Same vitest command → PASS. `pnpm --filter @orca/daemon exec tsc --noEmit` (this will surface server.ts breakage — expected, fixed in Task 6/7).

- [ ] **Step 6: Commit.**

```bash
git add apps/daemon/src/orchestrator-chat/usecases.ts apps/daemon/src/orchestrator-chat/projection.ts apps/daemon/src/orchestrator-chat/projection.test.ts
git commit -m "feat(daemon): multi-question pendingQuestion type + projection back-compat"
```

---

## Task 6: Daemon — /elicit holds open and returns deny

**Files:**
- Modify: `apps/daemon/src/agent-hooks/routes.ts:14-42`
- Test: `apps/daemon/src/agent-hooks/routes.test.ts`

- [ ] **Step 1: Update the elicit test + stub.** In `routes.test.ts`: change `stubDeps.onWorkerQuestion` (line 8) to resolve a reason string, and rewrite the elicit test (lines 58-85):

```typescript
const stubDeps = {
  onResponseDone: vi.fn(async () => undefined),
  resolveAdapterForSession: () => "claude-code",
  onWorkerQuestion: vi.fn(async () => "ANSWER REASON"),
};
```

```typescript
it("POST /v1/agent-hooks/elicit returns deny with the assembled answer reason", async () => {
  const onWorkerQuestion = vi.fn(async () => "User answered via Orca chat. Q1 'H': A. ...");
  const server = Fastify();
  registerAgentHookRoutes(server, {
    onResponseDone: async () => undefined,
    resolveAdapterForSession: () => "claude-code",
    onWorkerQuestion,
  });
  const res = await server.inject({
    method: "POST",
    url: "/v1/agent-hooks/elicit?sessionId=s1",
    payload: {
      tool_input: { questions: [
        { question: "Which approach?", header: "Choose approach", options: [{ label: "A", description: "Option A" }], multiSelect: false },
      ] },
      tool_use_id: "t1",
    },
  });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(body.hookSpecificOutput.permissionDecisionReason).toContain("User answered");
  expect(onWorkerQuestion).toHaveBeenCalledWith("s1", {
    questions: [{ question: "Which approach?", header: "Choose approach", options: [{ label: "A", description: "Option A" }], multiSelect: false }],
    toolUseId: "t1",
  });
});

it("POST /v1/agent-hooks/elicit allows (no deny) when there is no question payload", async () => {
  const server = Fastify();
  registerAgentHookRoutes(server, { onResponseDone: async () => undefined, resolveAdapterForSession: () => "claude-code", onWorkerQuestion: async () => "x" });
  const res = await server.inject({ method: "POST", url: "/v1/agent-hooks/elicit?sessionId=s1", payload: { tool_input: { questions: [] } } });
  const body = JSON.parse(res.body) as { hookSpecificOutput: { permissionDecision: string } };
  expect(body.hookSpecificOutput.permissionDecision).toBe("allow");
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @orca/daemon exec vitest run src/agent-hooks/routes.test.ts`
  Expected: FAIL (route returns `allow`).

- [ ] **Step 3: Implement.** In `routes.ts`, change the `onWorkerQuestion` dep signature (line 18) to return the deny-reason string:

```typescript
  onWorkerQuestion(sessionId: string, payload: { questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>; toolUseId: string }): Promise<string>;
```

Replace the `/elicit` handler (lines 32-42):

```typescript
  server.post("/v1/agent-hooks/elicit", async (request) => {
    const { sessionId } = request.query as { sessionId?: string };
    const body = (request.body ?? {}) as { tool_input?: { questions?: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }> }; tool_use_id?: string };
    const questions = body.tool_input?.questions ?? [];
    if (!sessionId || questions.length === 0) {
      // Nothing to relay — fall back to the native menu.
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    }
    // Hold open until the user answers in chat (or the daemon times out); the
    // returned reason is delivered to Claude as the answer. deny pre-empts the
    // tool so no tmux menu paints.
    const reason = await deps.onWorkerQuestion(sessionId, { questions, toolUseId: body.tool_use_id ?? "" });
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  });
```

- [ ] **Step 4: Run → pass.** Same command → PASS. (`tsc --noEmit` still red on server.ts until Task 7.)

- [ ] **Step 5: Commit.**

```bash
git add apps/daemon/src/agent-hooks/routes.ts apps/daemon/src/agent-hooks/routes.test.ts
git commit -m "feat(daemon): elicit hook holds open, returns deny + answer reason"
```

---

## Task 7: Daemon — server wiring: deferred relay + /answer route, delete gate + /select

**Files:**
- Modify: `apps/daemon/src/server.ts` (around 1061-1095 for the relay + routes; check `grep -n "SelectWorkerQuestionOptionRequest" apps/daemon/src/server.ts` for the import)
- Test: covered by `routes.test.ts` (Task 6) + a server-level test if `server.test.ts` exists. If `apps/daemon/src/server.test.ts` exists, add the `/answer` happy-path + 404 + 409 there; otherwise rely on the worker-questions + worker-answer-format unit tests (already covering validate/assemble/resolve) and the live E2E.

- [ ] **Step 1: Update imports in `server.ts`.** Replace the `SelectWorkerQuestionOptionRequest` import with `SubmitWorkerAnswersRequest`. Add `validateAnswers, assembleAnswerReason` from `./workflows/orchestrator/worker-answer-format.js`. Add the const for the daemon-side timeout near the `workerQuestions` construction (line 491):

```typescript
const ELICIT_ANSWER_TIMEOUT_MS = 590_000; // slightly under the 600s hook timeout
```

- [ ] **Step 2: Replace `onWorkerQuestion` (lines 1061-1080).**

```typescript
    onWorkerQuestion: async (sessionId, payload) => {
      const goalRow = db.prepare("SELECT goal_id FROM sessions WHERE id = ?").get(sessionId) as { goal_id: string } | undefined;
      if (!goalRow) return "No goal is associated with this session; proceed using your best judgment.";
      const goalId = goalRow.goal_id;
      const { questionId, answered } = workerQuestions.record({
        toolUseId: payload.toolUseId,
        sessionId,
        goalId,
        questions: payload.questions,
      });
      insertMessageWithEvent(
        { db, bus: eventBus, modelProviderRegistry: daemonContext.modelProviderRegistry, now: daemonContext.now, idFactory: daemonContext.idFactory },
        {
          id: daemonContext.idFactory(),
          goalId,
          role: "orchestrator",
          body: "The agent needs your input.",
          correlationId: daemonContext.idFactory(),
          createdAt: daemonContext.now(),
          pendingQuestion: { questionId, toolUseId: payload.toolUseId, questions: payload.questions },
        }
      );
      const timed = new Promise<string>((res) =>
        setTimeout(() => res("No answer received from the user; proceed using your best judgment."), ELICIT_ANSWER_TIMEOUT_MS)
      );
      const reason = await Promise.race([answered, timed]);
      workerQuestions.resolveAnswers(questionId, reason); // idempotent cleanup if the timeout won
      return reason;
    },
```

- [ ] **Step 3: Replace the select route (lines 1083-1095) with the answer route.**

```typescript
  // ---- Worker question answer route ----

  server.post("/v1/goals/:goalId/worker-questions/:questionId/answer", async (request, reply) => {
    const { questionId } = request.params as { goalId: string; questionId: string };
    const parsed = SubmitWorkerAnswersRequest.safeParse(request.body);
    if (!parsed.success) { reply.status(400); return { error: { code: "validation_failed", issues: parsed.error.issues } }; }
    const pending = workerQuestions.get(questionId);
    if (!pending) { reply.status(404); return { error: { code: "question_not_found" } }; }
    const invalid = validateAnswers(pending.questions, parsed.data.answers);
    if (invalid) { reply.status(400); return { error: { code: invalid } }; }
    const reason = assembleAnswerReason(pending.questions, parsed.data.answers);
    const ok = workerQuestions.resolveAnswers(questionId, reason);
    if (!ok) { reply.status(409); return { error: { code: "already_answered" } }; }
    return { ok: true };
  });
```

- [ ] **Step 4: Typecheck + full daemon suite.** `pnpm --filter @orca/daemon exec tsc --noEmit` → clean. `pnpm --filter @orca/daemon exec vitest run` → all green.

- [ ] **Step 5: Commit.**

```bash
git add apps/daemon/src/server.ts
git commit -m "feat(daemon): hold-hook relay + /answer route; delete unsupported gate + /select"
```

---

## Task 8: Desktop — submitWorkerAnswers api client

**Files:**
- Modify: `apps/desktop/src/api.ts:933-949`
- Test: none (thin wrapper; exercised via OrcaChat test mock in Task 9)

- [ ] **Step 1: Replace `selectWorkerQuestionOption` with `submitWorkerAnswers`.**

```typescript
export async function submitWorkerAnswers(
  goalId: string,
  questionId: string,
  answers: { questionIndex: number; selectedLabels: string[] }[],
): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  return requestVoid(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/worker-questions/${encodeURIComponent(questionId)}/answer`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify({ answers }),
    },
    "Submit worker answers failed",
  );
}
```

(Match the closing-paren style of the original function — it ended with the fallback message then `);`. Read lines 933-951 first to preserve the exact tail.)

- [ ] **Step 2: Typecheck.** `pnpm --filter @orca/desktop exec tsc --noEmit` → expect ONE error: `OrcaChat.tsx` still imports `selectWorkerQuestionOption`. Fixed in Task 9.

- [ ] **Step 3: Commit.**

```bash
git add apps/desktop/src/api.ts
git commit -m "feat(desktop): submitWorkerAnswers api client (replaces select)"
```

---

## Task 9: Desktop — multi-question / multiSelect UI with Submit + echo

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx:610-643` (and import line 25)
- Modify: `apps/desktop/src/orchestrator/orca-chat.css`
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

- [ ] **Step 1: Write failing tests.** In `OrcaChat.test.tsx`: rename the api mock (line 21, 35) from `selectWorkerQuestionOption` to `submitWorkerAnswers`, then add a test. (Match the existing render harness in the file — it mounts `<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />` with `listOrchestratorMessagesMock` returning the messages.) Add a `pendingQuestion` message and assert submit behavior:

```typescript
const submitWorkerAnswersMock = vi.fn(async () => undefined); // replaces selectWorkerQuestionOptionMock

const pendingMsg: OrchestratorChatMessage = {
  id: "msg-q", goalId: "goal-1", role: "orchestrator", kind: "message",
  body: "The agent needs your input.", correlationId: "c1", createdAt: now,
  pendingQuestion: {
    questionId: "q1", toolUseId: "t1",
    questions: [
      { header: "Color", question: "favorite color?", multiSelect: false,
        options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Calm" }] },
      { header: "Feat", question: "which features?", multiSelect: true,
        options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
    ],
  },
};

it("submits multi-question answers (radio + checkbox) and disables after", async () => {
  listOrchestratorMessagesMock.mockResolvedValue({ messages: [pendingMsg] });
  // ...render OrcaChat exactly as the existing tests do...
  await screen.findByText("favorite color?");
  fireEvent.click(screen.getByRole("radio", { name: /Red/i }));
  fireEvent.click(screen.getByRole("checkbox", { name: /^A/i }));
  fireEvent.click(screen.getByRole("checkbox", { name: /^B/i }));
  const submit = screen.getByRole("button", { name: /submit/i });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await waitFor(() => expect(submitWorkerAnswersMock).toHaveBeenCalledWith("goal-1", "q1", [
    { questionIndex: 0, selectedLabels: ["Red"] },
    { questionIndex: 1, selectedLabels: ["A", "B"] },
  ]));
  await waitFor(() => expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled());
});

it("keeps Submit disabled until every question is answered", async () => {
  listOrchestratorMessagesMock.mockResolvedValue({ messages: [pendingMsg] });
  // ...render...
  await screen.findByText("favorite color?");
  fireEvent.click(screen.getByRole("radio", { name: /Red/i })); // Q2 still unanswered
  expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @orca/desktop exec vitest run src/orchestrator/OrcaChat.test.tsx`
  Expected: FAIL (mock name + UI not present).

- [ ] **Step 3: Implement.** In `OrcaChat.tsx`:

Change the import (line 25) from `selectWorkerQuestionOption` to `submitWorkerAnswers`.

Replace the `ChatMessageRow` orchestrator branch's `pendingQuestion` block (lines 625-639). First extract a dedicated component (keeps `ChatMessageRow` simple and isolates the local selection state):

```tsx
        {message.pendingQuestion && (
          <WorkerQuestionForm goalId={goalId} pending={message.pendingQuestion} />
        )}
```

Add this component below `ChatMessageRow`:

```tsx
import { useState } from "react"; // already imported at top with other hooks — fold into the existing import

function WorkerQuestionForm({
  goalId,
  pending,
}: {
  goalId: string;
  pending: NonNullable<OrchestratorChatMessage["pendingQuestion"]>;
}) {
  // selections[qIndex] = Set of chosen labels
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [submitted, setSubmitted] = useState(false);
  const [expired, setExpired] = useState(false);

  function toggle(qIndex: number, label: string, multi: boolean) {
    setSelections((prev) => {
      const current = prev[qIndex] ?? [];
      if (multi) {
        const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
        return { ...prev, [qIndex]: next };
      }
      return { ...prev, [qIndex]: [label] };
    });
  }

  const allAnswered = pending.questions.every((_, i) => (selections[i]?.length ?? 0) > 0);

  async function handleSubmit() {
    const answers = pending.questions.map((_, i) => ({ questionIndex: i, selectedLabels: selections[i] ?? [] }));
    setSubmitted(true);
    try {
      await submitWorkerAnswers(goalId, pending.questionId, answers);
    } catch {
      setSubmitted(false);
      setExpired(true); // 404/expired or transient — surface inline, re-enable
    }
  }

  return (
    <div className="orca-chat-question">
      {pending.questions.map((q, qi) => (
        <fieldset key={qi} className="orca-chat-question-block" disabled={submitted}>
          <legend className="orca-chat-question-legend">
            {pending.questions.length > 1 ? `${qi + 1} · ` : ""}{q.question}
          </legend>
          {q.options.map((opt, oi) => {
            const chosen = (selections[qi] ?? []).includes(opt.label);
            return (
              <label key={oi} className="orca-chat-option-row">
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  name={`${pending.questionId}-${qi}`}
                  checked={chosen}
                  onChange={() => toggle(qi, opt.label, q.multiSelect)}
                />
                <span className="orca-chat-option-label">{submitted && chosen ? "✓ " : ""}{opt.label}</span>
                {opt.description ? <span className="orca-chat-option-desc">{opt.description}</span> : null}
              </label>
            );
          })}
        </fieldset>
      ))}
      <button
        type="button"
        className="submit-button orca-chat-question-submit"
        disabled={submitted || !allAnswered}
        onClick={() => void handleSubmit()}
      >
        {submitted ? "Submitted" : "Submit"}
      </button>
      {expired && <p className="form-error" role="alert">This question expired.</p>}
    </div>
  );
}
```

Fold `useState` into the existing top-of-file React import (line 1 already imports `useState`), so do not add a second import line — remove the inline `import { useState }` comment line above and rely on the existing import.

- [ ] **Step 4: Add CSS.** Append to `orca-chat.css`:

```css
.orca-chat-question { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
.orca-chat-question-block { border: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.orca-chat-question-legend { font-size: 12px; opacity: 0.85; padding: 0; margin-bottom: 2px; }
.orca-chat-option-row { display: flex; align-items: baseline; gap: 6px; font-size: 13px; cursor: pointer; }
.orca-chat-option-row input { margin: 0; }
.orca-chat-option-desc { opacity: 0.6; font-size: 12px; }
.orca-chat-question-submit { align-self: flex-start; margin-top: 4px; }
.orca-chat-question-submit:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 5: Run → pass + typecheck.** `pnpm --filter @orca/desktop exec vitest run src/orchestrator/OrcaChat.test.tsx` → PASS. `pnpm --filter @orca/desktop exec tsc --noEmit` → clean.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/orca-chat.css apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): multi-question/multiSelect worker question form with submit"
```

---

## Task 10: Full-suite + live E2E validation

- [ ] **Step 1: All suites green.**

```bash
pnpm --filter @orca/contracts exec vitest run
pnpm --filter @orca/daemon exec vitest run
pnpm --filter @orca/desktop exec vitest run
pnpm --filter @orca/contracts exec tsc --noEmit
pnpm --filter @orca/daemon exec tsc --noEmit
pnpm --filter @orca/desktop exec tsc --noEmit
```

Expected: all PASS, all clean.

- [ ] **Step 2: Live E2E — multi-question.** With the dev stack running, create a goal whose intake makes the worker call `AskUserQuestion` with **two** questions (a placeholder goal triggers an interview naturally). Confirm:
  - daemon log shows `POST /v1/agent-hooks/elicit` and the request **does not return immediately** (held).
  - the chat shows **one message with two question blocks** + a single Submit.
  - `tmux capture-pane -t orca-worker-<id>` shows **no menu painted** (deny pre-empts it).
  - answer both, click Submit → `POST …/answer` 200 → the worker continues using the chosen answers.

- [ ] **Step 3: Live E2E — multiSelect.** Trigger a `multiSelect:true` question; confirm checkboxes render, multiple selections submit, worker receives them.

- [ ] **Step 4: Pause for the user's manual testing before any merge.**

---

## Self-review notes

- **No menu paths remain:** `selectMenuOption` and `/select` deleted; `/elicit` only ever returns `allow` (no payload) or `deny` (answered). The tmux key-driving layer is gone.
- **Identity/idempotency:** `questionId` per elicit; `toolUseId` dedupes duplicate hook fires (store reuses the deferred). `resolveAnswers` is single-shot (409 on repeat).
- **Validation:** `validateAnswers` enforces completeness, in-range index, known labels, single-select arity; contract `SubmitWorkerAnswersRequest` enforces shape at the boundary.
- **Timeout:** daemon races `answered` against `ELICIT_ANSWER_TIMEOUT_MS` (590s) under the 600s hook timeout; on timeout Claude gets a deterministic "use your best judgment" reason — never hung.
- **Restart caveat (deferred, per spec):** in-memory deferreds drop on daemon restart; the worker's held hook errors. Not addressed here; follow-up to persist/re-derive.
- **Back-compat:** the projection drops a legacy single-shape `pending_question` blob instead of throwing, so old dev rows don't break the message list.
