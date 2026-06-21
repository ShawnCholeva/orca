# Persist the confirmed step-result card

**Date:** 2026-06-21
**Status:** Approved (design)

## Problem

When a supervised step finishes, Orca shows a confirmation card with the full
synthesized frame — the lead line plus the step's output fields (e.g. PROBLEM,
SUCCESS OUTCOME, CONSTRAINTS) — and Continue / Revise buttons. After the user
hits **Continue**, that card is replaced in the chat timeline by a compact
`step_result` card showing only a one-line summary and scores behind a drawer.
The full frame the user reviewed and approved is no longer visible in history —
information they explicitly evaluated is effectively lost from the transcript.

## Goal

After Continue, the timeline keeps a faithful, **static** copy of the card the
user saw: the full frame (lead + fields) inline, the scores behind a toggle, and
a `✓ You chose Continue` footer in place of the buttons. Auto-completed
(unsupervised) steps are unchanged — they keep the existing compact card.

Out of scope: byte-exact capture of the `lead` line (see Fidelity note); changing
the live confirmation card; the Revise flow's intermediate cards.

## Approach (chosen: rebuild on read)

The card body `{ lead, fields, scoring }` is produced by
`buildConfirmationSummary(outputSchema, block, scoring, proposal)`
(`confirmation-summary.ts`). Every input still persists after Continue:

- **`block`** — `completeStepWithLedger(stash.block)` writes the step's `output`
  (parsed from the same block the card rendered) to the `step_output` artifact in
  `workflow_artifacts` (`service.ts:3004` → `createStepOutputArtifact`). Because
  `buildConfirmationSummary` only reads `outputSchema` field keys, rebuilding from
  this persisted `output` reproduces the exact fields the user saw.
- **`outputSchema`** — lives on the workflow template.
- **`lead`** — `buildConfirmationSummary` derives `lead` from
  `scoring.reason || proposal || "Step complete."`. The raw
  `StepResultScoringProposal` is not persisted verbatim (it's transformed into the
  `WorkflowStepResult` in `step_result_json`), so we pass `scoring = null` and
  `proposal = stepResult.resultSummary ?? stepResult.outcome.reason` — the same
  text the compact card already uses as its headline — giving a meaningful `lead`.
- **scores** — already persisted in `step_result_json`; the existing
  `step_result` card already renders them, so `confirmationSummary.scoring` is
  left null and the card keeps sourcing scores from `stepResult`.

So no new column or capture logic is needed, and the change applies retroactively
to already-completed steps.

### "Was this user-confirmed?" signal

`confirmStep` calls `expireConfirmation`, which leaves an activity row with
`source_kind = 'step_confirmation_pending'`, `status = 'expired'` for the step run
(`store.ts:548`). Presence of that row is the durable signal that a confirmation
card was shown and resolved. Auto/unsupervised steps never produce it.

**Rule:** attach `confirmationSummary` to a `step_result` activity **iff** an
expired `step_confirmation_pending` activity exists for the same `step_run_id`.
The frame's presence on a `step_result` card therefore also means "user
confirmed" → render the frame + the `You chose Continue` footer.

## Components

### 1. Daemon projection — `apps/daemon/src/activities/projection.ts`

`enrichStepResult` already attaches `stepResult` + `stepName` to `step_result`
activities. Extend it to also:

- Check for an expired `step_confirmation_pending` activity for `stepRunId`.
- If present, load the latest `step_output` artifact body + the template's
  `outputSchema`, and call
  `buildConfirmationSummary(schema, block, null, leadText)` where
  `leadText = stepResult.resultSummary ?? stepResult.outcome.reason`.
- Attach the result as `activity.confirmationSummary` (same field the live card
  uses — already on the `Activity` contract, no schema change).

### 2. Frontend — `apps/desktop/src/orchestrator/ActivityThread.tsx`

- Extract the confirmation frame body (the `isConfirmation` branch's lead + fields
  rendering, currently inline in `LiveActivity`) into a shared
  `ConfirmationFrame` component.
- `LiveActivity` uses `ConfirmationFrame` (no visual change).
- `StepResultCard`: when `activity.confirmationSummary` is present, render
  `ConfirmationFrame` (full frame inline) + the existing scores behind the
  Details toggle + a `✓ You chose Continue` footer. When absent, render the
  existing compact card unchanged.

No change to `OrcaChat.tsx` timeline wiring — the `step_result` activity is
already a timeline card.

## Testing

- **Daemon** (`projection` test): a `step_result` activity with an expired
  `step_confirmation_pending` sibling gets `confirmationSummary` rebuilt from the
  `step_output` artifact + schema; one without the sibling does not.
- **Frontend** (`ActivityThread`/`StepResultCard` test): renders the frame +
  `You chose Continue` footer when `confirmationSummary` is present; renders the
  compact card (no frame, no footer) when absent; buttons never appear.

## Fidelity note

The `lead` line is rebuilt from the persisted result summary
(`resultSummary ?? outcome.reason`) rather than captured verbatim from the live
card's `scoring.reason`/`proposal`. The two are usually the same text, but may
differ slightly. Fields and scores are exact. If verbatim lead becomes important,
snapshot `confirmationSummary` at confirm time (the Option B path from design
discussion).
