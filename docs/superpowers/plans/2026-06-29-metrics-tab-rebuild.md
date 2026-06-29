# Metrics Tab Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the desktop app's "Runtime Diagnostics" Metrics tab with a faithful port of the approved design mock — a step-performance + self-teaching-loop operational console driven by mock data behind a real-data seam.

**Architecture:** New feature folder `apps/desktop/src/metrics/` following the existing per-feature pattern (`workspaces/`, `workflows/`). A typed mock module (`metrics-data.ts`) sits behind `getWorkflowMetrics()`/`getLearningLog()` so real telemetry can replace it later without touching the view. Presentational components use inline styles with the app's existing CSS tokens — the same convention as `workspaces/primitives.tsx` (which we reuse for `Btn`/`Pill`). `App.tsx`'s Metrics tab body is swapped to `<MetricsPage />` and the now-dead diagnostics fetch is removed.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest + @testing-library/react. Design tokens from `apps/desktop/src/theme/themes.ts`. No new runtime dependencies.

## Global Constraints

- **Tokens only** — colors must use existing CSS custom properties: `--panel`, `--panel-2`, `--raised`, `--hairline`, `--hairline-strong`, `--text`, `--text-2`, `--text-3`, `--text-4`, `--accent` (#5B8CFF), `--accent-hover`, `--accent-soft`, `--accent-line`, `--accent-2` (#8B5CF6), `--run`/`--run-soft` (healthy/green), `--warn`/`--warn-soft` (watch/amber), `--err`/`--err-soft` (degraded/red), `--info`/`--info-soft`. No new color literals except white `#FFFFFF` and the `rgba(255,255,255,…)` hairline overlays already used by `primitives.tsx`.
- **Uppercase mono kickers/labels** — `className="mono"`, ~10px, letter-spacing ~1.1, `textTransform: "uppercase"`.
- **Dark-theme-first, hairline borders, 10–14px radii. No gradients beyond the accent pair. No emoji.**
- **Reuse, don't hand-roll chrome** — import `Btn`, `Pill` from `../workspaces/primitives`. Add a local `Panel` (none exists app-wide).
- **Inline styles using tokens** — match `primitives.tsx`; do NOT introduce a CSS-class styling layer. The only global CSS relied on is already present in `theme.css` (`.mono`, `.scroll`, `@keyframes float-in`, `@keyframes pulse-dot`). No `metrics.css` is created.
- **Tab label stays "Metrics"**; the internal `activeTab` key `"reasoning"` is left unchanged.
- **Data seam** — no view component may read mock literals directly; all data comes through `getWorkflowMetrics()` / `getLearningLog()`.
- **TDD + frequent commits.** Run `pnpm --filter @orca/desktop test` for tests, `pnpm --filter @orca/desktop typecheck` (or `tsc -b`) and lint before final commit.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/desktop/src/metrics/metrics-data.ts` | Types (`WorkflowMetrics`, `StepMetrics`, `FailureMode`, `Proposal`, `LearningLogEntry`, `StepStatus`), the mock `WORKFLOW_METRICS` + `LEARNING_LOG`, the `getWorkflowMetrics()`/`getLearningLog()` seam, and helpers `statusMeta`, `gradeFor`. |
| `apps/desktop/src/metrics/metrics-icons.tsx` | The ~9 stroke icons the view needs (`ChevronRight`, `ChevronDown`, `ChevronLeft`, `Check`, `Close`, `Sparkle`, `Spark`, `Filter`, `Workflow`). |
| `apps/desktop/src/metrics/metrics-charts.tsx` | Small presentational atoms: `Panel`, `SectionLabel`, `Sparkline`, `Delta`, `OutcomeBar`, `StatTile`. |
| `apps/desktop/src/metrics/StepPerformance.tsx` | `WorkflowDropdown`, `StepRow`, and the step-performance `Panel` body. |
| `apps/desktop/src/metrics/SelfImprovement.tsx` | `ImprovementCard`, `ProposalModal`, `LearningLogRow`, `AutoApplyToggle`, and the rail container. |
| `apps/desktop/src/metrics/MetricsPage.tsx` | Top-level view: owns selected-workflow / period / open-step state, two-column layout, composes the left column + right rail. |
| `apps/desktop/src/metrics/MetricsPage.test.tsx` | Behavior tests. |
| `apps/desktop/src/App.tsx` (modify) | Swap the `reasoning` tab body to `<MetricsPage />`; remove dead diagnostics code. |

---

### Task 1: Data module + helpers

**Files:**
- Create: `apps/desktop/src/metrics/metrics-data.ts`
- Test: `apps/desktop/src/metrics/metrics-data.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Types: `StepStatus = "healthy" | "watch" | "degraded"`; `FailureMode = { label: string; count: number; pct: number }`; `Proposal = { title: string; confidence: number; lift: number; before: string; after: string }`; `StepMetrics = { name: string; score: number; status: StepStatus; runs: number; passed: number; recovered: number; failed: number; latency: string; delta: number; trend: number[]; failures: FailureMode[]; insight: string; proposal: Proposal | null }`; `WorkflowMetrics = { id: string; name: string; runs: number; health: number; healthDelta: number; firstPass: number; firstPassDelta: number; recovered: number; recoveredDelta: number; escalated: number; escalatedDelta: number; latency: string; latencyDelta: number; steps: StepMetrics[] }`; `LearningLogEntry = { t: string; type: "applied" | "observed" | "proposed" | "reverted"; text: string }`.
  - `getWorkflowMetrics(): WorkflowMetrics[]`
  - `getLearningLog(): LearningLogEntry[]`
  - `statusMeta: Record<StepStatus, { tone: "run" | "warn" | "err"; color: string; label: string }>`
  - `gradeFor(score: number): "A" | "B" | "C" | "D" | "F"`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/metrics/metrics-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getWorkflowMetrics, getLearningLog, gradeFor, statusMeta } from "./metrics-data";

describe("metrics-data", () => {
  it("returns at least three workflows, each with steps", () => {
    const wfs = getWorkflowMetrics();
    expect(wfs.length).toBeGreaterThanOrEqual(3);
    for (const wf of wfs) {
      expect(wf.steps.length).toBeGreaterThan(0);
    }
  });

  it("exposes a learning log with known event types", () => {
    const log = getLearningLog();
    expect(log.length).toBeGreaterThan(0);
    for (const e of log) {
      expect(["applied", "observed", "proposed", "reverted"]).toContain(e.type);
    }
  });

  it("grades by score boundaries", () => {
    expect(gradeFor(95)).toBe("A");
    expect(gradeFor(85)).toBe("B");
    expect(gradeFor(75)).toBe("C");
    expect(gradeFor(65)).toBe("D");
    expect(gradeFor(40)).toBe("F");
  });

  it("maps every status to a tone", () => {
    expect(statusMeta.healthy.tone).toBe("run");
    expect(statusMeta.watch.tone).toBe("warn");
    expect(statusMeta.degraded.tone).toBe("err");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- metrics-data`
Expected: FAIL — cannot resolve `./metrics-data`.

- [ ] **Step 3: Write the data module**

Create `apps/desktop/src/metrics/metrics-data.ts`. Port the mock's `WORKFLOW_METRICS` and `LEARNING_LOG` verbatim (values below), add types and the seam. (Data values are the canonical mock content — copy exactly.)

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/desktop test -- metrics-data`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics/metrics-data.ts apps/desktop/src/metrics/metrics-data.test.ts
git commit -m "feat(metrics): typed mock data module behind getWorkflowMetrics seam"
```

---

### Task 2: Icons + chart atoms

**Files:**
- Create: `apps/desktop/src/metrics/metrics-icons.tsx`
- Create: `apps/desktop/src/metrics/metrics-charts.tsx`
- Test: `apps/desktop/src/metrics/metrics-charts.test.tsx`

**Interfaces:**
- Consumes: `gradeFor` (Task 1) is NOT used here; atoms are data-shape-agnostic.
- Produces:
  - From `metrics-icons.tsx`: `ChevronRight`, `ChevronDown`, `ChevronLeft`, `Check`, `Close`, `Sparkle`, `Spark`, `Filter`, `Workflow` — each `(props: { size?: number; color?: string; style?: CSSProperties }) => ReactElement`.
  - From `metrics-charts.tsx`: `Panel({ title?, kicker?, right?, children, style?, bodyStyle?, bodyClassName? })`; `SectionLabel({ children, style? })`; `Sparkline({ data, color?, w?, h? })`; `Delta({ value, good?, suffix?, size? })` where `good?: "up" | "down"`; `OutcomeBar({ passed, recovered, failed, height? })`; `StatTile({ label, value, unit?, delta?, deltaGood?, deltaSuffix?, accent?, spark?, sparkColor?, grade? })`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/metrics/metrics-charts.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Delta, OutcomeBar, StatTile } from "./metrics-charts";

describe("Delta", () => {
  it("renders ±0 in neutral form for zero", () => {
    render(<Delta value={0} />);
    expect(screen.getByText("±0")).toBeInTheDocument();
  });

  it("uses run color when an up move is good", () => {
    const { container } = render(<Delta value={5} good="up" />);
    const el = container.querySelector("span");
    expect(el?.getAttribute("style")).toContain("var(--run)");
  });

  it("uses err color when an up move is bad", () => {
    const { container } = render(<Delta value={5} good="down" />);
    const el = container.querySelector("span");
    expect(el?.getAttribute("style")).toContain("var(--err)");
  });
});

describe("StatTile", () => {
  it("renders label, value and grade", () => {
    render(<StatTile label="Workflow health" value={82} grade="B" accent="var(--run)" delta={4} />);
    expect(screen.getByText("Workflow health")).toBeInTheDocument();
    expect(screen.getByText("82")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });
});

describe("OutcomeBar", () => {
  it("renders without crashing for all-zero input", () => {
    const { container } = render(<OutcomeBar passed={0} recovered={0} failed={0} />);
    expect(container.firstChild).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- metrics-charts`
Expected: FAIL — cannot resolve `./metrics-charts`.

- [ ] **Step 3a: Write the icons**

Create `apps/desktop/src/metrics/metrics-icons.tsx`. (Paths copied from the mock's `ui.jsx` icon set.)

```tsx
import type { CSSProperties, ReactElement, ReactNode } from "react";

interface IconProps {
  size?: number;
  color?: string;
  style?: CSSProperties;
}

function svg(path: ReactNode) {
  return function IconCmp({ size = 16, color = "currentColor", style }: IconProps): ReactElement {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={style}
        aria-hidden="true"
      >
        {path}
      </svg>
    );
  };
}

export const ChevronRight = svg(<path d="M9 6l6 6-6 6" />);
export const ChevronDown = svg(<path d="M6 9l6 6 6-6" />);
export const ChevronLeft = svg(<path d="M15 6l-6 6 6 6" />);
export const Check = svg(<path d="M5 12l4.5 4.5L19 7" />);
export const Close = svg(<><path d="M6 6l12 12" /><path d="M18 6l-12 12" /></>);
export const Sparkle = svg(
  <><path d="M12 3v4" /><path d="M12 17v4" /><path d="M3 12h4" /><path d="M17 12h4" /><path d="M5.5 5.5l2.8 2.8" /><path d="M15.7 15.7l2.8 2.8" /><path d="M5.5 18.5l2.8-2.8" /><path d="M15.7 8.3l2.8-2.8" /></>
);
export const Spark = svg(<path d="M3 17l5-6 4 3 4-7 5 5" />);
export const Filter = svg(<path d="M3 5h18l-7 9v5l-4 2v-7L3 5z" />);
export const Workflow = svg(
  <><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="3" width="6" height="6" rx="1" /><rect x="9" y="15" width="6" height="6" rx="1" /><path d="M6 9v3h12V9" /><path d="M12 12v3" /></>
);
```

- [ ] **Step 3b: Write the chart atoms**

Create `apps/desktop/src/metrics/metrics-charts.tsx`. (Ported from the mock; inline styles + tokens, the `Math.random` gradient id replaced with React's `useId` for SSR/test stability.)

```tsx
import { useId, type CSSProperties, type ReactElement, type ReactNode } from "react";

export function Panel({
  title,
  kicker,
  right,
  children,
  style,
  bodyStyle,
  bodyClassName,
}: {
  title?: string;
  kicker?: string;
  right?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  bodyClassName?: string;
}) {
  return (
    <section
      style={{
        background: "var(--panel)",
        border: "1px solid var(--hairline)",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        minHeight: 0,
        ...style,
      }}
    >
      {(title || right) && (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderBottom: "1px solid var(--hairline)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
            {kicker && (
              <span className="mono" style={{ color: "var(--text-3)", fontSize: 10.5, letterSpacing: 1.2, textTransform: "uppercase" }}>
                {kicker}
              </span>
            )}
            {title && (
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)", letterSpacing: -0.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {title}
              </h3>
            )}
          </div>
          {right && <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>{right}</div>}
        </header>
      )}
      <div className={bodyClassName} style={{ flex: 1, minHeight: 0, ...bodyStyle }}>
        {children}
      </div>
    </section>
  );
}

export function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      className="mono"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: 10.5,
        letterSpacing: 1.4,
        textTransform: "uppercase",
        color: "var(--text-3)",
        fontWeight: 600,
        padding: "4px 0",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Sparkline({ data, color = "var(--text-2)", w = 76, h = 26 }: { data: number[]; color?: string; w?: number; h?: number }): ReactElement {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (w - 2) + 1;
    const y = h - 2 - ((v - min) / span) * (h - 4);
    return [x, y] as const;
  });
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
  const last = pts[pts.length - 1];
  const gid = useId().replace(/:/g, "");
  return (
    <svg width={w} height={h} style={{ display: "block", flexShrink: 0 }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.2" fill={color} />
    </svg>
  );
}

export function Delta({ value, good = "up", suffix = "", size = 11 }: { value: number | null; good?: "up" | "down"; suffix?: string; size?: number }): ReactElement {
  if (value === 0 || value == null) {
    return <span className="mono" style={{ fontSize: size, color: "var(--text-4)" }}>±0{suffix}</span>;
  }
  const up = value > 0;
  const isGood = (good === "up" && up) || (good === "down" && !up);
  const color = isGood ? "var(--run)" : "var(--err)";
  const arrow = up ? "▲" : "▼";
  return (
    <span className="mono" style={{ fontSize: size, color, display: "inline-flex", alignItems: "center", gap: 3 }}>
      <span style={{ fontSize: size - 3 }}>{arrow}</span>
      {`${up ? "+" : ""}${value}${suffix}`}
    </span>
  );
}

export function OutcomeBar({ passed, recovered, failed, height = 7 }: { passed: number; recovered: number; failed: number; height?: number }) {
  const total = passed + recovered + failed || 1;
  const seg = (n: number, c: string) =>
    n > 0 ? <div style={{ width: `${(n / total) * 100}%`, background: c, height: "100%" }} /> : null;
  return (
    <div style={{ display: "flex", width: "100%", height, borderRadius: 999, overflow: "hidden", background: "rgba(255,255,255,0.05)" }}>
      {seg(passed, "var(--run)")}
      {seg(recovered, "var(--warn)")}
      {seg(failed, "var(--err)")}
    </div>
  );
}

export function StatTile({
  label,
  value,
  unit,
  delta,
  deltaGood = "up",
  deltaSuffix = "",
  accent,
  spark,
  sparkColor,
  grade,
}: {
  label: string;
  value: number | string;
  unit?: string;
  delta?: number;
  deltaGood?: "up" | "down";
  deltaSuffix?: string;
  accent?: string;
  spark?: number[];
  sparkColor?: string;
  grade?: string;
}) {
  return (
    <div style={{ flex: 1, minWidth: 0, background: "var(--panel)", border: "1px solid var(--hairline)", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span className="mono" style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: "var(--text-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
        {delta !== undefined && <Delta value={delta} good={deltaGood} suffix={deltaSuffix} />}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span style={{ fontSize: 26, fontWeight: 600, letterSpacing: -0.5, color: accent || "var(--text)", lineHeight: 1 }}>{value}</span>
          {unit && <span className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>{unit}</span>}
          {grade && (
            <span style={{ marginLeft: 4, fontSize: 12, fontWeight: 700, color: accent, border: `1px solid ${accent}`, borderRadius: 5, padding: "1px 6px", lineHeight: 1.3 }}>{grade}</span>
          )}
        </div>
        {spark && <Sparkline data={spark} color={sparkColor || "var(--text-3)"} w={64} h={24} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/desktop test -- metrics-charts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics/metrics-icons.tsx apps/desktop/src/metrics/metrics-charts.tsx apps/desktop/src/metrics/metrics-charts.test.tsx
git commit -m "feat(metrics): icons + chart atoms (Sparkline, Delta, OutcomeBar, StatTile, Panel)"
```

---

### Task 3: Step performance (dropdown + expandable rows)

**Files:**
- Create: `apps/desktop/src/metrics/StepPerformance.tsx`
- Test: `apps/desktop/src/metrics/StepPerformance.test.tsx`

**Interfaces:**
- Consumes: `WorkflowMetrics`, `StepMetrics`, `statusMeta` (Task 1); `Panel`, `SectionLabel`, `Sparkline`, `Delta`, `OutcomeBar` (Task 2); `Pill` from `../workspaces/primitives`; icons (Task 2).
- Produces:
  - `WorkflowDropdown({ workflows, value, onChange }: { workflows: WorkflowMetrics[]; value: string; onChange: (id: string) => void })`
  - `StepRow({ step, index, isLast, open, onToggle }: { step: StepMetrics; index: number; isLast: boolean; open: boolean; onToggle: () => void })`
  - `StepPerformancePanel({ wf, openStep, onToggleStep }: { wf: WorkflowMetrics; openStep: string | null; onToggleStep: (name: string) => void })`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/metrics/StepPerformance.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getWorkflowMetrics } from "./metrics-data";
import { StepPerformancePanel, WorkflowDropdown } from "./StepPerformance";

const wfs = getWorkflowMetrics();

describe("StepPerformancePanel", () => {
  it("lists every step name for the workflow", () => {
    render(<StepPerformancePanel wf={wfs[0]} openStep={null} onToggleStep={() => {}} />);
    for (const s of wfs[0].steps) {
      expect(screen.getByText(s.name)).toBeInTheDocument();
    }
  });

  it("shows failure modes and the insight only for the open step", () => {
    const verify = wfs[0].steps.find((s) => s.name === "Verify Proposal")!;
    render(<StepPerformancePanel wf={wfs[0]} openStep="Verify Proposal" onToggleStep={() => {}} />);
    expect(screen.getByText(verify.failures[0].label)).toBeInTheDocument();
    expect(screen.getByText(verify.insight)).toBeInTheDocument();
  });

  it("fires onToggleStep with the clicked step name", () => {
    const onToggle = vi.fn();
    render(<StepPerformancePanel wf={wfs[0]} openStep={null} onToggleStep={onToggle} />);
    fireEvent.click(screen.getByText("Define Intent"));
    expect(onToggle).toHaveBeenCalledWith("Define Intent");
  });
});

describe("WorkflowDropdown", () => {
  it("opens the menu and selects another workflow", () => {
    const onChange = vi.fn();
    render(<WorkflowDropdown workflows={wfs} value={wfs[0].id} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Brainstorm/ }));
    fireEvent.click(screen.getByText("Review gate"));
    expect(onChange).toHaveBeenCalledWith("wf-review");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- StepPerformance`
Expected: FAIL — cannot resolve `./StepPerformance`.

- [ ] **Step 3: Write the component**

Create `apps/desktop/src/metrics/StepPerformance.tsx`. (Ported from the mock. **Fix folded in:** the expanded detail renders a single-column failure-modes/insight block — no `proposal ? "1fr 1fr"` empty column.)

```tsx
import { useEffect, useRef, useState } from "react";
import { Pill } from "../workspaces/primitives";
import { statusMeta, type StepMetrics, type WorkflowMetrics } from "./metrics-data";
import { Delta, OutcomeBar, Panel, SectionLabel, Sparkline } from "./metrics-charts";
import { ChevronDown, ChevronRight, Check, Filter, Sparkle, Workflow } from "./metrics-icons";

const GRID = "34px minmax(0,1fr) 88px 64px 56px 22px";

export function WorkflowDropdown({ workflows, value, onChange }: { workflows: WorkflowMetrics[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = workflows.find((w) => w.id === value) ?? workflows[0];
  const curAtt = cur.steps.filter((s) => s.status !== "healthy").length;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); window.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          background: open ? "var(--accent-soft)" : "rgba(255,255,255,0.03)",
          border: `1px solid ${open ? "var(--accent-line)" : "var(--hairline)"}`,
          color: "var(--text)", borderRadius: 8, padding: "5px 9px 5px 11px",
          cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 500, minWidth: 200,
        }}
      >
        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cur.name}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{cur.steps.length} steps</span>
        {curAtt > 0 && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--warn)", flexShrink: 0 }} />}
        <ChevronDown size={13} color="var(--text-3)" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 120ms ease" }} />
      </button>

      {open && (
        <div
          className="scroll"
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 30,
            minWidth: 260, maxHeight: 320, overflow: "auto",
            background: "var(--panel)", border: "1px solid var(--hairline-strong)",
            borderRadius: 10, boxShadow: "0 16px 48px rgba(0,0,0,0.5)", padding: 4,
            animation: "float-in 120ms ease",
          }}
        >
          {workflows.map((w) => {
            const active = w.id === value;
            const att = w.steps.filter((s) => s.status !== "healthy").length;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => { onChange(w.id); setOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: 9, width: "100%",
                  background: active ? "var(--accent-soft)" : "transparent",
                  border: "none", borderRadius: 7, padding: "8px 10px", cursor: "pointer",
                  fontFamily: "inherit", textAlign: "left",
                }}
              >
                <Workflow size={13} color={active ? "var(--accent)" : "var(--text-3)"} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, color: active ? "var(--accent)" : "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.name}</span>
                {att > 0 && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--warn)", flexShrink: 0 }} />}
                <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", flexShrink: 0 }}>{w.steps.length}</span>
                {active && <Check size={13} color="var(--accent)" style={{ flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function StepRow({ step, index, isLast, open, onToggle }: { step: StepMetrics; index: number; isLast: boolean; open: boolean; onToggle: () => void }) {
  const m = statusMeta[step.status];
  const failures = step.failures.filter((f) => f.count > 0);
  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--hairline)" }}>
      <div
        onClick={onToggle}
        style={{ display: "grid", gridTemplateColumns: GRID, alignItems: "center", gap: 12, padding: "12px 14px", cursor: "pointer" }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0, border: `1px solid ${m.color}`, background: `color-mix(in srgb, ${m.color} 12%, transparent)`, color: m.color, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 600 }}>
            {String(index + 1).padStart(2, "0")}
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{step.name}</span>
            <Pill tone={m.tone} size="xs">{m.label}</Pill>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
            <div style={{ flex: 1, maxWidth: 220 }}><OutcomeBar passed={step.passed} recovered={step.recovered} failed={step.failed} /></div>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{step.runs} runs · {step.latency}</span>
          </div>
        </div>

        <Sparkline data={step.trend} color={m.color} w={84} h={26} />

        <div style={{ textAlign: "right" }}>
          <span style={{ fontSize: 20, fontWeight: 600, color: m.color, letterSpacing: -0.5 }}>{step.score}</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-4)" }}>/100</span>
        </div>

        <div style={{ textAlign: "right" }}><Delta value={step.delta} good="up" /></div>

        <ChevronRight size={13} color="var(--text-3)" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 140ms ease", justifySelf: "center" }} />
      </div>

      {open && (
        <div style={{ padding: "2px 16px 16px 60px", animation: "float-in 160ms ease" }}>
          <div style={{ background: "var(--panel-2)", border: "1px solid var(--hairline)", borderRadius: 10, padding: 12 }}>
            <SectionLabel style={{ paddingTop: 0 }}>Failure modes</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
              {failures.length === 0 && <div style={{ fontSize: 12, color: "var(--run)" }}>No failures recorded this period.</div>}
              {failures.map((f, i) => (
                <div key={i}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: "var(--text-2)" }}>
                    <span style={{ lineHeight: 1.4 }}>{f.label}</span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--text-3)", flexShrink: 0 }}>{f.count}×</span>
                  </div>
                  <div style={{ height: 4, background: "rgba(255,255,255,0.05)", borderRadius: 999, marginTop: 5, overflow: "hidden" }}>
                    <div style={{ width: `${f.pct}%`, height: "100%", background: "var(--err)", opacity: 0.7 }} />
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--hairline)", display: "flex", gap: 8 }}>
              <Sparkle size={14} color="var(--accent-2)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.55 }}>{step.insight}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function StepPerformancePanel({ wf, openStep, onToggleStep }: { wf: WorkflowMetrics; openStep: string | null; onToggleStep: (name: string) => void }) {
  const attention = wf.steps.filter((s) => s.status !== "healthy").length;
  const headers = ["", "Step", "Trend", "Score", "Δ 7d", ""];
  return (
    <Panel
      title="Step performance"
      kicker={wf.name.toUpperCase()}
      right={
        <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>
          {attention > 0 ? `${attention} need attention` : "all healthy"}
        </span>
      }
      style={{ flex: 1, minHeight: 0 }}
      bodyStyle={{ padding: 0, display: "flex", flexDirection: "column" }}
    >
      <div style={{ display: "grid", gridTemplateColumns: GRID, gap: 12, padding: "8px 14px", borderBottom: "1px solid var(--hairline)", flexShrink: 0 }}>
        {headers.map((h, i) => (
          <span key={i} className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-4)", textAlign: i >= 3 && i <= 4 ? "right" : "left" }}>{h}</span>
        ))}
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        {wf.steps.map((s, i) => (
          <StepRow key={s.name} step={s} index={i} isLast={i === wf.steps.length - 1} open={openStep === s.name} onToggle={() => onToggleStep(s.name)} />
        ))}
      </div>
    </Panel>
  );
}
```

Note: `Filter` is imported for parity with the mock's header filter button but the button itself is omitted (non-functional in the mock). If lint flags the unused import, drop `Filter` from the import line.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/desktop test -- StepPerformance`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics/StepPerformance.tsx apps/desktop/src/metrics/StepPerformance.test.tsx
git commit -m "feat(metrics): step-performance panel with expandable rows + workflow dropdown"
```

---

### Task 4: Self-improvement rail (cards, modal, learning log)

**Files:**
- Create: `apps/desktop/src/metrics/SelfImprovement.tsx`
- Test: `apps/desktop/src/metrics/SelfImprovement.test.tsx`

**Interfaces:**
- Consumes: `WorkflowMetrics`, `StepStatus`, `Proposal`, `LearningLogEntry`, `statusMeta` (Task 1); `Panel` (Task 2); `Btn`, `Pill` from `../workspaces/primitives`; icons (Task 2); `getLearningLog` (Task 1).
- Produces:
  - `Improvement = Proposal & { step: string; status: StepStatus }`
  - `ProposalModal({ imp, applied, onApply, onClose }: { imp: Improvement; applied: boolean; onApply: () => void; onClose: () => void })`
  - `ImprovementCard({ imp }: { imp: Improvement })`
  - `LearningLogRow({ entry }: { entry: LearningLogEntry })`
  - `AutoApplyToggle()`
  - `SelfImprovementRail({ wf }: { wf: WorkflowMetrics })`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/metrics/SelfImprovement.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getWorkflowMetrics } from "./metrics-data";
import { SelfImprovementRail } from "./SelfImprovement";

const wf = getWorkflowMetrics()[0]; // Brainstorm — has proposals + degraded step

describe("SelfImprovementRail", () => {
  it("renders an improvement card per step with a proposal", () => {
    render(<SelfImprovementRail wf={wf} />);
    expect(screen.getByText("Inject failed-constraint feedback into the retry prompt")).toBeInTheDocument();
    expect(screen.getByText("Require per-constraint evidence and cap retries at 2")).toBeInTheDocument();
  });

  it("opens the proposal modal with before/after when Review is clicked", () => {
    render(<SelfImprovementRail wf={wf} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Review" })[0]);
    expect(screen.getByText("Current instruction")).toBeInTheDocument();
    expect(screen.getByText("Proposed")).toBeInTheDocument();
  });

  it("renders the learning log timeline", () => {
    render(<SelfImprovementRail wf={wf} />);
    expect(screen.getByText(/duplicate writes/)).toBeInTheDocument();
    expect(screen.getByText("Activity")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- SelfImprovement`
Expected: FAIL — cannot resolve `./SelfImprovement`.

- [ ] **Step 3: Write the component**

Create `apps/desktop/src/metrics/SelfImprovement.tsx`. (Ported from the mock. **Fix folded in:** the `LEARNING_LOG` timeline — defined-but-never-rendered in the mock — is rendered here under an "Activity" section.)

```tsx
import { useEffect, useState, type ComponentType } from "react";
import { Btn, Pill } from "../workspaces/primitives";
import { getLearningLog, statusMeta, type LearningLogEntry, type Proposal, type StepStatus, type WorkflowMetrics } from "./metrics-data";
import { Panel } from "./metrics-charts";
import { Check, ChevronLeft, Close, Spark, Sparkle } from "./metrics-icons";

export type Improvement = Proposal & { step: string; status: StepStatus };

export function ProposalModal({ imp, applied, onApply, onClose }: { imp: Improvement; applied: boolean; onApply: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{ position: "absolute", inset: 0, zIndex: 50, background: "rgba(5,5,8,0.55)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", animation: "float-in 160ms ease" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxHeight: "85%", background: "var(--panel)", border: "1px solid var(--hairline-strong)", borderRadius: 14, boxShadow: "0 24px 80px rgba(0,0,0,0.55)", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--hairline)" }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent-line)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Sparkle size={15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.2 }}>Orca proposes</div>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--text-3)" }}>{imp.step}</div>
          </div>
          <Pill tone="run" size="xs">+{imp.lift} score</Pill>
          <Btn icon={<Close />} size="xs" onClick={onClose} />
        </header>

        <div className="scroll" style={{ flex: 1, padding: 18, overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", lineHeight: 1.35 }}>{imp.title}</div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 5, background: "rgba(255,255,255,0.06)", borderRadius: 999, overflow: "hidden" }}>
              <div style={{ width: `${imp.confidence}%`, height: "100%", background: "var(--accent)" }} />
            </div>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-2)" }}>{imp.confidence}% confidence</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ borderLeft: "2px solid var(--err)", paddingLeft: 10 }}>
              <div className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-4)", marginBottom: 3 }}>Current instruction</div>
              <div style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.55 }}>{imp.before}</div>
            </div>
            <div style={{ borderLeft: "2px solid var(--run)", paddingLeft: 10 }}>
              <div className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--run)", marginBottom: 3 }}>Proposed</div>
              <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55 }}>{imp.after}</div>
            </div>
          </div>
        </div>

        <footer style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--hairline)" }}>
          {applied ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--run)", fontWeight: 600 }}>
              <Check size={14} color="var(--run)" /> Applied · re-running {imp.step}
            </span>
          ) : (
            <>
              <div style={{ flex: 1 }} />
              <Btn kind="ghost" size="sm" onClick={onClose}>Dismiss</Btn>
              <Btn kind="primary" size="sm" icon={<Check />} onClick={() => { onApply(); onClose(); }}>Apply change</Btn>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

export function ImprovementCard({ imp }: { imp: Improvement }) {
  const [applied, setApplied] = useState(false);
  const [review, setReview] = useState(false);
  const m = statusMeta[imp.status];
  return (
    <>
      <div style={{ border: "1px solid var(--hairline)", borderRadius: 10, background: "var(--panel-2)", padding: 11, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: m.color, flexShrink: 0 }} />
          <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{imp.step}</span>
          <div style={{ flex: 1 }} />
          <Pill tone="run" size="xs">+{imp.lift}</Pill>
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", lineHeight: 1.35 }}>{imp.title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 999, overflow: "hidden" }}>
            <div style={{ width: `${imp.confidence}%`, height: "100%", background: "var(--accent)" }} />
          </div>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>{imp.confidence}% conf</span>
        </div>
        {applied ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--run)", fontWeight: 600 }}>
            <Check size={13} color="var(--run)" /> Applied
          </span>
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            <Btn kind="quiet" size="xs" onClick={() => setReview(true)}>Review</Btn>
          </div>
        )}
      </div>
      {review && <ProposalModal imp={imp} applied={applied} onApply={() => setApplied(true)} onClose={() => setReview(false)} />}
    </>
  );
}

const logMeta: Record<LearningLogEntry["type"], { tone: "run" | "info" | "accent" | "neutral"; label: string; icon: ComponentType<{ size?: number; color?: string }>; color: string }> = {
  applied: { tone: "run", label: "Applied", icon: Check, color: "var(--run)" },
  observed: { tone: "info", label: "Observed", icon: Spark, color: "var(--info)" },
  proposed: { tone: "accent", label: "Proposed", icon: Sparkle, color: "var(--accent)" },
  reverted: { tone: "neutral", label: "Reverted", icon: ChevronLeft, color: "var(--text-3)" },
};

export function LearningLogRow({ entry }: { entry: LearningLogEntry }) {
  const m = logMeta[entry.type];
  const I = m.icon;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "18px 1fr", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--hairline)" }}>
      <div style={{ paddingTop: 1 }}><I size={13} color={m.color} /></div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <Pill tone={m.tone} size="xs">{m.label}</Pill>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{entry.t}</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>{entry.text}</div>
      </div>
    </div>
  );
}

export function AutoApplyToggle() {
  const [on, setOn] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setOn((o) => !o)}
      aria-pressed={on}
      style={{ width: 32, height: 18, borderRadius: 999, border: "none", cursor: "pointer", flexShrink: 0, background: on ? "var(--accent)" : "rgba(255,255,255,0.12)", position: "relative", transition: "background 160ms ease", padding: 0 }}
    >
      <span style={{ position: "absolute", top: 2, left: on ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left 160ms ease" }} />
    </button>
  );
}

export function SelfImprovementRail({ wf }: { wf: WorkflowMetrics }) {
  const improvements: Improvement[] = wf.steps
    .filter((s) => s.proposal)
    .map((s) => ({ step: s.name, status: s.status, ...(s.proposal as Proposal) }));
  const attention = wf.steps.filter((s) => s.status !== "healthy").length;
  const proposals = improvements.length;
  const log = getLearningLog();

  return (
    <Panel
      title="Self-improvement"
      kicker="ORCA LEARNS"
      style={{ flex: 1, minHeight: 0 }}
      bodyStyle={{ padding: 12, display: "flex", flexDirection: "column", minHeight: 0 }}
    >
      <div className="scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.55, marginBottom: 12 }}>
          {proposals > 0 ? (
            <>Orca flagged <strong style={{ color: "var(--text)" }}>{attention} underperforming step{attention !== 1 ? "s" : ""}</strong> in {wf.name} and drafted {proposals} instruction change{proposals !== 1 ? "s" : ""}. Approve to let it improve itself.</>
          ) : (
            <>Every step in {wf.name} is healthy. Orca has no changes to propose right now.</>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {improvements.map((imp, i) => <ImprovementCard key={i} imp={imp} />)}
          {improvements.length === 0 && (
            <div style={{ textAlign: "center", padding: "18px 0", color: "var(--text-3)", fontSize: 12 }}>
              <Check size={20} color="var(--run)" style={{ marginBottom: 6 }} />
              <div>No pending improvements.</div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 16 }}>
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: 1.4, textTransform: "uppercase", color: "var(--text-3)", fontWeight: 600, padding: "4px 0" }}>Activity</div>
          {log.map((entry, i) => <LearningLogRow key={i} entry={entry} />)}
        </div>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--hairline)", cursor: "pointer", flexShrink: 0 }}>
        <AutoApplyToggle />
        <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>Auto-apply improvements above 90% confidence</span>
      </label>
    </Panel>
  );
}
```

Note: `Check` accepts a `style` prop (Task 2 icons all do); the `marginBottom` usage above is valid.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/desktop test -- SelfImprovement`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics/SelfImprovement.tsx apps/desktop/src/metrics/SelfImprovement.test.tsx
git commit -m "feat(metrics): self-improvement rail with proposal modal + learning log"
```

---

### Task 5: Assemble MetricsPage + wire into App, remove diagnostics

**Files:**
- Create: `apps/desktop/src/metrics/MetricsPage.tsx`
- Create: `apps/desktop/src/metrics/MetricsPage.test.tsx`
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**
- Consumes: `getWorkflowMetrics`, `gradeFor` (Task 1); `StatTile` (Task 2); `WorkflowDropdown`, `StepPerformancePanel` (Task 3); `SelfImprovementRail` (Task 4); `Workflow` icon (Task 2).
- Produces: `MetricsPage()` (default-or-named export — use a named export `MetricsPage`).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/metrics/MetricsPage.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetricsPage } from "./MetricsPage";

describe("MetricsPage", () => {
  it("renders the KPI strip for the default workflow", () => {
    render(<MetricsPage />);
    expect(screen.getByText("Workflow health")).toBeInTheDocument();
    expect(screen.getByText("First-pass")).toBeInTheDocument();
    expect(screen.getByText("Self-recovered")).toBeInTheDocument();
    expect(screen.getByText("Escalated")).toBeInTheDocument();
  });

  it("switches the step list when a different workflow is chosen", () => {
    render(<MetricsPage />);
    expect(screen.getByText("Define Intent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Brainstorm/ }));
    fireEvent.click(screen.getByText("Shadow-then-cutover"));
    expect(screen.getByText("Plan migration")).toBeInTheDocument();
    expect(screen.queryByText("Define Intent")).not.toBeInTheDocument();
  });

  it("toggles the period control", () => {
    render(<MetricsPage />);
    const btn = screen.getByRole("button", { name: "30d" });
    fireEvent.click(btn);
    expect(btn).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- MetricsPage`
Expected: FAIL — cannot resolve `./MetricsPage`.

- [ ] **Step 3: Write MetricsPage**

Create `apps/desktop/src/metrics/MetricsPage.tsx`:

```tsx
import { useState } from "react";
import { getWorkflowMetrics, gradeFor } from "./metrics-data";
import { StatTile } from "./metrics-charts";
import { StepPerformancePanel, WorkflowDropdown } from "./StepPerformance";
import { SelfImprovementRail } from "./SelfImprovement";
import { Workflow } from "./metrics-icons";

const PERIODS = ["24h", "7d", "30d"] as const;

export function MetricsPage() {
  const workflows = getWorkflowMetrics();
  const [wfId, setWfId] = useState(workflows[0].id);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("7d");
  const [openStep, setOpenStep] = useState<string | null>("Verify Proposal");
  const wf = workflows.find((w) => w.id === wfId) ?? workflows[0];

  const healthColor = wf.health >= 80 ? "var(--run)" : wf.health >= 70 ? "var(--warn)" : "var(--err)";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 12, padding: 12, height: "100%", minHeight: 0, overflow: "hidden" }}>
      {/* LEFT */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <Workflow size={14} color="var(--text-3)" />
          <span className="mono" style={{ fontSize: 10.5, letterSpacing: 1.1, textTransform: "uppercase", color: "var(--text-3)", marginRight: 2 }}>Workflow</span>
          <WorkflowDropdown workflows={workflows} value={wfId} onChange={(id) => { setWfId(id); setOpenStep(null); }} />
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", background: "rgba(255,255,255,0.03)", border: "1px solid var(--hairline)", borderRadius: 8, padding: 2 }}>
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className="mono"
                style={{ background: period === p ? "rgba(255,255,255,0.08)" : "transparent", color: period === p ? "var(--text)" : "var(--text-3)", border: "none", borderRadius: 6, padding: "4px 9px", cursor: "pointer", fontSize: 11 }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
          <StatTile label="Workflow health" value={wf.health} accent={healthColor} grade={gradeFor(wf.health)} delta={wf.healthDelta} deltaGood="up" spark={wf.steps[0].trend} sparkColor={healthColor} />
          <StatTile label="First-pass" value={wf.firstPass} unit="%" delta={wf.firstPassDelta} deltaGood="up" deltaSuffix="%" spark={wf.steps[0].trend} sparkColor="var(--accent)" />
          <StatTile label="Self-recovered" value={wf.recovered} unit="%" delta={wf.recoveredDelta} deltaGood="up" deltaSuffix="%" accent="var(--warn)" spark={wf.steps[1].trend} sparkColor="var(--warn)" />
          <StatTile label="Escalated" value={wf.escalated} unit="%" delta={wf.escalatedDelta} deltaGood="down" deltaSuffix="%" accent="var(--err)" spark={wf.steps[3]?.trend ?? wf.steps[0].trend} sparkColor="var(--err)" />
        </div>

        <StepPerformancePanel wf={wf} openStep={openStep} onToggleStep={(name) => setOpenStep((o) => (o === name ? null : name))} />
      </div>

      {/* RIGHT */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <SelfImprovementRail wf={wf} />
      </div>
    </div>
  );
}
```

(Spec fix: all four KPI tiles get a sparkline, satisfying "each a StatTile with delta + sparkline".)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/desktop test -- MetricsPage`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire MetricsPage into App.tsx and remove diagnostics**

In `apps/desktop/src/App.tsx`:

1. Add import near the other feature imports:
```tsx
import { MetricsPage } from "./metrics/MetricsPage";
```

2. Replace the entire `activeTab === "reasoning"` branch body (the `<section className="reasoning-pane">…Runtime Diagnostics…</section>`, ~lines 478–510) with:
```tsx
            ) : activeTab === "reasoning" ? (
              <section className="reasoning-pane" role="tabpanel" aria-label="Metrics">
                <MetricsPage />
              </section>
```

3. Remove the now-dead diagnostics code:
   - The `Diagnostics` type (`type Diagnostics = { plugins: PluginSummary[]; skills: SkillSummary[] };`).
   - State: `diagnostics`, `diagnosticsLoading`, `diagnosticsError`.
   - The `loadDiagnostics` function.
   - The `loadDiagnostics();` call inside the `connectionStatus === "open"` effect (leave `loadGoals();`), and update the comment from "Load goals/diagnostics" to "Load goals".
   - Remove now-unused imports `listPlugins`, `listSkills` from `../api`, and `PluginSummary`, `SkillSummary` from `@orca/contracts` **only if** no other code in `App.tsx` references them (verify with the grep in Step 6 before deleting).

- [ ] **Step 6: Verify nothing else references the removed symbols**

Run:
```bash
grep -n "diagnostics\|loadDiagnostics\|listPlugins\|listSkills\|PluginSummary\|SkillSummary\|reasoning-card\|reasoning-list\|reasoning-error\|reasoning-action-btn" apps/desktop/src/App.tsx
```
Expected: no matches (the only remaining `reasoning` reference is `activeTab === "reasoning"` and `className="reasoning-pane"`/`aria-label="Metrics"`). If `PluginSummary`/`SkillSummary`/`listPlugins`/`listSkills` are referenced elsewhere in the repo that's fine — only remove the imports from `App.tsx` if `App.tsx` no longer uses them.

- [ ] **Step 7: Run the full desktop test suite + typecheck**

Run:
```bash
pnpm --filter @orca/desktop test
pnpm --filter @orca/desktop typecheck
```
Expected: all tests PASS; no type errors. (If the repo uses `tsc -b` or a root `pnpm typecheck`, use that instead — check `apps/desktop/package.json` scripts.)

- [ ] **Step 8: Update App.test.tsx if it asserts on Runtime Diagnostics**

Run:
```bash
grep -n "Runtime Diagnostics\|diagnostics\|Plugins (\|Skills (" apps/desktop/src/App.test.tsx
```
If any test asserts the old Metrics/Runtime-Diagnostics content, update it to assert the new Metrics tab renders (e.g. selecting the Metrics tab shows "Workflow health" / "Step performance"). If there are no matches, no change needed.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/metrics/MetricsPage.tsx apps/desktop/src/metrics/MetricsPage.test.tsx apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx
git commit -m "feat(metrics): replace Runtime Diagnostics tab with operational-intelligence metrics view"
```

---

## Self-Review

**1. Spec coverage:**
- Two-column grid `minmax(0,1fr) 340px`, internal scroll → Task 5 `MetricsPage`. ✓
- Workflow selector + 24h/7d/30d toggle → Task 3 `WorkflowDropdown`, Task 5 period control. ✓
- KPI strip (health grade, first-pass, self-recovered, escalated; delta + sparkline; escalations-down-is-green) → Task 2 `StatTile`/`Delta`, Task 5 (all four tiles given sparklines). ✓
- Step performance expandable rows (index, name, status Pill, OutcomeBar, runs·latency, trend, score/100, Δ; expand → failure bars + insight) → Task 3 `StepRow`. ✓
- Right rail ORCA LEARNS, ImprovementCards → ProposalModal (before/after diff, confidence bar, Apply), auto-apply toggle → Task 4. ✓
- LEARNING_LOG rendered (mock-bug fix) → Task 4 `SelfImprovementRail` "Activity". ✓
- Half-empty expanded-row column fixed → Task 3 (single-column block). ✓
- Mock-data seam (`getWorkflowMetrics`) → Task 1; no view reads literals. ✓
- Reuse Panel/Pill/Btn/SectionLabel → Tasks 2–4 (Pill/Btn imported; Panel/SectionLabel local). ✓
- Reuse Sparkline/Delta/OutcomeBar/StatTile/gradeFor/statusMeta → Tasks 1–2. ✓
- Wire into App, remove diagnostics → Task 5. ✓
- Tab label stays "Metrics" → Task 5 (key unchanged, label already "Metrics"). ✓
- `ViewMetrics`/window export → N/A in the real app; the App import replaces it (intentional deviation from the mock's prototype loader). ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". All code blocks are complete. ✓

**3. Type consistency:** `WorkflowMetrics`/`StepMetrics`/`Proposal`/`FailureMode`/`LearningLogEntry`/`StepStatus` defined in Task 1 and used with identical names/shapes in Tasks 3–5. `Improvement = Proposal & { step; status }` defined Task 4, consumed only within Task 4. `statusMeta` tone union (`run`/`warn`/`err`) matches `Pill`'s `PillTone`. `Delta.good` and `StatTile.deltaGood` both `"up" | "down"`. Icon components share `{ size?; color?; style? }`. ✓

---

## Notes for the executor

- The mock used `Math.random()` for SVG gradient ids; this plan uses React `useId()` (Task 2) for deterministic, test-stable ids.
- The mock's `Filter` header button is intentionally dropped (non-functional). Keeping the import optional.
- `Apply` / `Auto-apply` remain local optimistic UI state — no daemon mutation (per spec "out of scope").
- If `pnpm --filter @orca/desktop test -- <name>` filtering differs in this repo's Vitest config, run the whole suite; tests are isolated by file.
