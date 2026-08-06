# Stuck-step detection, recovery, and honest scoring

**Date:** 2026-07-29
**Status:** Design, awaiting review
**Extends:** `2026-07-24-node-confidence-model-design.md` (the scoring engine this feeds)

## Problem

A step whose worker is alive but making no progress is invisible to every part of
Orca: the run shows a spinner forever, nothing recovers it, and the step score is
unaffected.

Observed live (goal `DSL`, run `019fa718…`, template `orca/adaptive-delivery` v13,
node `research`): the worker session `875ad5e9` sat parked in Claude Code's rewind
modal — `Interrupted · What should Claude do instead?` — for 33 minutes. Its tmux
session existed, `sessions.status = 'running'`, `workflow_step_runs.status = 'active'`,
`finished_at = NULL`, no `step_output` artifact.

Three independent gaps produce that outcome:

1. **The liveness watchdog can't see it.** `liveness-watchdog.ts:58` reaps only when
   the tmux session is *gone*. Alive-but-silent is its blind spot.
2. **Nothing terminates the step run.** `failStep` (`workflows/steps/usecases.ts:467`)
   and `markStepBlocked` (`:428`) have **zero production callers**; every live writer
   of `workflow_step_runs.status` sets `passed`. A step run ends passed or stays
   `active` forever. Even the crash ladder's cap (`orchestrator/service.ts:348`) only
   posts a chat message and leaves the step active. `cancelWorkflowRun`
   (`workflows/runs/usecases.ts:209`) cancels the run and abandons the in-flight step
   run untouched.
3. **The score therefore cannot penalize anything.** `aggregate.ts:347` builds
   `hardFailedFinals` from step runs whose status is `failed`/`blocked` and counts them
   as 0 in the denominator — its comment reads *"a step that fails often must not keep a
   high score"* — but since (2) means no such row is ever written, that set is
   structurally always empty. The penalty channel exists and has never fired.

The consequence is dishonest measurement, which is the failure mode the harness paper
(§5.2.2, oracle adequacy) warns about directly: a template can strand its users every
run and still read as healthy, because only successful completions ever reach scoring.

## Principles this design follows

- **The system acts; the user does not babysit.** A user pressing a button to make a
  failing system respond is the wrong shape. Detection and recovery are the daemon's
  job. The one explicit control exists solely for what no sensor can observe.
- **Sensors, not guesses** (paper §3.4.4). "No forward progress while it is the
  system's turn" is a deterministic fact. "The user seems stuck" is a guess. Only the
  former drives automated action.
- **Waiting on a human is not being stuck.** If Orca is waiting on the user, the stall
  clock does not run, however long that takes.

## Design

### Part 1 — System-turn stall sensor

`livenessWatchdogTick` keeps its dead-tmux reap and gains a second sensor for workers
that are alive but not progressing.

**Progress signal** (either resets the clock):
- `sessions.output_seq` advanced since the last tick, or
- the step's `activities.updated_at` advanced (hook-driven; per CLAUDE.md, prefer hooks
  over parsing the shadow session).

Using both matters: a redrawing TUI keeps `output_seq` climbing even when parked, and a
silent-but-working agent may produce no output while hooks fire. Requiring *both* to be
static is the conservative combination.

**System-turn gate** — the clock accrues only while Orca owes the next move. Either of
these suspends it *and resets the accumulated time*:
- `activities.status = 'paused_for_input'` — written by `question_pending`,
  `step_confirmation_pending`, `gate_decision_pending`, `mark_done_pending`, and
  `provider_recovery_pending`
- `activities.source_kind = 'permission_pending'` — **this one keeps
  `status = 'active'`** (`activities/store.ts:233` inserts every opened activity as
  `active`; only the explicit park paths flip the status), so checking the status alone
  would let a worker awaiting your tool approval trip the stall sensor. Both conditions
  are required.

A step run with no live activity row is treated as the system's turn: its worker is
running and nothing is waiting on the user.

The unique partial index `idx_activities_one_live_per_step` guarantees at most one live
activity per step run, so this is a single lookup.

**State** lives in the tick's in-memory map, `stepRunId → { seq, activityAt, sinceMs }`,
re-baselined on daemon restart (a restart is not evidence of a stall). No migration.

**Threshold** `ORCA_STALL_MS`, default 600000 (10 min), alongside the existing
`ORCA_LIVENESS_WATCHDOG_MS` / `ORCA_LIVENESS_GRACE_MS` knobs. The existing grace window
and the `hasStepOutput` skip both still apply before the stall check.

**On trip:** `failSession(db, bus, sessionId, goalId, "worker_stalled", now)` — the same
call the dead-worker reap already makes, so everything downstream is existing machinery.

`SessionFailureReason` (`packages/contracts/src/index.ts:569`) gains `worker_stalled`
and `user_declared_stuck`. (`failSession` takes `failureReason: string`, so the enum is
for typed consumers, not the call itself.)

### Part 2 — Recovery through the existing ladder, terminated at the cap

`session.failed` already routes to `onWorkflowSessionCompleted` → the crash branch
(`orchestrator/service.ts:342`): increment `crash_retries`, respawn under
`CRASH_RETRY_CAP` (3), escalate at cap. Two changes:

1. **Announce each rescue.** Post an orchestrator message on stall reap: *"The Research
   agent hasn't made progress for 10 minutes — restarting it (attempt 2 of 3)."* The
   user learns what happened without acting on it.
2. **Terminate at the cap.** Today the cap posts "Manual intervention needed" and leaves
   the step `active` forever. It must call `markStepBlocked(stepRunId, reason)` and block
   the run. `blocked` is a recoverable state, not a death: it is in
   `CANCELLABLE_WORKFLOW_RUN_STATUSES` and `resume` asserts `["paused", "blocked"]`.

**Resume-after-block requires a new attempt.** `markStepBlocked` sets `finished_at`, so
the step run is terminal; resuming must open a fresh step-run attempt rather than revive
the blocked row. This is the one integration risk in the design and gets a dedicated
test (below).

### Part 3 — Terminal facts and honest scoring

**Full cost** — these now write a terminal step-run status, so `hardFailedFinals` counts
them 0 in the denominator with no change to `aggregate.ts`'s existing math:
- stall escalation at the retry cap → `blocked`
- `cancelWorkflowRun` closes the in-flight step run → `blocked`, reason `run_cancelled`
- goal archive closes the in-flight step run the same way

**Partial cost** — a step run that was rescued and *then* passed should score below a
clean pass and above a failure. New column:

```sql
ALTER TABLE workflow_step_runs ADD COLUMN stall_rescues INTEGER NOT NULL DEFAULT 0;
```

Incremented in the crash branch when `sess.failure_reason` is `worker_stalled` or
`user_declared_stuck`. It **shares** the `CRASH_RETRY_CAP` budget with `crash_retries`
(one rescue budget per step run) but is counted separately for scoring.

`listStepRunsByTemplate` (`metrics/fetch.ts:88`) selects it — the query already returns
**every** attempt, not just finals, so a rescued-then-passed run is visible. `scoreOver`
(`aggregate.ts:352`) becomes:

```
n = conclusive.length + hardFails + STALL_WEIGHT × Σ stall_rescues
value = Σ contribution(conclusive) / n
```

with rescues contributing 0 to the numerator. `STALL_WEIGHT = 0.5`, a designed prior in
the same spirit as `SOURCE_CONFIDENCE`. Worked example: two clean passes plus one pass
that took one rescue → `n = 3 + 0.5 = 3.5`, `Σ = 3.0`, **score 0.857** instead of 1.0.

Scores recompute from persisted rows on read, so this is retroactive and needs no data
migration — consistent with the rest of the metrics engine.

**Decided:** crash rescues (`crash_retries`) keep their current scoring-invisible
behavior. Only stalls and user declarations cost. Rationale: surgical — no existing
template's score moves for a reason the user didn't ask about. Weighting crash rescues
the same way is a named follow-up, not part of this slice.

### Part 4 — `/stuck`, the last-resort honest signal

For the one case no sensor can catch: an agent that is emitting output and firing hooks
while going in circles. Here the user's judgment *is* the evidence.

- **Chat input** (`OrcaChat.tsx:924`, `handleSendMessage`) intercepts a leading `/`,
  offers autocomplete from a registry, and routes to a command path instead of
  `createOrchestratorMessage`.
- **Registry** — one entry: `{ name: "stuck", args: "[reason]", describe: … }`. A small
  extensible shape, not a framework (CLAUDE.md §2). Adding a second command is a few
  lines.
- **Route** — `POST /v1/goals/:goalId/commands`, body `{ command, args }`. Deterministic
  handler, **never** the orchestrator LLM: a command must not be "interpreted." Unknown
  command → plain error reply, no LLM involvement.
- **`/stuck [reason]`** records the user's message in the thread (the log stays honest),
  stores the reason in `sessions.failure_detail`, and reaps with `user_declared_stuck` —
  entering the identical ladder from Part 2. The system still does the healing.

## Data model changes

| Change | Kind |
|---|---|
| `workflow_step_runs.stall_rescues INTEGER NOT NULL DEFAULT 0` | new migration |
| `SessionFailureReason` += `worker_stalled`, `user_declared_stuck` | contracts enum |
| `TemplateStepRun.stallRescues` | metrics fetch type |
| `ORCA_STALL_MS` | env knob |

No change to `composedScore`, the calibration engine, tiers, or bands. The scoring change
is confined to the denominator in `scoreOver`.

## Architectural fit

The sensor reads `sessions.output_seq` and `activities.updated_at` — both operator-
agnostic control-plane state. It does not parse worker output or depend on tmux beyond
the existing `isTmuxAlive` probe, so it survives the FUTURE_ARCHITECTURE control-plane /
execution-plane split: under the Runner Protocol, "has this runner made progress" and
"whose turn is it" remain control-plane questions answerable from the same two facts.

## Testing

Unit — stall sensor:
- system-turn suppression: `paused_for_input` (each source kind) never trips, regardless
  of elapsed time; a `permission_pending` activity never trips **despite its `active`
  status** — the regression this design would otherwise ship
- clock resets when `output_seq` advances; resets when `activities.updated_at` advances;
  trips only when both are static past `ORCA_STALL_MS`
- existing behavior preserved: grace window, `hasStepOutput` skip, dead-tmux reap

Unit — scoring:
- `hardFailedFinals` picks up a `blocked` final and counts it 0 (a test that fails
  against today's engine only because nothing ever writes the status)
- `stall_rescues` denominator weighting, including the 0.857 worked example
- a rescued-then-passed run is not double-counted as both a rescue and a hard fail

Integration:
- cap reached → step run `blocked` + run `blocked` + chat message
- **blocked → resume opens a new step-run attempt** (`attempt = 2`), the identified risk
- `cancelWorkflowRun` closes the in-flight step run as `blocked`; goal archive likewise
- `/stuck` posts the user message, reaps with `user_declared_stuck`, increments
  `stall_rescues`, and respawns under cap
- unknown slash command returns an error without invoking the orchestrator

Live verification: reproduce against the `DSL` goal's Research step and confirm the step
score moves.

## Decisions made during implementation

Recorded here so they are deliberate rather than accidental:

- **In-flight rescues count toward the score.** A step that was rescued and is *still
  running* discounts the template's score immediately, rather than waiting for the run
  to finish. The rescue genuinely happened the moment the system had to restart the
  worker; the cost is not deferred. (User decision, 2026-08-04.)
- **A cap escalation is not a rescue.** `stall_rescues` increments only when a worker was
  actually restarted, so the attempt that produced the block contributes the hard-fail
  weight alone rather than compounding with a rescue weight.
- **Unchecked work is never graded.** The `null`/needs-evidence sentinel and the
  `VERSION_MIN` floor are both gated on the *unweighted* population count, so a rescue can
  never manufacture a failing grade — or a version-comparison signal — out of a step that
  produced no conclusive evidence.
- **Unknown slash commands fall through to the orchestrator** as ordinary chat messages.
  The design above says an unknown command returns a plain error; in practice the client
  registry returns `null` for anything unrecognized, so `/usr/bin/x` reads as prose rather
  than erroring. The daemon's `UnknownCommandError` path remains for other clients.
- **Resume dispatches an agent** (added after the whole-branch review). The cap tells the
  user to pick the run back up, so resuming had to do more than flip database state: it
  opens the fresh attempt *and* respawns a worker for it, sharing one implementation with
  the boot-recovery path. If that respawn fails, the run returns to `blocked` with a
  plain-language explanation so the Resume control reappears.

## Out of scope

- Actively unsticking a live session (sending `Esc`, re-prompting) before reaping it.
  Saves accumulated context but means synthesizing input into a TUI; revisit once the
  sensor has real-world data.
- Feeding the user's `/stuck` reason into the respawned agent's prompt as extra input.
  Wants a `spawnStepAgent` signature change; worth doing, separately.
- Weighting crash rescues in the score (decided above).
- Any additional slash commands (`/pause`, `/cancel`, `/resume` already exist as routes).
- Propagating stall facts into node confidence / vindication labelling; the denominator
  change is the honest minimum.
