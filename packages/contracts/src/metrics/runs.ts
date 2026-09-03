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

export const RunCost = z.object({
  /** Σ over `step_complete` ONLY, all attempts. `mark_done` is a checksum, never an addend. */
  usd: z.number().nonnegative(),
  /** Union of completions that failed or were superseded — the price of the retry loop. */
  wastedUsd: z.number().nonnegative(),
  coverage: z.object({
    reported: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  /** null when no mark_done roll-up exists to check against; false is a real defect. */
  rollupMatchesSum: z.boolean().nullable(),
}).strict();
export type RunCost = z.infer<typeof RunCost>;

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

  status: z.string(),
  blockedReason: z.string().nullable(),
  /** step_launch count − 1: a span launched more than once was restarted. */
  restarts: z.number().int().nonnegative(),
  stallRescues: z.number().int().nonnegative(),

  cost: SpanCost.nullable(),

  tier: VerificationTier.nullable(),
  verifiers: z.object({
    executable: z.boolean(),        // D
    grounding: z.boolean(),         // D
    independentReview: z.boolean(), // O — LLM opinion, mark it distinctly
  }).strict().nullable(),
  /** O — the independent reviewer's verdict, not ground truth. */
  refuteVerdict: z.enum(["upheld", "refuted", "uncertain", "unavailable"]).nullable(),
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

export const RunSummary = z.object({
  runId: z.string(),
  goalId: z.string(),
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
  cost: RunCost,
  stepsDelivered: z.number().int().nonnegative(),
  stepsBlocked: z.number().int().nonnegative(),
  restarts: z.number().int().nonnegative(),
  openInterventions: z.number().int().nonnegative(),
}).strict();
export type RunSummary = z.infer<typeof RunSummary>;

export const RunDetail = z.object({
  run: RunSummary,
  spans: z.array(RunTraceSpan),
  interventions: z.array(Intervention),
}).strict();
export type RunDetail = z.infer<typeof RunDetail>;
