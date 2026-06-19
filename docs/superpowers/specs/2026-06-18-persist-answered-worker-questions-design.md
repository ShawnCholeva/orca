# Persist answered worker questions as chat messages

**Date:** 2026-06-18
**Branch:** feat/honest-orchestrator-surface

## Problem

When a user answers a worker `AskUserQuestion` in the Orca chat, the question
card disappears and is replaced by a persisted activity card ending in
*"Forwarding your response to the agent."* The question text and the user's
answer are both discarded; only that generic line survives. Looking back at the
chat history, the exchange is gone and the leftover "Forwarding…" line reads as
noise.

The user wants the answered question to **persist in the chat as submitted**, and
the "Forwarding your response to the agent." line removed.

## Current behavior (why it happens)

- A worker question exists only as a **live activity** pinned to the bottom of
  the chat (`pickLiveActivity` → `LiveActivity` → `WorkerQuestionForm`). There is
  no persisted chat message for it.
- On answer, the daemon `/answer` route resolves the question and applies a
  `turn_completed` activity with summary `"Forwarding your response to the
  agent."` (`apps/daemon/src/server.ts`). `completeLive`
  (`apps/daemon/src/activities/store.ts`) flips the activity to `completed`,
  **nulls `pending_question`**, and stores that string as `final_summary`.
- Completing the activity is also what creates the natural thread break:
  `getLiveForStepRun` only appends to `active`/`paused_for_input` activities, so
  the agent's next tool call after the answer opens a **new** activity card. The
  "Forwarding…" line is therefore doing double duty — it is both the noise to
  remove *and* the marker that closes the pre-question work thread.

## Goals

1. The answered question persists in the chat timeline as its **own bubble**,
   placed **between** the pre-question work thread and the post-answer work
   thread.
2. The persisted bubble shows the answer, rendered per how it was given.
3. The "Forwarding your response to the agent." line is removed everywhere.
4. The post-question thread break is preserved (post-answer work starts a fresh
   activity card).
5. A non-persisted "Thinking…" indicator fills the latency after answering,
   replaced by the next real chat event.

## Non-goals

- Orchestrator `ask_user` questions and permission approvals are **not** changed.
  This is scoped to worker `AskUserQuestion`.
- No retro-migration of worker questions already pending at upgrade time.

## Approach

**Make the worker question a first-class chat message**, the same shape
permission approvals already use (`message.pendingApproval`). The activity layer
returns to being pure work-telemetry; it no longer carries worker questions.

This was chosen over persisting the answer on the activity ("Approach B") because:

- The user's complaint is about **chat history**, which is the messages table —
  putting the Q&A in a message places it where conversation history lives.
- It unifies worker questions with the two existing "agent needs your input"
  interactions (permission approvals, orchestrator `ask_user`), both of which are
  already messages carrying a `pending*` payload.
- It keeps the activity abstraction single-purpose instead of giving it a second
  job (telemetry + durable Q&A record).
- It is the layout the user wants: the Q&A is a conversational beat **between**
  two work threads, not nested inside the first work card.

## Target layout

```
┌─ Activity (thread 1) ──────────┐   settled: green checks, no "Forwarding"
│ ✓ Working on the step…         │
│ ✓ Read CreateGoalFlow.tsx      │
│ ✓ Read CoordinateStep.tsx      │
└────────────────────────────────┘
┌─ Question (orca) ──────────────┐   its own bubble; persists after answer
│ Which layout works better?     │
│  ✓ Top nav   (your answer)     │
└────────────────────────────────┘
┌─ Activity (thread 2) ──────────┐   the agent's post-answer work
│ ⠿ Read NextThing.tsx …         │
└────────────────────────────────┘
```

## Answer paths and renderings

There are three ways to answer; each renders the persisted bubble differently.

| Path | How | Persisted bubble | Separate "you" bubble? |
| --- | --- | --- | --- |
| Card option(s) | Pick option(s) on the card | Read-only, ✓ on chosen option(s) | No |
| Card "Something else" | Type in the card's free-text box | Read-only, typed text shown inline | **No** |
| Composer chat | Type in the main Orca composer | Read-only, "Answered in chat", nothing selected | Yes (your text) |

## Data model — `packages/contracts/src/index.ts`

Additive and optional, so existing blobs still parse. The answer rides **inside
the existing `pending_question` JSON blob** — no DB schema migration.

- Extend `PendingQuestion` (`.strict`):
  - `source?: "worker" | "orchestrator"` — absent/`"orchestrator"` keeps today's
    behavior; `"worker"` selects the new path.
  - `answer?: PendingQuestionAnswer` — present once answered.
- New `PendingQuestionAnswer` — exactly one of:
  - `answers?: WorkerAnswer[]` — option selections (card options path).
  - `freeText?: string` — card "Something else" inline text.
  - `viaChat?: true` — answered via the composer.
- Extend `SubmitWorkerAnswersRequest` with `fromChat?: boolean` to distinguish
  card free-text (`false`/absent) from composer free-text (`true`).

## Daemon — `apps/daemon/src`

### Ask time — `onWorkerQuestion` (server.ts), when `isNew`

1. Insert an `orchestrator` chat message carrying `pendingQuestion`:
   `{ source: "worker", questionId, toolUseId, questions }`. Body =
   `orcaVoiceQuestionText(payload.questions)` (reused).
2. `expireLive` the step's current live activity. This settles thread 1 (steps
   stay, no summary, no pulse) so the agent's post-answer work opens thread 2.
3. **Remove** the `agent.question_pending` activity signal for worker questions —
   the activity layer no longer holds worker questions.

### Answer time — `/answer` route (server.ts)

1. Resolve the worker-question registry (unchanged) and the 404/409 guards.
2. Build `PendingQuestionAnswer` from the request:
   - `answers` present → `{ answers }`; no user message.
   - `freeText` + `fromChat: true` (composer) → `{ viaChat: true }`; insert the
     user message (as today).
   - `freeText` + falsy `fromChat` (card) → `{ freeText }`; **no** user message.
3. **Update** the question message row's `pending_question` to embed `answer`, and
   emit a message-updated event so clients refetch.
4. **Delete** the `turn_completed` "Forwarding your response to the agent."
   activity — thread 1 was already settled at ask time.

### Message-updated event

Add an `orchestrator.message.updated` domain event (goal-scoped) emitted on the
answer update, so the desktop refetches messages even when no user message was
inserted (the card paths). The desktop SSE handler adds it to its refetch
triggers.

## Desktop — `apps/desktop/src/orchestrator`

### `ChatMessageRow`

Branch on `pendingQuestion.source`:
- `"worker"` → render `WorkerQuestionForm` wired to the worker endpoints
  (`submitWorkerAnswers` / `submitWorkerFreeText` with `fromChat: false` for the
  card's "Something else"). If `pendingQuestion.answer` is set, render read-only.
- `"orchestrator"` / absent → existing path (answer posts a new orchestrator
  message via `createOrchestratorMessage`).

### `WorkerQuestionForm`

Accept an optional `answer` prop. When present, render fully read-only:
- `answers` → ✓ on the selected labels (reuse the existing `submitted` visuals).
- `freeText` → the typed text shown inline in a read-only box, nothing selected.
- `viaChat` → an "Answered in chat" hint, nothing selected.

### `ActivityThread` / `LiveActivity`

Drop the `pendingQuestion` branch from `LiveActivity` and the
`activity.pendingQuestion != null` case in `pickLiveActivity` (keep confirmation
and provider-recovery handling). Remove the `renderQuestionForm` plumbing for
worker questions.

### `OrcaChat`

- Delete the `answeredQuestionId` suppression state and effect — the live
  question card no longer exists.
- Composer `handleSendMessage`: detect the pending worker question from the latest
  **worker-question message** with no `answer` (instead of
  `liveActivity.pendingQuestion`); submit via `submitWorkerFreeText` with
  `fromChat: true`.

### Transient "Thinking…" indicator

On answer submit (card or composer), show a non-persisted tail bubble using the
`ThinkingRow` style (the `OrcaMark` + animated-dots pill used for the step
"starting" indicator). Copy: **"Thinking…"** (no timer).

- Clear/replace it when the next real chat event for the step arrives: a new
  activity card, a new orca message, another question, or a confirmation/
  completion pause — each of which is itself the next visible signal.
- Include a safety timeout so a silent stall cannot leave it spinning.

## Data flow summary

1. Agent asks → worker-question message appears between settled thread 1 and the
   (eventual) thread 2; the agent is blocked on the answer.
2. User answers:
   - Card options → bubble flips read-only with ✓; no "you" bubble.
   - Card "Something else" → bubble shows typed text inline; no "you" bubble.
   - Composer → "you" bubble with the text; bubble reads "Answered in chat".
3. "Thinking…" shows until the agent's next output lands.
4. Agent resumes → thread 2 opens.
5. No "Forwarding your response to the agent." anywhere.

## Testing

### Daemon

- Ask inserts an `orchestrator` message with `pendingQuestion.source === "worker"`
  and expires the step's live activity.
- Each answer shape updates the message's `pending_question.answer` correctly and
  emits the message-updated event.
- Composer (`fromChat: true`) inserts a user message; card paths do not.
- No `turn_completed` "Forwarding…" activity is produced. Rewrite the existing
  assertion in `apps/daemon/src/server.activity.test.ts` (currently expects the
  "Forwarding your response to the agent." summary).

### Desktop

- `ChatMessageRow` routes worker vs. orchestrator questions to the right answer
  path.
- `WorkerQuestionForm` renders read-only answered state for all three shapes.
- Composer answers the pending worker-question message.
- `LiveActivity` no longer renders a worker question; update
  `ActivityThread.test.tsx`.
- The "Thinking…" indicator appears on submit and clears on the next event.

## Notes and assumptions

- **No DB migration:** the new fields live inside the existing `pending_question`
  TEXT column; `PendingQuestion` stays `.strict` with additive-optional fields, so
  older blobs (no `source`/`answer`) still parse.
- **In-flight migration:** a worker question already pending at upgrade keeps its
  old activity shape (it will not retro-convert to a message). Acceptable for a
  local-first dev app; new questions use the new path.
- **Confirmed:** the card's "Something else" shows inline only, with no duplicate
  "you" bubble. The composer is the only path that produces a "you" bubble.
- The untracked `apps/daemon/_verify_upgrade.ts` and `image.png` / `image2.png`
  are unrelated and left alone.
