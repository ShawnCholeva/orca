# Worker Question Relay — Hold-Hook(deny) Transport — Design

**Date:** 2026-05-31
**Branch:** `feat/worker-question-relay`
**Status:** Approved design; ready for implementation plan.

## Problem

The current worker-question relay (commits `9c10941`…`90b59f1`) surfaces a worker's
`AskUserQuestion` to the user as clickable chat buttons, then drives the worker's tmux menu
via `send-keys Down×i + Enter`. It is **single-question / single-select only**. Any
`AskUserQuestion` with `questions.length > 1` or `multiSelect: true` hits a gate
(`apps/daemon/src/server.ts:1065`) that posts *"The agent asked a multi-part question that
isn't supported yet — answer it directly in the worker or rephrase."* and dead-ends — the
user cannot answer because the worker pane is hidden.

The menu-driving transport is also fragile for the cases it does handle: it assumes the menu
paints with row 1 highlighted and that chat option order equals menu order; a select-before-paint
race or the two trailing rows Claude appends ("Type something" / "Chat about this") can cause a
**silent mis-answer** (user clicks Red, worker selects Blue).

## Spike result (2026-05-31)

A live spike verified the chosen transport. An interactive `claude` in tmux was given a
`PreToolUse(AskUserQuestion)` http hook pointing at a stand-in server that **held the response
open**, then returned:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
  "permissionDecision": "deny",
  "permissionDecisionReason": "User answered via Orca chat. Question 1 ('favorite color'): Red. Question 2 ('favorite size'): Large. These are the user's final answers. Treat the AskUserQuestion as fully answered with exactly these selections and continue the task. Do NOT call AskUserQuestion again." } }
```

Observed:
1. **No menu rendered** — `deny` pre-empts the tool, so the menu never paints.
2. Claude received the reason as tool feedback and output `Chose: Red and Large.` — **adopted the
   answer, did not loop, did not re-call `AskUserQuestion`.**
3. The hook payload carried the **full `questions[]`** array (every question, its options, and
   per-question `multiSelect` flag) plus `tool_use_id` and `session_id`.

Conclusion: multi-part is just data in the hook payload; the entire menu-driving layer is
unnecessary and can be deleted.

### Verified hook contract (from docs + spike)

`PreToolUse` `hookSpecificOutput` supports `permissionDecision` (`allow`/`deny`/`ask`/`defer`),
`permissionDecisionReason`, `updatedInput`, `updatedPermissions`, `additionalContext`. It **cannot**
supply a tool *result* directly — so the answer is delivered via the `deny` reason text, which is
shown to Claude. Per-hook `timeout` (seconds) bounds how long Claude blocks on the hook.

## Architecture: hold-hook(deny)

```
worker AskUserQuestion
  → PreToolUse http hook → daemon POST /v1/agent-hooks/elicit   (handler awaits a deferred; HTTP connection held open)
  → daemon posts ONE orchestrator chat message carrying all questions (pendingQuestion)
  → desktop renders question block(s): buttons (single-select) / checkboxes (multiSelect) + Submit
  → user submits → POST /v1/goals/:goalId/worker-questions/:questionId/answer { answers }
  → daemon validates, assembles deny reason, resolves the deferred
  → /elicit handler returns deny + assembled reason
  → worker Claude reads the answer as tool feedback, continues
```

**Hold mechanism — await-a-deferred.** The `/elicit` handler creates a `Promise`, stores its
`resolve` function in the question store keyed by `questionId`, then `await`s it (raced against a
timeout) and returns the assembled `deny` output. Fastify holds the connection open naturally while
the handler's promise is pending — no `reply.hijack()` or manual `reply.send` juggling. The answer
route calls the stored `resolve(answers)`.

## Components and responsibilities

### Contracts (`packages/contracts/src/index.ts`)

`PendingQuestion` becomes multi-question (replaces the single-question shape):

```ts
PendingQuestionItem = {
  header: string (≤120),
  question: string (≤4000),
  multiSelect: boolean,
  options: { label: string (1..200), description: string (≤1000) }[]  // 1..12
}
PendingQuestion = {
  questionId: string (min 1),
  toolUseId: string (min 1),
  questions: PendingQuestionItem[]   // 1..4
}
```

Answer request (replaces `SelectWorkerQuestionOptionRequest`):

```ts
SubmitWorkerAnswersRequest = {
  answers: { questionIndex: int ≥ 0, selectedLabels: string[] (min 1) }[]  // min 1
}
```

Answers are by **label**, not menu index — index ordering was a menu artifact being deleted.

### Daemon

- `agent-hooks/hook-settings.ts` — add `timeout: 600` to the `PreToolUse` http hook so Claude blocks
  long enough for a human to answer.
- `agent-hooks/routes.ts` — `/v1/agent-hooks/elicit` no longer returns immediately. It calls
  `onWorkerQuestion(...)` which registers the pending question and returns a `Promise<deny-output>`;
  the handler `await`s it and returns the result. (Route shape: the deps callback owns the
  deferred + timeout; the route just awaits and returns.)
- `workflows/orchestrator/worker-questions.ts` — `WorkerQuestionStore` now holds, per `questionId`:
  `{ toolUseId, sessionId, goalId, questions, resolve }`. Methods:
  - `record({ toolUseId, sessionId, goalId, questions, resolve }): string` (returns `questionId`;
    if an entry with the same `toolUseId` exists, return that id and do **not** create a second —
    idempotency).
  - `get(questionId)`.
  - `resolveAnswers(questionId, denyReason)` — calls the stored `resolve` once and deletes the entry;
    a second call is a no-op (single-resolve).
- `server.ts`:
  - Delete the `questions.length !== 1 || multiSelect` gate; all shapes are supported.
  - `onWorkerQuestion`: resolve `goalId` from session; build a deferred; `record(...)`; post one
    orchestrator chat message with the full `pendingQuestion`; return a promise that resolves to the
    `deny` output (raced against a daemon timeout).
  - Replace the select route with `POST /v1/goals/:goalId/worker-questions/:questionId/answer`:
    validate `SubmitWorkerAnswersRequest`; 404 if unknown/expired `questionId`; 409 if already
    answered; validate every question is answered, each `selectedLabels` ⊆ that question's option
    labels, and single-select questions carry exactly one label (else 400); assemble the deny reason;
    `resolveAnswers(...)`.
- `workflows/orchestrator/worker-session.ts` — delete `selectMenuOption` (no longer used). `sendKey`
  in `tmux/runner.ts` may remain (harmless, unused by this path).

**Assembled deny reason** (deterministic): `"User answered via Orca chat. " + per-question
"Q<n> '<header>': <labels joined by ', '>. " + "These are the user's final answers — treat the
AskUserQuestion as fully answered with exactly these selections and continue. Do not call
AskUserQuestion again."`

### Desktop (`apps/desktop/src`)

- `orchestrator/OrcaChat.tsx` — when a message has `pendingQuestion`, render each question as a block:
  single-select → option buttons; `multiSelect` → checkboxes. A single **Submit** enables once every
  question has at least one selection. Submit posts the assembled `answers` and disables the controls.
- `api.ts` — `submitWorkerAnswers(goalId, questionId, answers)`.
- `orca-chat.css` — styling for multi-question blocks, checkboxes, submit button.

## Identity, idempotency, validation (contracts up front)

- **Identity:** `questionId = idFactory()` per `/elicit` call. The held deferred is keyed by it.
- **Idempotency:** `toolUseId` (stable, from Claude) dedupes duplicate hook fires — a repeat with the
  same `toolUseId` reuses the existing pending entry rather than creating a second held connection.
- **Single-resolve:** the deferred resolves exactly once; the second answer submit → 409.
- **Validation:** unknown/expired `questionId` → 404; missing answer for any question, label not in
  that question's options, or >1 label on a single-select question → 400.

## Error handling / edges

- **Timeout:** `PreToolUse` hook `timeout: 600s`. A daemon-side timer (slightly shorter) races the
  deferred; on daemon timeout it resolves with `deny` reason `"No answer received; proceed using your
  best judgment."` so the worker is never left hung. The chat message remains but its buttons no-op
  (404 on submit after expiry).
- **Daemon restart mid-question:** pending deferreds are in-memory open connections; a restart drops
  them and the worker's hook errors out. Same caveat as the current implementation. **Out of MVP
  scope; noted as follow-up** (persist pending questions or re-derive).
- **Free-text answers:** `AskUserQuestion` is options-only; prose answers are a separate path, out of
  scope.

## What this fixes (scenarios)

1. Multi-question interview (the transcript dead-end) — now answerable in chat.
2. `multiSelect` questions — now answerable (checkboxes).
3. Silent mis-answer from menu drift / paint race — eliminated (no menu, no keys; answer by label).
4. Off-by-one onto Claude's trailing "Type something" / "Chat about this" rows — eliminated.
5. Worker blocked on a hanging menu — eliminated (`deny` means no menu paints).
6. Sequential multi-menu choreography — avoided entirely (one payload, one held reply).

## What gets deleted

- `selectMenuOption` (`worker-session.ts:156`) and its `Down×i` driver.
- The `questions.length !== 1 || multiSelect` unsupported gate (`server.ts:1065`).
- Single-`optionIndex` `SelectWorkerQuestionOptionRequest` and the `/select` route (replaced by
  `/answer`).
- `optionCount` field on the pending store.

## Testing

- `WorkerQuestionStore`: record (incl. `toolUseId` idempotency), resolveAnswers single-resolve,
  timeout fallback.
- `/elicit`: holds until resolved, returns the assembled `deny` body; idempotent on duplicate
  `toolUseId`.
- `/answer`: validation (404 / 409 / 400 cases), happy path resolves the deferred.
- Contracts: `PendingQuestion` multi-question parse; `SubmitWorkerAnswersRequest` validation.
- `OrcaChat`: renders multi-question + multiSelect; Submit enables when complete; posts correct
  `answers`.
- Live E2E: worker asks a multi-part question → chat shows all blocks → submit → worker continues
  with the chosen answers; confirm no menu paints in the worker pane.
