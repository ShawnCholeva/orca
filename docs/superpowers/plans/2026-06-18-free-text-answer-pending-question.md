# Free-text Answers to a Pending Question — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user respond to a pending worker `AskUserQuestion` with free text (typed in the composer or via an in-card "Something else" box), routing that text to the worker as the answer, persisting it to the transcript, and dismissing the card in correct order.

**Architecture:** A worker question already resolves via `resolveAnswers(questionId, reason)`, which forwards arbitrary text to the worker. We extend the worker-answer contract/route to accept `freeText` (resolving the question with the user's words and recording a chat message), add a desktop client call, and wire the composer + a new "Something else" affordance to it with optimistic card dismissal.

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), Fastify (daemon), React + Vitest + Testing Library (desktop).

## Global Constraints

- Free text bounds: `min(1).max(4000)` after trim — copied from `CreateOrchestratorMessageRequest`.
- A worker-answer request carries **exactly one** of `answers` or `freeText`, never both, never neither.
- "Something else" is **exclusive**: it cannot be combined with worker-option selections; it renders only for single-question forms.
- Match existing file style; touch only what each task requires (CLAUDE.md: surgical changes).
- The spec this implements: `docs/superpowers/specs/2026-06-18-free-text-answer-pending-question-design.md`.

---

### Task 1: Contract accepts a free-text worker answer

**Files:**
- Modify: `packages/contracts/src/index.ts:1265-1268`
- Test: `packages/contracts/src/__tests__/orchestration-contracts.test.ts`

**Interfaces:**
- Produces: `SubmitWorkerAnswersRequest` now parses `{ answers: WorkerAnswer[] }` **or** `{ freeText: string }`. Type gains optional `answers?` and `freeText?`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/contracts/src/__tests__/orchestration-contracts.test.ts` (near the existing `SubmitWorkerAnswersRequest` tests around line 950):

```ts
it("SubmitWorkerAnswersRequest accepts a free-text answer", () => {
  const r = SubmitWorkerAnswersRequest.parse({ freeText: "a dedicated workspaces tab" });
  expect(r.freeText).toBe("a dedicated workspaces tab");
  expect(r.answers).toBeUndefined();
});

it("SubmitWorkerAnswersRequest rejects empty free text", () => {
  expect(() => SubmitWorkerAnswersRequest.parse({ freeText: "   " })).toThrow();
});

it("SubmitWorkerAnswersRequest rejects both answers and freeText", () => {
  expect(() =>
    SubmitWorkerAnswersRequest.parse({
      answers: [{ questionIndex: 0, selectedLabels: ["Red"] }],
      freeText: "something",
    }),
  ).toThrow();
});

it("SubmitWorkerAnswersRequest rejects neither answers nor freeText", () => {
  expect(() => SubmitWorkerAnswersRequest.parse({})).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/contracts && pnpm test -- orchestration-contracts`
Expected: FAIL — the new shape is rejected by the current `.strict()` object (unknown key `freeText`).

- [ ] **Step 3: Implement the contract change**

Replace `packages/contracts/src/index.ts:1265-1268`:

```ts
export const SubmitWorkerAnswersRequest = z
  .object({
    answers: z.array(WorkerAnswer).min(1).optional(),
    freeText: z.string().trim().min(1).max(4000).optional(),
  })
  .strict()
  .refine((v) => (v.answers != null) !== (v.freeText != null), {
    message: "Provide exactly one of answers or freeText",
  });
export type SubmitWorkerAnswersRequest = z.infer<typeof SubmitWorkerAnswersRequest>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/contracts && pnpm test -- orchestration-contracts`
Expected: PASS (new tests pass; the existing label-shape test at ~line 950 still passes).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/__tests__/orchestration-contracts.test.ts
git commit -m "feat(contracts): accept a free-text worker answer"
```

---

### Task 2: Free-text deny-reason formatter

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/worker-answer-format.ts`
- Test: `apps/daemon/src/workflows/orchestrator/worker-answer-format.test.ts`

**Interfaces:**
- Produces: `assembleFreeTextReason(text: string): string` — the reason string handed to `resolveAnswers` for a free-text answer.

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/workflows/orchestrator/worker-answer-format.test.ts`:

```ts
import { validateAnswers, assembleAnswerReason, assembleFreeTextReason } from "./worker-answer-format.js";

describe("assembleFreeTextReason", () => {
  it("wraps the user's words as a final, answer-bearing deny reason", () => {
    expect(assembleFreeTextReason("a dedicated workspaces tab")).toBe(
      "User answered via Orca chat with a custom response: \"a dedicated workspaces tab\". " +
        "Treat the AskUserQuestion as fully answered with this response and continue. " +
        "Do not call AskUserQuestion again.",
    );
  });
});
```

(Replace the existing top-of-file import of `worker-answer-format.js` with the line above so `assembleFreeTextReason` is in scope.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm test -- worker-answer-format`
Expected: FAIL with "assembleFreeTextReason is not a function" / export missing.

- [ ] **Step 3: Implement the formatter**

Append to `apps/daemon/src/workflows/orchestrator/worker-answer-format.ts`:

```ts
/** Deny-reason text carrying the user's own free-text answer. */
export function assembleFreeTextReason(text: string): string {
  return (
    `User answered via Orca chat with a custom response: "${text}". ` +
    "Treat the AskUserQuestion as fully answered with this response and continue. " +
    "Do not call AskUserQuestion again."
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/daemon && pnpm test -- worker-answer-format`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/worker-answer-format.ts apps/daemon/src/workflows/orchestrator/worker-answer-format.test.ts
git commit -m "feat(daemon): free-text worker-answer deny reason"
```

---

### Task 3: Answer route resolves free text and records a chat message

**Files:**
- Modify: `apps/daemon/src/server.ts:1502-1525` (the worker-questions answer route)
- Modify: `apps/daemon/src/server.ts:215` (import `assembleFreeTextReason`)
- Modify: `apps/daemon/src/orchestrator-chat/usecases.ts:216-217` (narrow `insertMessageWithEvent` ctx param)
- Test: `apps/daemon/src/server.activity.test.ts`

**Interfaces:**
- Consumes: `SubmitWorkerAnswersRequest` (Task 1), `assembleFreeTextReason` (Task 2), existing `insertMessageWithEvent`, `workerQuestions.resolveAnswers`, `daemonContext.now/idFactory`, `eventBus`, `db`.
- Produces: `POST /v1/goals/:goalId/worker-questions/:questionId/answer` accepts `{ freeText }`; on success resolves the question with `assembleFreeTextReason(freeText)` and inserts a `role:"user"` orchestrator message with `body === freeText`.

- [ ] **Step 1: Narrow `insertMessageWithEvent` so the route can call it**

The route scope has `db`, `eventBus`, `daemonContext.idFactory` but not a full `OrchestratorChatCtx` (no `modelProviderRegistry`). `insertMessageWithEvent` only uses `db`, `bus`, `idFactory`, so narrow its parameter (existing full-ctx callers still satisfy it).

In `apps/daemon/src/orchestrator-chat/usecases.ts`, change the `insertMessageWithEvent` signature (line ~216):

```ts
export function insertMessageWithEvent(
  ctx: Pick<OrchestratorChatCtx, "db" | "bus" | "idFactory">,
  message: {
```

- [ ] **Step 2: Write the failing test**

Add to `apps/daemon/src/server.activity.test.ts` (alongside the existing answer-route tests, mirroring the harness used at ~line 519):

```ts
it("resolves a worker question from a free-text answer and records it in chat", async () => {
  const ids = {
    goalId: "goal-question-freetext",
    runId: "run-question-freetext",
    stepRunId: "step-question-freetext",
    sessionId: "session-question-freetext",
  };
  const questions: PendingQuestionItem[] = [
    {
      header: "Release Plan",
      question: "When should this ship?",
      multiSelect: false,
      options: [
        { label: "Ship now", description: "Release immediately." },
        { label: "Wait", description: "Hold for another review." },
      ],
    },
  ];
  seedLiveWorkflowSession(db, ids);
  expect(
    (await postToolUse(server, ids.sessionId, "tool-use-question-freetext")).statusCode,
  ).toBe(200);

  const elicitPromise = postElicit(server, ids.sessionId, "question-tool-freetext", questions);
  const recorded = await waitForRecordedQuestion(db, ids);

  const answer = await server.inject({
    method: "POST",
    url: `/v1/goals/${ids.goalId}/worker-questions/${recorded.pendingQuestion.questionId}/answer`,
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    payload: { freeText: "a dedicated workspaces tab" },
  });
  const elicit = await elicitPromise;

  expect(answer.statusCode).toBe(200);
  expect(elicit.json()).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        'User answered via Orca chat with a custom response: "a dedicated workspaces tab". ' +
        "Treat the AskUserQuestion as fully answered with this response and continue. " +
        "Do not call AskUserQuestion again.",
    },
  });

  const chatRows = db
    .prepare("SELECT role, body FROM orchestrator_messages WHERE goal_id = ? ORDER BY rowid")
    .all(ids.goalId) as Array<{ role: string; body: string }>;
  expect(chatRows).toContainEqual({ role: "user", body: "a dedicated workspaces tab" });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/daemon && pnpm test -- server.activity`
Expected: FAIL — the route currently 400s on a payload without `answers`, and no `user` chat row is written.

- [ ] **Step 4: Add the import**

In `apps/daemon/src/server.ts` line 215, extend the existing import:

```ts
import { validateAnswers, assembleAnswerReason, assembleFreeTextReason } from './workflows/orchestrator/worker-answer-format.js';
```

- [ ] **Step 5: Implement the route branch**

Replace the body of the answer route at `apps/daemon/src/server.ts:1502-1525` (the validate/assemble/resolve block) with:

```ts
  server.post("/v1/goals/:goalId/worker-questions/:questionId/answer", async (request, reply) => {
    const { goalId, questionId } = request.params as { goalId: string; questionId: string };
    const parsed = SubmitWorkerAnswersRequest.safeParse(request.body);
    if (!parsed.success) { reply.status(400); return { error: "validation_failed", issues: parsed.error.issues }; }
    const pending = workerQuestions.get(questionId);
    if (!pending || pending.goalId !== goalId) { reply.status(404); return { error: { code: "question_not_found" } }; }

    let reason: string;
    if (parsed.data.freeText != null) {
      reason = assembleFreeTextReason(parsed.data.freeText);
    } else {
      const invalid = validateAnswers(pending.questions, parsed.data.answers!);
      if (invalid) { reply.status(400); return { error: { code: invalid } }; }
      reason = assembleAnswerReason(pending.questions, parsed.data.answers!);
    }

    const ok = workerQuestions.resolveAnswers(questionId, reason);
    if (!ok) { reply.status(409); return { error: { code: "already_answered" } }; }

    if (parsed.data.freeText != null) {
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

    const stepContext = resolveStepContext(pending.sessionId);
    if (stepContext) {
      applyActivitySafely("agent.question_answered", {
        kind: "turn_completed",
        stepRunId: stepContext.stepRunId,
        summary: "Forwarding your response to the agent.",
        confidence: null,
      });
    }
    return { ok: true };
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm test -- server.activity`
Expected: PASS (new free-text test passes; the existing label-answer tests at ~line 460/519 still pass).

- [ ] **Step 7: Typecheck the daemon**

Run: `cd apps/daemon && pnpm typecheck`
Expected: no errors (confirms the narrowed `insertMessageWithEvent` param and route compile).

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/orchestrator-chat/usecases.ts apps/daemon/src/server.activity.test.ts
git commit -m "feat(daemon): resolve worker questions from free text + record chat message"
```

---

### Task 4: Desktop client — submitWorkerFreeText

**Files:**
- Modify: `apps/desktop/src/api.ts:984-1002` (next to `submitWorkerAnswers`)
- Test: `apps/desktop/src/api.test.ts`

**Interfaces:**
- Produces: `submitWorkerFreeText(goalId: string, questionId: string, freeText: string): Promise<void>` — POSTs `{ freeText }` to the worker-answer route.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/api.test.ts` (inside the `describe("desktop api client", …)` block):

```ts
it("submitWorkerFreeText posts freeText to the worker-answer route", async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

  await api.submitWorkerFreeText("goal-1", "q-1", "a dedicated workspaces tab");

  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toContain("/v1/goals/goal-1/worker-questions/q-1/answer");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ freeText: "a dedicated workspaces tab" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/api.test.ts`
Expected: FAIL with "api.submitWorkerFreeText is not a function".

- [ ] **Step 3: Implement the client function**

Add directly below `submitWorkerAnswers` in `apps/desktop/src/api.ts` (after line 1002):

```ts
export async function submitWorkerFreeText(
  goalId: string,
  questionId: string,
  freeText: string,
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
      body: JSON.stringify({ freeText }),
    },
    "Submit worker free-text answer failed",
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/api.test.ts
git commit -m "feat(desktop): submitWorkerFreeText client call"
```

---

### Task 5: "Something else" inline affordance in WorkerQuestionForm

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx:865-959` (`WorkerQuestionForm`)
- Modify: `apps/desktop/src/orchestrator/orca-chat.css` (style the free-text textarea)
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

**Interfaces:**
- Consumes: `submitWorkerFreeText` (Task 4) — wired into the live-activity `renderQuestionForm` wrapper here (without dismissal; Task 6 adds dismissal).
- Produces: `WorkerQuestionForm` gains optional prop `onSubmitFreeText?: (text: string) => Promise<void>`. When present **and** the form has exactly one question, it renders an exclusive "Something else" radio that reveals a textarea and submits via `onSubmitFreeText`.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/orchestrator/OrcaChat.test.tsx` (this exercises the live worker-question path, mirroring the setup of the existing "shows a Recommended badge" test at ~line 675):

```ts
it("offers 'Something else' on a live worker question and submits free text", async () => {
  setupRunLoad();
  listActivitiesMock.mockResolvedValue([
    {
      ...activeActivity,
      status: "paused_for_input",
      currentText: "I need your call on the approach.",
      sourceKind: "question_pending",
      pendingQuestion: {
        questionId: "question-1",
        toolUseId: "tool-1",
        questions: [
          {
            header: "Approach",
            question: "Which approach should I use?",
            multiSelect: false,
            options: [
              { label: "Use hooks", description: "Matches the existing integration." },
              { label: "Poll the API", description: "Adds a separate refresh loop." },
            ],
          },
        ],
      },
    },
  ]);
  const { OrcaChat } = await import("./OrcaChat");
  render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

  await screen.findByText("Which approach should I use?");
  fireEvent.click(screen.getByRole("radio", { name: /something else/i }));
  fireEvent.change(screen.getByPlaceholderText(/your own answer/i), {
    target: { value: "a dedicated workspaces tab" },
  });
  fireEvent.click(screen.getByRole("button", { name: /submit/i }));

  await waitFor(() =>
    expect(submitWorkerFreeTextMock).toHaveBeenCalledWith(
      "goal-1",
      "question-1",
      "a dedicated workspaces tab",
    ),
  );
});
```

Register the mock alongside the other api mocks at the top of `OrcaChat.test.tsx` (where `submitWorkerAnswersMock` is defined): add `const submitWorkerFreeTextMock = vi.fn();` and include `submitWorkerFreeText: submitWorkerFreeTextMock,` in the `vi.mock("../api", …)` factory; reset it in the `beforeEach` next to `submitWorkerAnswersMock.mockReset()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx -t "Something else"`
Expected: FAIL — no "Something else" radio exists yet.

- [ ] **Step 3: Add the prop and free-text state**

In `apps/desktop/src/orchestrator/OrcaChat.tsx`, extend the `WorkerQuestionForm` prop type (line ~869-875) to add:

```ts
  // Live worker questions also accept a free-text answer ("Something else").
  // Provided only on the live-activity path; absent for orchestrator ask_user.
  onSubmitFreeText?: (text: string) => Promise<void>;
```

Add state next to the existing `useState` hooks (line ~877-879):

```ts
  const [freeTextSelected, setFreeTextSelected] = useState(false);
  const [freeText, setFreeText] = useState("");
  const singleQuestion = pending.questions.length === 1;
  const offerFreeText = singleQuestion && onSubmitFreeText != null;
```

Extend the reset effect (line ~881-885) to also clear free-text state:

```ts
  useEffect(() => {
    setSelections({});
    setSubmitted(false);
    setExpired(false);
    setFreeTextSelected(false);
    setFreeText("");
  }, [pending.questionId]);
```

- [ ] **Step 4: Make selection exclusive and update submit gating**

Update `toggle` so picking a worker option clears the free-text choice (line ~887-896):

```ts
  function toggle(qIndex: number, label: string, multi: boolean) {
    setFreeTextSelected(false);
    setSelections((prev) => {
      const current = prev[qIndex] ?? [];
      if (multi) {
        const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
        return { ...prev, [qIndex]: next };
      }
      return { ...prev, [qIndex]: [label] };
    });
  }

  function chooseFreeText() {
    setSelections({});
    setFreeTextSelected(true);
  }
```

Replace `allAnswered` and `handleSubmit` (line ~898-910):

```ts
  const optionsAnswered = pending.questions.every((_, i) => (selections[i]?.length ?? 0) > 0);
  const canSubmit = freeTextSelected ? freeText.trim().length > 0 : optionsAnswered;

  async function handleSubmit() {
    const answers = pending.questions.map((_, i) => ({ questionIndex: i, selectedLabels: selections[i] ?? [] }));
    setSubmitted(true);
    try {
      if (freeTextSelected && onSubmitFreeText) await onSubmitFreeText(freeText.trim());
      else if (onSubmitAnswers) await onSubmitAnswers(answers);
      else await submitWorkerAnswers(goalId, pending.questionId, answers);
    } catch {
      setSubmitted(false);
      setExpired(true);
    }
  }
```

- [ ] **Step 5: Render the "Something else" row and textarea**

In the JSX, immediately after the `q.options.map(...)` block closes (the `})}` at line ~946) and still inside the `fieldset`, add — guarded so it only shows on the last question of a single-question form:

```tsx
          {offerFreeText && qi === pending.questions.length - 1 ? (
            <>
              <label className="orca-chat-option-row">
                <input
                  type="radio"
                  name={`${pending.questionId}-${qi}`}
                  aria-label="Something else"
                  checked={freeTextSelected}
                  onChange={chooseFreeText}
                />
                <span className="orca-chat-option-content">
                  <span className="orca-chat-option-head">
                    <span className="orca-chat-option-label">Something else</span>
                  </span>
                  <span className="orca-chat-option-desc">Write your own response instead of picking an option.</span>
                </span>
              </label>
              {freeTextSelected ? (
                <textarea
                  className="orca-chat-option-freetext"
                  value={freeText}
                  placeholder="Type your own answer…"
                  rows={2}
                  disabled={submitted}
                  onChange={(e) => setFreeText(e.target.value)}
                />
              ) : null}
            </>
          ) : null}
```

Update the submit button's `disabled` (line ~952) from `!allAnswered` to `!canSubmit`:

```tsx
        disabled={submitted || !canSubmit}
```

- [ ] **Step 6: Style the textarea**

Append to `apps/desktop/src/orchestrator/orca-chat.css` (near the other `.orca-chat-option-*` rules around line 815):

```css
.orca-chat-option-freetext {
  margin: 4px 0 0 22px;
  min-height: 48px;
  max-height: 140px;
  padding: 8px 10px;
  border: 1px solid var(--hairline-strong);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
}
.orca-chat-option-freetext:focus {
  outline: none;
  border-color: var(--accent-line);
}
```

- [ ] **Step 7: Wire the free-text handler into the live-activity form**

The "Something else" row only renders when `onSubmitFreeText` is supplied. Provide it from the live-activity render. First import the client call — add to the `../api` import group in `apps/desktop/src/orchestrator/OrcaChat.tsx` (near line 29 where `submitWorkerAnswers` is imported):

```ts
  submitWorkerFreeText,
```

Then replace `renderQuestionForm={WorkerQuestionForm}` (line ~718) with a wrapper that injects the handler:

```tsx
                renderQuestionForm={(props) => (
                  <WorkerQuestionForm
                    {...props}
                    onSubmitFreeText={async (text) => {
                      await submitWorkerFreeText(selectedGoalId ?? "", props.pending.questionId, text);
                    }}
                  />
                )}
```

(Task 6 evolves this wrapper to also dismiss the card.)

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx -t "Something else"`
Expected: PASS.

- [ ] **Step 9: Run the full OrcaChat suite for regressions**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx`
Expected: PASS. The existing "Recommended badge" worker-question test now also renders through the wrapper, so a "Something else" row appears in it too — that test queries specific option text/roles and selecting "Use hooks" still routes to `submitWorkerAnswers`, so it stays green.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/orca-chat.css apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): 'Something else' free-text option on worker questions"
```

---

### Task 6: Composer routing + optimistic card dismissal

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx` — state (line ~108-109), `handleSendMessage` (line ~530-555), the live-activity render guard + wrapper (introduced in Task 5), and add a dismissal effect.
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

**Interfaces:**
- Consumes: `submitWorkerFreeText` (imported in Task 5), `liveActivity` from `pickLiveActivity` (already computed at line 413), the `renderQuestionForm` wrapper (added in Task 5).
- Produces: composer text sent while a worker question is live answers that question; the live question card is suppressed immediately after either path resolves it.

- [ ] **Step 1: Write the failing tests**

Add to `apps/desktop/src/orchestrator/OrcaChat.test.tsx` (reuses `submitWorkerFreeTextMock` from Task 5):

```ts
it("composer text while a worker question is live answers the worker, not the orchestrator", async () => {
  setupRunLoad();
  listActivitiesMock.mockResolvedValue([
    {
      ...activeActivity,
      status: "paused_for_input",
      currentText: "I need your call on the approach.",
      sourceKind: "question_pending",
      pendingQuestion: {
        questionId: "question-1",
        toolUseId: "tool-1",
        questions: [
          {
            header: "Approach",
            question: "Which approach should I use?",
            multiSelect: false,
            options: [{ label: "Use hooks", description: "x" }],
          },
        ],
      },
    },
  ]);
  const { OrcaChat } = await import("./OrcaChat");
  render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

  await screen.findByText("Which approach should I use?");
  fireEvent.change(screen.getByPlaceholderText("Message Orca…"), {
    target: { value: "a dedicated workspaces tab" },
  });
  fireEvent.click(screen.getByRole("button", { name: /send/i }));

  await waitFor(() =>
    expect(submitWorkerFreeTextMock).toHaveBeenCalledWith(
      "goal-1",
      "question-1",
      "a dedicated workspaces tab",
    ),
  );
  expect(createOrchestratorMessageMock).not.toHaveBeenCalled();
  // The live question card is dismissed, so the question no longer renders.
  await waitFor(() =>
    expect(screen.queryByText("Which approach should I use?")).not.toBeInTheDocument(),
  );
});
```

(`createOrchestratorMessageMock` already exists in this test file's `../api` mock; if not, add it to the mock factory and `beforeEach` reset the same way as `submitWorkerFreeTextMock`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx -t "answers the worker"`
Expected: FAIL — composer currently calls `createOrchestratorMessage` and the card stays up.

- [ ] **Step 3: Add dismissal state**

Next to the other `useState` hooks (line ~108-109):

```ts
  const [answeredQuestionId, setAnsweredQuestionId] = useState<string | null>(null);
```

(`submitWorkerFreeText` was already imported in Task 5, Step 7.)

- [ ] **Step 4: Branch the composer onto the worker path**

In `handleSendMessage` (line ~530), after `const body = messageDraft.trim(); if (!body) return;` and before `setSendingMessage(true)`, add the worker-question branch:

```ts
    const liveQuestionId = liveActivity?.pendingQuestion?.questionId ?? null;
    if (liveQuestionId) {
      setSendingMessage(true);
      setMessageError(null);
      try {
        await submitWorkerFreeText(selectedGoalId, liveQuestionId, body);
        setAnsweredQuestionId(liveQuestionId);
        setMessageDraft("");
      } catch (err) {
        setMessageError(toErrorMessage(err, "Failed to send your answer."));
      } finally {
        setSendingMessage(false);
      }
      return;
    }
```

- [ ] **Step 5: Suppress the dismissed live question card**

Replace the live-activity render block from Task 5 (line ~714) so a dismissed question card is hidden and the wrapper also records the dismissal:

```tsx
            {liveActivity &&
              !(
                liveActivity.pendingQuestion != null &&
                liveActivity.pendingQuestion.questionId === answeredQuestionId
              ) && (
              <LiveActivity
                goalId={selectedGoalId ?? ""}
                activity={liveActivity}
                renderQuestionForm={(props) => (
                  <WorkerQuestionForm
                    {...props}
                    onSubmitFreeText={async (text) => {
                      await submitWorkerFreeText(selectedGoalId ?? "", props.pending.questionId, text);
                      setAnsweredQuestionId(props.pending.questionId);
                    }}
                  />
                )}
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

- [ ] **Step 6: Clear the dismissal once the backend catches up**

Add an effect near the other effects in the component body (after `liveActivity` is computed, e.g. just below line 413):

```ts
  // Once the resolved question leaves the live slot (backend caught up), stop
  // suppressing — a later, different question must be allowed to render.
  useEffect(() => {
    if (
      answeredQuestionId != null &&
      liveActivity?.pendingQuestion?.questionId !== answeredQuestionId
    ) {
      setAnsweredQuestionId(null);
    }
  }, [liveActivity?.pendingQuestion?.questionId, answeredQuestionId]);
```

- [ ] **Step 7: Run the targeted test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx -t "answers the worker"`
Expected: PASS.

- [ ] **Step 8: Run the full desktop suite + typecheck**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx src/orchestrator/ActivityThread.test.tsx && pnpm typecheck`
Expected: PASS, no type errors. (The "Something else" test from Task 5 still passes through the dismissal-aware wrapper.)

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): composer answers live worker questions + dismiss card"
```

---

## Final verification

- [ ] **Run the full workspace test + typecheck**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: all packages pass.

- [ ] **Manual smoke (optional, via the running daemon):** trigger a worker `AskUserQuestion`, type a free response in the composer → the worker continues, your message shows in chat, the card disappears in order. Repeat using the in-card "Something else" box.
