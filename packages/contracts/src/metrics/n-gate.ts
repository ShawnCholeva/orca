// The n-gate rules: when a statistic has earned the right to be shown, and what
// renders below that threshold. Orca's metrics screen lives permanently at small n
// (tens of runs, not millions of requests), where the classic APM patterns mislead:
// a percentile over 4 points, a trend line through 4 points, a version delta from
// 1 run against 3. Pure and display-agnostic — components branch on these predicates
// and never inline an `n` comparison of their own, so the low-n -> high-n transition
// is automatic rather than maintained.
//
// The governing split: FACTS (sums, counts, per-run cost) are exact at n=1 and are
// never gated. ESTIMATES (rates, means, deltas, trends, tails) are claims about runs
// nobody has seen, and every one of them is gated here.

// ---------------------------------------------------------------------------
// Measurement state — why a value isn't a number, organised by REMEDY, which is
// the only axis a reader can act on. Widens the daemon's CalibrationEntry.state
// (`measured | insufficient | unmeasurable`): `unmeasurable` was carrying two
// situations with different remedies, and neither covered a facet that is simply
// never emitted. Never re-derive these in the UI — map state to form, nothing else.
// ---------------------------------------------------------------------------
export const MEASUREMENT_STATES = [
  "measured",                 // at or above the gate; the value stands
  "insufficient",             // wired and running, not enough yet     -> wait for runs
  "unmeasurable_coverage",    // the check ran on too few completions  -> run more checks
  "unmeasurable_structural",  // no independent check exists, ever     -> none; say so
  "uninstrumented",           // the value isn't recorded at all       -> engineering work
] as const;

export type MeasurementState = (typeof MEASUREMENT_STATES)[number];

// `lossy` distinguishes a value that is measured and then dropped from one that was
// never captured. Same remedy class (both owe engineering work) so it stays one state,
// but the urgency differs — a lossy value is being destroyed on every run that
// completes right now — so it gets its own sentence.
export function labelForMeasurementState(
  state: MeasurementState,
  opts?: { needed?: number; checked?: number; of?: number; lossy?: boolean }
): string | null {
  switch (state) {
    case "measured":
      return null;
    case "insufficient":
      return opts?.needed != null
        ? `Not enough runs yet — ${opts.needed} more and this becomes a number.`
        : "Not enough runs yet for this to mean anything.";
    case "unmeasurable_coverage":
      return opts?.checked != null && opts?.of != null
        ? `Only ${opts.checked} of ${opts.of} runs were actually checked — too few to measure.`
        : "Too few of these runs were actually checked to measure this.";
    case "unmeasurable_structural":
      return "Nothing independent can check this — the step is only reporting on itself.";
    case "uninstrumented":
      return opts?.lossy
        ? "This is being measured and then thrown away. It needs a fix before it can show up here."
        : "This isn't being recorded yet.";
  }
}

// ---------------------------------------------------------------------------
// The gate table
// ---------------------------------------------------------------------------
export const GATED_PATTERNS = [
  "fact",
  "runRows",
  "proportion",
  "median",
  "mean",
  "tail",
  "trend",
  "cohortBaseline",
  "statisticalAnomaly",
] as const;

export type GatedPattern = (typeof GATED_PATTERNS)[number];

export type RenderForm =
  | "value"              // the number itself
  | "valueWithSpread"    // the number plus min-max or IQR
  | "valueWithInterval"  // the number plus its uncertainty interval
  | "points"             // every observation, unconnected — no summary statistic
  | "rows"               // the individual runs
  | "outcome"            // a word, not a percentage (n=1)
  | "countWithInterval"  // "3 of 4" plus the interval
  | "rateWithInterval"   // a percentage plus the interval
  | "line"               // a connected trend
  | "worstRun"           // the tail replacement: a fact, not an estimate
  | "ruleThresholds"     // deterministic rules in place of statistical detection
  | "suppress"           // show nothing
  | "none";              // no observations at all — render the MeasurementState

export interface GateVerdict {
  pattern: GatedPattern;
  n: number;
  gate: number | null; // null when the pattern is ungated or unconditionally banned
  meets: boolean;
  form: RenderForm;
}

// Minimum observations before each estimate earns its place.
//   median   5  — below this the "median" is just one of the points; show them all
//   mean     8  — a mean without a spread is misleading either way, so gate it higher
//   trend   12  — a line through fewer points asserts a trajectory nobody can see
//   cohort  20  — per cohort
//   anomaly 30  — a statistical baseline; below it, use fixed rules
// Tails are absent deliberately: a stable p90 needs n>=100 and p95 n>=200
// (n ~ 10/(1-p)), which this product will never have. See gateFor("tail").
export const GATES = {
  median: 5,
  mean: 8,
  trend: 12,
  cohortBaseline: 20,
  statisticalAnomaly: 30,
} as const;

// Proportions are never suppressed — their FORM changes instead, because a rate is
// the one estimate whose uncertainty can be drawn honestly at any n.
export const PROPORTION_RATE_MIN = 5; // below this, lead with the count, not the percentage

export function gateFor(pattern: GatedPattern, n: number): GateVerdict {
  const v = (gate: number | null, meets: boolean, form: RenderForm): GateVerdict => ({
    pattern, n, gate, meets, form,
  });

  switch (pattern) {
    // Facts are exact at n=1. Hedging them is the error the current screen makes.
    case "fact":
      return v(null, true, "value");
    case "runRows":
      return v(null, true, "rows");

    case "proportion":
      if (n <= 0) return v(null, false, "none");
      // A rate over one observation is the observation wearing a percent sign.
      if (n === 1) return v(PROPORTION_RATE_MIN, false, "outcome");
      if (n < PROPORTION_RATE_MIN) return v(PROPORTION_RATE_MIN, false, "countWithInterval");
      return v(PROPORTION_RATE_MIN, true, "rateWithInterval");

    case "median":
      return n >= GATES.median ? v(GATES.median, true, "value") : v(GATES.median, false, "points");
    case "mean":
      return n >= GATES.mean ? v(GATES.mean, true, "valueWithSpread") : v(GATES.mean, false, "points");

    // Banned at every n. The replacement is the worst observed run, which is a fact.
    case "tail":
      return v(null, false, "worstRun");

    case "trend":
      return n >= GATES.trend ? v(GATES.trend, true, "line") : v(GATES.trend, false, "points");
    case "cohortBaseline":
      return n >= GATES.cohortBaseline
        ? v(GATES.cohortBaseline, true, "value")
        : v(GATES.cohortBaseline, false, "suppress");
    case "statisticalAnomaly":
      return n >= GATES.statisticalAnomaly
        ? v(GATES.statisticalAnomaly, true, "value")
        : v(GATES.statisticalAnomaly, false, "ruleThresholds");
  }
}

// ---------------------------------------------------------------------------
// Interval estimation
//
// Wilson for display; the daemon's betaMean stays for SCORING. They are different
// jobs: scoring is a decision under uncertainty and should shrink toward a designed
// prior, but display reports what happened and must let the sample speak. Running
// betaMean(0.5, K=4, 4, 0) gives 0.75 — four passes out of four rendered as 75%,
// which no reader can reconcile against their own count.
//
// Brown, Cai & DasGupta (2001) recommend Wilson or Jeffreys for n<=40. Orca is
// permanently n<=40.
// ---------------------------------------------------------------------------

const Z = 1.959963984540054; // normal 97.5th percentile — two-sided 95%
const ALPHA = 0.05;

export interface ProportionInterval {
  point: number;
  lower: number;
  upper: number;
  n: number;
  // Degenerate samples make a genuinely one-sided claim, so we make it exactly:
  // the bound below IS the number the copy quotes, by construction.
  bound: "two-sided" | "lower" | "upper";
}

// The exact one-sided 95% upper bound on the true rate when nothing was observed:
// 1 - alpha^(1/n) (one-sided Clopper-Pearson). The familiar 3/n "rule of three" is an
// asymptotic approximation to this that overstates badly below n~30 — at n=4 it claims
// 75% where the truth is 53%, and below n=3 it exceeds 1 outright. This product lives
// entirely below n=30, so we never use the approximation.
export function zeroEventUpperBound(n: number): number | null {
  if (n <= 0) return null;
  return 1 - Math.pow(ALPHA, 1 / n);
}

export function proportionInterval(pos: number, neg: number): ProportionInterval | null {
  const n = pos + neg;
  if (n <= 0) return null;
  const x = pos;

  // Nothing passed / nothing failed: report the exact one-sided bound rather than
  // Wilson, which is anti-conservative in this tail (at 0 of 4 it claims an upper
  // bound of 0.49 where the exact bound is 0.53).
  if (x === 0) return { point: 0, lower: 0, upper: zeroEventUpperBound(n)!, n, bound: "upper" };
  if (x === n) return { point: 1, lower: Math.pow(ALPHA, 1 / n), upper: 1, n, bound: "lower" };

  const z2 = Z * Z;
  const center = (x + z2 / 2) / (n + z2);
  const half = (Z / (n + z2)) * Math.sqrt((x * (n - x)) / n + z2 / 4);
  return {
    point: x / n,
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
    n,
    bound: "two-sided",
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface Range { lower: number; upper: number }

// Touching counts as overlapping: a difference of exactly zero is not a difference.
export function rangesOverlap(a: Range, b: Range): boolean {
  return a.lower <= b.upper && b.lower <= a.upper;
}

export const VERSION_DELTA_MIN_PER_SIDE = 5;

// "The delta must exceed the pooled spread" is not encodable as written. This is:
// emit a delta only when both sides are sampled enough AND their uncertainty ranges
// are disjoint. One predicate covers proportions (Wilson intervals) and continuous
// quantities (min-max ranges) alike. Overlapping ranges mean the difference is not
// distinguishable from noise, and the honest render is the two values side by side.
export function deltaAllowed(a: Range & { n: number }, b: Range & { n: number }): boolean {
  if (a.n < VERSION_DELTA_MIN_PER_SIDE || b.n < VERSION_DELTA_MIN_PER_SIDE) return false;
  return !rangesOverlap(a, b);
}

// When uncertainty can no longer change the verdict, drawing it is noise: collapse
// the interval to a plain number. Deliberately decision-relevance and not width — a
// width threshold would be dead code, since at n=100 a 90% rate still carries a
// ~6pp half-width and would never collapse.
export function collapsesToNumber(interval: Range, bandEdges: readonly number[]): boolean {
  return !bandEdges.some((edge) => edge > interval.lower && edge < interval.upper);
}
