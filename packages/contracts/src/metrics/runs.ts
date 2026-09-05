import { z } from "zod";
import { VerificationTier } from "./index.js";

// ── Run trace projection ─────────────────────────────────────────────────────
// A run is a trace; a step run is a span. Deliberately a NEW wire shape rather
// than a widened `ReplayStep`: that projection drops both ids and three of six
// facets, and is honest about being a compact goal-level audit scroll. See
// docs/superpowers/specs/2026-09-02-run-trace-contract.md.

/**
 * Cost provenance. **Absence is never zero**, and the reason for absence must come
 * from a declaration rather than an inference — `unmetered` ("no capture path
 * exists") and `unreported` ("a channel exists and sent nothing") are the
 * difference between a documented limit and a defect, and inferring either from a
 * missing row would silently reclassify bugs as limits.
 *
 * Two of these are not yet emittable and the projection says so rather than
 * guessing: `measured` vs `estimated` needs `cost.source` on `CostEntry` (the
 * daemon currently collapses provider-authoritative and price-map figures into one
 * `usd`), and `unreported` vs `unmetered` needs the adapter's declared
 * `hookContract()`. Until then the projection emits `reported` and `unknown`, which
 * split into the other four as those land.
 */
export const CostState = z.enum([
  "measured",     // provider reported it and we recorded that it did
  "estimated",    // usage known, priced from the static map
  "reported",     // cost present, provenance not yet recorded — interim for measured|estimated
  "unreported",   // channel exists, provider sent nothing
  "unmetered",    // no capture path exists for this provider
  "unknown",      // absent, and we have not established which of the two above applies
]);
export type CostState = z.infer<typeof CostState>;

export const SpanCost = z.object({
  usd: z.number().nullable(),
  tokensIn: z.number().int().nonnegative().nullable(),
  tokensOut: z.number().int().nonnegative().nullable(),
  /**
   * Summed over the completions that carried them; null when none did. On the live
   * data cache reads outnumber fresh input roughly 300 to 1, and the price map does
   * not price cache — so a span's `usd` cannot be read without knowing how much of
   * its traffic was cache. Null rather than zero: a completion written before the
   * field existed did not have zero cache traffic, it had unrecorded cache traffic.
   */
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheCreationTokens: z.number().int().nonnegative().nullable(),
  state: CostState,
}).strict();
export type SpanCost = z.infer<typeof SpanCost>;

/**
 * A park's meaning inverts with its run's liveness, and the two demand opposite
 * user actions — so the server decides it. `awaiting_you` means the reader is the
 * bottleneck; `abandoned` means the run died holding the card and answering it
 * accomplishes nothing. Never derive this in the UI from run status + open flag.
 */
export const ParkState = z.enum(["awaiting_you", "abandoned", "resolved"]);
export type ParkState = z.infer<typeof ParkState>;

export const InterventionSourceKind = z.enum([
  "question_pending",
  "step_confirmation_pending",
  "gate_decision_pending",
  "mark_done_pending",
  "permission_pending",
  "provider_recovery_pending",
  "unknown",
]);
export type InterventionSourceKind = z.infer<typeof InterventionSourceKind>;

export const Intervention = z.object({
  activityId: z.string(),
  goalId: z.string(),
  workflowRunId: z.string(),
  workflowStepRunId: z.string().nullable(),
  sourceKind: InterventionSourceKind,
  enteredAt: z.string(),
  exitedAt: z.string().nullable(),
  /** ACTUAL age, unclamped and live while open — NOT the clamped value that feeds parkedMs. */
  durationMs: z.number().int().nonnegative(),
  open: z.boolean(),
  parkState: ParkState,
}).strict();
export type Intervention = z.infer<typeof Intervention>;

/**
 * The four durations that must sum: `elapsedMs = workingMs + parkedMs + unaccountedMs`.
 * `spanActiveMs` is reported alongside but deliberately OUTSIDE the sum — parks can
 * occur inside a span, so it overlaps the others.
 */
export const RunDurations = z.object({
  /** First span start → the run's terminal moment; accrues to now only while the RUN is live. */
  elapsedMs: z.number().int().nonnegative(),
  /** Σ telemetry.latency_ms — provider-reported model time. A magnitude, not a placed interval. */
  workingMs: z.number().int().nonnegative(),
  /** Union of MERGED park intervals, clamped to the run's window. Never a sum. */
  parkedMs: z.number().int().nonnegative(),
  /** Residual: dispatch, hooks, sensors, orchestrator turns, and unobserved interior. */
  unaccountedMs: z.number().int().nonnegative(),
  /** Σ span durations. Overlaps the above; excluded from the sum. */
  spanActiveMs: z.number().int().nonnegative(),
  accruing: z.boolean(),
  /** Set when the residual went negative and was floored — the invariant is broken, say so. */
  integrityFlag: z.string().nullable(),
}).strict();
export type RunDurations = z.infer<typeof RunDurations>;

/**
 * The roll-up checksum's own state. Deliberately NOT a nullable boolean: `null`
 * would read identically to "checked and inconclusive", and this is the one field
 * whose entire purpose is honesty about absence.
 */
export const RollupCheck = z.enum([
  "matches",         // Σ step_complete == mark_done's cumulative roll-up
  "diverged",        // they disagree — a completion escaped the roll-up; a real defect
  "not_applicable",  // the run has no mark_done, so there is nothing to check against
]);
export type RollupCheck = z.infer<typeof RollupCheck>;

export const RunCost = z.object({
  /** Σ over `step_complete` ONLY, all attempts. `mark_done` is a checksum, never an addend. */
  usd: z.number().nonnegative(),
  /**
   * Spend that produced nothing the run delivered, split rather than blended —
   * `failedUsd + supersededUsd == wastedUsd`, and a completion lands in exactly one
   * bucket (failure is the stronger claim, so a failed-and-superseded completion
   * counts as failed). They answer different questions and reasonable readers pick
   * different ones, so the contract names both instead of choosing.
   */
  wastedUsd: z.number().nonnegative(),
  /** Completions whose own `outcome.status` is `failed`. The unambiguous half. */
  failedUsd: z.number().nonnegative(),
  /** Completions that SUCCEEDED but were replaced by a later attempt of the same step. */
  supersededUsd: z.number().nonnegative(),
  coverage: z.object({
    reported: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    /**
     * Spans that emitted NO completion at all, so they are absent from
     * `reported`/`total` entirely rather than counted as unreported. A worker gate
     * is exactly this today — it spawns a real agent and reports nothing — which
     * means `usd` is understated by an amount the run cannot state. Falls to 0 on
     * its own once those spans emit, so it needs no regime marker.
     */
    silent: z.number().int().nonnegative(),
  }).strict(),
  rollupCheck: RollupCheck,
}).strict();
export type RunCost = z.infer<typeof RunCost>;

/**
 * Which record a timestamp rests on. Named rather than inferred, so a reader is
 * told what kind of evidence they have instead of being handed a bare instant.
 */
export const ProgressChannel = z.enum([
  "harness_transition",  // an engine-owned boundary — the strongest signal
  "step_boundary",       // a step run started or finished
  "activity_transition", // an activity CHANGED status — a park opening or closing
  "run_event",           // any other run-attributable event (signal only, not progress)
]);
export type ProgressChannel = z.infer<typeof ProgressChannel>;

/**
 * Two clocks, because a run with no open park has two possible realities and one
 * timestamp cannot serve both: nothing is happening (a dead worker), or things
 * are happening and nothing is advancing (a loop).
 *
 * Deliberately no "state" and no staleness threshold. The magnitude does the
 * judging — "last progress 39h ago" needs no constant to be alarming, and a
 * threshold would be a number nobody could defend.
 *
 * NOT derived from `activities.updated_at`, which is the obvious source and the
 * wrong one: a row touched by a retry loop is indistinguishable from a row doing
 * work. On the live stuck run that column moved twice within seconds after 38.6
 * hours of no progress, in an identical state. Progress is defined by append-only
 * state transitions, never by mutation timestamps.
 */
export const RunProgress = z.object({
  /** Last time the run's state actually ADVANCED. Clipped to the run's terminal. */
  lastProgressAt: z.string().nullable(),
  lastProgressChannel: ProgressChannel.nullable(),
  /**
   * Last time ANYTHING run-attributable happened. Defined to include
   * `lastProgressAt`, so `lastSignalAt >= lastProgressAt` holds by construction
   * rather than by coincidence and the pair can never invert.
   */
  lastSignalAt: z.string().nullable(),
  lastSignalChannel: ProgressChannel.nullable(),
  /**
   * False while a step is mid-flight. Only the Stop and PermissionRequest hooks
   * are wired, so an agent working inside a step emits nothing at all — and an old
   * `lastSignalAt` then cannot distinguish "idle" from "working, unobserved".
   * Concluding silence there would assert idleness the record cannot support.
   *
   * A 36-minute gap with no step boundary on a COMPLETED run is the case: the
   * honest reading is "we can't tell from the record what happened in it", not
   * "nothing did".
   */
  silenceConclusive: z.boolean(),
}).strict();
export type RunProgress = z.infer<typeof RunProgress>;

/**
 * One completion of a span, with its own model, cost and outcome. `cost` on the
 * span is the SUM of these and `models` the set; neither can say which attempt
 * was the $42 failure and which the $3 pass, and that attribution is the whole
 * question when a step was redone under a second model.
 *
 * `superseded` mirrors computeCost's rule: a completion is replaced when a later
 * completion exists for the same step template anywhere in the run — a crash
 * relaunch is another span of the same step, and its completion counts.
 */
export const SpanCompletion = z.object({
  at: z.string(),
  model: z.string().nullable(),
  usd: z.number().nullable(),
  outcome: z.string().nullable(),
  failureCode: z.string().nullable(),
  superseded: z.boolean(),
  /**
   * Whether the completion gate judged this completion — it carried an evidence
   * record. The daemon's verdict distribution counts ONLY these, so a surface that
   * derives verdicts from the log must skip the rest or it will count completions
   * the gate never saw as upheld.
   */
  gated: z.boolean(),
}).strict();
export type SpanCompletion = z.infer<typeof SpanCompletion>;

export const RunTraceSpan = z.object({
  workflowRunId: z.string(),
  workflowStepRunId: z.string(),
  goalId: z.string(),
  stepTemplateId: z.string(),
  name: z.string(),
  ordinal: z.number().int(),
  attempt: z.number().int().positive(),
  kind: z.enum(["step", "gate"]),

  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  elapsedMs: z.number().int().nonnegative().nullable(),
  workingMs: z.number().int().nonnegative().nullable(),
  /**
   * Park time that fell INSIDE this span's own window — the overlap of the run's
   * merged park intervals with `[startedAt, finishedAt]`.
   *
   * It was previously forced to 0 on the reasoning that "a park between two spans
   * belongs to neither". That is true and it is not the whole rule: a park can
   * also open and close *within* a span. Live, one Triage span is 78 minutes
   * elapsed with 74.6 of them a confirmation card — forcing 0 pushed all of it
   * into `unaccounted`, so the step row said "unaccounted" about the same minutes
   * the run header called "waiting on you".
   *
   * The overlap computation handles both cases without a special case: a park
   * between spans overlaps none, so it lands in neither, exactly as intended.
   */
  parkedMs: z.number().int().nonnegative().nullable(),

  status: z.string(),
  blockedReason: z.string().nullable(),
  /** step_launch count − 1: a span RE-LAUNCHED. The crash/reap signal. */
  restarts: z.number().int().nonnegative(),
  /** step_complete count. >1 means the revise loop ran — distinct from `restarts`. */
  completions: z.number().int().nonnegative(),
  stallRescues: z.number().int().nonnegative(),

  cost: SpanCost.nullable(),
  /**
   * The distinct models across this span's completions, in order of first use.
   * Which model ran a step is the harness's own decision (operator selection), and
   * it was recorded on every completion's telemetry without ever being projected: a
   * page that names no model describes the workflow and cannot describe the harness.
   *
   * A list rather than one name because `cost` is summed across ALL of a span's
   * completions before it leaves the daemon. A step revised under a different model
   * has one cost and two models, and naming only the last would attribute the whole
   * figure to it. Empty when no completion carried a model.
   */
  models: z.array(z.string()),
  /** Every completion of this span in time order; empty when it never completed. */
  completionLog: z.array(SpanCompletion),

  tier: VerificationTier.nullable(),
  verifiers: z.object({
    executable: z.boolean(),        // D
    grounding: z.boolean(),         // D
    independentReview: z.boolean(), // O — LLM opinion, mark it distinctly
  }).strict().nullable(),
  /** O — the independent reviewer's verdict, not ground truth. */
  refuteVerdict: z.enum(["upheld", "refuted", "uncertain", "unavailable"]).nullable(),
  /**
   * Why the reviewer was called and what it concluded, in its own words. The verdict
   * alone is an opinion with its argument removed; "refuted" without the reason
   * sends the reader to re-derive what the model already wrote down.
   */
  refuteTriggeredBy: z.array(z.enum(["high_risk", "no_oracle", "weak_oracle"])),
  refuteReason: z.string().nullable(),
  /**
   * Why the evidence fell short, from the FINAL completion's evidence record. The
   * coverage matrix shows that nothing executed; this says what was left untested
   * and why the oracle was judged insufficient, which is what decides whether the
   * fix is a sensor or a test. Null when the span never completed.
   */
  evidenceGaps: z.object({
    untestedRegions: z.array(z.string()),
    oracleGaps: z.array(z.string()),
  }).strict().nullable(),
  conflicts: z.array(z.string()),
  outcomeStatus: z.string().nullable(),
  failureCode: z.string().nullable(),
}).strict();
export type RunTraceSpan = z.infer<typeof RunTraceSpan>;

/**
 * Why the run stopped. First-class because **non-random termination contaminates a
 * population the way non-random missingness invalidates a bound**: a run killed by
 * the daemon's own spawn-window reap says nothing about the workflow's quality, and
 * pooling it into first-pass/verification/recovery makes the screen report the
 * daemon while naming the workflow. Workflow-quality metrics must exclude
 * `infrastructure_killed` from the denominator or label it inline — never silently
 * pool. Those runs are a real sample of a different question (infrastructure
 * reliability) and belong there instead.
 */
export const TerminationCause = z.enum([
  "running",                // not terminated yet
  "completed",              // reached its terminal node
  "workflow_failed",        // the workflow's own logic stopped it (veto, guardrail, cap)
  "infrastructure_killed",  // the substrate killed it — worker crash, reap, provider error
  "unknown",                // terminal, but nothing recorded why
]);
export type TerminationCause = z.infer<typeof TerminationCause>;

/**
 * What is waiting on the reader RIGHT NOW, derived server-side.
 *
 * Exists because the obvious client derivation — `terminationCause === "running"
 * && openInterventions > 0` — reconstructs `parkState` from a status and an
 * untyped count, and cannot tell `awaiting_you` from `abandoned`. Every one of the
 * founder's currently-open cards on a DEAD run is `abandoned`; rendering those as
 * actionable sends him to answer cards that accomplish nothing.
 *
 * `count: 0` is an observation ("we checked; nothing is waiting"), not an absence,
 * so this is never null. `sinceMs` needs no run-terminal clip: a park on a dead run
 * is `abandoned` by construction and can never appear here, so the unclipped-clock
 * bug is unreachable rather than guarded against.
 */
export const AwaitingYou = z.object({
  count: z.number().int().nonnegative(),
  /** Age of the longest currently-open one. Null when count is 0. */
  sinceMs: z.number().int().nonnegative().nullable(),
  /**
   * Of that longest one, and read from the EVENT rather than the activities row —
   * the row is mutable and holds the LATEST value, so a reused activity would
   * confidently report a later pause's reason. It is the difference between
   * "Orca is waiting on you", which a reader learns to ignore, and "Orca needs
   * your OK on a step", which they act on.
   */
  sourceKind: InterventionSourceKind.nullable(),
}).strict();
export type AwaitingYou = z.infer<typeof AwaitingYou>;

export const RunSummary = z.object({
  runId: z.string(),
  goalId: z.string(),
  /**
   * Non-nullable: a run cannot outlive its goal. The only hard delete is the
   * workspace purge (`workspaces/usecases.ts`), which drops FK enforcement, deletes
   * the goals, then deletes every FK-violating row transitively and THROWS if any
   * dangling reference survives — so an orphaned run is not a state the database
   * can be left in.
   *
   * It exists because the goal is the noun the reader thinks in ("the Kelvin one")
   * and the template is not: with one template, `templateName` is the largest text
   * on every row and has zero discriminating power.
   */
  goalTitle: z.string(),
  templateId: z.string(),
  templateName: z.string(),
  templateVersion: z.number().int(),
  status: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  blockedReason: z.string().nullable(),
  terminationCause: TerminationCause,
  /** The literal signal the cause was read from — so the classification is auditable. */
  terminationEvidence: z.string().nullable(),
  durations: RunDurations,
  progress: RunProgress,
  cost: RunCost,
  stepsDelivered: z.number().int().nonnegative(),
  stepsBlocked: z.number().int().nonnegative(),
  /**
   * Σ of span `restarts` — a step run RE-LAUNCHED, which is the crash/reap signal.
   * NOT "how many times did this run retry"; that is `retriedCompletions`. The two
   * differ: a step can produce three completions from one launch (the revise loop)
   * or three launches for one completion (crash-retry).
   */
  spanRelaunches: z.number().int().nonnegative(),
  /** Σ of completions beyond the first per span — the revise/re-judge loop's volume. */
  retriedCompletions: z.number().int().nonnegative(),
  openInterventions: z.number().int().nonnegative(),
  awaitingYou: AwaitingYou,
}).strict();
export type RunSummary = z.infer<typeof RunSummary>;

/**
 * One tool-gate decision. The Workflows tab counts these; the reasons the policy
 * gave — "destructive recursive delete", "access to a secret/credential file" —
 * were on the risk facet and never left the daemon. A denial with its reason is a
 * fact about what the agent reached for, and the only such fact the run records.
 */
export const ToolDecision = z.object({
  workflowStepRunId: z.string().nullable(),
  stepName: z.string().nullable(),
  at: z.string(),
  decision: z.enum(["allow", "require_approval", "deny"]),
  riskClass: z.enum(["low", "medium", "high", "critical"]),
  /** The policy's classification reasons, verbatim. */
  reasons: z.array(z.string()),
}).strict();
export type ToolDecision = z.infer<typeof ToolDecision>;

export const RunDetail = z.object({
  run: RunSummary,
  spans: z.array(RunTraceSpan),
  interventions: z.array(Intervention),
  /** Every tool-gate decision on the run, in time order. */
  toolDecisions: z.array(ToolDecision),
}).strict();
export type RunDetail = z.infer<typeof RunDetail>;
