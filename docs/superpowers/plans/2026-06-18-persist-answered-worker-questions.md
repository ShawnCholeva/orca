# Persist Answered Worker Questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a worker `AskUserQuestion` persist in the chat as its own answered bubble between two work threads, remove the "Forwarding your response to the agent." line, and show a transient "Thinking…" indicator after answering.

**Architecture:** Promote worker questions to first-class chat messages (the same `pending*`-on-a-message pattern permission approvals use). The daemon inserts an `orchestrator` message carrying `pendingQuestion {source:"worker"}` when the question is asked, settles the current activity thread, and on answer updates that message in place with the chosen answer. The desktop renders worker-question messages with an interactive form while pending and a read-only view once answered; the activity layer no longer carries worker questions.

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), Fastify + better-sqlite3 (`apps/daemon`), React + Vitest (`apps/desktop`).

## Global Constraints

- Scope is **worker `AskUserQuestion` only**. Do NOT change orchestrator `ask_user` or permission approvals.
- Transient indicator copy is exactly **`Thinking…`** (with the `…` ellipsis character), rendered in the `ThinkingRow` pill style. No timer.
- Card "Something else" free-text shows inline only — it must NOT insert a separate user chat message. The composer path is the only one that inserts a user message.
- No DB schema migration: new fields ride inside the existing `pending_question` TEXT column; `PendingQuestion` stays `.strict()` with additive-optional fields.
- After editing `packages/contracts/src`, rebuild it (`pnpm -C packages/contracts build`) so the apps resolve the new types.
- TDD: write the failing test first, watch it fail, implement, watch it pass, commit.

---

### Task 1: Contracts — answer shape, question source, request flag, event type

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/index.test.ts`

**Interfaces:**
- Produces:
  - `PendingQuestionAnswer` = `{ answers?: WorkerAnswer[]; freeText?: string; viaChat?: true }` (exactly one set).
  - `PendingQuestion` gains `source?: "worker" | "orchestrator"` and `answer?: PendingQuestionAnswer`.
  - `SubmitWorkerAnswersRequest` gains `fromChat?: boolean`.
  - `DomainEventType` gains `"orchestrator.message.updated"`.
  - `WorkerAnswer` is moved above `PendingQuestion` (same shape: `{ questionIndex: number; selectedLabels: string[] }`).

- [ ] **Step 1: Write the failing test**

Add to `packages/contracts/src/index.test.ts`:

```ts
import {
  PendingQuestion,
  PendingQuestionAnswer,
  SubmitWorkerAnswersRequest,
  DomainEventType,
} from "./index.js";

describe("worker question persistence contracts", () => {
  const baseQuestion = {
    questionId: "q1",
    toolUseId: "t1",
    questions: [
      { header: "H", question: "Which?", multiSelect: false, options: [{ label: "A", description: "a" }] },
    ],
  };

  it("accepts a worker-sourced question with an options answer", () => {
    const parsed = PendingQuestion.parse({
      ...baseQuestion,
      source: "worker",
      answer: { answers: [{ questionIndex: 0, selectedLabels: ["A"] }] },
    });
    expect(parsed.source).toBe("worker");
    expect(parsed.answer?.answers?.[0]?.selectedLabels).toEqual(["A"]);
  });

  it("accepts inline free-text and via-chat answers", () => {
    expect(PendingQuestionAnswer.parse({ freeText: "custom" }).freeText).toBe("custom");
    expect(PendingQuestionAnswer.parse({ viaChat: true }).viaChat).toBe(true);
  });

  it("rejects an answer with more than one shape", () => {
    expect(PendingQuestionAnswer.safeParse({ freeText: "x", viaChat: true }).success).toBe(false);
  });

  it("still parses a legacy question with no source/answer", () => {
    expect(PendingQuestion.parse(baseQuestion).source).toBeUndefined();
  });

  it("accepts fromChat on the answer request and knows the updated event", () => {
    expect(SubmitWorkerAnswersRequest.parse({ freeText: "x", fromChat: true }).fromChat).toBe(true);
    expect(DomainEventType.parse("orchestrator.message.updated")).toBe("orchestrator.message.updated");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/contracts test src/index.test.ts`
Expected: FAIL — `PendingQuestionAnswer` is undefined / `source` not accepted / event not in enum.

- [ ] **Step 3: Implement the schema changes**

In `packages/contracts/src/index.ts`:

a) **Move `WorkerAnswer` up and add `PendingQuestionAnswer` immediately above `PendingQuestion`** (currently ~line 1011). Insert this block right before `export const PendingQuestion`:

```ts
export const WorkerAnswer = z
  .object({
    questionIndex: z.number().int().min(0),
    selectedLabels: z.array(z.string().min(1)).min(1)
  })
  .strict();
export type WorkerAnswer = z.infer<typeof WorkerAnswer>;

export const PendingQuestionAnswer = z
  .object({
    answers: z.array(WorkerAnswer).min(1).optional(),
    freeText: z.string().min(1).max(4000).optional(),
    viaChat: z.literal(true).optional()
  })
  .strict()
  .refine(
    (v) => [v.answers != null, v.freeText != null, v.viaChat != null].filter(Boolean).length === 1,
    { message: "Provide exactly one of answers, freeText, or viaChat" }
  );
export type PendingQuestionAnswer = z.infer<typeof PendingQuestionAnswer>;
```

b) **Extend `PendingQuestion`** (the existing object, ~line 1011) to:

```ts
export const PendingQuestion = z
  .object({
    questionId: z.string().min(1),
    toolUseId: z.string().min(1),
    questions: z.array(PendingQuestionItem).min(1).max(4),
    source: z.enum(["worker", "orchestrator"]).optional(),
    answer: PendingQuestionAnswer.optional()
  })
  .strict();
export type PendingQuestion = z.infer<typeof PendingQuestion>;
```

c) **Delete the now-duplicate `WorkerAnswer` definition** near `SubmitWorkerAnswersRequest` (currently ~lines 1257-1263) — it now lives above. Keep `SubmitWorkerAnswersRequest`, and add `fromChat`:

```ts
export const SubmitWorkerAnswersRequest = z
  .object({
    answers: z.array(WorkerAnswer).min(1).optional(),
    freeText: z.string().trim().min(1).max(4000).optional(),
    fromChat: z.boolean().optional()
  })
  .strict()
  .refine((v) => (v.answers != null) !== (v.freeText != null), {
    message: "Provide exactly one of answers or freeText",
  });
export type SubmitWorkerAnswersRequest = z.infer<typeof SubmitWorkerAnswersRequest>;
```

d) **Add the event type** inside the `DomainEventType` enum (currently ~line 199), right after `"orchestrator.message.created",`:

```ts
  "orchestrator.message.created",
  "orchestrator.message.updated",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/contracts test src/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Rebuild contracts so apps resolve the new types**

Run: `pnpm -C packages/contracts build`
Expected: exits 0, `dist/` updated.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts packages/contracts/dist
git commit -m "feat(contracts): worker-question answer shape, source, fromChat, message.updated event"
```

---

### Task 2: Daemon — record an answer onto a worker-question message

**Files:**
- Modify: `apps/daemon/src/orchestrator-chat/usecases.ts`
- Test: `apps/daemon/src/orchestrator-chat/projection.test.ts`

**Interfaces:**
- Consumes: `PendingQuestionAnswer` (Task 1), `insertMessageWithEvent` (existing).
- Produces: `recordWorkerQuestionAnswer(ctx, { goalId, questionId, answer }): boolean` — finds the orchestrator message whose `pending_question.questionId` matches, merges `answer` into its `pending_question` blob, UPDATEs the row, and publishes an `orchestrator.message.updated` event. Returns `false` if no matching message exists.

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/orchestrator-chat/projection.test.ts`:

```ts
import { recordWorkerQuestionAnswer } from "./usecases.js";

describe("recordWorkerQuestionAnswer", () => {
  it("merges the answer into the matching worker-question message", () => {
    const db = makeDb(); // existing helper in this file's setup
    const bus = { publish: vi.fn() };
    const ctx = { db, bus, idFactory: () => "evt-1" };
    insertMessageWithEvent(
      { db, bus, idFactory: () => "m1" },
      {
        id: "m1", goalId: "g1", role: "orchestrator", body: "Which?",
        correlationId: "c1", createdAt: "2026-06-18T00:00:00.000Z",
        pendingQuestion: {
          questionId: "q1", toolUseId: "t1", source: "worker",
          questions: [{ header: "H", question: "Which?", multiSelect: false, options: [{ label: "A", description: "a" }] }],
        },
      },
    );

    const ok = recordWorkerQuestionAnswer(ctx, {
      goalId: "g1", questionId: "q1",
      answer: { answers: [{ questionIndex: 0, selectedLabels: ["A"] }] },
    });

    expect(ok).toBe(true);
    const msgs = listOrchestratorMessagesByGoal(db, "g1");
    expect(msgs[0]!.pendingQuestion?.answer?.answers?.[0]?.selectedLabels).toEqual(["A"]);
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "orchestrator.message.updated", goalId: "g1" }),
    );
  });

  it("returns false when no message matches", () => {
    const db = makeDb();
    const ctx = { db, bus: { publish: vi.fn() }, idFactory: () => "evt" };
    expect(recordWorkerQuestionAnswer(ctx, { goalId: "g1", questionId: "nope", answer: { viaChat: true } })).toBe(false);
  });
});
```

> Note: this test file already imports `insertMessageWithEvent` and `listOrchestratorMessagesByGoal` and sets up an in-memory db with the `orchestrator_messages` schema. Reuse that existing setup helper (the file's `beforeEach`/db factory); if the db factory is inline, extract the table-creation into a local `makeDb()` in the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C apps/daemon test src/orchestrator-chat/projection.test.ts`
Expected: FAIL — `recordWorkerQuestionAnswer` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `apps/daemon/src/orchestrator-chat/usecases.ts` (it already imports `PendingQuestion`; add `PendingQuestionAnswer` to that import, plus `DomainEvent` is already imported):

```ts
export function recordWorkerQuestionAnswer(
  ctx: Pick<OrchestratorChatCtx, "db" | "bus" | "idFactory">,
  input: { goalId: string; questionId: string; answer: PendingQuestionAnswerT }
): boolean {
  const idFactory = ctx.idFactory ?? randomUUID;
  const stagedEvent = ctx.db.transaction(() => {
    const row = ctx.db
      .prepare(
        `SELECT id, pending_question FROM orchestrator_messages
          WHERE goal_id = ? AND json_extract(pending_question, '$.questionId') = ?
          LIMIT 1`
      )
      .get(input.goalId, input.questionId) as { id: string; pending_question: string } | undefined;
    if (row == null) return undefined;

    const pending = PendingQuestion.parse(JSON.parse(row.pending_question));
    const next = { ...pending, answer: input.answer };
    ctx.db
      .prepare("UPDATE orchestrator_messages SET pending_question = ? WHERE id = ?")
      .run(JSON.stringify(next), row.id);

    const payload = { messageId: row.id };
    const eventId = idFactory();
    const result = ctx.db
      .prepare("INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(eventId, "orchestrator.message.updated", input.goalId, JSON.stringify(payload), new Date().toISOString());
    return {
      seq: Number(result.lastInsertRowid),
      id: eventId,
      type: "orchestrator.message.updated",
      goalId: input.goalId,
      payload,
      createdAt: new Date().toISOString(),
    } satisfies DomainEvent;
  })();

  if (stagedEvent === undefined) return false;
  ctx.bus.publish(stagedEvent);
  return true;
}
```

Add the type import at the top of the file (alongside the existing `PendingQuestion` / `PendingApproval` imports):

```ts
import {
  // ...existing...
  PendingQuestion,
  type PendingQuestionAnswer as PendingQuestionAnswerT,
} from "@orca/contracts";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C apps/daemon test src/orchestrator-chat/projection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-chat/usecases.ts apps/daemon/src/orchestrator-chat/projection.test.ts
git commit -m "feat(daemon): recordWorkerQuestionAnswer updates the question message in place"
```

---

### Task 3: Daemon — ask time inserts a worker-question message and settles thread 1

**Files:**
- Modify: `apps/daemon/src/server.ts` (the `onWorkerQuestion` handler, ~lines 1464-1488)
- Test: `apps/daemon/src/server.activity.test.ts`

**Interfaces:**
- Consumes: `insertMessageWithEvent` (already imported in server.ts), `orcaVoiceQuestionText` (existing local fn), `applyActivitySafely`, `resolveStepContext`, `daemonContext.idFactory`/`now`.
- Produces: on a new worker question, a persisted `orchestrator` message with `pendingQuestion.source === "worker"`, and the step's live activity is settled (expired) rather than paused.

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/server.activity.test.ts` (reuse the existing harness used by the test at line ~545: it raises a worker question and waits for it via `waitForRecordedQuestion`):

```ts
it("inserts a worker-question chat message and settles the activity thread on ask", async () => {
  const ids = {
    goalId: "goal-question-msg", runId: "run-question-msg",
    stepRunId: "step-question-msg", sessionId: "session-question-msg",
  };
  const questions: PendingQuestionItem[] = [
    { header: "Release Plan", question: "Ship?", multiSelect: false,
      options: [{ label: "Ship now", description: "go" }] },
  ];
  // (set up active step/activity exactly as the sibling tests do, then raise the question)
  await raiseWorkerQuestion(server, ids.sessionId, "tool-msg", questions);
  await waitForRecordedQuestion(db, ids);

  const messages = ListOrchestratorMessagesResponse.parse(
    (await server.inject({ method: "GET", url: `/v1/goals/${ids.goalId}/orchestrator-messages`, headers: AUTH_HEADERS })).json(),
  );
  const q = messages.messages.find((m) => m.pendingQuestion?.source === "worker");
  expect(q?.pendingQuestion?.questions).toHaveLength(1);

  const activities = ListActivitiesResponse.parse(
    (await server.inject({ method: "GET", url: `/v1/goals/${ids.goalId}/activities`, headers: AUTH_HEADERS })).json(),
  );
  // The pre-question activity is settled, not paused, and carries no pending question.
  expect(activities.items[0]?.status).not.toBe("paused_for_input");
  expect(activities.items[0]?.pendingQuestion).toBeUndefined();
});
```

> Match the existing helpers/imports in this file (`raiseWorkerQuestion`/equivalent raise call, `waitForRecordedQuestion`, `ListActivitiesResponse`, `AUTH_HEADERS`). Add `ListOrchestratorMessagesResponse` to the `@orca/contracts` import if not present, and confirm the orchestrator-messages route path string used elsewhere in the suite.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C apps/daemon test src/server.activity.test.ts`
Expected: FAIL — no worker-sourced message; activity is `paused_for_input`.

- [ ] **Step 3: Implement the ask-time change**

In `apps/daemon/src/server.ts`, replace the `if (isNew) { ... applyActivitySafely("agent.question_pending", ...) }` block inside `onWorkerQuestion` (~lines 1474-1488) with:

```ts
      if (isNew) {
        // Persist the worker question as a first-class chat message so it lives
        // in chat history and can render an answered state later.
        insertMessageWithEvent(
          { db, bus: eventBus, idFactory: daemonContext.idFactory },
          {
            id: daemonContext.idFactory(),
            goalId,
            role: "orchestrator",
            body: orcaVoiceQuestionText(payload.questions),
            correlationId: daemonContext.idFactory(),
            createdAt: daemonContext.now(),
            pendingQuestion: {
              questionId,
              toolUseId: payload.toolUseId,
              source: "worker",
              questions: payload.questions,
            },
          },
        );
        // Settle the current activity thread (empty summary -> expireLive) so the
        // agent's post-answer work opens a fresh thread after the question bubble.
        const stepContext = resolveStepContext(sessionId);
        if (stepContext) {
          applyActivitySafely("agent.question_pending", {
            kind: "turn_completed",
            stepRunId: stepContext.stepRunId,
            summary: "",
            confidence: null,
          });
        }
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C apps/daemon test src/server.activity.test.ts`
Expected: the new test PASSES. (The older test that asserts the "Forwarding…" summary still fails until Task 4 — that is expected; run the single new test by name if you want a clean green here: append `-t "settles the activity thread on ask"`.)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.activity.test.ts
git commit -m "feat(daemon): worker question becomes a chat message; settle thread on ask"
```

---

### Task 4: Daemon — answer time updates the message, drops the "Forwarding" line

**Files:**
- Modify: `apps/daemon/src/server.ts` (the `/worker-questions/:questionId/answer` route, ~lines 1502-1547)
- Test: `apps/daemon/src/server.activity.test.ts`

**Interfaces:**
- Consumes: `recordWorkerQuestionAnswer` (Task 2), `SubmitWorkerAnswersRequest.fromChat` (Task 1).
- Produces: on answer, the question message gains an `answer`; a user message is inserted ONLY for the composer path (`fromChat`); no `turn_completed` "Forwarding…" activity is produced.

- [ ] **Step 1: Rewrite the stale assertion + add coverage**

In `apps/daemon/src/server.activity.test.ts`, the existing test (~lines 571-583) asserts the "Forwarding…" summary. Replace that assertion block with:

```ts
    // The answer is recorded on the question message; no "Forwarding" activity.
    const messages = ListOrchestratorMessagesResponse.parse(
      (await server.inject({ method: "GET", url: `/v1/goals/${ids.goalId}/orchestrator-messages`, headers: AUTH_HEADERS })).json(),
    );
    const answered = messages.messages.find((m) => m.pendingQuestion?.source === "worker");
    expect(answered?.pendingQuestion?.answer?.answers?.[0]?.selectedLabels).toEqual(["Ship now"]);

    const activitiesResponse = await server.inject({
      method: "GET", url: `/v1/goals/${ids.goalId}/activities`, headers: AUTH_HEADERS,
    });
    const activities = ListActivitiesResponse.parse(activitiesResponse.json());
    expect(activities.items.some((a) => a.finalSummary === "Forwarding your response to the agent.")).toBe(false);
```

Add a focused free-text test:

```ts
it("records inline free-text from the card without inserting a user message", async () => {
  // raise a single-question worker question (as the sibling tests do) -> recorded
  const before = ListOrchestratorMessagesResponse.parse(
    (await server.inject({ method: "GET", url: `/v1/goals/${ids.goalId}/orchestrator-messages`, headers: AUTH_HEADERS })).json(),
  ).messages.length;

  await server.inject({
    method: "POST",
    url: `/v1/goals/${ids.goalId}/worker-questions/${recorded.pendingQuestion.questionId}/answer`,
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    payload: { freeText: "do it my way" }, // no fromChat -> card path
  });

  const after = ListOrchestratorMessagesResponse.parse(
    (await server.inject({ method: "GET", url: `/v1/goals/${ids.goalId}/orchestrator-messages`, headers: AUTH_HEADERS })).json(),
  ).messages;
  expect(after.length).toBe(before); // no extra user message
  expect(after.find((m) => m.pendingQuestion?.source === "worker")?.pendingQuestion?.answer?.freeText).toBe("do it my way");
});
```

> Use the same scaffolding the existing answer tests use to raise + record the question (`recorded`, `ids`, `AUTH_HEADERS`). Add `ListOrchestratorMessagesResponse` to imports if missing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C apps/daemon test src/server.activity.test.ts`
Expected: FAIL — answer not recorded on the message; card free-text still inserts a user message; "Forwarding…" still present.

- [ ] **Step 3: Implement the answer-route change**

In `apps/daemon/src/server.ts`, replace the body of the answer route from the `let reason: string;` declaration through the end of the route (~lines 1511-1546) with:

```ts
    let reason: string;
    let answer: PendingQuestionAnswer;
    if (parsed.data.freeText != null) {
      reason = assembleFreeTextReason(parsed.data.freeText);
      answer = parsed.data.fromChat ? { viaChat: true } : { freeText: parsed.data.freeText };
    } else {
      const invalid = validateAnswers(pending.questions, parsed.data.answers!);
      if (invalid) { reply.status(400); return { error: { code: invalid } }; }
      reason = assembleAnswerReason(pending.questions, parsed.data.answers!);
      answer = { answers: parsed.data.answers! };
    }

    const ok = workerQuestions.resolveAnswers(questionId, reason);
    if (!ok) { reply.status(409); return { error: { code: "already_answered" } }; }

    // Composer answers post the user's text as a chat message; card answers
    // (options or inline "Something else") render inline on the question bubble
    // and add no separate user message.
    if (parsed.data.freeText != null && parsed.data.fromChat) {
      insertMessageWithEvent(
        { db, bus: eventBus, idFactory: daemonContext.idFactory },
        {
          id: daemonContext.idFactory(),
          goalId,
          role: "user",
          body: parsed.data.freeText,
          correlationId: daemonContext.idFactory(),
          createdAt: daemonContext.now(),
        },
      );
    }

    recordWorkerQuestionAnswer(
      { db, bus: eventBus, idFactory: daemonContext.idFactory },
      { goalId, questionId, answer },
    );

    return { ok: true };
```

Add imports at the top of `server.ts`:
- to the `@orca/contracts` import group: `type PendingQuestionAnswer`.
- to the orchestrator-chat usecases import (where `insertMessageWithEvent` is imported): `recordWorkerQuestionAnswer`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C apps/daemon test src/server.activity.test.ts`
Expected: PASS (all worker-question tests in the file).

- [ ] **Step 5: Run the daemon suite to catch fallout**

Run: `pnpm -C apps/daemon test`
Expected: PASS. If `server.activity.test.ts:580`-style "Forwarding…" assertions exist elsewhere, update them to match (no "Forwarding…" activity).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.activity.test.ts
git commit -m "feat(daemon): record worker answer on message, drop Forwarding line"
```

---

### Task 5: Desktop — client sends `fromChat` for composer free-text

**Files:**
- Modify: `apps/desktop/src/api.ts` (`submitWorkerFreeText`, ~lines 1004-1022)
- Test: none (thin fetch wrapper; covered via Task 9 component tests).

**Interfaces:**
- Produces: `submitWorkerFreeText(goalId, questionId, freeText, opts?: { fromChat?: boolean }): Promise<void>`.

- [ ] **Step 1: Implement the signature change**

Edit `submitWorkerFreeText` in `apps/desktop/src/api.ts`:

```ts
export async function submitWorkerFreeText(
  goalId: string,
  questionId: string,
  freeText: string,
  opts?: { fromChat?: boolean },
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
      body: JSON.stringify({ freeText, ...(opts?.fromChat ? { fromChat: true } : {}) }),
    },
    "Submit worker free-text answer failed",
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm -C apps/desktop typecheck`
Expected: PASS (existing call sites pass no `opts`, which is allowed).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/api.ts
git commit -m "feat(desktop): submitWorkerFreeText accepts fromChat flag"
```

---

### Task 6: Desktop — read-only answered question view

**Files:**
- Create: `apps/desktop/src/orchestrator/WorkerQuestionAnswered.tsx`
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx` (export the `WorkerAnswer`/form types if needed — see note)
- Test: `apps/desktop/src/orchestrator/WorkerQuestionAnswered.test.tsx`

**Interfaces:**
- Consumes: `PendingQuestion`, `PendingQuestionAnswer` from `@orca/contracts`.
- Produces: `WorkerQuestionAnswered({ pending }: { pending: PendingQuestion })` — renders a read-only question card using `pending.answer`. Marks chosen options with `✓`, shows inline free-text, or an "Answered in chat" hint for `viaChat`. Renders nothing if `pending.answer` is absent.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/orchestrator/WorkerQuestionAnswered.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { WorkerQuestionAnswered } from "./WorkerQuestionAnswered";
import type { PendingQuestion } from "@orca/contracts";

const base: PendingQuestion = {
  questionId: "q1", toolUseId: "t1", source: "worker",
  questions: [{
    header: "Layout", question: "Which layout?", multiSelect: false,
    options: [{ label: "Top nav", description: "top" }, { label: "Sidebar", description: "side" }],
  }],
};

describe("WorkerQuestionAnswered", () => {
  it("marks the chosen option", () => {
    render(<WorkerQuestionAnswered pending={{ ...base, answer: { answers: [{ questionIndex: 0, selectedLabels: ["Top nav"] }] } }} />);
    expect(screen.getByText(/✓\s*Top nav/)).toBeInTheDocument();
  });

  it("shows inline free-text", () => {
    render(<WorkerQuestionAnswered pending={{ ...base, answer: { freeText: "do it my way" } }} />);
    expect(screen.getByText("do it my way")).toBeInTheDocument();
  });

  it("shows an answered-in-chat hint for viaChat", () => {
    render(<WorkerQuestionAnswered pending={{ ...base, answer: { viaChat: true } }} />);
    expect(screen.getByText(/answered in chat/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C apps/desktop test src/orchestrator/WorkerQuestionAnswered.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `apps/desktop/src/orchestrator/WorkerQuestionAnswered.tsx`:

```tsx
import type { PendingQuestion } from "@orca/contracts";

const RECOMMENDED_SUFFIX = " (Recommended)";

export function WorkerQuestionAnswered({ pending }: { pending: PendingQuestion }) {
  const answer = pending.answer;
  if (answer == null) return null;

  const selectedFor = (qi: number): string[] =>
    answer.answers?.find((a) => a.questionIndex === qi)?.selectedLabels ?? [];

  return (
    <div className="orca-chat-question" data-testid="worker-question-answered">
      <div className="orca-chat-question-header">
        <span>Question</span>
      </div>
      {pending.questions.map((q, qi) => (
        <fieldset key={qi} className="orca-chat-question-block" disabled>
          <legend className="orca-chat-question-legend">
            {pending.questions.length > 1 && <span className="orca-chat-question-index">{qi + 1} · </span>}
            <span>{q.question}</span>
          </legend>
          {q.options.map((opt, oi) => {
            const recommended = opt.label.endsWith(RECOMMENDED_SUFFIX);
            const displayLabel = recommended ? opt.label.slice(0, -RECOMMENDED_SUFFIX.length) : opt.label;
            const chosen = selectedFor(qi).includes(opt.label);
            return (
              <div key={oi} className="orca-chat-option-row">
                <span className="orca-chat-option-content">
                  <span className="orca-chat-option-head">
                    <span className="orca-chat-option-label">
                      {chosen ? "✓ " : ""}{displayLabel}
                    </span>
                  </span>
                </span>
              </div>
            );
          })}
        </fieldset>
      ))}
      {answer.freeText != null ? (
        <div className="orca-chat-option-freetext" data-testid="answered-freetext">{answer.freeText}</div>
      ) : null}
      {answer.viaChat ? (
        <p className="orca-chat-question-answered-note">Answered in chat.</p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C apps/desktop test src/orchestrator/WorkerQuestionAnswered.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/WorkerQuestionAnswered.tsx apps/desktop/src/orchestrator/WorkerQuestionAnswered.test.tsx
git commit -m "feat(desktop): read-only answered worker-question view"
```

---

### Task 7: Desktop — route worker-question messages to the right form

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx` (`ChatMessageRow`, ~lines 861-902, and the `WorkerQuestionForm` answered-state guard)
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `WorkerQuestionAnswered` (Task 6), `submitWorkerAnswers`, `submitWorkerFreeText` (Tasks 5).
- Produces: `ChatMessageRow` renders, for a message with `pendingQuestion.source === "worker"`: the read-only `WorkerQuestionAnswered` when `answer` is set, else an interactive `WorkerQuestionForm` wired to the worker endpoints (card "Something else" submits with `fromChat:false`). Orchestrator-sourced questions keep the existing post-as-message path.

- [ ] **Step 1: Write the failing test**

Create/extend `apps/desktop/src/orchestrator/OrcaChat.test.tsx`. Mock `../api`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

const submitWorkerAnswers = vi.fn().mockResolvedValue(undefined);
vi.mock("../api", async () => ({
  ...(await vi.importActual<object>("../api")),
  submitWorkerAnswers,
  submitWorkerFreeText: vi.fn().mockResolvedValue(undefined),
}));

// Import after the mock.
const { ChatMessageRow } = await import("./OrcaChat");

const workerMsg = {
  id: "m1", goalId: "g1", role: "orchestrator", kind: "message", body: "Which?",
  correlationId: null, createdAt: "2026-06-18T00:00:00.000Z",
  pendingQuestion: {
    questionId: "q1", toolUseId: "t1", source: "worker",
    questions: [{ header: "H", question: "Which?", multiSelect: false, options: [{ label: "A", description: "a" }] }],
  },
} as const;

describe("ChatMessageRow worker questions", () => {
  beforeEach(() => submitWorkerAnswers.mockClear());

  it("submits a pending worker question to the worker endpoint", async () => {
    render(<ChatMessageRow message={workerMsg as never} goalId="g1" />);
    await userEvent.click(screen.getByLabelText("A"));
    await userEvent.click(screen.getByRole("button", { name: /send answer/i }));
    expect(submitWorkerAnswers).toHaveBeenCalledWith("g1", "q1", [{ questionIndex: 0, selectedLabels: ["A"] }]);
  });

  it("renders the read-only view once answered", () => {
    const answered = { ...workerMsg, pendingQuestion: { ...workerMsg.pendingQuestion, answer: { answers: [{ questionIndex: 0, selectedLabels: ["A"] }] } } };
    render(<ChatMessageRow message={answered as never} goalId="g1" />);
    expect(screen.getByTestId("worker-question-answered")).toBeInTheDocument();
  });
});
```

> `ChatMessageRow` must be exported from `OrcaChat.tsx` (it is currently a module-local function — add `export`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C apps/desktop test src/orchestrator/OrcaChat.test.tsx`
Expected: FAIL — worker question routes to the orchestrator post path / `ChatMessageRow` not exported.

- [ ] **Step 3: Implement the routing**

In `apps/desktop/src/orchestrator/OrcaChat.tsx`:

a) Export `ChatMessageRow` (add `export` to its declaration) and import the new component + worker client:

```ts
import { WorkerQuestionAnswered } from "./WorkerQuestionAnswered";
```
(`submitWorkerAnswers` and `submitWorkerFreeText` are already imported.)

b) Replace the `message.pendingQuestion && (...)` block inside `ChatMessageRow` (~lines 878-895) with a source-aware branch:

```tsx
        {message.pendingQuestion && message.pendingQuestion.source === "worker" ? (
          message.pendingQuestion.answer ? (
            <WorkerQuestionAnswered pending={message.pendingQuestion} />
          ) : (
            <WorkerQuestionForm
              goalId={goalId}
              pending={message.pendingQuestion}
              onSubmitFreeText={async (text) => {
                await submitWorkerFreeText(goalId, message.pendingQuestion!.questionId, text, { fromChat: false });
              }}
            />
          )
        ) : message.pendingQuestion ? (
          <WorkerQuestionForm
            goalId={goalId}
            pending={message.pendingQuestion}
            onSubmitAnswers={async (answers) => {
              const questions = message.pendingQuestion!.questions;
              const body = questions
                .map((q, i) => {
                  const labels = answers.find((a) => a.questionIndex === i)?.selectedLabels ?? [];
                  return `${q.header || q.question}: ${labels.join(", ")}`;
                })
                .join("\n");
              await createOrchestratorMessage(goalId, { body });
            }}
          />
        ) : null}
```

Notes:
- The worker branch with no `onSubmitAnswers` falls through `WorkerQuestionForm.handleSubmit` to the default `submitWorkerAnswers(goalId, pending.questionId, answers)` (existing behavior — keep it).
- `offerFreeText` in `WorkerQuestionForm` already requires `onSubmitFreeText != null`, so the card "Something else" option now appears for worker-question messages.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C apps/desktop test src/orchestrator/OrcaChat.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): route worker-question messages to worker form / answered view"
```

---

### Task 8: Desktop — remove the live-activity question card

**Files:**
- Modify: `apps/desktop/src/orchestrator/ActivityThread.tsx` (`pickLiveActivity`, `LiveActivity`)
- Test: `apps/desktop/src/orchestrator/ActivityThread.test.tsx`

**Interfaces:**
- Produces: `pickLiveActivity` only returns confirmation / provider-recovery pauses (no `pendingQuestion` case). `LiveActivity` no longer renders a question form or accepts `renderQuestionForm`.

- [ ] **Step 1: Update the failing tests**

In `apps/desktop/src/orchestrator/ActivityThread.test.tsx`, remove/replace any case asserting that `pickLiveActivity` returns a `pendingQuestion` activity or that `LiveActivity` renders a question form. Add:

```ts
it("ignores a pending-question activity (questions are chat messages now)", () => {
  const activity = {
    // minimal Activity with status paused_for_input + a pendingQuestion, no confirmation/recovery
    status: "paused_for_input", sourceKind: "question_pending",
    pendingQuestion: { questionId: "q1", toolUseId: "t1", source: "worker", questions: [] },
    steps: [],
  } as never;
  expect(pickLiveActivity([activity])).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C apps/desktop test src/orchestrator/ActivityThread.test.tsx`
Expected: FAIL — `pickLiveActivity` still returns the activity.

- [ ] **Step 3: Implement the removal**

In `apps/desktop/src/orchestrator/ActivityThread.tsx`:

a) `pickLiveActivity` — drop the `pendingQuestion` clause:

```ts
    if (
      activity?.status === "paused_for_input" &&
      (activity.sourceKind === "step_confirmation_pending" ||
        activity.sourceKind === "provider_recovery_pending")
    ) {
      return activity;
    }
```

b) `LiveActivity` — remove the `renderQuestionForm` prop, the `QuestionFormProps` type, the `hasPendingQuestion` logic, and the question-rendering branch. The component keeps `currentText`, confirmation, and provider-recovery. New body:

```tsx
export function LiveActivity({
  goalId,
  activity,
  renderProviderRecovery: ProviderRecovery,
  onContinue,
}: {
  goalId: string;
  activity: Activity;
  renderProviderRecovery?: ComponentType<ProviderRecoveryProps>;
  onContinue?: (runId: string) => void;
}) {
  const isConfirmation =
    activity.status === "paused_for_input" &&
    activity.sourceKind === "step_confirmation_pending";
  const isProviderRecovery =
    activity.status === "paused_for_input" &&
    activity.sourceKind === "provider_recovery_pending" &&
    activity.providerRecovery != null;
  return (
    <div className="activity-bubble" data-testid="activity-bubble" data-status={activity.status}>
      <div className="activity-bubble-text">{activity.currentText}</div>
      {isConfirmation ? (
        <div className="step-confirm-actions">
          <button
            type="button"
            data-testid="step-confirm-continue"
            className="step-confirm-continue-btn"
            onClick={() => onContinue?.(activity.workflowRunId)}
          >
            Continue
          </button>
          <span className="step-confirm-hint">
            Continue accepts this result and advances the workflow. Type revisions in chat to send it back to the agent.
          </span>
        </div>
      ) : null}
      {isProviderRecovery && ProviderRecovery && activity.providerRecovery ? (
        <ProviderRecovery runId={activity.workflowRunId} recovery={activity.providerRecovery} />
      ) : null}
    </div>
  );
}
```

c) Remove the now-unused `QuestionFormProps` type and the `goalId` param if it becomes unused (keep it only if `ProviderRecovery` needs it — it does not; remove `goalId` from the signature and the call site in Task 9).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C apps/desktop test src/orchestrator/ActivityThread.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/ActivityThread.tsx apps/desktop/src/orchestrator/ActivityThread.test.tsx
git commit -m "refactor(desktop): drop live-activity worker-question rendering"
```

---

### Task 9: Desktop — composer answers the message, "Thinking…" indicator, event wiring

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

**Interfaces:**
- Consumes: `pickLiveActivity`/`LiveActivity` (Task 8, new signature), the worker-question message list.
- Produces: composer free-text answers the latest unanswered worker-question message via `submitWorkerFreeText(..., { fromChat: true })`; a non-persisted `ThinkingRow` "Thinking…" tail appears after any worker answer and clears on the next activity / orca message; SSE refetches on `orchestrator.message.updated`.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/orchestrator/OrcaChat.test.tsx` a render of `OrcaChat` with a goal whose messages include an unanswered worker question, then type in the composer and submit; assert `submitWorkerFreeText` was called with `{ fromChat: true }` and that a "Thinking…" element appears.

```tsx
it("composer answers the pending worker question and shows Thinking…", async () => {
  // Arrange: mock listOrchestratorMessages to return one unanswered worker question,
  // listActivities -> [], getGoalDetail -> a goal with hasModel, connectionStatus open.
  // (Follow the existing OrcaChat render harness; if none exists, mock ../api fully.)
  renderOrcaChatWithWorkerQuestion();
  await userEvent.type(screen.getByPlaceholderText("Message Orca…"), "use my approach");
  await userEvent.keyboard("{Enter}");
  expect(submitWorkerFreeText).toHaveBeenCalledWith("g1", "q1", "use my approach", { fromChat: true });
  expect(await screen.findByText("Thinking…")).toBeInTheDocument();
});
```

> If a full `OrcaChat` harness is heavy, keep this test at the unit level by extracting the "find pending worker question" selector into an exported pure helper `findPendingWorkerQuestionId(messages)` and test that directly, plus a smaller composer test. Prefer the helper approach if the full render is brittle.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C apps/desktop test src/orchestrator/OrcaChat.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the OrcaChat changes**

In `apps/desktop/src/orchestrator/OrcaChat.tsx`:

a) **Remove** the `answeredQuestionId` state (line ~110), its clearing effect (~lines 420-427), and the suppression wrapper around `<LiveActivity>` (~lines 743-769). Render `LiveActivity` unconditionally when `liveActivity` is set, with the new prop set (no `renderQuestionForm`, no `goalId`):

```tsx
            {liveActivity && (
              <LiveActivity
                activity={liveActivity}
                renderProviderRecovery={({ runId, recovery }) => (
                  <ProviderRecoveryCard
                    runId={runId}
                    recovery={recovery}
                    onChanged={() => setRefreshNonce((current) => current + 1)}
                  />
                )}
                onContinue={handleContinue}
              />
            )}
```

b) **Add** the pending-worker-question selector and a transient indicator state near the other `useState`s:

```ts
const [answerPendingSince, setAnswerPendingSince] = useState<number | null>(null);

const pendingWorkerQuestionId =
  [...messages].reverse().find(
    (m) => m.pendingQuestion?.source === "worker" && m.pendingQuestion.answer == null,
  )?.pendingQuestion?.questionId ?? null;

function markAnswerPending() {
  setAnswerPendingSince(Date.now());
}
```

c) **Clear** the indicator when the next real event lands, plus a safety timeout:

```ts
useEffect(() => {
  if (answerPendingSince == null) return;
  const since = answerPendingSince;
  const newActivity = activities.some((a) => Date.parse(a.createdAt) > since);
  const orcaReplied = messages.some((m) => m.role !== "user" && Date.parse(m.createdAt) > since);
  if (newActivity || orcaReplied) setAnswerPendingSince(null);
}, [answerPendingSince, activities, messages]);

useEffect(() => {
  if (answerPendingSince == null) return;
  const id = setTimeout(() => setAnswerPendingSince(null), 20000);
  return () => clearTimeout(id);
}, [answerPendingSince]);
```

> Note on the clear condition: a newly-asked worker question is an `orchestrator` message created after `since`, so `orcaReplied` clears the indicator when the agent asks again. The user's own composer answer is a `user` message and does not clear it.

d) **Composer path** in `handleSendMessage` — replace the `liveActivity?.pendingQuestion?.questionId` lookup with `pendingWorkerQuestionId`, pass `{ fromChat: true }`, and mark the indicator instead of `setAnsweredQuestionId`:

```ts
    const liveQuestionId = pendingWorkerQuestionId;
    if (liveQuestionId) {
      setSendingMessage(true);
      setMessageError(null);
      try {
        await submitWorkerFreeText(selectedGoalId, liveQuestionId, body, { fromChat: true });
        markAnswerPending();
        setMessageDraft("");
      } catch (err) {
        setMessageError(toErrorMessage(err, "Failed to send your answer."));
      } finally {
        setSendingMessage(false);
      }
      return;
    }
```

e) **Card path** — pass an `onWorkerAnswered` callback to `ChatMessageRow` so card answers also raise the indicator. Update the timeline render of message rows:

```tsx
              entry.kind === "message" ? (
                <ChatMessageRow
                  key={entry.key}
                  message={entry.message}
                  goalId={selectedGoalId ?? ""}
                  onWorkerAnswered={markAnswerPending}
                />
              ) : ...
```

Add `onWorkerAnswered?: () => void` to `ChatMessageRow`'s props, and call it from the worker `onSubmitAnswers`/`onSubmitFreeText` handlers after success (in the Task 7 block):

```tsx
              onSubmitFreeText={async (text) => {
                await submitWorkerFreeText(goalId, message.pendingQuestion!.questionId, text, { fromChat: false });
                onWorkerAnswered?.();
              }}
```
and for the default-options submit, pass an `onSubmitAnswers` for the worker branch that calls `submitWorkerAnswers` then `onWorkerAnswered`:

```tsx
            <WorkerQuestionForm
              goalId={goalId}
              pending={message.pendingQuestion}
              onSubmitAnswers={async (answers) => {
                await submitWorkerAnswers(goalId, message.pendingQuestion!.questionId, answers);
                onWorkerAnswered?.();
              }}
              onSubmitFreeText={async (text) => {
                await submitWorkerFreeText(goalId, message.pendingQuestion!.questionId, text, { fromChat: false });
                onWorkerAnswered?.();
              }}
            />
```

f) **Render** the "Thinking…" tail near the other tail indicators (after `showStarting`, before/independent of `awaitingReply`):

```tsx
            {answerPendingSince != null && (
              <div data-testid="answer-thinking">
                <ThinkingRow label="Thinking…" />
              </div>
            )}
```

g) **SSE refetch** — add `orchestrator.message.updated` to the event filter in `openEventStream` `onEvent` (~lines 357-363):

```ts
        if (
          event.type === "goal.orchestrator_model_changed" ||
          event.type === "orchestrator.message.created" ||
          event.type === "orchestrator.message.updated" ||
          event.type === "activity.changed" ||
          event.type.startsWith("workflow.") ||
          event.type.startsWith("recommendation.")
        ) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C apps/desktop test src/orchestrator/OrcaChat.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the desktop suite + typecheck**

Run: `pnpm -C apps/desktop test && pnpm -C apps/desktop typecheck`
Expected: PASS. Fix any references to the removed `answeredQuestionId` / old `LiveActivity` props.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): composer answers worker-question message + transient Thinking indicator"
```

---

### Task 10: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole suite**

Run: `pnpm -r test`
Expected: PASS across `@orca/contracts`, `apps/daemon`, `apps/desktop`.

- [ ] **Step 2: Typecheck the monorepo**

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 3: Manual smoke (optional, via the running daemon)**

Drive a goal to a worker `AskUserQuestion`. Verify: the question appears as its own chat bubble between two activity threads; answering via options shows ✓ inline; answering via the card's "Something else" shows the text inline with no extra "you" bubble; answering via the composer shows a "you" bubble + "Answered in chat" on the question; "Thinking…" appears after answering and disappears when the next thread starts; the "Forwarding your response to the agent." line never appears.

- [ ] **Step 4: Add a CSS rule for the answered-in-chat note (if unstyled)**

If `.orca-chat-question-answered-note` looks unstyled, add to `apps/desktop/src/orchestrator/orca-chat.css`:

```css
.orca-chat-question-answered-note { margin-top: 8px; font-size: 12px; opacity: 0.6; }
```
Commit:
```bash
git add apps/desktop/src/orchestrator/orca-chat.css
git commit -m "style(desktop): answered-in-chat note"
```

---

## Self-Review

**Spec coverage:**
- Question persists as its own bubble between threads → Tasks 3 (ask message + settle), 7 (render), 8 (remove live card).
- Three answer renderings (options ✓ / inline free-text / answered-in-chat) → Tasks 4 (record), 6 (view).
- Remove "Forwarding…" → Task 4.
- Thread break preserved → Task 3 (empty-summary settle) confirmed by Task 4 test (no "Forwarding" activity) + post-answer work opens a new activity naturally.
- Card "Something else" inline only, no user message → Task 4 (free-text test) + Task 7 (`fromChat:false`).
- Composer answers message + inserts user message → Tasks 4, 9.
- Transient "Thinking…" → Task 9.
- `orchestrator.message.updated` event + refetch → Tasks 1, 2, 9.
- No DB migration → Tasks 1/2 store inside `pending_question`.

**Type consistency:** `recordWorkerQuestionAnswer`, `PendingQuestionAnswer`, `source`, `fromChat`, `WorkerQuestionAnswered`, `pendingWorkerQuestionId`, `markAnswerPending`, `onWorkerAnswered` are used consistently across tasks. `submitWorkerFreeText(..., { fromChat })` signature matches Task 5.

**Placeholder scan:** test scaffolding notes ("follow existing harness") point at concrete existing helpers in the named files rather than leaving logic unspecified; all implementation steps include full code.
