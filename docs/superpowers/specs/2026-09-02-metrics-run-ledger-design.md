# Metrics → Run Ledger: design

**Date:** 2026-09-02 · **Lead:** orca-1a · **Team:** orca-e9 (product), orca-36 (harness), orca-6b (engineer), orca-d0 (APM)
**Status:** design agreed, slice 1 in build

## The complaint

> "I'm not quite understanding how my workflow runs are behaving based on what is there."

## Diagnosis

Four independent investigations converged on the same structural fault, then a fifth
finding overturned the first explanation. Both halves are true; the second is upstream.

**1. Wrong unit.** The screen is 100% template-scoped aggregate
(`getTemplateMetricsSummaries` / `Detail` over a 24h/7d/30d window). There is no `run`
anywhere in it. `workflowRunId` appears in `apps/desktop/src/metrics/` exactly once — in a
test fixture. The daemon already exposes `/v1/goals/:goalId/harness-metrics`,
`/harness-attribution` and `/harness-replay` (genesis-first, keyset-paged) and **the desktop
consumes none of them**. Orca built the dashboard and skipped the trace view.

**2. Wrong statistics for the sample.** The live DB holds **5 runs** across 3 template
versions, lifetime. `SAMPLE_MIN=5`, `VERSION_MIN=2`. So nearly every panel correctly
computes "insufficient" — and the UI's entire response to low confidence is
`opacity: 0.55`. It dims the number and asserts it anyway. The founder reads a wall of
hedged, half-faded panels and concludes he cannot understand his runs. He is right about
the experience and wrong about the cause: **the screen is starved, not confusing.**

**3. The reframe (orca-d0).** The small population is *runs*, not *events*. 5 runs contain
74 harness transitions. The screen aggregates at the one level where there is genuinely
nothing, and discards the sample that exists. → **Push the unit of analysis down to the
transition; push comparison up to the individual run.**

**4. Facts vs estimates, inverted.** Sums, counts and per-run costs are *facts* — exact at
n=1, no sample gate. Rates, medians and deltas are *estimates*. The screen dims the facts
and asserts the estimates: `$123.04` for the one completed run renders at 55% opacity while
a six-dimension version delta computed from **1 run vs 3 runs** renders at full strength to
15 decimal places.

## Ground truth (live DB, whole lifetime)

| | |
|---|---|
| Workflow runs | 5 — 1 completed, **4 blocked** |
| Blocked cause | `worker_exited_no_signal` ×3 → `CRASH_RETRY_CAP`. **All four identical.** |
| Run …4645, fully decomposed | wall-clock **1260.3 min (21.0h)** = agent-active **73.3 min (5.8%)** + step overhead **98.9 min (7.8%)** + between-steps **1088.1 min (86.3%)** |
| The 86% | Execution ends 05:37:16; `__gate__:review` starts 23:34:27. That 17.95h hole **is** the 1077.2-min `step_confirmation_pending` park derived independently from `activity.changed` — two derivations, same interval, **to the minute**. |
| Run …4645 cost | **$61.52**, 10 of 11 nodes reported. Execution retried 3× for $42.48 + $2.64 + $3.23 = **$48.35 — 79% of the run**. |
| `mark_done` | 1 |
| Harness transitions | 74 · learning_events / proposals / baselines: **0 / 0 / 0** |
| Refute | 7 upheld · 0 refuted · **7 unavailable (50%)** — shadow cold-start bug |
| Per-run spend | $123.04 (73m, the only completed run) · $7.57 · $3.67 · $0.60 |
| Gate transitions | **0** — no gate boundary exists in the registry |

## Bugs found (not design items)

- **`Triage` scores 16/100 with zero failure modes listed.** The score derives from step_run
  **status** (blocked tanks `firstPassRate`); the failure-mode list derives from the
  evidence/refute **facets** (all `passed`, all `upheld`). Two data sources, opposite
  stories, one tile. It is *showing a crash loop through a quality lens*.
  → **Rule: process failures and quality failures must never share a tile.** A run that
  crashed out is not a low-quality run; it is a run that never got to be judged.
- **`trajectoryEfficiency` is a unit collision.** `tokens / n` — mean tokens per transition,
  unnormalized, sitting in a grid of 0..1 fractions, with an inverted sign convention
  (higher is worse; its five neighbours are higher-is-better). Renders as `23103.596…`.
- **`versionComparison` has no per-side sample guard** (`aggregate.ts:137` fires whenever
  `presentVersions.length >= 2`). Hence v16 (1 run) vs v14 (3 runs).
- **Gate cost is structurally null.** Gate workers spawn real agent sessions doing real LLM
  work and emit no transitions at all. On screen `null` reads as *free*. It is not free; it
  was never measured.
- **`gate-metrics.ts:116` sums `tokens_in + tokens_out`, excluding cache.** A step that moved
  690k tokens reports 11k — a 60× understatement, next to a `usd` that correctly includes
  cache.
- **The period selector is inert.** 7d and 30d return byte-identical data.

## Design

**Governing shape: a LEDGER, not a dashboard.** Five runs, five rows, shown in full. No
averages, no grades, no sparklines, no period selector. Every number is a count of something
that happened, not an estimate of a population.

1. **Headline** — one sentence, the most important true fact. Never a tile, never a grade.
   > "4 of your 5 runs stopped before finishing. All four crashed the same way — the worker
   > exited three times and ran out of retries."
2. **The runs** — one row each, newest first, all of them.
   > `Sep 1 · Adaptive Delivery v3 · stock-trader · BLOCKED at Implement — ran out of retries
   > · 47m (23m parked on you) · $2.14, 6 of 9 nodes reported · 3 stops: 2 permission, 1 revise`
3. **Run detail** — cost-weighted waterfall. Row per step span, x = wall clock, width =
   duration, cost as a second encoding. Delegates nested as child spans. Verdict ribbon with
   **four** states (passed / failed / partial / **unverified**). Span interiors **hatched** —
   only `Stop` and `PermissionRequest` hooks are wired, so a pre-approved tool call leaves no
   trace and we must never draw a solid bar for time we cannot account for.
4. **"What we can't tell you yet"** — one consolidated prose block naming each sample floor
   and the current distance to it. Never fifteen greyed panels.
5. **Steps** — demoted, rendered only where `verifiedSampleSize > 0`. The verification-honesty
   work is the best thing on the current screen; it survives intact, one level down.
6. **Learning** — one line, stating the floor *before* the button.

### Honesty rules (binding)

- **Never dim. Change the form.** A measured value is a number; an unmeasured one is a
  different object — raw points, an interval, or a sentence. `opacity: 0.55` is banned.
- **Type every null**, reusing the daemon's existing vocabulary (`measured | insufficient |
  unmeasurable` from `verification.ts`) plus *not-instrumented*. Three different actions for
  the user, currently collapsed into one dash.
- **Cost states (five):** `measured` (provider-authoritative) / `estimated` (our price map) /
  `unreported` (channel exists, provider sent nothing) / `unmetered` (no capture path — **not
  zero**; antigravity) / **`captured-but-discarded`** (metered right now, in daemon RAM, never
  persisted — gates). Report billable-new and cache-read as two series, never one scalar.
  **Absence of cost is never zero, and the reason for absence must come from a declaration, not
  an inference** — `unmetered` vs `unreported` is "we cannot see this" vs "we should have seen
  this and didn't"; one is a documented limit, the other a defect. Derive `unmetered` from the
  adapter's `hookContract()`; inferring it from missing rows silently reclassifies bugs as limits.
- **Typed nulls (five), organised by REMEDY:** `measured` (—) / `insufficient` (wait for runs) /
  `unmeasurable_coverage` (run more checks) / `unmeasurable_structural` (nothing to do — self-
  report only) / `uninstrumented` (harness work). Widen `CalibrationEntry.state`; never add a
  second enum in the desktop. The desktop maps state → form, never re-derives it.
- **Never let `betaMean` reach a display path.** It is a shrinkage estimate with an informative
  prior at K=4 pseudo-counts: 4-of-4 observed returns **0.75**, so the screen would say 75% for
  something the user counted as 4 out of 4. Scoring keeps it; display uses Wilson.
- **Decompose rather than pick.** When two careful readings disagree, it is usually two numbers.
  Duration renders as `elapsed · working · waiting on you` (three fields that must sum — that
  property is what makes the tax falsifiable in front of the reader). Cost renders as
  `total · of which thrown away`; the total INCLUDES superseded attempts, because that is what
  the subscription bill reflects.
- **An open interval is not a missing interval.** A park with no exit event renders as
  `still parked (20h)`, live-ticking, never dropped — it is the most important row on the
  screen, not the least, because it is the only one actionable right now. It must be clickable,
  landing on the actual card (carry the activity's `step_run_id`).
- **n is a permanent column**, at the same visual weight as the value — not a tooltip.
- **Rates render as intervals, never points.** One component whose width does the epistemics.
- **Zero-event framing:** use the EXACT one-sided bound `1 − 0.05^(1/n)`, not the 3/n rule of
  three — 3/n is an n>30 approximation and overstates badly below it. At n=4, 0 failures means
  the true rate could be up to **53%**, not 75%. (`1 - Math.pow(0.05, 1/n)`, no library.)
  n=1→95% · n=2→78% · n=3→63% · n=4→53% · n=5→45% · n=10→26% · n=20→14%.
- **Ban p90+.** Replace with "worst run" — a fact, and more informative at this n.
- **Window by last N runs, not by time.**
- **Never render a container whose content cannot be computed** (delete the gate cost row and
  the inert period selector rather than showing "—" forever).
- **Never offer an action that cannot currently succeed** without saying so in the same
  sentence.
- **Process failures and quality failures never share a tile.**

### Sample gates (orca-d0)

Individual rows n≥1 · median n≥5 ("median of 5", not p50) · mean n≥8, never without spread ·
proportions: n=1 renders the outcome WORD not a rate, n=2-4 "x of n" primary, n≥5 percentage
primary — always with a **Wilson** interval (one-sided exact at 0/n and n/n) · delta vs version
**n≥5 per side AND non-overlapping uncertainty ranges** · cohort baseline
n≥20 · trend line n≥12 ordered points (below: unconnected dots) · anomaly detection n≥30
(below: fixed rule thresholds).

### Growth path

**Per-element gating, not a screen-wide mode switch.** A surface appears when *its own*
sample floor is met, and states its distance to that floor while below it. There is no "n=5
screen" and "n=500 screen" to maintain — one screen whose elements light up independently.
Nothing that appears later *displaces* the ledger; the ledger is the substrate aggregates
drill into, permanently. That is what makes an aggregate trustworthy: the user has seen the
instances it is made of.

## Sequencing

- **Slice 0** — shadow-session cold-start fix *(committed)*. A blind `sendEnter` was selecting
  `❯ No, exit` and quitting the agent; this is the direct cause of the 50% refute-unavailable
  rate. Upstream of everything: every run from here collects double the evidence.
- **Slice 0.5** — root-cause `worker_exited_no_signal`. **Top priority.** It destroys 80% of
  runs and blocks data generation.
- **Slice 1** — `sourceKind` into the `activity.changed` payload (one line) · run-scoped
  replay filter + run ids back on the `ReplayStep` wire shape · run list + node timeline ·
  intervention tax (count, duration, cause) · human-override rate on gates · blocked outcome
  + engine reason · deletions.
- **Slice 2** — n-aware components, typed nulls, retire the broken dimensions,
  PreToolUse/PostToolUse trajectory, gate emission.
- **Slice 3** — learning effectiveness, once rows exist.

## Traps recorded

- **`tool_gate` measures the permission policy, not the agent.** As the founder moves toward
  autonomous, gate counts collapse toward zero and every gate-derived metric will look like
  triumph. Never build loop detection or trajectory efficiency on it.
- **Stall/crash rescue time stays OUT of the intervention tax.** Folding it in launders an
  engineering defect into a user-behaviour statistic — it would blame the user for our bug.
- **Cross-check the tax:** `wall-clock − latency_ms` derives the parked interval from an
  independent source. If it doesn't reconcile with the activities-derived time, one is wrong.
- **Don't widen 0065.** `activities` already carries the richer fact, append-only.
  `awaiting_user` answers "am I parked now"; `activities` answers "for how long, and why."
- **The blocked story is a product failure the screen merely admits.** If the underlying rate
  stays at 80%, we have built a very honest coping mechanism.

## Corrections logged (things we nearly shipped)

- **`3/n` rule of three** → exact `1 − 0.05^(1/n)`. Would have overstated the founder's
  uncertainty by 22 points at his n.
- **`betaMean` in a display path** → would have rendered 75% for a 4-of-4 count.
- **"Two experts disagree on run cost/duration"** → they measured different things; the gap
  *was* the intervention tax. Rule adopted: decompose, don't arbitrate.
- **Gates are `unmetered`** → wrong; they are `captured-but-discarded`. OTLP ingests gate
  sessions into `SessionCostAccumulator`; there is exactly one `drain()` in the daemon
  (dispatch-engine.ts:168, reachable only from `step_complete`), so gate cost sits in RAM until
  restart, then vanishes. Same missing drain leaks the accumulator unboundedly for gate
  surrogates, refute turns, shadow sessions and crashed steps.
- **Triage=16 blamed on `firstPassRate`** → `firstPassRate` never feeds `score`. The path is
  `FAILED_STATUSES` → `hardFailedFinals` **and** `supersededByHardFail`, the latter *evicting
  two verified-passing completions from the numerator*. Patching `firstPassRate` would not have
  moved the number.
- **`step_launch`↔`step_complete` pair 1:1** → they do not (31 vs 20 live; ratios 3:0, 3:1,
  1:2, 2:3). Wall-clock comes from `workflow_step_runs.started_at→finished_at`; the
  `step_launch` count per step_run is itself the **restart count**.
- **`ReplayStep` can be extended for the trace view** → it drops both run ids *and* three of six
  facets (stateDeps, composition, refute). Define `RunTraceSpan` fresh; leave ReplayStep alone.
- **"3 ran out of retries, 1 couldn't reach an agent"** → that was an illustration, not data.
  Real `blocked_reason` strings must be read from the DB. Placeholders became copy twice.

## The recurring failure — in us, not just in the screen

Three times on this project, a plausible label was attached to a set it did not describe:
product's illustration ("3 ran out of retries, 1 couldn't reach an agent") hardening into copy;
the lead's superseded-attempts reasoning for a cost ruling that was right for a different
reason; and "three confirmation cards are still waiting on you" — which was wrong twice over
(they sit on runs that had *already blocked*, so nobody is waiting on anyone, and one of the
three is a `tool_use` permission prompt, not a confirmation).

That last one reached the founder before it was caught. It would have sent him to answer cards
that accomplish nothing.

**This is the same disease the screen has** — a name asserting more than the data supports —
recurring inside the team building the cure. Treat it as a standing hazard, not three
incidents: **every label on this screen must be checked against the set it names, not against
the set we assumed it named.**

Corollary now in the contract: **an open park carries its run's liveness as a field**, so the
UI renders "waiting on you (Nh)" only when the run is actually active and "left open when the
run stopped (Nh)" otherwise. Deriving it at render time from two loose fields is precisely how
this got got wrong.

## Settled: elapsed does not tick

`elapsedMs` ends at the run's terminal moment. A run that took 17 minutes and then died must
not read "50h and counting" — that would claim it ran for two days and make every abandoned run
permanently the loudest thing on the screen. **Duration belongs to the run; card age belongs to
the card.** Folding one into the other is what produced the bad clause above.

The park merge unions across **attempts of the same step**, not only across steps — one run's
two open parks are attempts 2 and 3 of the same `triage`. A merge keyed on `step_template_id`
would silently collapse them and produce a smaller, entirely plausible-looking total.

## Product bugs this project discovered (out of its own scope)

1. **`worker_exited_no_signal` crash loop** — blocks 80% of runs. Top priority.
2. **No notification when a run parks on the user.** A confirmation card sat 18 hours because
   Orca never said it was waiting. No screen design fixes this.
3. **Runs terminate without resolving or expiring their pending activities.** The expiry path
   exists (an older run's activities did reach `expired`) but didn't fire here, leaving three
   prompts orphaned for 48–50h. Possibly the same bug as (1) — a run dying abruptly may be why
   cleanup never ran.

## Settled definitions (the read model was under-specified; this is why two experts diverged 17×)

- **Run cost = Σ `step_complete` only.** `mark_done` carries a *cumulative roll-up* of every
  step_complete, so summing all boundaries double-counts — exactly 2× is the signature.
  mark_done is a **checksum, never an addend**.
- **Free correctness sensor:** Σ(step_complete) must equal mark_done's roll-up. It does, to the
  cent, on live data. Assert it in the read model — divergence means a completion escaped.
- **Sum ALL step_completes, including retries and superseded attempts.** Charging only final
  attempts would have hidden $48.35 of $61.52.
  ⚠️ **These two rules are not in tension and must not be "resolved."** The $61.52 figure
  *already includes* every superseded attempt (triage $1.26+$0.26, research $4.28+$0.91,
  execution $42.48+$2.64+$3.23). Anyone who reads "include superseded attempts" as a reason to
  prefer $123.04 will ship **every completed run at double its true cost**, while blocked runs
  — which have no `mark_done` — stay correct. The double-count is `mark_done`, not the retries.
- **Every duration and cost field carries its definition inline in the contract**, not just a
  type. The 17× divergence was not a data problem: two people picked defensible intervals and
  neither named it.

## `parkedMs` is a UNION, not a sum (build-blocker)

The UNIQUE index guarantees one live activity per **step_run**, not per **run** — so two
step_runs can be parked simultaneously and their intervals overlap. Run …5a4d's parks naively
sum to 4046 min against 3105 min of elapsed. Naive summation exceeds wall-clock, which drives
`unaccountedMs` negative and fires the data-integrity flag on healthy data on day one.
**`parkedMs` = the union of merged intervals.** Where a merge hasn't been applied yet, list the
open parks individually and render NO total — an honest omission, not a wrong number.

## The waste number

Splitting run …4645's $61.52 by each completion's own outcome status:

| step | failed attempts | succeeded |
|---|---|---|
| triage | $1.26 | $0.26 |
| clarify | — | $2.81 |
| research | $4.28 | $0.91 |
| proposal | — | $1.15 |
| **execution** | **$42.48** | $2.64 + $3.23 |
| done | — | $2.51 |

**$48.02 of $61.52 — 78% of the run — was spent on attempts that failed and had to be redone.**
One failed execution attempt cost $42.48, more than the entire rest of the run combined. That is
`wastedUsd`: real, exact at n=1, and never surfaced anywhere in Orca.

## Two pathologies that look identical today

- **Script Studio** — 21h elapsed, **18h45m one card waiting on him**. The product silently waited.
- **DSL** — 24h58m elapsed, **24h35m unaccounted**: 18 min of agent work, 5 min of human waiting,
  and a full day nobody can account for. That run sat dead and no one knew.

Same "it took a day" symptom, opposite causes, opposite fixes (notify him vs. detect the dead
worker). Today both render identically — which *is* the comprehension failure he described.

## The contamination finding (binding — it changes the screen's central claim)

**The founder's effective n for workflow-quality questions is 1, not 5.**

Measured, not inferred: **14 of the 19 worker deaths in the entire database fall within 40
seconds of a daemon boot** — several at −0s — across three separate days including 2026-07-29.
So **74% of all worker deaths ever recorded are infrastructure kills**, on a mechanism that
needs only a daemon restart to fire. It predates this week; it is not an artifact of running
four agents at once. Every workflow-quality metric over that data is measuring daemon restart
frequency.

Triage=16, finally closed: *the tile is 16 because the daemon killed the worker, and the
failure-mode list is empty because the workflow did nothing wrong. Both halves were telling the
truth about different subjects.*

Termination cause takes **four** values, not three — `completed` / `workflow-failed` /
`infrastructure-killed` / **`unknown`**. The fourth is required because `sessions.exited_at` is
the *watchdog's stamp*, not the death (one row lagged **924 s**), so a death is not always
attributable. Silently bucketing an unattributable death as infrastructure because that is the
common case would manufacture exactly the false confidence this project exists to remove.
Consequence for the read model: **any duration derived from `exited_at` measures detection, not
death.**

Four of his five runs terminated because of an infrastructure defect (Orca's own boot reaper
killing live workers in their spawn window), not because of anything the workflow did. So every
workflow-quality metric computed over those five runs — verification strength, recovery,
first-pass, trajectory — **is measuring the daemon, not the workflow.** The screen would tell
him his workflow is broken when his daemon is, from data that looks perfectly well-formed.

This is the same principle as the zero-event-bound precondition, one level up: those four runs
are not draws from "how my workflow behaves," they are draws from "did the daemon restart
mid-spawn." **Non-random termination contaminates the population exactly as non-random
missingness invalidates a bound.**

Requirements that follow, ahead of most display work:

1. **Classify termination cause as a first-class field** — `completed` / `workflow-failed` /
   `infrastructure-killed`. Without it there is no honest denominator for anything.
2. **Never silently pool infrastructure kills into workflow-quality metrics.** Exclude them, or
   label them inline.
3. **Those four runs are not waste** — they are the sample for an *infrastructure-reliability*
   metric, which the founder should absolutely see, just not on the same axis.
4. **Until (1) exists, the honest headline is that he has ONE run's worth of workflow
   evidence.** Harder message than "5 runs, 4 blocked," and the true one.

## The class of bug, generalized

**An enum value that is read but never written is a predicate that lies to its readers — and it
lies in the safe-looking direction**, because the code reads as though the case is handled.
`sessions.status = 'starting'` was read in 17 places and written in none.

That is the same failure as `opacity: 0.55`: a surface asserting a state it cannot support.
**Audit the metrics read model for its own instances of this** before shipping.

The fix that landed is a **denylist, not a widened allowlist** — exclude terminal statuses
rather than enumerate live ones — on an explicit asymmetry: being wrong in one direction wastes
a tmux session; being wrong in the other destroys a user's work. A new pre-running status can
now leak a pane but can never again get a live agent killed.

Six other readers still carry the un-widened `('running','starting')` set (`server.ts:896`,
`workflows/steps/routes.ts:235`, `orchestrator/service.ts:2342/2408/2525`, plus `service.ts:564`'s
in-memory check). Same defect, blind to a session in its spawn window. Sweep together.

## The line

> **5.8% of that 21-hour run was a model doing work. 86% was Orca waiting on him — 18 of those
> hours at a single confirmation card. It cost $61.52, and $48.35 of that was one step retrying
> three times.**
