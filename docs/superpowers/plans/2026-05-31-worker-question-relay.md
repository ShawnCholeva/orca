# Worker Question Relay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a headless tmux worker calls claude's `AskUserQuestion` tool, surface its question + options to the user in the orchestrator chat as clickable buttons; when the user clicks, drive the worker's tmux menu to that selection.

**Architecture:** A `PreToolUse(AskUserQuestion)` http hook (added to each worker's `--settings`) posts the structured `{questions[], tool_use_id}` to the daemon and returns `allow` (the menu renders in the worker pane and the agent blocks on it). The daemon records the pending question, posts an orchestrator chat message carrying the options, and the desktop renders clickable buttons. The user's click hits a daemon endpoint that maps option→index and drives the tmux menu via `send-keys Down×(i-1) + Enter` (spike-proven; option order matches menu order). No pane parsing anywhere.

**Tech stack:** TypeScript, Node.js daemon, Fastify, tmux, React/TypeScript desktop, SQLite, zod contracts, vitest.

**Design source:** spike on 2026-05-31 confirmed the `PreToolUse` payload shape:
```json
{ "tool_name":"AskUserQuestion", "tool_use_id":"toolu_…",
  "tool_input": { "questions": [ { "question":"…","header":"…",
    "options":[{"label":"…","description":"…"}], "multiSelect":false } ] } }
```
The rendered tmux menu lists `1. <opt0> / 2. <opt1> / …` then claude appends `Type something` / `Chat about this` — so menu index for option *i* (0-based) is `i+1`, reached by `Down×i` from the default-highlighted first row.

**MVP scope:** single question, single-select (`multiSelect:false`, `questions.length===1`). For `multiSelect:true` or multiple questions, post a plain chat note that the agent asked something unsupported and leave the worker (deferred). Built on `main` after the tmux-worker transport merge (`5beb3f4`).

---

## File structure

**Contracts** (`packages/contracts/src`):
- Extend `OrchestratorChatMessage` with an optional `pendingQuestion` payload.
- Add `SelectWorkerQuestionOption` request/response.

**Daemon** (`apps/daemon/src`):
- `agent-hooks/hook-settings.ts` — add `PreToolUse(AskUserQuestion)` to `buildAgentHookSettings`.
- `agent-hooks/routes.ts` — add `POST /v1/agent-hooks/elicit`.
- `workflows/orchestrator/worker-session.ts` — add `selectMenuOption(sessionId, optionIndex)`.
- `workflows/orchestrator/worker-questions.ts` (new) — in-memory pending-question store keyed by a question id.
- `server.ts` — wire elicit route → store + chat post; wire a select route → store + `selectMenuOption`.
- `orchestrator-chat/...` — projection includes `pendingQuestion` when present.

**Desktop** (`apps/desktop/src`):
- `orchestrator/OrcaChat.tsx` — render option buttons for a message with `pendingQuestion`; click → `selectWorkerQuestionOption` api.
- `api.ts` — `selectWorkerQuestionOption(goalId, questionId, optionIndex)`.

---

## Task 1: Contracts — pendingQuestion + select request

**Files:**
- Modify: `packages/contracts/src/orchestrator-chat.ts` (or wherever `OrchestratorChatMessage` is defined — grep it)
- Test: the contracts test file for that schema (grep for an existing `OrchestratorChatMessage` test)

- [ ] **Step 1: Find the schema + its test.** `grep -rn "OrchestratorChatMessage" packages/contracts/src`. Read the schema module and an adjacent test to match conventions.

- [ ] **Step 2: Write failing test** asserting the new shapes parse:

```typescript
import { OrchestratorChatMessage, SelectWorkerQuestionOptionRequest } from "../src/index.js"; // adjust import to the package's public entry

it("OrchestratorChatMessage accepts an optional pendingQuestion", () => {
  const m = OrchestratorChatMessage.parse({
    id: "m1", goalId: "g1", role: "orchestrator", kind: "message", body: "Agent asks: pick one",
    correlationId: "c1", createdAt: new Date().toISOString(),
    pendingQuestion: {
      questionId: "q1", header: "Color", question: "Favorite color?",
      options: [{ label: "Red", description: "Warm" }, { label: "Green", description: "Calm" }],
    },
  });
  expect(m.pendingQuestion?.options).toHaveLength(2);
});

it("SelectWorkerQuestionOptionRequest validates an option index", () => {
  expect(SelectWorkerQuestionOptionRequest.parse({ optionIndex: 1 }).optionIndex).toBe(1);
  expect(() => SelectWorkerQuestionOptionRequest.parse({ optionIndex: -1 })).toThrow();
});
```

- [ ] **Step 3: Run → fail.** `pnpm --filter @orca/contracts exec vitest run <test path>` → FAIL.

- [ ] **Step 4: Implement.** Add to the `OrchestratorChatMessage` zod object an optional field:

```typescript
pendingQuestion: z
  .object({
    questionId: z.string().min(1),
    header: z.string().max(120),
    question: z.string().max(4000),
    options: z
      .array(z.object({ label: z.string().min(1).max(200), description: z.string().max(1000) }))
      .min(1)
      .max(12),
  })
  .optional(),
```
Add and export a new request schema:
```typescript
export const SelectWorkerQuestionOptionRequest = z.object({ optionIndex: z.number().int().min(0).max(11) }).strict();
export type SelectWorkerQuestionOptionRequest = z.infer<typeof SelectWorkerQuestionOptionRequest>;
```
Export `pendingQuestion` typing via the existing inferred `OrchestratorChatMessage` type. Ensure both are exported from the package entrypoint (the file that re-exports public contracts — grep `export * from` / the index).

- [ ] **Step 5: Run → pass.** Contracts typecheck: `pnpm --filter @orca/contracts exec tsc --noEmit`.

- [ ] **Step 6: Commit.**
```bash
git add packages/contracts/src
git commit -m "feat(contracts): pendingQuestion on chat message + select-option request"
```

---

## Task 2: Daemon — PreToolUse(AskUserQuestion) hook in worker settings

**Files:**
- Modify: `apps/daemon/src/agent-hooks/hook-settings.ts`
- Test: `apps/daemon/src/agent-hooks/hook-settings.test.ts`

- [ ] **Step 1: Failing test** (append):

```typescript
it("includes a PreToolUse AskUserQuestion http hook pointing at /elicit", () => {
  const s = buildAgentHookSettings({ sessionId: "sess-1", port: 8787, authToken: "tok" });
  const pre = (s.hooks as Record<string, unknown>)["PreToolUse"] as Array<{ matcher: string; hooks: Array<{ url: string; headers: Record<string,string> }> }>;
  expect(pre[0]!.matcher).toBe("AskUserQuestion");
  expect(pre[0]!.hooks[0]!.url).toContain("/v1/agent-hooks/elicit?sessionId=sess-1");
  expect(pre[0]!.hooks[0]!.headers).toEqual({ Authorization: "Bearer tok" });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** In `hook-settings.ts`:
- Add `export function elicitHookUrl(port: number, sessionId: string): string { return `http://127.0.0.1:${port}/v1/agent-hooks/elicit?sessionId=${encodeURIComponent(sessionId)}`; }`
- Extend the `AgentHookSettings` interface `hooks` to also allow `PreToolUse?: Array<{ matcher: string; hooks: HttpHook[] }>`.
- In `buildAgentHookSettings`, add to the returned `hooks`:
```typescript
PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "http", url: elicitHookUrl(args.port, args.sessionId), headers }] }],
```
(Keep the existing `Stop`/`StopFailure`.)

- [ ] **Step 4: Run → pass.** Typecheck.

- [ ] **Step 5: Commit.**
```bash
git add apps/daemon/src/agent-hooks/hook-settings.ts apps/daemon/src/agent-hooks/hook-settings.test.ts
git commit -m "feat(daemon): worker PreToolUse(AskUserQuestion) elicit hook"
```

---

## Task 3: Daemon — worker-questions store + selectMenuOption

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/worker-questions.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/worker-session.ts`
- Test: `apps/daemon/src/workflows/orchestrator/worker-questions.test.ts`, `worker-session.test.ts`

- [ ] **Step 1: Failing test for the store** (`worker-questions.test.ts`):

```typescript
import { describe, expect, it } from "vitest";
import { WorkerQuestionStore } from "./worker-questions.js";

describe("WorkerQuestionStore", () => {
  it("records and resolves a pending question by id", () => {
    const store = new WorkerQuestionStore(() => "q-1");
    const id = store.record({ sessionId: "s1", optionCount: 3 });
    expect(id).toBe("q-1");
    expect(store.get(id)).toMatchObject({ sessionId: "s1", optionCount: 3 });
    store.resolve(id);
    expect(store.get(id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `worker-questions.ts`:**

```typescript
export interface PendingWorkerQuestion { sessionId: string; optionCount: number; }

export class WorkerQuestionStore {
  private readonly pending = new Map<string, PendingWorkerQuestion>();
  constructor(private readonly idFactory: () => string = () => Math.random().toString(36).slice(2)) {}
  record(q: PendingWorkerQuestion): string { const id = this.idFactory(); this.pending.set(id, q); return id; }
  get(id: string): PendingWorkerQuestion | undefined { return this.pending.get(id); }
  resolve(id: string): void { this.pending.delete(id); }
}
```

- [ ] **Step 4: Failing test for `selectMenuOption`** (append to `worker-session.test.ts`):

```typescript
describe("WorkerSessionManager.selectMenuOption", () => {
  it("navigates to the option via Down keys then Enter", async () => {
    const tmux = fakeTmux(["❯ 1. A\n  2. B\n  3. C"]);
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      daemonPort: 8787, authToken: "tok", claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
    });
    await mgr.spawn({ sessionId: "s1", workspacePath: "/repo", command: "claude", env: {} });
    await mgr.selectMenuOption("s1", 2); // 0-based: third option → Down x2 + Enter
    const sendKeys = tmux.calls.filter((c) => c[0] === "send-keys");
    const downs = sendKeys.filter((c) => c.includes("Down")).length;
    expect(downs).toBe(2);
    expect(sendKeys.some((c) => c.includes("Enter"))).toBe(true);
  });
});
```

- [ ] **Step 5: Run → fail.**

- [ ] **Step 6: Implement `selectMenuOption`** in `worker-session.ts`. Add a `sendKey` helper usage via the runner (the runner has `sendEnter`; add a generic key send). First add to `tmux/runner.ts`: `export async function sendKey(r: TmuxRunner, name: string, key: string): Promise<void> { await r.run(["send-keys", "-t", name, key]); }` (and a test for it in `runner.test.ts`). Then:

```typescript
async selectMenuOption(sessionId: string, optionIndex: number): Promise<"selected" | "no_session"> {
  const s = this.sessions.get(sessionId);
  if (!s) return "no_session";
  // Menu defaults to the first row highlighted; Down optionIndex times reaches it.
  for (let n = 0; n < optionIndex; n++) { await sendKey(this.tmux, s.name, "Down"); await sleep(this.deps.postPasteMs ?? 80); }
  await sendEnter(this.tmux, s.name);
  return "selected";
}
```
(Import `sendKey`.)

- [ ] **Step 7: Run → pass.** Typecheck.

- [ ] **Step 8: Commit.**
```bash
git add apps/daemon/src/workflows/orchestrator/worker-questions.ts apps/daemon/src/workflows/orchestrator/worker-questions.test.ts apps/daemon/src/workflows/orchestrator/worker-session.ts apps/daemon/src/workflows/orchestrator/worker-session.test.ts apps/daemon/src/tmux/runner.ts apps/daemon/src/tmux/runner.test.ts
git commit -m "feat(daemon): worker question store + tmux menu selection"
```

---

## Task 4: Daemon — /elicit route + select route + wiring

**Files:**
- Modify: `apps/daemon/src/agent-hooks/routes.ts`
- Modify: `apps/daemon/src/server.ts`
- Test: `apps/daemon/src/agent-hooks/routes.test.ts`

- [ ] **Step 1: Failing test for /elicit** (append to routes.test.ts):

```typescript
it("POST /v1/agent-hooks/elicit records the question, posts it to chat, returns allow", async () => {
  const posted: Array<{ sessionId: string; questions: unknown }> = [];
  const server = Fastify();
  registerAgentHookRoutes(server, {
    onResponseDone: async () => {},
    resolveAdapterForSession: () => "claude-code",
    onWorkerQuestion: async (sessionId, payload) => { posted.push({ sessionId, questions: payload.questions }); return "q-123"; },
  });
  const res = await server.inject({
    method: "POST", url: "/v1/agent-hooks/elicit?sessionId=s1",
    payload: { tool_input: { questions: [{ question: "Pick", header: "H", options: [{ label: "A", description: "" }], multiSelect: false }] }, tool_use_id: "t1" },
  });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
  expect(posted[0]!.sessionId).toBe("s1");
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** In `routes.ts`:
- Extend `AgentHookRouteDeps` with `onWorkerQuestion(sessionId: string, payload: { questions: Array<{ question: string; header: string; options: Array<{label:string;description:string}>; multiSelect: boolean }>; toolUseId: string }): Promise<string | null>` (returns a questionId, or null if unsupported/deferred).
- Add the route:
```typescript
server.post("/v1/agent-hooks/elicit", async (request, reply) => {
  const { sessionId } = request.query as { sessionId?: string };
  const body = (request.body ?? {}) as { tool_input?: { questions?: any[] }; tool_use_id?: string };
  const questions = body.tool_input?.questions ?? [];
  if (sessionId && questions.length > 0) {
    await deps.onWorkerQuestion(sessionId, { questions, toolUseId: body.tool_use_id ?? "" });
  }
  // Always allow: the menu renders and the agent blocks on it; the daemon drives the
  // selection once the user clicks. (Unsupported shapes still render; user/agent can Esc.)
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
});
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Wire in server.ts.** In the `registerAgentHookRoutes` deps, add `onWorkerQuestion`:
```typescript
onWorkerQuestion: async (sessionId, payload) => {
  if (payload.questions.length !== 1 || payload.questions[0]!.multiSelect) {
    // MVP: only single, single-select. Post a plain note and skip.
    postWorkerQuestionNote(sessionId, "The agent asked a multi-part question that isn't supported yet.");
    return null;
  }
  const q = payload.questions[0]!;
  const questionId = workerQuestions.record({ sessionId, optionCount: q.options.length });
  // Resolve the goal for this session, post an orchestrator chat message carrying pendingQuestion.
  const goalId = (db.prepare("SELECT goal_id FROM sessions WHERE id = ?").get(sessionId) as { goal_id: string } | undefined)?.goal_id;
  if (!goalId) return null;
  insertMessageWithEvent(
    { db, bus: eventBus, modelProviderRegistry: daemonContext.modelProviderRegistry, now: daemonContext.now, idFactory: daemonContext.idFactory },
    { id: daemonContext.idFactory(), goalId, role: "orchestrator", body: `The agent needs your input: ${q.question}`, correlationId: daemonContext.idFactory(), createdAt: daemonContext.now(),
      pendingQuestion: { questionId, header: q.header, question: q.question, options: q.options } }
  );
  return questionId;
},
```
NOTE: `insertMessageWithEvent` (in `orchestrator-chat/usecases.ts`) currently only persists `id, goal_id, role, kind, body, correlation_id, created_at` and its message type may not include `pendingQuestion`. You must thread `pendingQuestion` through: (a) accept it in `insertMessageWithEvent`'s message arg, (b) persist it — store as JSON in a new nullable `pending_question` column on `orchestrator_messages` (add a migration), (c) the projection (`orchestrator-chat/projection.ts`) reads + parses it back into `pendingQuestion`. Follow the existing migration + projection patterns. Construct `workerQuestions = new WorkerQuestionStore(daemonContext.idFactory)` near the `workerSessions` construction. Add a small `postWorkerQuestionNote(sessionId, text)` helper that posts a plain orchestrator message.

- [ ] **Step 6: Add the select route** (in server.ts, near the orchestrator chat routes). `POST /v1/goals/:goalId/worker-questions/:questionId/select` with body `SelectWorkerQuestionOptionRequest`:
```typescript
server.post("/v1/goals/:goalId/worker-questions/:questionId/select", async (request, reply) => {
  const { questionId } = request.params as { goalId: string; questionId: string };
  const parsed = SelectWorkerQuestionOptionRequest.safeParse(request.body);
  if (!parsed.success) { reply.status(400); return { error: "validation_failed", issues: parsed.error.issues }; }
  const pending = workerQuestions.get(questionId);
  if (!pending) { reply.status(404); return { error: { code: "question_not_found" } }; }
  if (parsed.data.optionIndex >= pending.optionCount) { reply.status(400); return { error: { code: "option_out_of_range" } }; }
  await workerSessions.selectMenuOption(pending.sessionId, parsed.data.optionIndex);
  workerQuestions.resolve(questionId);
  return { ok: true };
});
```

- [ ] **Step 7: Verify.** `pnpm --filter @orca/daemon exec vitest run src/agent-hooks src/server.test.ts` and `tsc --noEmit`.

- [ ] **Step 8: Commit.**
```bash
git add apps/daemon/src migrations apps/daemon/src/agent-hooks/routes.test.ts
git commit -m "feat(daemon): elicit route posts worker question to chat; select route drives menu"
```

---

## Task 5: Desktop — render option buttons + post selection

**Files:**
- Modify: `apps/desktop/src/api.ts`
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`
- Modify: `apps/desktop/src/orchestrator/orca-chat.css` (button styling)
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

- [ ] **Step 1: Add the api client** (`api.ts`):
```typescript
export async function selectWorkerQuestionOption(goalId: string, questionId: string, optionIndex: number): Promise<void> {
  await request(`/v1/goals/${goalId}/worker-questions/${questionId}/select`, { method: "POST", body: JSON.stringify({ optionIndex }) });
}
```
Match the file's existing `request`/fetch helper + error handling conventions (read the file first).

- [ ] **Step 2: Failing test** (`OrcaChat.test.tsx`): render a message with `pendingQuestion` and assert option buttons appear + clicking calls the api. Match the file's existing render harness + mocking style (read it first). Example assertion:
```typescript
it("renders worker question options and selects on click", async () => {
  // ...render OrcaChat with a message carrying pendingQuestion {questionId:"q1", options:[{label:"Red",...},{label:"Green",...}]}...
  const btn = screen.getByRole("button", { name: /Green/i });
  fireEvent.click(btn);
  await waitFor(() => expect(selectSpy).toHaveBeenCalledWith(expect.any(String), "q1", 1));
});
```

- [ ] **Step 3: Run → fail.**

- [ ] **Step 4: Implement** in `OrcaChat.tsx`. In the orchestrator message renderer (`ChatMessageRow` for the `orca` role), when `message.pendingQuestion` is present, render the body then a button per option:
```tsx
{message.pendingQuestion && (
  <div className="orca-chat-question-options">
    {message.pendingQuestion.options.map((opt, i) => (
      <button key={i} type="button" className="orca-chat-option-btn"
        onClick={() => void selectWorkerQuestionOption(selectedGoalId!, message.pendingQuestion!.questionId, i)}>
        <span className="orca-chat-option-label">{opt.label}</span>
        {opt.description && <span className="orca-chat-option-desc">{opt.description}</span>}
      </button>
    ))}
  </div>
)}
```
Thread `selectedGoalId` into `ChatMessageRow` (it's available in the parent `OrcaChat`). Add minimal CSS for `.orca-chat-question-options` (vertical stack) and `.orca-chat-option-btn`. After a successful click, the message can stay (the orchestrator will post the agent's next turn); optionally disable the buttons after click (local state) — keep MVP simple: leave enabled.

- [ ] **Step 5: Run → pass.** `pnpm --filter @orca/desktop exec vitest run src/orchestrator/OrcaChat.test.tsx` + `tsc --noEmit`.

- [ ] **Step 6: Commit.**
```bash
git add apps/desktop/src/api.ts apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/orca-chat.css apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): clickable worker-question options in chat"
```

---

## Task 6: End-to-end validation (manual, against live daemon)

- [ ] **Step 1: Full suites green.** `pnpm --filter @orca/contracts exec vitest run && pnpm --filter @orca/daemon exec vitest run && pnpm --filter @orca/desktop exec vitest run`; typecheck all.

- [ ] **Step 2: Live E2E.** With the dev stack running, create a goal whose intake step makes the agent ask a multiple-choice question (a placeholder goal triggers this naturally). Confirm in the daemon-terminal log: `POST /v1/agent-hooks/elicit`. Confirm the chat shows the question + clickable option buttons. Click one; confirm `POST …/select`, then the worker pane (`tmux capture-pane -t orca-worker-<id>`) shows the option selected and the agent proceeds.

- [ ] **Step 3:** Pause for the user's manual testing before merge.

---

## Self-review notes
- **Sync hook:** `/elicit` returns `allow` immediately; the agent then blocks on the rendered menu. The select route can fire any time after — the menu persists until selected. If a race is observed (select before the menu paints), add a brief `capturePane` wait for a `❯ 1.`-style line in `selectMenuOption` before sending keys.
- **Default highlight:** each `AskUserQuestion` call renders a fresh menu highlighted on row 1, so `Down×optionIndex` is correct. Do not assume a persisted cursor.
- **multiSelect / multi-question:** explicitly deferred — `onWorkerQuestion` posts a plain note and returns null.
- **Restart:** the pending-question store is in-memory; a daemon restart drops unanswered questions (the worker's menu is still up in tmux but its questionId is lost). Acceptable for MVP; note as a follow-up (persist pending questions or re-derive from the pane).
