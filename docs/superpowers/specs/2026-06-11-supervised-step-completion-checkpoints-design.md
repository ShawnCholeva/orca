# Supervised Step-Completion Checkpoints

**Date:** 2026-06-11
**Status:** Design approved — ready for implementation planning
**Builds on:** `docs/superpowers/specs/2026-06-08-step-result-scoring-and-activity-visibility-design.md`

## Problem

When a worker step is approved and scored by the shadow orchestrator, the daemon
immediately writes the output artifact, terminates the worker session, and
advances to the next step (`apps/daemon/src/workflows/orchestrator/service.ts`,
`approve_step_complete`, ~line 751). The user has no opportunity to review the
result, accept it explicitly, or push the step agent to improve its output before
the session is torn down.

Orca is described as supporting "supervised progression through five autonomy
levels," but autonomy is currently dormant:

- `goals.autonomy_level` is hardcoded to `1`, read into the goal projection, and
  consulted by nothing.
- The Settings modal "Autonomy level" section is a static five-item mockup
  (`AUTONOMY_LEVELS` in `apps/desktop/src/settings/SettingsModal.tsx`) wired to no
  state, persistence, or behavior.

This work introduces the first real use of autonomy as a simple binary the user
controls, and uses it to gate step completion.

## Goals

- Default to **supervised** execution: each approved+scored step holds at a
  checkpoint before the worker is terminated and the workflow advances.
- Let the user explicitly **Continue**, or refine the step by chatting with the
  still-live worker (reusing the existing revise/forward loop) until satisfied.
- Provide a single, global **Supervised / Unsupervised** control in the Settings
  modal. The user only ever considers these two modes.
- Keep **unsupervised** mode byte-for-byte identical to today's behavior.
- Preserve all existing terminal-result semantics (scoring, `step_result` cards,
  reconciliation) on the Continue path.
- **Capture the revision-after-approval divergence signal** as canonical,
  queryable data whenever the user refines a step the orchestrator already
  approved and scored.

## Non-Goals

- No reintroduction of multi-level (3/4/5) autonomy. The user-facing model is
  binary.
- No removal of the dormant `goals.autonomy_level` column (left untouched,
  out of scope).
- No per-goal supervision override. Supervision is a single global setting.
- No automated learning/tuning *consumer* in this work. The divergence signal is
  captured and persisted now (see Revision Signal Capture); building the model or
  process that consumes it to recalibrate scoring is future work.
- No change to blocked/failed/cancelled terminal paths, which never reach the
  approval checkpoint.

## Decisions

1. Supervision is a **global app setting**, not per-goal. Default supervised.
2. The checkpoint reuses the existing activity **`paused_for_input`** hold
   mechanism rather than a new step-run status.
3. While paused, the step run stays **non-terminal** and the worker session is
   **left alive**. Scoring, artifact write, worker termination, and advancement
   are all deferred to the Continue action.
4. Refinement reuses the existing orchestrator `forward_to_agent` relay and the
   normal chat input — no separate "send back" UI.
5. Each re-completion is independently re-scored; the checkpoint reappears with
   the new score.
6. Switching to unsupervised mid-run auto-continues any currently paused step.
7. When the user refines instead of continuing, the daemon **persists a revision
   signal** — the orchestrator's superseded scoring, the user's feedback, and step
   context — to a dedicated canonical table. The signal is captured at the moment
   of divergence, not reconstructed later from a presentation trail.

## Supervision Setting

### Storage

New key-value table:

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

One key is used: `supervision_mode` with value `'supervised'` or
`'unsupervised'`. **Absence of the row means supervised** (safe by default), so no
backfill or data migration is required for existing installs.

A KV table (rather than a single-purpose column) is chosen so the first global
app setting has a home without inventing bespoke per-setting schema. No other keys
are introduced by this work.

### API

- `GET /settings` → `{ supervisionMode: "supervised" | "unsupervised" }`
  (returns `supervised` when the row is absent).
- `PUT /settings` with `{ supervisionMode }` → upserts the row and `updated_at`.

Contract schemas live in `packages/contracts`. The orchestrator reads
`supervision_mode` directly from the table at the gate (no caching needed; reads
are cheap and infrequent).

### Settings Modal

Replace the static `AUTONOMY_LEVELS` list and its rendering in `OrchestrationTab`
with a two-option **Supervised / Unsupervised** selector:

- **Supervised** — "Pause after each step so you can review the result and refine
  it before continuing." (default)
- **Unsupervised** — "Run steps to completion automatically without pausing."

The selector loads its value from `GET /settings` and persists changes via
`PUT /settings`. Removing `AUTONOMY_LEVELS` and the `CheckIcon`-based level rows is
in scope; no other Settings sections change.

## Daemon Gate Flow

### Reading the mode

In the `approve_step_complete` branch of `applyOrchestratorAction`, read
`supervision_mode`. Unsupervised → existing behavior, unchanged. Supervised →
the hold path below.

### Hold (supervised)

Instead of writing the artifact, terminating the worker, and advancing:

1. **Stash the pending completion** on the step run, e.g. a new
   `workflow_step_runs.pending_completion_json` column holding the extracted
   `orca:step-complete` block, the validated scoring proposal, and `finishedAt`.
   The worker session is **left alive**; the step run status is **not** made
   terminal.
2. **Pause the activity:** set the step's live activity to
   `status = 'paused_for_input'` with a new `source_kind =
   'step_confirmation_pending'`, carrying the score summary needed to render the
   checkpoint card.
3. Emit `activity.changed` and return. No terminate, no advance.

If scoring is missing/invalid (the evaluation-failure case from the prior spec),
the checkpoint still appears so the user can review and refine; the stash records
the evaluation-failure result that would be persisted on Continue.

### Continue

New user-triggered route `POST /workflows/runs/:id/confirm-step` (exact path to be
finalized in planning; mirrors existing workflow run routes):

1. Load `pending_completion_json`. If absent → idempotent no-op (already
   continued or superseded).
2. Run the **existing terminal tail**: write the step-output artifact, build the
   scored result from the stashed scoring, terminate the worker best-effort, and
   `advanceToNextStep`. This materializes the permanent `step_result` terminal
   card exactly as today.
3. Clear the paused activity (it is superseded by the terminal `step_result`
   activity from the advance).

The Continue path issues **no new model call** — it reuses the scoring captured at
approval time.

### Refine (revise while paused)

The user types feedback in the normal chat input. It routes through the
orchestrator, which decides `forward_to_agent` to the live worker. When the relay
targets a step that has a `pending_completion_json`:

1. **Persist a revision signal** from the stashed completion before clearing it
   (see Revision Signal Capture).
2. **Clear** `pending_completion_json`.
3. Return the activity from `paused_for_input` to `active`.

The worker revises, re-emits `orca:step-complete`, the shadow re-approves and
re-scores, and the Hold path repeats with the new score. The loop ends when the
user clicks Continue.

### Switch to unsupervised mid-run

`PUT /settings` → `unsupervised` scans for steps currently paused at a
confirmation checkpoint and runs the Continue path for each, so flipping the
global switch immediately releases held steps.

## Activity & Contract Model

- New activity `source_kind: 'step_confirmation_pending'`, valid only with
  `status = 'paused_for_input'`. It carries a concise score summary (reusing the
  `step_result` card fields already defined) for display. It is **transient**: it
  resolves to `active` on refine, or is superseded by the terminal `step_result`
  activity on Continue.
- The canonical terminal `step_result` activity and
  `workflow_step_runs.step_result_json` are produced **only** on the Continue
  (terminal) path, preserving the invariant from the prior spec that exactly one
  `step_result` activity exists per terminal step attempt.
- Workflow event payloads remain identifier-only within the existing size cap.

## Revision Signal Capture

When the user refines a step the orchestrator already approved and scored, the
daemon records one row capturing the divergence between orchestrator judgment and
user judgment. This is canonical data, written at the moment of refinement.

```sql
CREATE TABLE IF NOT EXISTS step_revision_signals (
  id                    TEXT PRIMARY KEY,
  step_run_id           TEXT NOT NULL,
  goal_id               TEXT NOT NULL,
  revision_index        INTEGER NOT NULL,   -- 0-based: prior refinements of this step run
  superseded_scoring_json TEXT NOT NULL,    -- the scoring the orchestrator approved
  feedback_text         TEXT,               -- user's refinement message; redacted, size-bounded
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_step_revision_signals_step_run
  ON step_revision_signals (step_run_id);
```

- Written on the Refine path, from the `pending_completion_json` stash, **before**
  the stash is cleared, so the superseded scoring is never lost.
- `superseded_scoring_json` is the orchestrator's approved scoring proposal (the
  same shape stashed at the Hold step), capturing what the orchestrator judged
  good enough that the user rejected.
- `feedback_text` is the relayed user message, passed through existing
  secret-redaction and size bounds.
- `revision_index` distinguishes successive refinements of the same step run.
- Contract exposes the signal shape in `packages/contracts`. No read/query UI is
  built in this work; the table is the queryable home for a later consumer.

This table is independent of the `step_result` / activity pipeline: it never gates
workflow advancement and a write failure here must not block refinement.

- Render the `step_confirmation_pending` activity as an interactive checkpoint
  card, reusing the `paused_for_input` thinking-bubble styling:
  - step name and concise score summary;
  - a **Continue** button;
  - a hint that typing in chat sends revisions to the step agent.
- **Continue** posts `confirm-step`; the card then yields to the permanent
  terminal `step_result` card produced by the advance.
- Refinement needs no new input UI — the existing chat input already reaches the
  live worker through the orchestrator relay.
- In unsupervised mode no checkpoint card is shown; behavior is unchanged.

## Error Handling & Recovery

- **Daemon restart while paused:** the step is non-terminal with
  `pending_completion_json` set. On startup, re-assert the paused activity if the
  worker session is still alive; if the worker is gone, fall back to the existing
  worker-exit recovery (evaluation-failure result + advance). No re-score.
- **Worker exits while paused:** existing `onWorkflowSessionCompleted` recovery
  applies and supersedes the pending completion.
- **Continue with missing/stale stash:** idempotent no-op (already continued or
  superseded by a revision).
- **Continue races a revision:** the stash is the single source of truth; whichever
  clears it first wins, the other becomes a no-op.
- Stashed and displayed text reuses existing secret-redaction and size bounds.

## Future Considerations (out of scope)

The `step_revision_signals` table is populated by this work, but **consuming** it
is future: a later effort can mine the captured divergences to recalibrate
scoring, tighten approval criteria, or learn per-step expectations. That consumer
— and any read/analytics UI over the signals — is intentionally not built here.

## Testing

### Contracts
- Settings schema accepts both modes; `GET` defaults to supervised when absent.
- Activity contract accepts `step_confirmation_pending` only with
  `paused_for_input`.
- Revision-signal schema round-trips superseded scoring and feedback.

### Daemon
- Supervised approval **holds**: no artifact write, no worker termination, no
  advance; step run non-terminal; activity paused; pending completion stashed.
- Continue runs the terminal tail exactly once: artifact, scored result, worker
  terminate, advance, terminal `step_result` card; issues no model call.
- Refine clears the stash, returns the activity to active, relays to the worker;
  a subsequent re-completion re-scores and re-pauses.
- Refine writes one `step_revision_signals` row with the superseded scoring and
  redacted feedback before clearing the stash; `revision_index` increments across
  successive refinements of the same step run.
- A revision-signal write failure does not block refinement.
- Unsupervised approval is unchanged (terminate + advance immediately).
- Switching to unsupervised mid-run auto-continues paused steps.
- Restart while paused re-asserts the checkpoint (worker alive) or recovers
  (worker gone); no re-score.
- Continue is idempotent with missing/stale stash.

### Desktop
- Paused checkpoint card renders the score summary and a Continue button.
- Continue posts `confirm-step`; the card yields to the terminal `step_result`
  card.
- Unsupervised mode renders no checkpoint card.
- Settings selector loads current mode, persists changes, and defaults to
  supervised.

## Acceptance Criteria

- New goals run supervised by default; each approved step holds at a checkpoint
  with its score before terminating the worker or advancing.
- The user can Continue explicitly, or refine via chat with the live worker and
  see the checkpoint reappear with an updated score, looping until Continue.
- Unsupervised mode is behaviorally identical to pre-change Orca.
- Supervision is controlled by a single global Supervised/Unsupervised selector in
  the Settings modal; the static autonomy-level mockup is removed.
- The Continue path preserves all existing terminal-result semantics and issues no
  new model call.
- Every refinement of an approved step persists a `step_revision_signals` row
  capturing the superseded scoring and user feedback, queryable for later
  analysis.
