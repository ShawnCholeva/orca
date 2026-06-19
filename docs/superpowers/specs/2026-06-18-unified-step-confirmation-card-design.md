# Unified step-confirmation card

**Date:** 2026-06-18
**Branch:** `feat/honest-orchestrator-surface`
**Status:** Design approved, pending spec review

## Problem

When an interview step (e.g. Brainstorm → Frame) finishes, the user is shown a
generic **Question** card (an orchestrator `ask_user`) asking them to confirm the
synthesized frame, with options `Confirm` / `Revise` / `Something else`. This is
wrong in three ways:

1. **Wrong surface.** The confirmation renders as a generic question card, not as
   a step-completion card. The user expects the existing step-completion
   confirmation card ("Locked in · Completeness 95% · … · Continue / type
   revisions in chat").
2. **Redundant options.** The mediator authors a `Revise` option while the
   question form auto-appends a `Something else` free-text option — the two
   collapse to the same action (give free-text feedback).
3. **Double confirmation.** The `interview` completion policy added on this branch
   tells the mediator to `ask_user` to confirm *before* it may
   `approve_step_complete`. But `approve_step_complete` already triggers the
   engine's `step_confirmation_pending` gate (the existing confirmation card). So
   the Frame step demands two confirmation rounds, the first being the
   wrong-looking, redundant one.

Meanwhile the existing confirmation card is thin: it shows only a flattened
`summary` string and a `Continue` button. The richer terminal `StepResultCard`
(expandable score drawer, structured summary) appears only *after* Continue and
has no buttons.

## Goal

Replace the redundant `ask_user` confirmation with a single, richer
step-confirmation card that:

- **Summarizes what was decided** in the step (faithful to the recorded output).
- **Tucks the scores into an expandable dropdown** (collapsed by default).
- Offers **Continue** (accept and advance) and **Revise** (make corrections
  before closing the step) buttons.

This card is the shared confirmation gate, so the upgrade applies to every
supervised/handoff step, not just Brainstorm.

## Current architecture (for reference)

Completion → confirmation flow for a supervised/handoff/interview step
(`apps/daemon/src/workflows/orchestrator/service.ts`):

1. Agent emits an `orca:step-complete` block.
2. Mediator returns `approve_step_complete` with `scoring`.
3. Service stashes `{ block, scoring, finishedAt }` in
   `workflow_step_runs.pending_completion_json`.
4. Builds `summary = summarizeScoring(scoring, extractProposal(responseText))`
   (proposal lead + one score line) and `pauseForConfirmation` writes it to the
   activity's `current_text`, setting `source_kind = 'step_confirmation_pending'`.
5. Desktop renders the `LiveActivity` confirmation card: `current_text` +
   `Continue` button + "type revisions in chat" hint.
6. `Continue` → `confirmStep(runId)` applies the block, terminates the worker,
   builds the full `StepResult`, and advances. The terminal `StepResultCard`
   (rich, expandable) then appears in the timeline.
7. Revise today: user types in chat → mediator interprets → maybe `revise_step`
   → `reviseStep` relays feedback to the still-alive agent session.

The agent session stays alive during the confirmation pause (it is only
terminated inside `confirmStep`). Both the recorded `block` and full `scoring`
are available at pause time; only a flattened string is currently passed to the
UI.

## Design

### 1. The card (desktop — `ActivityThread.tsx`)

Grow the `step_confirmation_pending` branch of `LiveActivity` from a single text
line into:

- **Prose lead** — one sentence: the mediator's `scoring.reason`, falling back to
  the agent's `extractProposal` text, falling back to a generic "Step complete."
- **Structured body** — renders the labeled fields supplied in
  `confirmationSummary.fields` (derived daemon-side, see §2) as sections. Strings
  render as-is; arrays render as bullet lists. The daemon omits empty/missing
  fields, so the card never shows a blank label.
- **Scores dropdown** — collapsed by default; expands to success score, the 5
  quality dimensions, handoff-ready, and reason. Reuses the existing
  `StepResultCard` "Details" drawer styling. Duration/turns/tool-calls are *not*
  shown here — they are unknown until after Continue and remain on the terminal
  `StepResultCard`.
- **Buttons** — `Continue` (existing `confirmStep`) and `Revise` (new, see §3).

### 2. Data threading (daemon + contracts)

Add a structured payload to the activity, built at pause time where `block` and
`scoring` are already in hand.

- **Contract** (`packages/contracts`): new optional field on `Activity`:
  ```ts
  confirmationSummary?: {
    lead: string;
    fields: Array<{ label: string; value: string | string[] }>;
    scoring: StepResultScoringProposal | null;
  }
  ```
- **Daemon**: the `approve_step_complete` handler (`service.ts`) builds
  `confirmationSummary` and passes it through `pauseForConfirmation`
  (`activities/store.ts`), persisting it on the activity row alongside the
  existing `current_text`. `fields` are derived from `stepTpl.outputSchema`
  keys mapped over the recorded `block` — keys humanized (`success_outcome` →
  "Success outcome"), and empty/missing fields and the internal `_completion`
  key omitted; `lead` from `scoring.reason` /
  `extractProposal`; `scoring` passed through. The flat `summary` string is
  retained as the `current_text` fallback for any consumer that doesn't read the
  structured field.

### 3. Revise flow

Conversational and deterministic — no new send-UI on the card itself.

1. `Revise` → `POST /v1/goals/:goalId/workflow-runs/:runId/revise`. The daemon:
   - posts an orchestrator chat message *"What would you like to revise?"*
     carrying `pendingRevision: { workflowRunId }`;
   - resolves the confirmation card (the activity leaves
     `step_confirmation_pending` so the card is dismissed). The agent session
     stays alive.
2. The composer reroutes: while a latest-unresolved `pendingRevision` message
   exists (mirrors today's `pendingWorkerQuestionId` reroute), the user's next
   chat message is sent to `POST .../revise/submit` instead of to the mediator.
   The message renders as a normal user bubble.
3. The submit handler:
   - marks the `pendingRevision` message resolved (stops the reroute);
   - clears the `pending_completion_json` stash (idempotency — the completion is
     rejected pending rework);
   - calls the existing `reviseStep(feedback)` (relays to the agent session and
     bumps the revise counter, so `REVISE_CAP` / escalation still applies);
   - `resumeFromConfirmation` flips the step active.
4. The agent reworks and re-emits `orca:step-complete` → new confirmation card.

**Marker placement decision:** `pendingRevision` lives on the orchestrator chat
message (consistent with `pendingQuestion`), not on the step-run row, because the
composer-reroute pattern already keys off messages.

### 4. Remove the redundant `ask_user` (prompts + catalog)

- `apps/daemon/src/orchestrator-llm/prompts.ts` — interview policy: drop the
  "then ask the user to confirm" / "unconfirmed by the user" clauses. The card
  owns confirm/revise now. Keep the rule that blocks `approve_step_complete`
  while the output's `open_questions` is non-empty.
- `apps/daemon/src/workflows/templates/catalog.ts` — Frame step instructions:
  replace "present your synthesized frame (problem, success outcome, constraints)
  and ask the user to confirm or revise. Complete only after the user confirms"
  with: drain the open-questions queue, then **complete** (emit the step-complete
  block with empty `open_questions`); the confirmation card handles the user's
  confirm/revise. (Edit stays within the unreleased v3 on this branch — no
  version bump needed.)

## Scope

- The confirmation card is shared by every supervised/handoff step, so the
  richer card applies to all of them. The structured-output rendering is
  schema-generic.
- Removing the redundant pre-approval `ask_user` only affects the `interview`
  completion policy (Frame).

## Error handling

- **Revise cap:** routed through the existing `reviseStep`, so the cap and
  escalation path are preserved.
- **Idempotency:** the submit handler clears the stash; `confirmStep` is already
  idempotent.
- **Sparse output:** empty/missing schema fields render nothing rather than a
  blank label; if no fields and no lead are available, the card falls back to the
  flat `current_text` summary.

## Testing

Daemon:
- `confirmationSummary` construction: fields derived from `outputSchema` + `block`
  (strings, arrays, skipped `_completion`, humanized labels); lead fallback chain.
- `POST .../revise`: posts the prompt message with `pendingRevision`, leaves
  `step_confirmation_pending`.
- `POST .../revise/submit`: resolves the marker, clears the stash, calls
  `reviseStep`, resumes the step active.
- Interview-policy prompt no longer instructs a separate confirm `ask_user`;
  still blocks completion on non-empty `open_questions`.

Desktop:
- Card renders prose lead, structured fields, collapsed scores dropdown (expands),
  and Continue/Revise buttons.
- `Revise` posts the prompt and the composer reroutes the next message to the
  revise-submit endpoint.
- Submitting a revision calls the revise-submit client and clears the reroute.

## Out of scope

- Changing the terminal `StepResultCard` (duration/turns/tool-calls stay there).
- Any change to non-supervised (auto-advancing) completion.
- Reworking the worker-question / free-text answer surfaces.
