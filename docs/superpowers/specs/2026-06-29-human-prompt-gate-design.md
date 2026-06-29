# Human-Prompt Gate — Design

**Date:** 2026-06-29
**Status:** Approved (pending implementation plan)
**Area:** daemon / orchestrator (control plane)

## Problem

A single decision can be surfaced to the human **multiple times** for one step run,
through **uncoordinated channels** that don't know about each other. Observed in the
"Update pill colors on workspaces tab" goal: the same "which blue for the Active pill"
decision was asked three times — once by the step-confirmation card, once by the
worker's own `AskUserQuestion`, and once by the orchestrator's `ask_user` — while the
worker was already blocked waiting on its question.

### Root cause (evidence)

- **Two distinct originators, not a re-render.** The two persisted question rows have
  distinct `questionId`/`toolUseId` and a `UNIQUE INDEX` on `activity_steps.tool_use_id`
  structurally prevents one tool-use from rendering twice. DB:
  - Q1 (05:43:43) `source:"worker"`, `toolUseId:"toolu_014eBNz4…"` — a real Claude
    tool-use id (the worker's `AskUserQuestion`).
  - Q2 (05:44:23) **no `source`**, `toolUseId:"019f11e8-…"` — an Orca-generated UUID
    (the orchestrator's `ask_user`, `service.ts:959`).
- **The worker asked once.** Worker transcript `520083b8` contains exactly one
  `AskUserQuestion` call. The worker did not re-ask; it is genuinely blocked on the
  elicit hook's open HTTP request (up to `ELICIT_ANSWER_TIMEOUT_MS` ≈ 590s).
- **No cross-channel dedup.** Dedup exists only inside the worker channel, keyed on
  `toolUseId`, held **in-memory** in `WorkerQuestionStore` (`worker-questions.ts`) —
  rebuilt empty on restart, with no DB constraint. The orchestrator's UUID `toolUseId`
  can never collide with the worker's real id, so the two channels never coordinate.

## Goals

- **Invariant:** at most **one human prompt open per step run** at a time, across all
  three channels (worker question, orchestrator question, confirmation card).
- Kill the observed bug (worker asks → orchestrator re-asks the same thing) outright.
- Bake the coordination into the harness substrate (single authoritative seam over
  event-sourced state), not a one-off patch.
- Preserve inspectability: every suppressed prompt is logged, never silently lost.

## Non-goals

- No new event family or projection table (see "Substrate choice" — rejected as a
  second source of truth).
- No change to the **worker hard-block** mechanism (the open HTTP request and the
  in-memory `WorkerQuestionStore` that holds the resolve promise stay as-is; only the
  *truth* "is a prompt open" moves to derived/durable state).
- No UI redesign of the question/confirmation cards beyond rendering a withdrawn state.

## Substrate choice (and why)

**Chosen: a named gate seam over the existing event spine.** The prompt open/close
transitions are **already events**: opening writes through `insertMessageWithEvent`
(questions) or `insertActivityChangedEvent` (cards); answering/resolving updates the
same projected rows. The gate is therefore a **projection read**, reconstructable by
replaying events — no second copy of state.

**Rejected: a dedicated `human_prompt_opened/closed` event + gate table.** It would
duplicate state the `pending_question` / `activities` rows already hold — exactly the
"parallel, un-synchronized state" consistency hazard the paper names (agent-harness.pdf
p.64), and redundant against FUTURE_ARCHITECTURE's "append-only event spine +
projections" (line 98) and CLAUDE.md "Simplicity First."

### Doc alignment

- agent-harness.pdf p.28/p.31 — human-review gates + escalation unified into **one
  harness-level control process**: justifies covering all three channels under one gate.
- FUTURE_ARCHITECTURE.md line 95 — "deterministic code owns … **gates**": one
  deterministic gate owner, not two partial owners.
- agent-harness.pdf p.42/p.64 — single shared blackboard / single source of truth;
  avoid parallel un-reconciled state.
- agent-harness.pdf p.33 — telemetry/inspectability: suppressed prompts are recorded.

### Harness-axis alignment (ORCA.md §14 — the unifying frame)

The four reliability axes are how this codebase frames substrate work. The gate maps
cleanly:

- **Governed** (primary). Orca's HITL surface is a set of "human approval gates"
  (ORCA.md §1). This is a new Governed-axis primitive that makes the human-input surface
  a **single deterministic gate** per step run, alongside the existing routing gates
  (`workflow_gate_decisions`) and `permission-gate.ts` — not a replacement for either.
- **Inspectable.** Every suppression is recorded as a **queryable** record (stepRunId +
  intended questions + the open prompt that won), not a bare console line — consistent
  with the existing append-only Inspectable spine (`HarnessTransition` / `TelemetryFacet`).
  It is *not* a new `HarnessTransition` boundary (those are `step_launch` / `step_complete`
  / `tool_gate` / `mark_done`); it is a lighter structured suppression record.
- **Stateful.** The gate's truth is **derived from durable projected state**, replacing
  the volatile in-memory `WorkerQuestionStore` dedup as the source of truth. It is
  deliberately **distinct from** the Stateful-axis conflict/belief-divergence substrate
  (the `ConflictJudge` seam, read/write-sets): this is coordination of the *human-input
  channel*, not workspace read/write conflict — so it does not duplicate that seam.
- **Executable.** Unaffected — no change to deterministic sensors or step validation.

### Deterministic-core + control-plane placement

The gate is **pure deterministic code, no LLM** — consistent with "deterministic core,
selective AI" (ORCA.md §3) and "deterministic code owns … gates." It lives entirely in
the **control plane**: the worker question *originates* execution-plane (a runner hook),
but its durable record and the gate read are control-plane state. This is
forward-compatible with FUTURE_ARCHITECTURE's control/execution split and Runner Protocol
— when the runner boundary becomes a network seam, the question still arrives as a hook
event into the control plane and the gate still reads control-plane projections. The gate
is invoked from the `OrchestratorService` reaction layer (where the `ask_user` action is
applied); the gate read itself is a standalone pure query usable by the `DispatchEngine`
control unit too.

## Design

### 1. The gate seam

New module `apps/daemon/src/workflows/orchestrator/human-prompt-gate.ts`:

```
isHumanPromptOpen(db, stepRunId): boolean
```

Unions the two existing event-sourced projections, scoped by `stepRunId`:

1. **Questions** — `orchestrator_messages` where `pending_question IS NOT NULL`
   AND `json_extract(pending_question,'$.answer') IS NULL`
   AND `json_extract(pending_question,'$.withdrawn') IS NULL`
   AND `json_extract(pending_question,'$.stepRunId') = ?`.
2. **Confirmation card** — `activities` where
   `source_kind='step_confirmation_pending' AND status='paused_for_input' AND step_run_id = ?`.

Returns true if either yields a row.

### 2. Contract change (additive, no migration)

`packages/contracts/src/index.ts` `PendingQuestion` (line 1102) gains two optional
fields:

- `stepRunId?: string` — scopes a question to its step run so the gate can read it
  per-step. Stamped at every post site.
- `withdrawn?: true` — marks an orchestrator question superseded by a worker hard-block;
  the projection renders it retracted and the gate counts it closed.

Both are additive JSON fields; existing rows remain valid. A pre-existing open question
without `stepRunId` simply isn't gate-scoped (rare, transient).

### 3. The three call sites

| Channel | Site | Behavior |
|---|---|---|
| **Worker `AskUserQuestion`** (hard block) | `server.ts:1648` (`onWorkerQuestion`) | **Always posts.** Stamp `stepRunId` (already available via `resolveStepContext(sessionId)`) into the `pending_question` payload. **Supersede:** on opening, set `withdrawn:true` on any open question for this `stepRunId` whose `source` is not `"worker"` (i.e. an orchestrator question). |
| **Orchestrator `ask_user`** (optional) | `service.ts:959` (`applyOrchestratorAction`, `case "ask_user"`) | **Acquire/suppress:** if `isHumanPromptOpen(db, ctx.stepRun.id)` → **do not post**; record a queryable suppression record (`stepRunId` + intended `questions` + which open prompt won), consistent with the Inspectable axis. Otherwise post as today, stamping `stepRunId` **and `source:"orchestrator"`** (currently omitted) so supersede can target it unambiguously. |
| **Confirmation card** | `store.ts:384` (`pauseForConfirmation`) | **Always posts** (the agent is parked; nothing races it). No acquire check — it only needs to be *readable* by the gate, which it already is (carries `step_run_id`). |

### 4. Release (no new code)

Because the gate is derived from existing lifecycle state, closing a prompt is already
handled:

- Question answered → `recordWorkerQuestionAnswer` sets `pending_question.answer`
  (`usecases.ts:304`) → gate sees `answer != null` → closed.
- Confirmation card resolved → `confirmStep`/`confirmSplit` advances the run, the
  activity leaves `paused_for_input` → gate sees no row → closed.

There is no "release" path to write and none to leak.

## Why suppression is deferral, not loss

The orchestrator's `ask_user` is produced by its **response-done** decision loop. While
a hard-block prompt is open, the agent has not produced a new final response, so the
orchestrator has nothing genuinely new to judge. Once the open prompt resolves and the
agent produces a real response, the judge re-runs and re-raises any genuinely-distinct
question. Therefore:

- **Common case (the bug):** worker asks first, orchestrator re-asks the same thing
  40s later → suppressed outright.
- **Reverse ordering:** orchestrator asks first, then the worker hard-block opens →
  worker supersedes the orchestrator's now-redundant question (`withdrawn:true`).

The `≤1-human-prompt-per-step-run` invariant holds in every ordering, and every
suppression leaves an inspectable record so deferral is auditable, never silent.

## Testing

- **Gate unit tests** (`human-prompt-gate.test.ts`): open worker question → true; open
  card → true; answered question → false; withdrawn question → false; question scoped to
  a *different* stepRun → false; parallel step runs each report independently.
- **Suppression** (`service` test): with a worker question already open for a step run,
  an `ask_user` action posts **no** new message and writes the suppression record.
- **Supersede** (`server`/integration): orchestrator question open, then worker
  `AskUserQuestion` for the same step run → orchestrator question marked `withdrawn`,
  worker question posts.
- **Release**: answering the worker question, or resolving the confirmation card, makes
  `isHumanPromptOpen` return false; a subsequent `ask_user` then posts.
- **Parallel branches** (splitter): a worker question on branch A does not suppress an
  `ask_user` on branch B (distinct stepRunIds).
- **Projection**: a `withdrawn` question renders retracted and is not interactively
  answerable.

## Risks

- **Distinct-but-deferred question feels lost to the user.** Mitigated by the
  re-evaluation loop (deferral) + suppression logging for audit.
- **Pre-existing open questions lack `stepRunId`** at rollout. Transient; they fall
  outside the gate until answered. Acceptable.
- **`json_extract` query cost.** Negligible at current message volumes; the queries are
  step-run-scoped and indexed on the existing `goal_id, created_at` / `step_run_id`
  indexes.

## Touched files (anticipated)

- `apps/daemon/src/workflows/orchestrator/human-prompt-gate.ts` (new) + test
- `packages/contracts/src/index.ts` — `PendingQuestion` (`stepRunId?`, `withdrawn?`)
- `apps/daemon/src/server.ts` — `onWorkerQuestion` (stamp `stepRunId`, supersede)
- `apps/daemon/src/workflows/orchestrator/service.ts` — `ask_user` acquire/suppress + stamp
- `apps/daemon/src/orchestrator-chat/projection.ts` — render `withdrawn`
- Tests across the above.
