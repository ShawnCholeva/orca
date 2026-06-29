// Metrics tab data + helpers. Mock today, behind a getWorkflowMetrics() seam so
// real workflow/step telemetry can replace it later without touching the view.

export type StepStatus = "healthy" | "watch" | "degraded";

export interface FailureMode {
  label: string;
  count: number;
  pct: number;
}

export interface Proposal {
  title: string;
  confidence: number;
  lift: number;
  before: string;
  after: string;
}

export interface StepMetrics {
  name: string;
  score: number;
  status: StepStatus;
  runs: number;
  passed: number;
  recovered: number;
  failed: number;
  latency: string;
  delta: number;
  trend: number[];
  failures: FailureMode[];
  insight: string;
  proposal: Proposal | null;
}

export interface WorkflowMetrics {
  id: string;
  name: string;
  runs: number;
  health: number;
  healthDelta: number;
  firstPass: number;
  firstPassDelta: number;
  recovered: number;
  recoveredDelta: number;
  escalated: number;
  escalatedDelta: number;
  latency: string;
  latencyDelta: number;
  steps: StepMetrics[];
}

export interface LearningLogEntry {
  t: string;
  type: "applied" | "observed" | "proposed" | "reverted";
  text: string;
}

const WORKFLOW_METRICS: WorkflowMetrics[] = [
  {
    id: "wf-brainstorm",
    name: "Brainstorm",
    runs: 318,
    health: 82, healthDelta: 4,
    firstPass: 64, firstPassDelta: 6,
    recovered: 28, recoveredDelta: 5,
    escalated: 8, escalatedDelta: -3,
    latency: "2.4s", latencyDelta: -0.3,
    steps: [
      {
        name: "Define Intent", score: 94, status: "healthy",
        runs: 318, passed: 301, recovered: 12, failed: 5,
        latency: "1.1s", delta: 2,
        trend: [88, 89, 90, 89, 91, 92, 90, 92, 93, 93, 94, 94],
        failures: [
          { label: "Ambiguous prompt not flagged as open question", count: 4, pct: 80 },
          { label: "Audience inferred incorrectly", count: 1, pct: 20 },
        ],
        insight: "Strongest step in the workflow. Open-question detection improved after last instruction tweak; ambiguity now surfaces 96% of the time.",
        proposal: null,
      },
      {
        name: "Define Constraints", score: 88, status: "healthy",
        runs: 318, passed: 279, recovered: 27, failed: 12,
        latency: "1.6s", delta: 1,
        trend: [84, 85, 83, 86, 87, 86, 88, 87, 88, 89, 88, 88],
        failures: [
          { label: "Missed a soft constraint present in Goal memory", count: 7, pct: 58 },
          { label: "Hard / soft misclassification", count: 3, pct: 25 },
          { label: "Did not flag conflicting constraints", count: 2, pct: 17 },
        ],
        insight: "Healthy, but recall of soft constraints from durable memory dips when memory exceeds ~20 entries. Candidate for a retrieval re-rank.",
        proposal: null,
      },
      {
        name: "Generate Proposal", score: 79, status: "watch",
        runs: 311, passed: 214, recovered: 71, failed: 26,
        latency: "4.2s", delta: -3,
        trend: [86, 85, 84, 82, 83, 81, 80, 82, 79, 80, 78, 79],
        failures: [
          { label: "Violates a hard constraint on first attempt", count: 16, pct: 62 },
          { label: "Proposal not falsifiable / too vague", count: 7, pct: 27 },
          { label: "Tradeoff section omitted", count: 3, pct: 11 },
        ],
        insight: "Most retries in the workflow originate here. When a hard constraint is violated, the retry prompt does not include which constraint failed — so the model often repeats the mistake.",
        proposal: {
          title: "Inject failed-constraint feedback into the retry prompt",
          confidence: 77, lift: 9,
          before: "Produce a single proposal that satisfies all hard constraints.",
          after: "Produce a single proposal that satisfies all hard constraints. On retry, the constraints you previously violated are listed below — address each explicitly.",
        },
      },
      {
        name: "Verify Proposal", score: 61, status: "degraded",
        runs: 382, passed: 188, recovered: 96, failed: 98,
        latency: "3.0s", delta: -7,
        trend: [74, 72, 71, 70, 68, 67, 66, 64, 63, 62, 60, 61],
        failures: [
          { label: "Inconclusive verdict — no evidence cited", count: 53, pct: 54 },
          { label: "False pass (constraint actually violated)", count: 31, pct: 32 },
          { label: "Looped >2x without converging", count: 14, pct: 14 },
        ],
        insight: "The weakest step and the source of most escalations. Verdicts are returned without evidence 1 in 3 times, and false passes are trending up (8% to 12% this week). This silently lets bad proposals through to Store Memory.",
        proposal: {
          title: "Require per-constraint evidence and cap retries at 2",
          confidence: 91, lift: 21,
          before: "Check the proposal against every hard constraint. Return pass / fail / inconclusive.",
          after: "For EACH hard constraint, quote the exact proposal text that satisfies it before returning pass. If no evidence exists, return fail (never inconclusive). After 2 failed loops, escalate to a human.",
        },
      },
      {
        name: "Critique Proposal", score: 90, status: "healthy",
        runs: 281, passed: 262, recovered: 14, failed: 5,
        latency: "2.7s", delta: 3,
        trend: [85, 86, 87, 86, 88, 88, 89, 89, 90, 89, 90, 90],
        failures: [
          { label: "Surfaced risks already covered by constraints", count: 3, pct: 60 },
          { label: "No cheap validation suggested", count: 2, pct: 40 },
        ],
        insight: "Reliable. Counter-arguments are rated useful by reviewers 90% of the time. Slight redundancy with the constraints step — low priority.",
        proposal: null,
      },
      {
        name: "Store Memory", score: 96, status: "healthy",
        runs: 274, passed: 268, recovered: 5, failed: 1,
        latency: "0.6s", delta: 4,
        trend: [82, 85, 88, 90, 91, 93, 94, 95, 95, 96, 96, 96],
        failures: [
          { label: "Reference link to source constraint missing", count: 1, pct: 100 },
        ],
        insight: "Best-performing step. The dedup rule applied 2 days ago cut duplicate memory writes by 94% — see learning log.",
        proposal: null,
      },
    ],
  },
  {
    id: "wf-cutover",
    name: "Shadow-then-cutover",
    runs: 41,
    health: 88, healthDelta: 2,
    firstPass: 71, firstPassDelta: 4,
    recovered: 22, recoveredDelta: -1,
    escalated: 7, escalatedDelta: -2,
    latency: "—", latencyDelta: 0,
    steps: [
      {
        name: "Plan migration", score: 92, status: "healthy",
        runs: 41, passed: 39, recovered: 2, failed: 0, latency: "6.1s", delta: 1,
        trend: [88, 89, 90, 90, 91, 91, 92, 92, 91, 92, 92, 92],
        failures: [{ label: "Underestimated blast radius", count: 0, pct: 0 }],
        insight: "Plans consistently identify the right repos and gates. No failures this period.",
        proposal: null,
      },
      {
        name: "Double-write shadow", score: 90, status: "healthy",
        runs: 41, passed: 38, recovered: 3, failed: 0, latency: "—", delta: 2,
        trend: [85, 86, 87, 88, 88, 89, 89, 90, 90, 89, 90, 90],
        failures: [{ label: "Shadow window ended early", count: 2, pct: 100 }],
        insight: "Healthy. Self-recovered both early-termination cases by extending the window automatically.",
        proposal: null,
      },
      {
        name: "Delta validate", score: 74, status: "watch",
        runs: 41, passed: 28, recovered: 9, failed: 4, latency: "—", delta: -4,
        trend: [82, 81, 80, 79, 78, 77, 76, 75, 74, 75, 73, 74],
        failures: [
          { label: "Sub-cent rounding drift flagged as failure", count: 9, pct: 69 },
          { label: "Alarm threshold too sensitive", count: 4, pct: 31 },
        ],
        insight: "Too many false alarms on sub-cent drift — the same pattern QA-1 logged as a learning. Threshold is stricter than the proration-parity constraint requires.",
        proposal: {
          title: "Loosen delta alarm to the $0.01 parity tolerance",
          confidence: 84, lift: 12,
          before: "Alarm on any non-zero delta between v1 and v3 outputs.",
          after: "Alarm only when |delta| exceeds the proration-parity tolerance ($0.01). Log sub-cent drift as informational.",
        },
      },
      {
        name: "Flag cutover", score: 95, status: "healthy",
        runs: 38, passed: 37, recovered: 1, failed: 0, latency: "0.4s", delta: 1,
        trend: [90, 91, 92, 93, 93, 94, 94, 95, 95, 94, 95, 95],
        failures: [{ label: "Flag flip ordering", count: 0, pct: 0 }],
        insight: "Clean. Gated flag flips have not regressed since the workflow was adopted.",
        proposal: null,
      },
      {
        name: "Decommission", score: 86, status: "healthy",
        runs: 34, passed: 31, recovered: 2, failed: 1, latency: "—", delta: 2,
        trend: [80, 81, 82, 83, 84, 84, 85, 85, 86, 86, 85, 86],
        failures: [{ label: "Removed a path still referenced by a consumer", count: 1, pct: 100 }],
        insight: "Solid, but one premature removal — recommends a reference check before deleting legacy paths.",
        proposal: null,
      },
    ],
  },
  {
    id: "wf-review",
    name: "Review gate",
    runs: 156,
    health: 71, healthDelta: -2,
    firstPass: 58, firstPassDelta: -4,
    recovered: 24, recoveredDelta: 2,
    escalated: 18, escalatedDelta: 5,
    latency: "1.9s", latencyDelta: 0.2,
    steps: [
      {
        name: "Diff scan", score: 89, status: "healthy",
        runs: 156, passed: 144, recovered: 9, failed: 3, latency: "2.2s", delta: 1,
        trend: [86, 87, 86, 88, 88, 89, 88, 89, 90, 89, 89, 89],
        failures: [
          { label: "Missed change in generated file", count: 2, pct: 67 },
          { label: "Binary diff skipped silently", count: 1, pct: 33 },
        ],
        insight: "Coverage is strong. Generated-file changes occasionally slip through — minor.",
        proposal: null,
      },
      {
        name: "Risk classify", score: 58, status: "degraded",
        runs: 156, passed: 71, recovered: 38, failed: 47, latency: "1.4s", delta: -6,
        trend: [70, 69, 67, 66, 64, 63, 62, 60, 59, 58, 57, 58],
        failures: [
          { label: "Severity over-stated (low flagged as medium)", count: 28, pct: 60 },
          { label: "Security-relevant change rated low", count: 12, pct: 26 },
          { label: "No rationale attached to severity", count: 7, pct: 14 },
        ],
        insight: "Drives the spike in human escalations. Over-flags low-risk diffs, eroding reviewer trust, while still under-rating a few security-relevant changes. Calibration is off in both directions.",
        proposal: {
          title: "Anchor severity to labelled examples + require rationale",
          confidence: 88, lift: 18,
          before: "Classify each finding by severity (low / medium / high).",
          after: "Classify severity against the 12 labelled reference findings. Attach a one-line rationale citing the specific risk. Default security-touching changes to at least medium.",
        },
      },
      {
        name: "Suggest mitigation", score: 83, status: "healthy",
        runs: 118, passed: 104, recovered: 10, failed: 4, latency: "2.0s", delta: 2,
        trend: [78, 79, 80, 81, 81, 82, 82, 83, 83, 82, 83, 83],
        failures: [{ label: "Mitigation not applicable to codebase", count: 4, pct: 100 }],
        insight: "Good. Suggestions are accepted by reviewers ~83% of the time.",
        proposal: null,
      },
      {
        name: "Gate decision", score: 76, status: "watch",
        runs: 118, passed: 89, recovered: 18, failed: 11, latency: "0.5s", delta: -1,
        trend: [80, 79, 79, 78, 77, 78, 76, 77, 76, 75, 76, 76],
        failures: [
          { label: "Blocked merge a human later approved", count: 7, pct: 64 },
          { label: "Passed a finding marked high", count: 4, pct: 36 },
        ],
        insight: "Inherits miscalibration from Risk classify — fixing the upstream step should lift this one too.",
        proposal: null,
      },
    ],
  },
];

const LEARNING_LOG: LearningLogEntry[] = [
  { t: "2d ago", type: "applied", text: "Tightened Store Memory dedup rule → duplicate writes −94%." },
  { t: "19h ago", type: "observed", text: "Verify Proposal false-pass rate climbing: 8% → 12% over 7 days." },
  { t: "6h ago", type: "proposed", text: "Drafted per-constraint evidence requirement for Verify Proposal." },
  { t: "3h ago", type: "reverted", text: "Rolled back Critique verbosity change — no measurable lift." },
  { t: "1h ago", type: "observed", text: "Risk classify over-flagging correlates with reviewer override rate." },
];

export function getWorkflowMetrics(): WorkflowMetrics[] {
  return WORKFLOW_METRICS;
}

export function getLearningLog(): LearningLogEntry[] {
  return LEARNING_LOG;
}

export const statusMeta: Record<StepStatus, { tone: "run" | "warn" | "err"; color: string; label: string }> = {
  healthy: { tone: "run", color: "var(--run)", label: "Healthy" },
  watch: { tone: "warn", color: "var(--warn)", label: "Watch" },
  degraded: { tone: "err", color: "var(--err)", label: "Degraded" },
};

export function gradeFor(score: number): "A" | "B" | "C" | "D" | "F" {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
}
