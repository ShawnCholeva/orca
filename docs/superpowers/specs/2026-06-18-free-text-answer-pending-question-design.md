# Free-text answers to a pending question

**Date:** 2026-06-18
**Status:** Design — pending review

## Problem

When a worker `AskUserQuestion` is pending, the question card renders as the pinned
"live" tail bubble. If the user wants to respond with something that is *not* one
of the offered options and types into the chat composer, three things go wrong:

1. **Out of order.** The user's message drops into the time-ordered timeline
   *above* the question card, while the card stays pinned to the bottom — so the
   user's reply appears above the question it answers.
2. **Stale card.** The question card stays up as if still waiting, with a
   "Reading your message / Working out a response" indicator stacked below it.
3. **The worker is never answered.** The composer routes free text through
   `createOrchestratorMessage` → mediator `onUserMessage`. The mediator never calls
   `workerQuestions.resolveAnswers`, so the worker's `AskUserQuestion` stays blocked
   until `ELICIT_ANSWER_TIMEOUT_MS` and then proceeds on "best judgment." The user's
   text never reaches the worker as *the answer*.

There is also a **discoverability gap**: nothing on the card signals that a free
response is allowed at all.

## Goal

Free text supersedes the pending question through a single channel: it resolves
the worker question with the user's words, shows the answer in the transcript, and
dismisses the card — in correct order. Add a discoverable in-card doorway to that
same behavior.

Out of scope: orchestrator `ask_user` questions rendered in `ChatMessageRow`
(those already answer correctly as user guidance); the orchestrator round-trip
variant (explicitly cut — see Alternatives).

## Approach

One behavior — "free text supersedes the pending question" — reached two ways:

- **Composer:** typing in the main chat input while a worker question is live.
- **"Something else":** a synthetic, exclusive option on the card that reveals an
  inline textarea.

Both submit to the same worker free-text answer path.

### Backend — worker free-text answer

The worker-question resolution mechanism already forwards arbitrary text:
`resolveAnswers(questionId, reason)` hands `reason` to the worker as the
`AskUserQuestion` result. Today the `/answer` route only builds `reason` from
validated label selections. Extend it to accept free text.

- **Contract** (`SubmitWorkerAnswersRequest`): allow a free-text answer as an
  alternative to `answers`. Add optional `freeText: string` (min length 1) and
  refine so exactly one of `answers` / `freeText` is present. Existing
  label-based callers are unaffected.
- **Route** (`POST /v1/goals/:goalId/worker-questions/:questionId/answer`): when
  `freeText` is present, skip `validateAnswers`; build the reason via a new
  formatter (`assembleFreeTextReason`) that wraps the user's words — e.g.
  *"User answered via Orca chat with a custom response: «text». Treat the
  AskUserQuestion as fully answered with this and continue. Do not call
  AskUserQuestion again."* — then `resolveAnswers(questionId, reason)`.
- **Transcript:** the same route records the user's free text as a `role: "user"`
  orchestrator chat message (reusing `insertMessageWithEvent`) so the answer is
  durable and survives reload. This is the single source of truth; the frontend
  does not separately persist it.

### Frontend — dismiss-as-answer

- **Client** (`api.ts`): `submitWorkerFreeText(goalId, questionId, text)` posting
  `{ freeText }` to the answer route.
- **Composer routing** (`handleSendMessage`): if a worker question is live
  (`liveActivity?.pendingQuestion`), route the typed text through
  `submitWorkerFreeText(goalId, liveActivity.pendingQuestion.questionId, text)`
  instead of `createOrchestratorMessage`, then mark that `questionId` answered.
- **Optimistic dismissal:** track the answered `questionId` in `OrcaChat` state.
  While `liveActivity.pendingQuestion.questionId` equals the answered id, suppress
  the live question bubble. Because the pinned tail card disappears, the user's
  message and the working indicator fall into natural order at the bottom. Clear
  the tracked id once `liveActivity` transitions away from that question (effect
  on the live question id), letting the backend state take over.

### Frontend — "Something else" affordance

In `WorkerQuestionForm`:

- Append a synthetic **"Something else"** choice below the worker's options
  (render-only; never sent as a label).
- It is **exclusive**: selecting it clears any worker-option selections and
  disables them; selecting a worker option clears "Something else" and collapses
  its textarea. This holds even for `multiSelect` questions — you either choose
  from the worker's options or write your own, never both.
- Selecting it reveals an inline `<textarea>`. Submit is enabled when the textarea
  is non-empty. Submitting routes through the worker free-text path (same as the
  composer) and dismisses the card.
- Thread the free-text submit into the form. `WorkerQuestionForm` is supplied to
  `LiveActivity` via `renderQuestionForm`; pass a wrapper from `OrcaChat` that
  injects the free-text handler so the form can both submit labels
  (`submitWorkerAnswers`) and submit free text.

## Data flow

```
User free text (composer OR "Something else")
        │
        ▼
submitWorkerFreeText(goalId, questionId, text)
        │
        ▼
POST /worker-questions/:id/answer { freeText }
        │
        ├─ resolveAnswers(id, assembleFreeTextReason(text)) ──► worker unblocks, continues
        └─ insertMessageWithEvent(user message) ─────────────► transcript bubble
        │
        ▼
Frontend marks questionId answered ──► live question card suppressed ──► order restored
```

## Error handling

- **Already answered (409):** the route already returns `already_answered` if the
  question was resolved (e.g., a label submit and a free-text submit race). The
  composer/card surface the existing expired/failed affordance; the card is
  dismissed regardless since the question is resolved.
- **Question not found (404):** treated as expired, same as today.
- **Submit failure:** keep the existing `WorkerQuestionForm` behavior — clear
  `submitted`, show the expired/retry state; do not dismiss optimistically on a
  thrown error.

## Testing

- Contract: `SubmitWorkerAnswersRequest` accepts `{ freeText }`, rejects empty
  free text, rejects both `answers` and `freeText` together, still accepts the
  label shape.
- Route: free-text answer resolves the worker question with the wrapped reason and
  records a user chat message; label path unchanged.
- `WorkerQuestionForm`: "Something else" appears, is exclusive (clears/disables
  worker options and vice versa), reveals the textarea, and submits via the
  free-text path; label submit still uses `submitWorkerAnswers`.
- `OrcaChat`: composer free text while a worker question is live routes to
  `submitWorkerFreeText` and dismisses the live card; the card does not reappear
  above the user's message; with no live question, the composer still uses
  `createOrchestratorMessage`.

## Alternatives considered

- **Pure frontend fix (keep `createOrchestratorMessage`).** Rejected: leaves the
  worker blocked until timeout — the answer never reaches it. Cosmetic only.
- **Orchestrator round-trip for "Something else"** (submit empty → orchestrator
  asks → user answers in composer). Rejected: two messages, extra LLM latency
  before the user can even type, more failure surface, and the answer drifts out
  of the card. The inline textarea delivers the same answer in one step.
