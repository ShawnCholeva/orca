# Run Trace Contract — evidence spec for the run-shaped read model

**Status:** proposed · **Author:** harness expert (orca-36) · **Date:** 2026-09-02
**Companion:** [`2026-09-02-metrics-run-ledger-design.md`](./2026-09-02-metrics-run-ledger-design.md) (product/IA — the *screen*). This document is the *evidence contract* only: what is persisted, what is derivable, and what each field is allowed to claim. It does not specify layout.
**Implements from:** `apps/daemon/src/metrics/`, `apps/daemon/src/harness-metrics/`, `packages/contracts/src/harness/index.ts`, `apps/daemon/src/activities/store.ts`.

---

## 0. Why this document exists

Two experts read the same live database and reported run cost 2× apart and run duration 17× apart. Neither was wrong; neither had named their interval. That is the failure this contract prevents.

**Governing rule: every duration and cost field carries its definition inline, not just its type.** A number whose denominator or interval is unstated is not a measurement.

Three further rules, each earned from a defect found in the current screen:

1. **A composite number is never rendered without its denominator and composition.** (From `Triage = 16`: score, tier, and band are computed over three different populations and rendered adjacently with no indication.)
2. **Absence is never zero, and the reason for absence comes from a declaration, not an inference.**
3. **An open interval is not a missing interval.** An unterminated park is the most important row on the screen, not the least.

---

## 1. Frame: a run is a trace

| Trace concept | Orca entity | Key |
|---|---|---|
| Trace | `workflow_runs` row | `workflow_run_id` |
| Span | `workflow_step_runs` row (one per attempt) | `workflow_step_run_id` |
| Span bracket | `step_launch` → `step_complete` transitions | `boundary` |
| Child trace | `delegate_spawn` / `delegate_join` | `CompositionFacet.childRunId` |
| Span annotations | `tool_gate` transitions, `activity.changed` events | run + step keyed |

**Do not extend or reuse `ReplayStep`.** Its wire shape carries `{seq, boundary, at, summary, facets:{risk, evidence, telemetry}}` — it drops `workflowRunId`, `workflowStepRunId`, and three of six facets (`stateDeps`, `composition`, `refute`), so it cannot show conflicts, belief-divergence, delegation, or the independent-review verdict. Its own docstring is honest that it is a compact goal-level audit projection. Widening it would break that guarantee while serving neither consumer. Define `RunTraceSpan` fresh.

### D / O marking

Every field below is marked:

- **D** — deterministic sensor or mechanical fact (exit codes, timestamps, token counts, graph topology, status enums).
- **O** — LLM-judged opinion (refute verdict, gate reason, scoring proposal, agent-authored `untestedRegions` / `assumptions`).
- **D\*** — deterministic arithmetic over mixed D/O inputs. Must render with its composition visible.

The UI must visually distinguish D from O. This is not decoration: an `independent_review` verdict carries 0.55 weight into a number rendered as a grade, and the reader cannot currently tell it apart from a passing test.

---

## 2. Durations — four fields that sum

```
elapsedMs  =  workingMs  +  parkedMs  +  unaccountedMs
```

| Field | Definition | Source | Mark |
|---|---|---|---|
| `elapsedMs` | First span `started_at` → **the run's own terminal moment**; accrues to `now` only while the run is genuinely active (§2.1) | `workflow_step_runs` | D |
| `accruing` | `true` only when the **run** is non-terminal | derived | D |
| `workingMs` | Σ `telemetry.latency_ms` over the run's `step_complete` transitions. Provider-reported **model time** — a magnitude, not a placed interval. | `TelemetryFacet` | D |
| `parkedMs` | **Union of merged** `paused_for_input` intervals (§5) — never a sum | `events` (`activity.changed`) | D |
| `unaccountedMs` | `elapsedMs − workingMs − parkedMs` | derived | D |

> **`parkedMs` is a merged-interval union, not `SUM(exit − enter)`.** The unique index `idx_activities_one_live_per_step` guarantees one live activity per **step_run**, not per **run** — two step_runs can be parked simultaneously, so parks genuinely overlap. Live: run `01a05a4d-…` has 9 parks across 2 step_runs that naively sum to **3971 min against ~3105 min of elapsed**. Summing exceeds wall-clock and drives `unaccountedMs` negative, firing the integrity flag on healthy data.
>
> Take **every park on the run**, sort by `enteredAt`, merge overlapping intervals, then sum the merged set. **Do not group by step or by `stepTemplateId` before merging** — run `01a05a4d-…` holds two open parks on *attempt 2 and attempt 3 of the same `triage` step*, which grouping by `stepTemplateId` would silently collapse into one. Parks are identified by `activityId` and carry `workflowStepRunId`; the merge operates on the flat interval set.
>
> **Where a merge has not been applied, list the open parks individually and render no total** — an honest omission beats a wrong number.

`unaccountedMs` is the honest name for dispatch latency, hook round-trips, sensor execution, orchestrator turns, and genuinely unobserved interior. **It is a residual, and it must be rendered as such** — it is the "hatched" material in the trace view.

**Invariant:** `unaccountedMs >= 0`. `workingMs` and `parkedMs` are disjoint by construction (a parked agent is not computing). If the residual goes negative, one of the two inputs is wrong — floor at zero and **raise a data-integrity flag rather than hiding it**. This is the falsifiability property: three independently-sourced numbers that must add.

### 2.1 `elapsedMs` for a blocked run holding an open card — the call

**`elapsedMs` ends at the run's own terminal moment. It does not tick for a dead run.** Only a genuinely active run accrues to `now`.

Run `01a05b0c-…` ran for **17 minutes** and then blocked, and its confirmation card is still open ~50 hours later. Rendering "50h and counting" would assert that a run lasted two days when it was dead after seventeen minutes, and would make every abandoned run in the history permanently the loudest row on the screen. **Duration is a property of the run; a card's age is a property of the card.** Do not fold one into the other.

**This means `parkedMs` and a park's displayed age are two different quantities**, and conflating them is what makes the invariant appear to break:

- `parkedMs` — the merged union **clamped to `[runStart, runTerminalMoment]`**. This is what participates in `elapsed = working + parked + unaccounted`.
- `Intervention.durationMs` — the park's **actual age, unclamped**, live-ticking while open. This is what the card row displays.

Clamping keeps the sum invariant sound without lying about either number.

### 2.2 An open park needs its run state attached, server-side

A park's meaning inverts depending on whether its run is alive, and the two demand opposite user actions:

| `parkState` | Condition | Reads as |
|---|---|---|
| `awaiting_you` | run **active** + park open | "waiting on you (Nh)" — the reader is the bottleneck; go act |
| `abandoned` | run **terminal** + park open | "left open when the run stopped (Nh)" — debris; the reader is *not* the bottleneck |

**Emit `parkState` as a field; do not let the UI derive it from two separate values.** All three of the currently-open parks are `abandoned` — labelling them "waiting on you" would send the reader to answer three cards that accomplish nothing, which is worse than showing nothing. Deriving this at render time from `run.status` + `park.open` is exactly how it gets got wrong later.

A fifth figure is useful but does **not** participate in the sum, because parks can occur inside a span:

| `spanActiveMs` | Σ (`finished_at − started_at`) over spans — "how long were steps in flight" | `workflow_step_runs` | D |

### Worked example (live: run `01a04645-…`)

```
elapsed        1260.3 min (21.0h)  100%
├─ working        73.3 min ( 1.2h)   5.8%
├─ parked       1128.1 min (18.8h)  89.5%   ← of which ONE park = 1077.2 min
└─ unaccounted    58.9 min ( 1.0h)   4.7%
(spanActive      172.2 min — steps in flight, overlaps the above)
```

The 17.95-hour hole between `execution` finishing (05:37:16) and `__gate__:review` starting (23:34:27) resolves exactly to one `step_confirmation_pending` park, derived independently from `activity.changed`. **Two derivations from different tables converging to the minute** is the strongest evidence standard anything in this projection meets. Preserve that cross-check as a runtime assertion.

---

## 3. Cost — two fields, plus a checksum

| Field | Definition | Mark |
|---|---|---|
| `costUsd` | Σ `telemetry.cost.usd` over **`step_complete` only**, **all attempts including superseded/retried** | D |
| `costWastedUsd` | Σ over the **set union** of: completions whose own `telemetry.outcome.status == 'failed'`, plus completions superseded by a later attempt of the same (run, step). Union, not a sum of two filters — a completion can be both. | D |
| `costCoverage` | `{reported, total}` counts of completions carrying non-null cost | D |

**`mark_done` is a checksum, never an addend.** It carries a cumulative roll-up that sums every `step_complete` on the run (per ORCA.md, Stateful axis). Summing all boundaries adds the total to itself — the source of the $61.52 / $123.04 discrepancy. Exactly 2× is the signature.

**Assert it:** `Σ(step_complete cost) == mark_done.telemetry.cost.usd`. On the live run this holds to the cent. Divergence means a completion escaped the roll-up's view — a cheap, deterministic integrity sensor the spine should have.

**Total includes superseded attempts.** That is what the subscription bill reflects; a delivered-work-only figure is a number no invoice will agree with.

**`costWastedUsd` belongs in the run row, not a drawer — it is the headline of the cost half.** Live, run `01a04645-…` splits by each completion's own outcome status:

```
succeeded   7 completions   $13.50
failed      3 completions   $48.02   (all evidence_veto)   ← 78% of the run
(1 completion carried no cost — unreported)
                            ──────
                            $61.52
```

**One failed `execution` attempt cost $42.48 — more than the entire rest of the run combined.** The definition is clean and needs no heuristic: the completion's own `outcome.status` says it.

### 3.1 The five cost states

| State | Meaning | Derivation |
|---|---|---|
| `measured` | Provider reported it; we recorded it | `cost != null` **and** `cost.source == 'provider'` |
| `estimated` | Usage known; priced from the static map | `cost != null` **and** `cost.source == 'price_map'` |
| `unreported` | Channel exists, provider sent nothing | telemetry facet present, `cost == null` |
| `unmetered` | No capture path exists — **not zero** | adapter's declared `hookContract()` + OTLP capability, joined via the goal's `orchestrator_provider` |
| `captured-but-discarded` | Metered in memory, never persisted | spawned a session, emitted no telemetry facet (today: gate surrogates) |

**One stored bit is required.** `buildTelemetry` currently collapses provider-authoritative and price-map-estimated into one `usd` (`dispatch-engine.ts:172-178`), so `measured` and `estimated` are indistinguishable after the fact. Add an additive, nullable-defaulted `cost.source: 'provider' | 'price_map'` to `CostEntry` — same pattern as the existing cache-token fields, so serialized facets still parse. Everything else derives; **store nothing else.**

**Never store `unmetered`.** Derive it from the adapter declaration. The boot-time guard hard-fails startup when an adapter's declared `hookContract()` drifts from what it emits, which is what makes the declaration trustworthy enough to render from. Inferring it from missing rows would silently reclassify **defects as limits** — `unmetered` means "we cannot see this," `unreported` means "we should have seen this and didn't." That distinction is the whole point of the vocabulary.

`captured-but-discarded` disappears when gate emission lands (§6). A state that names a bug should have that lifecycle.

---

## 4. `RunTraceSpan`

```ts
RunTraceSpan = {
  // identity — REQUIRED, the failure ReplayStep has
  workflowRunId: string;            // D
  workflowStepRunId: string;        // D
  goalId: string;                   // D  — still-parked rows must be clickable
  nodeId: string;                   // D
  stepTemplateId: string;           // D  ("__gate__:<nodeId>" for gate spans)
  name: string; ordinal: number; attempt: number;   // D

  kind: "step" | "gate" | "splitter" | "delegate";  // D

  // timing (§2)
  startedAt: string; finishedAt: string | null;     // D  (null ⇒ open)
  elapsedMs: number;                                 // D
  workingMs: number | null;                          // D  null ⇒ unmetered provider
  parkedMs: number;                                  // D
  unaccountedMs: number;                             // D  residual; >= 0 or flagged

  // execution health
  status: "pending"|"active"|"blocked"|"passed"|"failed"|"skipped";  // D
  blockedReason: string | null;     // D  ← currently fetched and DROPPED; surface it
  restarts: number;                 // D  count(step_launch) for this step_run − 1
  stallRescues: number;             // D

  // cost (§3)
  cost: { usd, tokensIn, tokensOut, cacheRead, cacheCreation,
          source: "provider"|"price_map"|null,
          state: <one of the five> } | null;         // D

  // verification — the D/O boundary lives here
  tier: VerificationTier; tierLabel: string;         // D  (sensor/grounding gated)
  verifiers: { executable: boolean;                  // D
               grounding: boolean;                   // D
               independentReview: boolean };         // O  ← mark distinctly
  sensors: { kind, command, exitCode, durationMs, result, summary }[];   // D
  grounding: { rule, field, mode, result, detail }[];                    // D
  refute: { verdict, reason, reasoning,              // O
            triggeredBy, riskClass } | null;         // D (triggeredBy, riskClass)
  untestedRegions: string[];                         // O  agent-authored, NOT measured coverage
  residualRisk: string[];                            // O
  assumptions: { statement, sourceRef, verified }[]; // O (verified flag is D)

  // state & safety
  conflicts: { kind, refs, withTransitionId }[];     // D
  readSet: []; writeSet: [];                         // D
  toolGates: { allow, requireApproval, deny,
               hardConstraintViolations }: counts;   // D

  // score — D* : deterministic arithmetic over mixed inputs
  score: {
    value: number | null;                            // D*
    base: number; coverage: number;                  // D*
    denominator: { conclusive, hardFailed, stallRescues, effectiveN };   // D  ← MANDATORY
    verifierMix: { executable, grounding, independentReview, selfReportOnly };  // D/O
  } | null;
}
```

**`score` must never serialize without `denominator`.** `Triage = 16` decomposes as `0.70 delivered ÷ 4.5 effective attempts (1 verified delivery, 3 crash-blocked runs, 1 stall rescue)`. The bare `16` is true and unreadable. Make the shape enforce it.

### Gate spans

`kind: "gate"` spans carry `evidence: null` — **a gate runs no sensors, and that is a true statement, not a hole.** Their verdict lives in `workflow_gate_decisions` (O), never on the span. One derived field is worth more than the rest of the gate row:

| `humanOverrode` | `recommended_outcome != outcome` | D |

That is a *direct* measurement of "can I stop watching this workflow?" — the L4→L5 crossing — computable today with zero new emission.

---

## 5. Interventions — the parked-time ledger

`activities` (migration 0024) + append-only `activity.changed` rows in `events` already form a parked-state ledger with run and step attribution. Nothing new is needed to derive durations.

```
ENTER    events row, type='activity.changed', payload.status == 'paused_for_input'
EXIT     next activity.changed for the same activityId with a different status
DURATION exit.created_at − enter.created_at
```

```ts
Intervention = {
  sourceKind: "question_pending" | "step_confirmation_pending" | "gate_decision_pending"
            | "mark_done_pending" | "permission_pending" | "provider_recovery_pending";  // D
  workflowRunId, workflowStepRunId, goalId;   // D  — required for the click target
  activityId: string;                         // D  — merge identity (§2)
  enteredAt: string;                          // D
  exitedAt: string | null;                    // D  null ⇒ STILL PARKED
  durationMs: number;                         // D  ACTUAL age, unclamped, live while open (§2.1)
  open: boolean;                              // D
  parkState: "awaiting_you" | "abandoned" | "resolved";   // D  — server-derived, §2.2
}
```

### 5.1 The one required emission change

**`sourceKind` is absent from the `activity.changed` payload** (`store.ts:167`, which emits only `{activityId, goalId, workflowRunId, stepRunId, turnOrdinal, status}`). Durations are derivable without it; the *cause* is not, reliably — joining back to the mutable `activities` row is lossy, and this is observed rather than theoretical: several live paused rows have since resolved their `source_kind` to `turn_completed` / `tool_use` because the row was overwritten after the pause.

**Add `sourceKind` to that payload. One line.** It is the difference between "stopped for you 6 times" and "1h50m of your 3h run was permission prompts" — the latter converts directly to a user action.

### 5.2 `permission_pending` needs it most

Permission prompts are the highest-frequency stop and currently the least recoverable:

- `permission_pending` **never flips `status` to `paused_for_input`** — `onPermissionRequest` mutates the live row in place, so its events all carry `status='active'` and consecutive events are indistinguishable (`store.ts:578-588`).
- The chat card is **deleted** on resolve (`deletePendingApprovalMessage`), destroying the enter timestamp.
- `RiskFacet.approval` has `decided_at` but no `requested_at`.

Adding `sourceKind` to the payload fixes this without touching status semantics: `resolvePermissionPendingActivity` already emits an event on both resolution paths, so the exit boundary exists — it is merely unlabeled. Until it lands, **render permission-prompt counts but not durations.** Anything computed today is a guess.

### 5.3 Open intervals

Three live parks have no exit event. **Render `still parked (20h)` with a live-ticking duration. Never drop, never null.** An unterminated park is the only thing on the screen the reader can act on right now, and it must be clickable — the span carries `goalId` and `workflowStepRunId` precisely so the link lands on the actual confirmation card rather than the top of the chat.

### 5.4 Out of scope, deliberately

Stall rescues and crash retries are **agent-lost time, not human-parked time.** Keep them on an adjacent line, never summed into the tax. Folding them in would launder an engineering defect into a user-behavior statistic. (Live: 4 of 5 runs blocked by `worker_exited_no_signal`.)

---

## 6. Gate emission — the one boundary gap

Gate step runs exist (`__gate__:critique`, `__gate__:review`, with `started_at`/`finished_at`) and emit **zero harness transitions**. A worker gate spawns a real agent on the user's subscription and leaves no telemetry record; the screen renders that as `null`, which reads as *free*.

**Verdict: deliberate for shadow gates, an oversight for worker gates.** The discriminant is `evalSubstrate`. A shadow gate is a control-plane evaluation with no execution and genuinely has nothing to emit. A worker gate (`spawnGateWorker`) inserts a real surrogate `workflow_step_runs` row, resolves a strong agent through `resolveStepDispatch`, calls `recordOperatorSelection`, and spawns a session whose Stop hook lands in `onAgentResponseDone`. The boundary model predates that substrate and was never revisited — `gate-metrics.ts:114` already filters on `'__gate__:' + nodeId`, a consumer written for a producer that was never built, and `workflow_llm_calls` is a table shaped exactly for this with zero rows ever.

**Emit the existing boundaries on the surrogate. Do not add a `gate_evaluate` boundary.**

- `step_launch` — in `spawnGateWorker`'s transaction, alongside the surrogate insert.
- `step_complete` — inside `closeSurrogate()`, carrying drained telemetry and `evidence: null`.

Rationale: a worker gate has a step_run id, an attempt, a fingerprint, an operator selection, and a start/finish. Structurally there is nothing about it that is not a step; a new boundary would encode a distinction that lives in the *template* vocabulary, not in the execution. The registry stays at six boundaries, the facet model is untouched, and `evalSubstrate` becomes verifiable from data (shadow emits nothing — correctly; worker emits a pair).

**Two binding cautions:**

1. **Emit inside `closeSurrogate()` itself, not on the happy path.** It is called from five sites — the main path plus four early returns (stale run, unparseable stash, missing template, not-awaiting-worker). Gate cost leaks on every abort otherwise. Distinguish them via `outcome.status`.
2. **Verify the `__gate__:` prefix filter holds on every metrics path** (`aggregate.ts:253-255`, `vindication.ts`). That filter is what keeps gate spans out of step metrics. It is the safety property of the whole change.

Gate cost is **not** `unmetered`. The OTLP receiver is already ingesting gate-session rows into `SessionCostAccumulator`; there is exactly one `drain()` call in the daemon (`dispatch-engine.ts:168`, reachable only from `step_complete`), so gate cost accrues in an unevicted in-memory `Map` and vanishes on restart. It is `captured-but-discarded`, and this change is the drain.

> Side finding: because nothing drains sessions that never reach `step_complete` (gate surrogates, refute turns, shadow sessions, crashed steps), `SessionCostAccumulator` grows unbounded for the daemon's lifetime. Small, real, same root cause.

---

## 7. Endpoints

### `GET /v1/metrics/runs`

Per row: `runId, goalId, templateId, templateVersion, templateName, status` (D); `startedAt, finishedAt, elapsedMs, workingMs, parkedMs, unaccountedMs` (D, §2); `costUsd, costWastedUsd, costCoverage{reported,total}` (D, §3); `stepsDelivered, stepsBlocked, restarts, openInterventions` (D); `worstBlockedReason` (D).

### `GET /v1/metrics/runs/:runId`

`{ run, spans: RunTraceSpan[], interventions: Intervention[], gates: […], timeline: […] }`, spans ordered by ordinal then attempt.

### `GET /v1/goals/:goalId/harness-replay?runId=…`

Add a `runId` filter. Transitions already carry `workflowRunId`; this is a where-clause on the existing keyset query and preserves genesis-first paging.

---

## 8. Zero-emission confirmation

Everything above derives from persisted rows today, with **exactly three exceptions**, all additive:

| # | Change | Size | Unlocks |
|---|---|---|---|
| 1 | `sourceKind` in the `activity.changed` payload | one line | why-attributed intervention tax, incl. permission prompts (§5.1) |
| 2 | `cost.source` on `CostEntry` | one nullable field | `measured` vs `estimated` (§3.1) |
| 3 | `step_launch`/`step_complete` on gate surrogates | §6 | gate cost, latency, restarts |

Two corrections to earlier assumptions, recorded so they are not re-derived:

- **`step_launch` ↔ `step_complete` is not 1:1.** Live counts are 31 vs 20; per step_run the ratios include 3:0, 3:1, 1:2, 2:3. Use `workflow_step_runs.started_at`/`finished_at` as the authoritative span bracket, and treat the `step_launch` **count** as the restart signal.
- **Per-step mean cost × step count ≠ run total.** Steps repeat. Live run totals are $61.52 / $3.67 / $0.60; the per-step-mean estimate gave ~$26 — off by 2.4×. The aggregate view cannot produce a run total and silently implies one.

---

## 9. Observability ceiling (for the "unobserved interior" rendering)

Only `Stop` and `PermissionRequest` hooks are wired (`claude.ts:168`, `codex.ts:92`, `antigravity.ts:45`). Consequences for the hatched-material design:

- **The unobserved fraction is computable; its placement is not.** `latency_ms` is a sum of model turns, not a contiguous interval, so a span can be drawn as a *proportioned* bar (solid sized to `workingMs`, hatched to `unaccountedMs`) but must not claim *where* inside the span the observed time sat.
- **`tool_gate` coverage is sampled by permission policy, not complete.** A pre-allowed tool fires no hook and leaves no trace, and `permissionRule()` deliberately broadens edits to the parent directory so "always allow" sticks. Tool-gate counts are a lower bound; label them so.
- **A provider with no usage channel yields `workingMs: null`, not 0** — which renders as 100% unobserved and would be *true but misleading*. Distinguish "unobserved because nothing reports" from "unobserved because time elapsed unaccounted" using the same `hookContract()` declaration as `unmetered` (§3.1).
- The fraction will read high (≈95% at run level, ≈57% within spans, on the live run). That is honest. It is the argument for `PostToolUse`, and it self-corrects as hooks land — which is why it must be computed, never authored.

---

## 10. Deferred (named, not started)

`PostToolUse` trajectory · artifact refs (`prompt_ref`/`raw_output_ref` are hardcoded null; `SensorResult.artifactRef` has no store behind it) · revision edges (`route_back` boundary) · approval latency (`requested_at` on `RiskFacet.approval`) · splitting delivery-quality from run-completion in `score` (a scoring-contract change; founder decision).

**Dimension adjudication** (separate track, agreed): retire `recovery` (replacement already computed and rendered as `recoveredRate`); retire `replayability` (fraction of transitions carrying telemetry — the system grading whether it wrote its own rows, unfalsifiable by construction; replace with evidence coverage); redefine `trajectoryEfficiency` as wasted-spend ratio (§3). Freeze `DimensionKey`'s six string values and decouple them from the metrics dimensions — it is a *proposal* vocabulary, and freezing it avoids the parse-breakage class entirely. The `SixDimensions`/`SixDeltas` `.strict()` contract break is real work touching desktop and fixtures.

## 11. Product bugs surfaced by this work

Not metrics gaps — the screen's job is to make them undeniable, not to fix them.

1. **`worker_exited_no_signal` crash loop** — blocked 4 of 5 runs. Note the code is the *liveness watchdog's own label* for `isTmuxAlive() === false`, not an observed process exit, so it names a symptom rather than a cause.
2. **No notification on a pending confirmation** — a card sat 17.95 hours because Orca never told anyone it was waiting.
3. **Runs terminate without resolving or expiring their pending activities.** All three currently-open parks sit on runs that had already blocked, on step runs that had also blocked. An expiry path exists (an older run's activities did reach `expired`) — it did not fire for these. This is what makes `parkState: "abandoned"` (§2.2) necessary rather than cosmetic.
