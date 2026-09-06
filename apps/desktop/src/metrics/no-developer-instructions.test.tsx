import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IMPLEMENTATION_VOCABULARY } from "@orca/contracts";
import type { Intervention, RunDetail, RunSummary, RunTraceSpan } from "@orca/contracts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CantTellYou, CostCaveats, RunDetailPanel, RunRow } from "./RunLedger";
import { Dashboard, aggregate } from "./WorkflowRollup";
import { IntervalBar } from "./interval-bar";

afterEach(cleanup);

// Seven developer instructions reached the founder's screen — "Emit
// step_launch/step_complete on the gate surrogate", "Wire the PostToolUse hook",
// "Stamp the pause reason into the event". We removed them from the visible layer and
// one survived another day in every `aria-label`, spoken verbatim, because
// `MeasurementLabel` builds its accessible name from the same strings.
//
// The contracts guard checks what the module RETURNS. It cannot check what callers
// SUPPLY: `reason` and `detail` are passthroughs, so a call site can hand implementation
// talk straight through to the reader, and to the accessible name in particular — the
// channel that already carried one for a day. This is that half.
//
// It asserts over BOTH channels deliberately. Visible text is checked by looking at a
// page; an accessible name is not, and the day this defect survived was a day spent
// verifying copy by looking at rendered pixels. The instrument was correct, used well,
// and had a blind spot shaped exactly like its own strength.
//
// One more property worth naming, because it is counter-intuitive and repeatable:
// moving a string OUT of the visual layer increases its exposure rather than reducing
// it. It removes the only warning that the string exists, and the reader who still
// receives it is the one least able to complain about it.

const H = 3_600_000;

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "r1", goalId: "g1", goalTitle: "Add a Kelvin conversion",
    templateId: "t", templateName: "Adaptive Delivery", templateVersion: 16,
    status: "completed", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T01:00:00.000Z",
    blockedReason: null, terminationCause: "infrastructure_killed",
    terminationEvidence: "crashed 3 times (worker_exited_no_signal)",
    durations: { elapsedMs: H, workingMs: 600_000, parkedMs: 2_400_000, unaccountedMs: 600_000,
                 spanActiveMs: 0, accruing: false, integrityFlag: null },
    cost: { usd: 0, wastedUsd: 0, failedUsd: 0, supersededUsd: 0,
            coverage: { reported: 0, total: 0, silent: 2 }, rollupCheck: "not_applicable" },
    stepsDelivered: 0, stepsBlocked: 1, spanRelaunches: 2, retriedAttempts: 0,
    openInterventions: 1,
    progress: { lastProgressAt: null, lastProgressChannel: null, lastSignalAt: null,
                lastSignalChannel: null, silenceConclusive: true },
    awaitingYou: { count: 0, sinceMs: null, sourceKind: null },
    ...over,
  };
}

function span(over: Partial<RunTraceSpan> = {}): RunTraceSpan {
  return {
    workflowRunId: "r1", workflowStepRunId: "sr1", goalId: "g1", stepTemplateId: "critique",
    name: "Critique", ordinal: 0, attempt: 1, kind: "gate",
    startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:02:00.000Z",
    elapsedMs: 120_000, workingMs: null, parkedMs: 0, status: "passed", blockedReason: null,
    restarts: 0, completions: 1, stallRescues: 0, cost: null, tier: null,
    verifiers: null, refuteVerdict: null, refuteTriggeredBy: [], refuteReason: null, evidenceGaps: null, conflicts: [], outcomeStatus: "succeeded",
    failureCode: null, models: [], completionLog: [], ...over,
  };
}

function park(over: Partial<Intervention> = {}): Intervention {
  return {
    activityId: "a1", goalId: "g1", workflowRunId: "r1", workflowStepRunId: "sr1",
    sourceKind: "unknown", enteredAt: "2026-09-01T00:10:00.000Z", exitedAt: null,
    durationMs: 3_000_000, open: true, parkState: "abandoned", ...over,
  };
}

const pipelineStep = () => ({
  stepTemplateId: "proposal", name: "Proposal", ordinal: 1, score: 87, sampleSize: 1,
  confidence: "low" as const, runs: 1, passedFirstTry: 1, recovered: 0, failed: 0,
  quality: { verdictPassRate: 1, verifiedSampleSize: 1, scoredSampleSize: 1, sensorPassRate: 1,
             oracleSufficientRate: 1, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
  cost: { p50LatencyMs: 1, meanTokens: 1, meanUsd: 0.01, meanRetries: 1 },
  risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
  failureClusters: [],
  verification: { tier: "ai_reviewed" as const, tierLabel: "Reviewed, not proven", confidence: 0.7,
                  falseAcceptanceRate: 0.1, artifacts: [], recentRefuteReasons: [],
                  band: { level: "weak" as const, label: "Weakly verified" } },
  failureModes: [], reconciliation: null, trend: [], versionBoundaries: [],
  versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: [], recentReasons: [],
});

const pipelineDetail = () => ({
  summary: {} as never,
  steps: [
    { ...pipelineStep(), runs: 6, quality: { ...pipelineStep().quality, verifiedSampleSize: 4 } },
    { ...pipelineStep(), stepTemplateId: "x", name: "Verify", runs: 6,
      quality: { ...pipelineStep().quality, verifiedSampleSize: 0 } },
  ],
  gates: [], splitters: [],
  policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 },
                   overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] },
  completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 },
                    vetoed: { count: 0, sampleTransitionIds: [] } },
});

const detail = (): RunDetail => ({
  run: summary(),
  spans: [span(), span({ workflowStepRunId: "sr2", name: "Verify" })],
  interventions: [park(), park({ activityId: "a2", sourceKind: "step_confirmation_pending" })],
  harnessErrors: [], toolDecisions: [],
});

/** Every string this surface puts in front of a reader, spoken or seen. */
function readerFacingText(root: HTMLElement): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    const label = el.getAttribute("aria-label");
    if (label) out.push({ where: `aria-label on <${el.tagName.toLowerCase()}>`, text: label });
    const title = el.getAttribute("title");
    if (title) out.push({ where: `title on <${el.tagName.toLowerCase()}>`, text: title });
    // An SVG <title> CHILD is a tooltip too, and it reached this collector only via
    // textContent below — filed as "visible text", which is the one thing it is not.
    // The mislabel hid behind the matrix panel's title attributes until that panel was
    // removed and the precondition went red with every chart tooltip still in place.
    // A collector that misnames a channel understates its own coverage, which is the
    // quiet half of the same defect this file exists for.
    if (el.tagName.toLowerCase() === "title" && el.textContent?.trim()) {
      out.push({ where: `svg <title> in <${el.parentElement?.tagName.toLowerCase() ?? "?"}>`,
                 text: el.textContent });
    }
  }
  out.push({ where: "visible text", text: root.textContent ?? "" });
  return out;
}

/** The surfaces asserted below. Shared with the coverage check so there is one list. */
const SURFACE_NAMES = ["RunRow", "RunDetailPanel", "CostCaveats", "CantTellYou", "Dashboard", "IntervalBar"] as const;

/**
 * Components that render no reader-facing prose of their own, with the reason.
 *
 * This exists so the surface list cannot silently fall behind the directory. Together
 * the two lists must account for every exported component in `metrics/` — adding one
 * without classifying it fails, and the failure names the file. The list stays a
 * literal, but it is checked against the filesystem rather than trusted, which is the
 * difference between a copy that can drift and one that cannot.
 */
const NOT_A_PROSE_SURFACE: Record<string, string> = {
  // Primitives: a number, a shape, a count. Their absence cases route through
  // MeasurementLabel, which the surfaces above exercise.
  aggregate: "a summing function, no output of its own",
  StackedRows: "segments with tooltips and a legend, all supplied by the caller",
  CoverageMatrix: "fractions and bars in columns, all supplied by the caller",
  WorkflowRollup: "loads and delegates to Dashboard, which is asserted directly",
  // Dashboard panel primitives: each renders a number, a bar or a cell. The prose on
  // that surface is in Dashboard itself, which is asserted above.
  Panel: "chrome — a title and its children",
  SectionHeading: "renders its children",
  Big: "a figure and a label supplied by the caller",
  BarList: "labels and bars supplied by the caller",
  Donut: "slices, a centre total and a legend, all supplied by the caller",
  TimeBars: "a count per interval; the unit and hover text are the caller's",
  TimeLine: "a level per interval; the unit and hover text are the caller's",
  activePerBucket: "counts overlaps into intervals",
  CountRow: "counts and labels supplied by the caller",
  Figure: "a number and a label",
  Sample: "a count and its noun",
  StatTile: "a label and a figure; its absence renders via MeasurementLabel",
  SectionLabel: "chrome — renders its children",
  Sparkline: "an svg path, no text",
  Delta: "an arrow and a number",
  OutcomeBar: "three widths, no text",
  VersionMarkerChips: "short lineage markers, no prose",
  VersionHistoryStrip: "version numbers and run counts",
  RateInterval: "a rate and an interval; the n=0 case renders MeasurementLabel",
  MeasurementLabel: "the source of the vocabulary — guarded at the contracts layer",
  WorkflowDropdown: "renders template names supplied by the daemon",

  // Pure functions. Exercised by their own tests; they render nothing themselves.
  coverageHeadline: "returns a string, asserted in PipelineHealth.test",
  headline: "returns a string, asserted in RunLedger.test",
  formatDuration: "returns a duration string",
  workflowEvidenceRuns: "a filter",
  terminatedRuns: "a filter",
  markerEarnsItsPlace: "a predicate",
  tokens: "formats a token count",
  PROMPT_KIND: "a lookup table of pause kinds",
  workflowsOf: "groups runs by template",
  versionsOf: "groups a workflow's runs by version",
  RANGES: "the window choices",
  withinWindow: "a filter",
  gatePeriodFor: "maps a window to a template period",
  bucketize: "counts into intervals",
  intervalsFor: "the steps that divide a window",
  defaultIntervalFor: "picks a step",
  modelName: "strips a release date from a model id",

  // Composers: they mount the surfaces above, each of which is asserted directly.
  MetricsPage: "composes tabs",
  RunLedger: "composes the run surfaces",

  // ── The known hole, named rather than closed ──────────────────────────────
  // These render prose on the LEGACY "Workflow averages" tab. The founder's
  // instruction on this work was to leave that tab intact, so they are neither
  // guarded nor fixable here. orca-d0 swept their call sites and found no live
  // violations, which is why this is a gap rather than a defect — but a swept-once
  // surface is not a guarded one, and whoever next owns that tab should mount them.
  GateRow: "LEGACY TAB — unguarded, out of scope, swept clean once by hand",
  GatePerformancePanel: "LEGACY TAB — unguarded, out of scope",
  FusedPipelinePanel: "LEGACY TAB — unguarded, out of scope",
  StepRow: "LEGACY TAB — unguarded, out of scope",
  StepPerformancePanel: "LEGACY TAB — unguarded, out of scope",
  SelfImprovementRail: "LEGACY TAB — unguarded, out of scope",
  ProposalReviewModal: "LEGACY TAB — unguarded, out of scope",
};

describe("the surface list cannot fall behind the directory", () => {
  it("accounts for every exported component in metrics/", () => {
    const dir = __dirname;
    const exported = new Set<string>();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".tsx") || file.includes(".test.")) continue;
      const src = readFileSync(join(dir, file), "utf8");
      for (const m of src.matchAll(/^export function ([A-Za-z0-9_]+)/gm)) exported.add(m[1]!);
    }
    const listed = new Set([...SURFACE_NAMES, ...Object.keys(NOT_A_PROSE_SURFACE)]);
    const unclassified = [...exported].filter((n) => !listed.has(n)).sort();
    expect(
      unclassified,
      "New exported component(s) in metrics/ are in neither the surface list nor the\n" +
        "exemption list. Add each to one: a surface if it renders prose to the reader,\n" +
        "an exemption with a reason if it does not. A guard holding its own copy of a\n" +
        "list is another place the list can diverge — this is what stops that."
    ).toEqual([]);
  });
});

describe("no surface speaks to the reader about our backlog", () => {
  const surfaces: [(typeof SURFACE_NAMES)[number], () => HTMLElement][] = [
    ["RunRow", () => render(<RunRow run={summary()} onOpen={() => {}} />).container],
    ["RunDetailPanel", () => render(<RunDetailPanel detail={detail()} onBack={() => {}} />).container],
    ["CostCaveats", () => render(<CostCaveats runs={[summary(), summary({ runId: "b" })]} />).container],
    ["CantTellYou", () => render(<CantTellYou runs={[summary(), summary({ runId: "b" })]} />).container],
    // The dashboard, not the fetching wrapper: WorkflowRollup only loads and
    // delegates, so mounting it synchronously would assert over a loading state.
    // Same split as RunDetailPanel vs RunLedger.
    ["Dashboard", () => render(
      <Dashboard agg={aggregate({
        runs: [summary(), summary({ runId: "b" })],
        details: [{ run: summary(), spans: [span()], interventions: [park()], harnessErrors: [], toolDecisions: [] }],
      })} />
    ).container],
  ];

  for (const [name, mount] of surfaces) {
    it(`${name} carries none, in visible text or in an accessible name`, () => {
      const strings = readerFacingText(mount());
      // Assert the COLLECTOR ran before asserting on what it collected. Without this
      // the loop below is vacuous when `readerFacingText` returns nothing or the
      // surface renders nothing — four green tests over zero strings, indistinguishable
      // from four green tests over clean ones. That is the failure this whole file
      // exists downstream of, and the first version of it had the hole: proving the
      // detector matches a literal is not proving the harness gathers anything.
      // The precondition, stated as what it actually requires rather than as a count.
      // A threshold of "more than 2" was a number I chose, and a single-element
      // surface legitimately produces exactly two strings — so it would have failed
      // an honest surface while looking principled. What the loop below needs is that
      // SOMETHING was gathered, and that the accessible channel was among it.
      expect(strings.some((s) => s.text.trim().length > 0),
        `${name} produced no reader-facing text at all`).toBe(true);
      expect(
        strings.some((s) => s.where.startsWith("aria-label") || s.where.startsWith("title") ||
            s.where.startsWith("svg <title>")),
        `${name} produced nothing on a channel a screenshot cannot show. The defect this\n` +
          `file exists for lived in an aria-label and survived a day of verifying copy by\n` +
          `looking at pixels — so a surface with no accessible name and no tooltip is one\n` +
          `this guard would pass over while checking only what was already visible.`,
      ).toBe(true);

      for (const { where, text } of strings) {
        expect(text, `${name} — ${where}`).not.toMatch(IMPLEMENTATION_VOCABULARY);
      }
    });
  }

  it("the detector actually catches a caller-supplied instruction", () => {
    // A guard that cannot fail is decoration. `reason` and `detail` are passthroughs,
    // so this is precisely the hole the contracts test cannot see — and it is how the
    // seven got in.
    expect("Emit step_launch/step_complete on the gate surrogate.").toMatch(IMPLEMENTATION_VOCABULARY);
    expect("Wire the PostToolUse hook.").toMatch(IMPLEMENTATION_VOCABULARY);
    expect("It needs a fix before it can show up here.").toMatch(IMPLEMENTATION_VOCABULARY);
    // And does not fire on the reader-facing replacements, or on `uninstrumented`,
    // where the word boundary saves us from `instrument`.
    expect("This isn't being recorded yet.").not.toMatch(IMPLEMENTATION_VOCABULARY);
    expect("This gate ran a real agent, and its cost and timing weren't recorded.")
      .not.toMatch(IMPLEMENTATION_VOCABULARY);
  });
});
