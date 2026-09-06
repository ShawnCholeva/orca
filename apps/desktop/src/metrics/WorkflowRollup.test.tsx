import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Intervention, RunDetail, RunSummary, RunTraceSpan, TemplateMetricsDetail } from "@orca/contracts";
import { Dashboard, RANGES, WorkflowRollup, aggregate, bucketize, defaultIntervalFor, gatePeriodFor, intervalsFor, versionsOf, withinWindow, workflowsOf } from "./WorkflowRollup";
import * as api from "../api";
import { Donut, TimeBars } from "./dashboard-panels";

// Real timers restored here as well as in the tests: a failing assertion would
// otherwise leave the next test on a faked clock, and useFakeTimers does not move
// an already-faked clock, so the leak would be silent.
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const H = 3_600_000;

function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "r1", goalId: "g1", goalTitle: "Add a Kelvin conversion", templateId: "t",
    templateName: "Adaptive Delivery", templateVersion: 16, status: "completed",
    startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T01:00:00.000Z",
    blockedReason: null, terminationCause: "infrastructure_killed", terminationEvidence: null,
    durations: { elapsedMs: 10 * H, workingMs: H, parkedMs: 8 * H, unaccountedMs: H,
                 spanActiveMs: 0, accruing: false, integrityFlag: null },
    cost: { usd: 10, wastedUsd: 0, failedUsd: 4, supersededUsd: 1,
            coverage: { reported: 2, total: 3, silent: 1 }, rollupCheck: "matches" },
    stepsDelivered: 1, stepsBlocked: 2, spanRelaunches: 3, retriedCompletions: 1, openInterventions: 0,
    progress: { lastProgressAt: null, lastProgressChannel: null, lastSignalAt: null,
                lastSignalChannel: null, silenceConclusive: true },
    awaitingYou: { count: 0, sinceMs: null, sourceKind: null },
    ...over,
  };
}

function span(over: Partial<RunTraceSpan> = {}): RunTraceSpan {
  return {
    workflowRunId: "r1", workflowStepRunId: "sr1", goalId: "g1", stepTemplateId: "triage",
    name: "Triage", ordinal: 0, attempt: 1, kind: "step",
    startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:30:00.000Z",
    elapsedMs: 30 * 60_000, workingMs: 60_000, parkedMs: 0, status: "passed", blockedReason: null,
    restarts: 2, completions: 1, stallRescues: 0,
    cost: { usd: 5, tokensIn: 1, tokensOut: 1, cacheReadTokens: null, cacheCreationTokens: null, state: "reported" },
    tier: null, verifiers: null, refuteVerdict: null, refuteTriggeredBy: [], refuteReason: null, evidenceGaps: null, conflicts: [],
    outcomeStatus: "succeeded", failureCode: null, models: [], completionLog: [], ...over,
  };
}

function park(over: Partial<Intervention> = {}): Intervention {
  return {
    activityId: "a1", goalId: "g1", workflowRunId: "r1", workflowStepRunId: "sr1",
    sourceKind: "unknown", enteredAt: "2026-09-01T00:10:00.000Z", exitedAt: null,
    // Deliberately absurd against a 10h run: an open park grows without bound.
    durationMs: 400 * H, open: true, parkState: "abandoned", ...over,
  };
}

const loaded = (over: Partial<RunDetail> = {}) => ({
  runs: [run(), run({ runId: "b", terminationCause: "completed" })],
  details: [
    { run: run(), spans: [span()], interventions: [park()], harnessErrors: [], toolDecisions: [], ...over },
    { run: run({ runId: "b" }), spans: [span({ workflowStepRunId: "s2", name: "Execution", cost: { usd: 40, tokensIn: 1, tokensOut: 1, cacheReadTokens: null, cacheCreationTokens: null, state: "reported" } })], interventions: [park({ activityId: "a2", sourceKind: "question_pending" })], harnessErrors: [], toolDecisions: [] },
  ],
});

describe("everything on the dashboard is a count or a sum", () => {
  it("sums spend, time and step counts across runs", () => {
    const a = aggregate(loaded());
    expect(a.usd).toBe(20);
    expect(a.elapsedMs).toBe(20 * H);
    expect(a.delivered).toBe(2);
    expect(a.relaunches).toBe(6);
  });

  it("keeps the four duration terms addable", () => {
    const a = aggregate(loaded());
    expect(a.workingMs + a.parkedMs + a.unaccountedMs).toBe(a.elapsedMs);
  });

  it("takes parked time from the run's own split, never from summing pauses", () => {
    // Two ways to count the same thing and only one can be added to the terms beside
    // it. Pauses overlap and an open one grows without bound: summing intervention
    // durations here gives 800h against 20h of wall clock. A figure that exceeds its
    // own denominator is the kind of number that survives review by looking precise.
    const a = aggregate(loaded());
    const naive = loaded().details.flatMap((d) => d.interventions).reduce((s, i) => s + (i.durationMs ?? 0), 0);
    expect(naive).toBeGreaterThan(a.elapsedMs);
    expect(a.parkedMs).toBe(16 * H);
    expect(a.parkedMs).toBeLessThanOrEqual(a.elapsedMs);
  });

  it("partitions runs by STATE, so an unfinished run is not given a terminal outcome", () => {
    const a = aggregate({ ...loaded(), runs: [run(), run({ runId: "b", terminationCause: "running" })] });
    // The partition must stay EXHAUSTIVE across the split. "stopped" used to be one
    // bucket defined as "not completed and not running", which quietly swallowed three
    // causes under a label naming only one of them. Splitting it is only safe while
    // the parts still sum to n — otherwise a run acquires no state at all and vanishes
    // from a panel that claims to show every run.
    expect(a.completed + a.killed + a.workflowFailed + a.stoppedUnknown + a.running).toBe(2);
    expect(a.running).toBe(1);
    expect(a.killed).toBe(1);
  });
});

describe("what the dashboard refuses to render", () => {
  const html = () => render(<Dashboard agg={aggregate(loaded())} />).container.textContent ?? "";

  it("shows no rate, mean, percentile, trend arrow or letter grade", () => {
    const t = html();
    expect(t).not.toMatch(/average|\bmean\b|percentile|p50|p90|▲|▼/i);
    expect(t).not.toMatch(/\/100\b/);
  });

  it("never calls a repeated step a retry, anywhere on the surface", () => {
    // A veto-then-pass step emits two step_completes for ONE attempt, which is how a
    // row came to claim "attempt 1" and "redone 1x" at the same time.
    //
    // The panel this guarded ("Completions beyond the first") was removed as
    // unreadable — the founder could not say what it was for, which is a fair verdict
    // on a figure needing three sentences of provenance. The VOCABULARY rule outlives
    // it: the dashboard still counts crash relaunches, and "retries" is exactly the
    // wrong noun for those too, for the same reason it was wrong here. So this keeps
    // the half that still has a subject and drops the half that does not.
    const t = html();
    expect(t.length, "the dashboard rendered nothing, so absence proves nothing").toBeGreaterThan(0);
    expect(t).toContain("relaunches after a crash");
    expect(t).not.toMatch(/\bretries\b|\bredone\b/i);
  });
});

describe("a denominator says what it counts", () => {
  it("distinguishes attempts from runs when a step retried", () => {
    // `spans` counts attempts. Triage retried, so nine span rows sit across seven
    // runs — and labelling that "9 runs" beside a seven-run total is the population
    // defect this denominator was ADDED to fix, reappearing inside the fix. It looked
    // correct on every other step only because those steps never retried.
    const a = aggregate({
      runs: [run(), run({ runId: "b" })],
      details: [
        { run: run(), spans: [span({ workflowStepRunId: "s1" }), span({ workflowStepRunId: "s2", attempt: 2 })], interventions: [], harnessErrors: [], toolDecisions: [] },
        { run: run({ runId: "b" }), spans: [span({ workflowRunId: "b", workflowStepRunId: "s3" })], interventions: [], harnessErrors: [], toolDecisions: [] },
      ],
    });
    const { container } = render(<Dashboard agg={a} />);
    const text = container.textContent ?? "";
    expect(text).toContain("3 attempts across 2 runs");
    expect(text).not.toContain("3 runs");
  });

  it("says just the run count when every run made one attempt", () => {
    // The longer phrasing earns its place only where the two numbers differ; saying
    // "2 attempts across 2 runs" everywhere would be noise that stops being read.
    const a = aggregate({
      runs: [run()],
      details: [{ run: run(), spans: [span()], interventions: [], harnessErrors: [], toolDecisions: [] }],
    });
    const { container } = render(<Dashboard agg={a} />);
    expect(container.textContent).toContain("1 run");
    expect(container.textContent).not.toContain("attempts across");
  });
});

describe("the step ring closes over steps, not over events", () => {
  it("leaves relaunches out of the ring and totals only the step outcomes", () => {
    // The fixture delivers 1, blocks 2 and relaunches 3. A ring drawn over all three
    // would centre on 6, and 6 is not a number of anything: `spanRelaunches` counts
    // crash events, so a step that crashed twice and then delivered is inside both
    // `delivered` and `relaunches`. The ring must read 3 — and the relaunch count
    // must still be on the panel, in its own unit, rather than dropped to make the
    // arithmetic work.
    const { container } = render(<Dashboard agg={aggregate({ runs: [run()], details: [] })} />);
    const ring = [...container.querySelectorAll("svg")].find((el) =>
      el.getAttribute("aria-label")?.includes("delivered"));
    expect(ring, "no ring carried the step slices").toBeTruthy();
    expect(ring!.getAttribute("aria-label")).toBe("steps: 1 delivered, 2 blocked");
    expect(ring!.textContent).toContain("3");
    expect(ring!.textContent).not.toContain("6");
    expect(container.textContent).toContain("relaunches after a crash");
  });
});

describe("a ring with one slice is still a ring", () => {
  it("draws a full circle when a single part holds everything", () => {
    // The case that chose d3-shape over hand-rolled trig: with one part the arc's
    // start and end land on the same coordinate, and naive path math emits a dot or
    // nothing at all. It is also the case that means every run succeeded — so the
    // degenerate render would arrive precisely when the news is good.
    const { container } = render(
      <Donut caption="runs" parts={[{ label: "completed", value: 7, display: "7", tone: "var(--ok)" }]} />);
    const d = container.querySelector("path")?.getAttribute("d") ?? "";
    expect(d, "a lone 100% slice drew no path").not.toBe("");
    expect(d).toMatch(/A/);
    expect(container.textContent).toContain("100%");
  });
});

describe("unmeasured time is not idle time", () => {
  it("keeps a step whose attempts never reported working time out of 'unaccounted'", () => {
    // A span whose step never completed reports `workingMs: null`. Treating that as
    // zero and subtracting puts the step's whole elapsed into "unaccounted", which
    // states that Orca sat there doing nothing. On the founder's live data Verify and
    // Critique are unmeasured in 2 of 2 attempts — two rows that would have read
    // 100% idle when the truth is 100% unrecorded. Parked survives in those spans
    // because it is built from intervals rather than from completions.
    const a = aggregate({
      runs: [run()],
      details: [{
        run: run(),
        spans: [span({ workflowStepRunId: "s1", name: "Verify", workingMs: null,
                       elapsedMs: 100_000, parkedMs: 30_000 })],
        interventions: [], harnessErrors: [], toolDecisions: [],
      }],
    });
    const v = a.byStep.get("Verify")!;
    expect(v.unmeasuredSpans).toBe(1);
    expect(v.unmeasuredMs).toBe(70_000);
    expect(v.unaccountedMs, "unmeasured time leaked into unaccounted").toBe(0);
    expect(v.parkedMs, "parked is known even when working is not").toBe(30_000);
    // The four terms still add to the step's own elapsed.
    expect(v.workingMs + v.parkedMs + v.unaccountedMs + v.unmeasuredMs).toBe(v.elapsedMs);

    const { container } = render(<Dashboard agg={a} />);
    expect(container.textContent).toContain("1 of 1 not recorded");
  });

  it("never draws a segment backwards when a span over-reports its own clock", () => {
    // Two live spans already report working + parked ABOVE their elapsed. Unclamped,
    // the remainder goes negative and the bar grows the wrong way — so the terms are
    // clamped to keep them addable, which is what the whole duration vocabulary rests
    // on. Asserting the precondition too: a fixture that did not over-report would
    // pass this while proving nothing.
    const over = span({ elapsedMs: 100_000, workingMs: 90_000, parkedMs: 50_000 });
    expect((over.workingMs ?? 0) + (over.parkedMs ?? 0)).toBeGreaterThan(over.elapsedMs!);
    const a = aggregate({ runs: [run()], details: [{ run: run(), spans: [over], interventions: [], harnessErrors: [], toolDecisions: [] }] });
    const t = a.byStep.get("Triage")!;
    expect(t.unaccountedMs).toBeGreaterThanOrEqual(0);
    expect(t.workingMs + t.parkedMs + t.unaccountedMs + t.unmeasuredMs).toBe(t.elapsedMs);
  });
});

describe("a ring centres on a figure, not on a raw sum", () => {
  it("prints the caller's formatted total rather than the float behind it", () => {
    // The component was written for counts, where String(sum) is the right answer.
    // The first money caller put "75.279189" in the middle of the ring: the sum was
    // correct and its presentation was not. Asserting the precondition too — a
    // fixture whose parts happened to add to a round number would pass this while
    // proving nothing.
    const parts = [
      { label: "kept", value: 19.42, display: "$19.42", tone: "var(--ok)" },
      { label: "failed", value: 50.859189, display: "$50.86", tone: "var(--err)" },
    ];
    const raw = String(parts.reduce((a, p) => a + p.value, 0));
    expect(raw, "fixture does not reproduce the defect").toMatch(/\.\d{3,}/);

    const { container } = render(<Donut caption="spent" total="$70.28" parts={parts} />);
    expect(container.textContent).toContain("$70.28");
    expect(container.textContent).not.toContain(raw);
  });
});

describe("every termination cause lands in exactly one slice", () => {
  it("keeps the run-state partition exhaustive across all five causes", () => {
    // One run per cause. If any cause fell through the filters the sum would be short,
    // and the donut would silently show fewer runs than the window holds — the failure
    // mode the old single "stopped" bucket was one relabel away from.
    const causes = ["completed", "running", "infrastructure_killed", "workflow_failed", "unknown"] as const;
    const a = aggregate({
      runs: causes.map((c, i) => run({ runId: `r${i}`, terminationCause: c })),
      details: [],
    });
    expect(a.completed + a.killed + a.workflowFailed + a.stoppedUnknown + a.running).toBe(causes.length);
    expect([a.completed, a.running, a.killed, a.workflowFailed, a.stoppedUnknown]).toEqual([1, 1, 1, 1, 1]);
  });
});

describe("the coverage matrix separates a missing sensor from a missing recording", () => {
  it("keeps gates out of the matrix and reports them as ran-but-unrecorded", () => {
    // Clarify completes and fires nothing: a wiring gap, fixable by adding a sensor.
    // A gate ran and PASSED while emitting no transitions: an instrumentation gap,
    // fixable by emission. Rendering the gate as a 0/0 row beside Clarify's 0/2 would
    // tell the reader to wire a sensor onto something already working.
    const a = aggregate({
      runs: [run()],
      details: [{
        run: run(),
        spans: [
          span({ workflowStepRunId: "s1", name: "Clarify", stepTemplateId: "clarify", kind: "step",
                 completions: 1, verifiers: { executable: false, grounding: false, independentReview: false } }),
          span({ workflowStepRunId: "s2", name: "Verify", stepTemplateId: "__gate__:verify", kind: "gate",
                 status: "passed", completions: 0, workingMs: null, verifiers: null }),
        ],
        interventions: [], harnessErrors: [], toolDecisions: [],
      }],
    });
    expect(a.byStep.get("Clarify")!.completed).toBe(1);
    expect(a.byStep.get("Clarify")!.execChecks).toBe(0);
    expect(a.byStep.get("Verify")!.gatesUnrecorded).toBe(1);
    expect(a.byStep.get("Verify")!.completed, "a gate must contribute no matrix row").toBe(0);

    const t = render(<Dashboard agg={a} />).container.textContent ?? "";
    // The gate's own row has moved off this surface — gate performance now comes from
    // template metrics, in its own panel. What must not regress is the matrix
    // POPULATION: a gate contributes no row, so it can never be read as a step whose
    // sensors are missing, which is the confusion this test exists for.
    expect(t, "Clarify's own row must still be counted").toContain("0/1");
    expect(t, "the headline counts templates, and a gate is not one").toContain("0 of 1");
  });
});

describe("a still-running run cannot move a total", () => {
  it("sums over ended runs only, and keeps every run in the state partition", () => {
    // A live run's elapsed and parked clocks are still accruing, so including it makes
    // a total that changes on reload with nothing having happened. On the founder's
    // data one open run carries 62 of 113 hours and sets the headline by itself.
    // The run must still APPEAR — its state is a fact — it just cannot be summed.
    const a = aggregate({
      runs: [
        run({ runId: "done", terminationCause: "completed", cost: { usd: 10, wastedUsd: 0, failedUsd: 0, supersededUsd: 0, coverage: { reported: 1, total: 1, silent: 0 }, rollupCheck: "matches" } }),
        run({ runId: "live", terminationCause: "running", cost: { usd: 999, wastedUsd: 0, failedUsd: 0, supersededUsd: 0, coverage: { reported: 1, total: 1, silent: 0 }, rollupCheck: "matches" } }),
      ],
      details: [],
    });
    expect(a.usd, "the live run's spend leaked into the total").toBe(10);
    expect(a.ended).toHaveLength(1);
    // Still counted as a run, and still in the partition.
    expect(a.runs).toHaveLength(2);
    expect(a.completed + a.killed + a.workflowFailed + a.stoppedUnknown + a.running).toBe(2);
    expect(a.running).toBe(1);
  });

  it("says out loud which runs the headline left out", () => {
    // Excluding silently is the worse half: the figure would be stable and the reader
    // would have no way to know a run was missing from it.
    const a = aggregate({
      runs: [run({ runId: "done" }), run({ runId: "live", terminationCause: "running" })],
      details: [],
    });
    const t = render(<Dashboard agg={a} />).container.textContent ?? "";
    expect(t).toContain("1 still running, not counted");
  });

  it("drops the exclusion clause when every run has ended", () => {
    // The clause earns its place only when something was actually excluded; carrying
    // "0 still running" on every window is noise that stops being read.
    const a = aggregate({ runs: [run({ runId: "done" })], details: [] });
    const t = render(<Dashboard agg={a} />).container.textContent ?? "";
    expect(t).not.toContain("still running, not counted");
  });
});


describe("the harness's own choices reach the surface", () => {
  it("attributes spend to the model that produced each completion, not to the span", () => {
    // A step that ran haiku ($42, failed) and then opus ($3, passed) is one span
    // with one cost. Summed by span the $45 would have to go to one model or be
    // named as mixed; summed by completion each dollar goes where it was spent.
    const c = (model: string | null, usd: number, outcome = "succeeded", superseded = false) =>
      ({ at: "2026-09-01T00:10:00.000Z", model, usd, outcome, failureCode: null, superseded, gated: true });
    const a = aggregate({
      runs: [run({ terminationCause: "completed" })],
      details: [{ run: run(), spans: [
        span({ workflowStepRunId: "s1", name: "Triage", completionLog: [c("claude-haiku-4-5-20251001", 3, "failed")] }),
        span({ workflowStepRunId: "s2", name: "Proposal", completionLog: [c("claude-haiku-4-5-20251001", 2, "succeeded", true)] }),
        span({ workflowStepRunId: "s3", name: "Execution", completionLog: [c("claude-haiku-4-5-20251001", 42, "failed", true), c("claude-opus-5", 3)] }),
        span({ workflowStepRunId: "s4", name: "Verify", kind: "gate", completionLog: [], cost: null }),
      ], interventions: [], harnessErrors: [], toolDecisions: [] }],
    });
    expect([...a.byModel.entries()]).toEqual([
      ["claude-haiku-4-5-20251001", { usd: 47, attempts: 3, failed: 2, replaced: 1 }],
      ["claude-opus-5", { usd: 3, attempts: 1, failed: 0, replaced: 0 }],
    ]);
    const t = render(<Dashboard agg={a} />).container.textContent ?? "";
    expect(t).toContain("claude-haiku-4-5");
    expect(t).toContain("$47.00 · 3 attempts · 2 failed · 1 replaced");
    expect(t).toContain("claude-opus-5");
    expect(t).not.toContain("mixed");
  });

  it("names a completion with no recorded model as such, never as free", () => {
    const a = aggregate({
      runs: [run({ terminationCause: "completed" })],
      details: [{ run: run(), spans: [span({ completionLog: [{ at: "2026-09-01T00:10:00.000Z", model: null, usd: 7, outcome: "succeeded", failureCode: null, superseded: false, gated: true }] })], interventions: [], harnessErrors: [], toolDecisions: [] }],
    });
    expect(a.byModel.get("model not recorded")).toEqual({ usd: 7, attempts: 1, failed: 0, replaced: 0 });
  });

  it("totals the pauses by kind over ended runs, with the ones whose reason was lost named as such", () => {
    // Every figure is a count or a sum of park LENGTHS — not a share of wall
    // clock, because parks overlap and the run's own split already owns that.
    const a = aggregate({
      runs: [run({ runId: "a", terminationCause: "completed" }), run({ runId: "live", terminationCause: "running" })],
      details: [
        { run: run({ runId: "a" }), spans: [], harnessErrors: [], toolDecisions: [], interventions: [
          park({ activityId: "p1", sourceKind: "step_confirmation_pending", durationMs: 60_000, exitedAt: "x", open: false, parkState: "resolved" }),
          park({ activityId: "p2", sourceKind: "step_confirmation_pending", durationMs: 30_000, exitedAt: "x", open: false, parkState: "resolved" }),
          park({ activityId: "p3", sourceKind: "unknown", durationMs: 5_000, exitedAt: "x", open: false, parkState: "resolved" }),
          // Abandoned on a dead run: its duration is the card's AGE, still growing,
          // and must be counted but never summed.
          park({ activityId: "p4", sourceKind: "step_confirmation_pending", durationMs: 400 * H, exitedAt: null, open: true, parkState: "abandoned" }),
        ] },
        { run: run({ runId: "live" }), spans: [], harnessErrors: [], toolDecisions: [], interventions: [
          park({ activityId: "p9", sourceKind: "provider_recovery_pending", durationMs: 999 * H }),
        ] },
      ],
    });
    expect([...a.parksByKind.entries()]).toEqual([
      ["step_confirmation_pending", { count: 3, totalMs: 90_000, longestMs: 60_000, abandoned: 1 }],
      ["unknown", { count: 1, totalMs: 5_000, longestMs: 5_000, abandoned: 0 }],
    ]);
    const t = render(<Dashboard agg={a} />).container.textContent ?? "";
    expect(t).toContain("a step to confirm");
    expect(t).toContain("3 pauses · 1m 30s in all · longest 1m 0s · 1 left unanswered when the run stopped");
    expect(t).not.toContain("400h");
    expect(t).toContain("reason not kept");
    expect(t).not.toContain("provider recovery");
  });

  it("sums the four token kinds across ended runs, with cache as its own term", () => {
    const a = aggregate({
      runs: [run({ terminationCause: "completed" })],
      details: [{ run: run(), spans: [
        span({ workflowStepRunId: "s1", cost: { usd: 1, tokensIn: 100, tokensOut: 200, cacheReadTokens: 5000, cacheCreationTokens: 300, state: "reported" } }),
        span({ workflowStepRunId: "s2", cost: { usd: 1, tokensIn: 50, tokensOut: 50, cacheReadTokens: null, cacheCreationTokens: null, state: "reported" } }),
      ], interventions: [], harnessErrors: [], toolDecisions: [] }],
    });
    expect(a.tokens).toEqual({ fresh: 150, output: 250, cacheRead: 5000, cacheWrite: 300, attempts: 2, spansWithoutCache: 1 });
    const t = render(<Dashboard agg={a} />).container.textContent ?? "";
    expect(t).toContain("5.0k");
    expect(t).toContain("1 of 2 attempts recorded no cache figure");
  });

  it("prints millions of tokens as millions", () => {
    const a = aggregate({
      runs: [run({ terminationCause: "completed" })],
      details: [{ run: run(), spans: [span({ cost: { usd: 1, tokensIn: 100, tokensOut: 200, cacheReadTokens: 88_590_700, cacheCreationTokens: 300, state: "reported" } })], interventions: [], harnessErrors: [], toolDecisions: [] }],
    });
    const t = render(<Dashboard agg={a} />).container.textContent ?? "";
    expect(t).toContain("88.6M");
    expect(t).not.toContain("88590.7k");
  });

  it("splits the window by template version, as counts and sums per version", () => {
    // Harness revisions are the comparison this page exists for, and pooling
    // v13 with v16 hides whether v16 fixed anything. One row per version; every
    // cell is a count or a sum over that version's ended runs.
    const a = aggregate({
      runs: [
        run({ runId: "a", templateVersion: 14, terminationCause: "completed", stepsDelivered: 8 }),
        run({ runId: "b", templateVersion: 16, terminationCause: "infrastructure_killed", stepsDelivered: 0 }),
        run({ runId: "c", templateVersion: 16, terminationCause: "running", stepsDelivered: 5 }),
      ],
      details: [],
    });
    expect(a.byVersion.map((v) => [v.version, v.runs, v.ended, v.completed, v.killed, v.delivered])).toEqual([
      [16, 2, 1, 0, 1, 0],
      [14, 1, 1, 1, 0, 8],
    ]);
    const t = render(<Dashboard agg={a} />).container.textContent ?? "";
    expect(t).toContain("v16");
    expect(t).toContain("v14");
  });

  it("lists what the safety floor stopped, by reason, across ended runs", () => {
    const a = aggregate({
      runs: [run({ runId: "a", terminationCause: "completed" }), run({ runId: "live", terminationCause: "running" })],
      details: [
        { run: run({ runId: "a" }), spans: [], interventions: [], harnessErrors: [], toolDecisions: [
          { workflowStepRunId: "s1", stepName: "Execution", at: "2026-09-01T00:05:00.000Z", decision: "deny", riskClass: "critical", reasons: ["bash: destructive recursive delete (rm -rf)"] },
          { workflowStepRunId: "s1", stepName: "Execution", at: "2026-09-01T00:06:00.000Z", decision: "deny", riskClass: "critical", reasons: ["bash: destructive recursive delete (rm -rf)"] },
          { workflowStepRunId: "s1", stepName: "Execution", at: "2026-09-01T00:07:00.000Z", decision: "require_approval", riskClass: "medium", reasons: ["bash: writes outside the workspace"] },
        ] },
        { run: run({ runId: "live" }), spans: [], interventions: [], harnessErrors: [], toolDecisions: [
          { workflowStepRunId: "s9", stepName: "Execution", at: "2026-09-02T00:05:00.000Z", decision: "deny", riskClass: "critical", reasons: ["bash: access to a secret/credential file"] },
        ] },
      ],
    });
    expect([...a.stopsByReason.entries()]).toEqual([
      ["bash: destructive recursive delete (rm -rf)", { denied: 2, approvals: 0 }],
      ["bash: writes outside the workspace", { denied: 0, approvals: 1 }],
    ]);
    // The counts and the reasons are read from the same rows, so they agree by
    // construction — the live run's denial is in neither.
    expect(a.stops).toEqual({ denied: 2, approvals: 1, allowed: 0 });
    const t = render(<Dashboard agg={a} />).container.textContent ?? "";
    expect(t).toContain("rm -rf");
    // The panel's own prose names "a credential file" as a category; the live run's
    // REASON is the specific string, and that is what must stay off the surface.
    expect(t).not.toContain("secret/credential");
  });
});

describe("choosing the workflow to inspect", () => {
  // All inside the default 24-hour window of the faked clock.
  const two = () => [
    run({ runId: "old-a", templateId: "t-a", templateName: "Adaptive Delivery", startedAt: "2026-09-01T00:00:00.000Z" }),
    run({ runId: "b1", templateId: "t-b", templateName: "Bug Triage", startedAt: "2026-09-01T10:00:00.000Z" }),
    run({ runId: "a2", templateId: "t-a", templateName: "Adaptive Delivery", startedAt: "2026-09-01T05:00:00.000Z" }),
  ];

  it("lists each workflow that has runs, most recently run first, with its run count", () => {
    expect(workflowsOf(two())).toEqual([
      { templateId: "t-b", name: "Bug Triage", runs: 1 },
      { templateId: "t-a", name: "Adaptive Delivery", runs: 2 },
    ]);
  });

  it("opens on the most recently run workflow and switches every panel when another is chosen", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-01T12:00:00.000Z") });
    vi.spyOn(api, "getRunSummaries").mockResolvedValue(two());
    vi.spyOn(api, "getRunDetail").mockImplementation(async (id) => ({
      run: two().find((r) => r.runId === id)!, spans: [], interventions: [], harnessErrors: [], toolDecisions: [],
    }));
    const gates = vi.spyOn(api, "getTemplateMetricsDetail").mockRejectedValue(new Error("no template metrics"));
    render(<WorkflowRollup />);
    await waitFor(() => expect(document.body.textContent).toContain("spent across 1 run"));
    // The gate fetch is keyed to the CHOSEN template, never to the first of several.
    // Its only version is the latest, so the scope is exact; the default window
    // maps to the 24-hour period.
    expect(gates).toHaveBeenCalledWith("t-b", "24h", "latest");

    fireEvent.click(screen.getByText("Bug Triage"));
    fireEvent.click(screen.getByText("Adaptive Delivery"));
    await waitFor(() => expect(document.body.textContent).toContain("spent across 2 runs"));
    expect(gates).toHaveBeenCalledWith("t-a", "24h", "latest");
    // The other workflow's run is not in any figure once it is deselected.
    expect(document.body.textContent).not.toContain("spent across 3 runs");
    vi.useRealTimers();
  });
});

describe("choosing the version to inspect", () => {
  // All inside the default 24-hour window of the faked clock.
  const runs = () => [
    run({ runId: "v14-a", templateVersion: 14, startedAt: "2026-09-01T00:00:00.000Z" }),
    run({ runId: "v16-a", templateVersion: 16, startedAt: "2026-09-01T10:00:00.000Z" }),
    run({ runId: "v14-b", templateVersion: 14, startedAt: "2026-09-01T05:00:00.000Z" }),
    run({ runId: "v13-a", templateVersion: 13, startedAt: "2026-09-01T02:00:00.000Z" }),
  ];

  it("lists the versions with runs, newest version first, with run counts", () => {
    expect(versionsOf(runs())).toEqual([
      { version: 16, runs: 1 },
      { version: 14, runs: 2 },
      { version: 13, runs: 1 },
    ]);
  });

  it("opens on the version of the most recent run, and switches when another is chosen", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-01T12:00:00.000Z") });
    vi.spyOn(api, "getRunSummaries").mockResolvedValue(runs());
    vi.spyOn(api, "getRunDetail").mockImplementation(async (id) => ({
      run: runs().find((r) => r.runId === id)!, spans: [], interventions: [], harnessErrors: [], toolDecisions: [],
    }));
    const gates = vi.spyOn(api, "getTemplateMetricsDetail").mockRejectedValue(new Error("none"));
    render(<WorkflowRollup />);
    await waitFor(() => expect(document.body.textContent).toContain("spent across 1 run"));
    // The newest version IS the latest, so the gate figures can be scoped to it.
    expect(gates).toHaveBeenCalledWith("t", "24h", "latest");

    fireEvent.click(screen.getByText("v16"));
    fireEvent.click(screen.getByText("v14"));
    await waitFor(() => expect(document.body.textContent).toContain("spent across 2 runs"));
    // An older version has no gate scope of its own; the fetch widens to every
    // version and the panel must say so.
    expect(gates).toHaveBeenCalledWith("t", "24h", "all");

    fireEvent.click(screen.getByText("v14"));
    fireEvent.click(screen.getByText("All versions"));
    await waitFor(() => expect(document.body.textContent).toContain("spent across 4 runs"));
    expect(document.body.textContent).toContain("By template version");
    vi.useRealTimers();
  });

  it("says when the gate figures cover every version while one version is chosen", () => {
    // Only the fields the panel reads; the rest of the template detail is irrelevant here.
    const gates = {
      completionGate: { verdictDist: { upheld: 1, evidence_veto: 0, refute_veto: 0, escalated: 0 } },
      gates: [{ name: "Critique", sampleSize: 3 }], splitters: [],
    } as unknown as TemplateMetricsDetail;
    const t = render(<Dashboard agg={aggregate({
      runs: [run({ terminationCause: "completed" })], details: [], gates, gatesCoverEveryVersion: true,
    })} />).container.textContent ?? "";
    expect(t).toContain("across every version");
    const without = render(<Dashboard agg={aggregate({
      runs: [run({ terminationCause: "completed" })], details: [], gates,
    })} />).container.textContent ?? "";
    expect(without).not.toContain("across every version");
  });
});

describe("what the gates decided, from the same rows as everything else", () => {
  it("maps each gated completion to its verdict exactly as the daemon does, and skips the ungated", () => {
    // The mapping is copied from the daemon's gate-metrics module: a reviewer veto is
    // "sent back — reviewer"; an evidence veto is "escalated" when the outcome says so
    // and "sent back — no evidence" otherwise; anything else the gate saw is upheld.
    // A completion the gate never judged (no evidence record) is not a verdict.
    const c = (outcome: string, failureCode: string | null, gated = true) =>
      ({ at: "2026-09-01T00:10:00.000Z", model: null, usd: 1, outcome, failureCode, superseded: false, gated });
    const a = aggregate({
      runs: [run({ terminationCause: "completed" }), run({ runId: "live", terminationCause: "running" })],
      details: [
        { run: run(), interventions: [], harnessErrors: [], toolDecisions: [], spans: [
          span({ workflowStepRunId: "s1", completionLog: [c("succeeded", null), c("failed", "refute_veto")] }),
          span({ workflowStepRunId: "s2", completionLog: [c("failed", "evidence_veto"), c("escalated", "evidence_veto")] }),
          span({ workflowStepRunId: "s3", completionLog: [c("succeeded", null, false)] }),
          span({ workflowStepRunId: "s4", kind: "gate", completionLog: [c("succeeded", null)] }),
        ] },
        { run: run({ runId: "live" }), interventions: [], harnessErrors: [], toolDecisions: [], spans: [
          span({ workflowStepRunId: "s9", completionLog: [c("succeeded", null)] }),
        ] },
      ],
    });
    expect(a.verdicts).toEqual({ upheld: 1, refute_veto: 1, evidence_veto: 1, escalated: 1 });
    const t = render(<Dashboard agg={a} />).container.textContent ?? "";
    expect(t).toContain("What the gates decided");
    expect(t).toContain("upheld");
    expect(t).toContain("sent back — reviewer");
    // No longer a different window from the matrix; the caption must not claim one.
    expect(t).not.toContain("different window");
    expect(t).not.toContain("not the same set");
  });

  it("draws the ring without the template endpoint, and adds the gate-node lines only with it", () => {
    const base = { runs: [run({ terminationCause: "completed" })], details: [] as RunDetail[] };
    const without = render(<Dashboard agg={aggregate({ ...base, gates: null })} />).container.textContent ?? "";
    expect(without).toContain("What the gates decided");
    expect(without).not.toContain("aren't available");
    const gates = {
      completionGate: { verdictDist: { upheld: 99, evidence_veto: 0, refute_veto: 0, escalated: 0 } },
      gates: [{ name: "Critique", sampleSize: 3 }], splitters: [],
    } as unknown as TemplateMetricsDetail;
    const withGates = render(<Dashboard agg={aggregate({ ...base, gates })} />).container.textContent ?? "";
    expect(withGates).toContain("Critique decided 3 times");
    // The endpoint's own verdict count is not what the ring shows any more.
    expect(withGates).not.toContain("99");
  });
});

describe("choosing the window to inspect", () => {
  const NOW = Date.parse("2026-09-05T12:00:00.000Z");
  const runs = () => [
    run({ runId: "h1", startedAt: "2026-09-05T11:30:00.000Z" }),            // 30m ago
    run({ runId: "d1", startedAt: "2026-09-04T13:00:00.000Z" }),            // 23h ago
    run({ runId: "w1", startedAt: "2026-09-01T12:00:00.000Z" }),            // 4d ago
    run({ runId: "m1", startedAt: "2026-08-10T12:00:00.000Z" }),            // 26d ago
    run({ runId: "old", startedAt: "2026-07-28T05:00:00.000Z" }),           // 39d ago
  ];

  it("offers the eight ranges in order and keeps the runs that were ACTIVE inside the window", () => {
    expect(RANGES.map((r) => r.label)).toEqual([
      "Last 1 hour", "Last 8 hours", "Last 12 hours", "Last 24 hours",
      "Last 3 days", "Last 7 days", "Last 14 days", "Last 1 month",
    ]);
    // Every fixture run lasted 10 hours (the fixture's elapsed) and ended.
    const ids = (key: string) => withinWindow(runs(), key, NOW).map((r) => r.runId);
    expect(ids("1h")).toEqual(["h1"]);
    expect(ids("24h")).toEqual(["h1", "d1"]);
    expect(ids("7d")).toEqual(["h1", "d1", "w1"]);
    expect(ids("1mo")).toEqual(["h1", "d1", "w1", "m1"]);
    // A run that ended INSIDE the window belongs to it even though it started before.
    const spans = run({ runId: "spans", startedAt: "2026-09-04T00:00:00.000Z",
      durations: { elapsedMs: 36 * 3_600_000, workingMs: 0, parkedMs: 0, unaccountedMs: 36 * 3_600_000, spanActiveMs: 0, accruing: false, integrityFlag: null } });
    expect(withinWindow([spans], "1h", NOW).map((r) => r.runId)).toEqual(["spans"]);
    // A run still running is active in every window, however long ago it began —
    // the stuck run IS stuck in every window.
    const live = run({ runId: "live", startedAt: "2026-07-01T00:00:00.000Z", terminationCause: "running" });
    expect(withinWindow([live], "1h", NOW).map((r) => r.runId)).toEqual(["live"]);
  });

  it("maps a window to the smallest template period that contains it", () => {
    expect(gatePeriodFor("1h")).toBe("24h");
    expect(gatePeriodFor("24h")).toBe("24h");
    expect(gatePeriodFor("3d")).toBe("7d");
    expect(gatePeriodFor("14d")).toBe("30d");
    expect(gatePeriodFor("1mo")).toBe("30d");
  });

  it("opens on the last 24 hours, and leaves the choosers in place when the window is empty", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    vi.spyOn(api, "getRunSummaries").mockResolvedValue(runs());
    vi.spyOn(api, "getRunDetail").mockImplementation(async (id) => ({
      run: runs().find((r) => r.runId === id)!, spans: [], interventions: [], harnessErrors: [], toolDecisions: [],
    }));
    const gates = vi.spyOn(api, "getTemplateMetricsDetail").mockRejectedValue(new Error("none"));
    try {
      render(<WorkflowRollup />);
      await waitFor(() => expect(document.body.textContent).toContain("spent across 2 runs"));
      expect(gates).toHaveBeenCalledWith("t", "24h", "latest");

      // The window is the outermost filter: the workflow chooser counts runs INSIDE it.
      expect(screen.getByText("Adaptive Delivery").parentElement?.textContent).toContain("2 runs");

      fireEvent.click(screen.getByText("Last 24 hours"));
      fireEvent.click(screen.getByText("Last 7 days"));
      await waitFor(() => expect(document.body.textContent).toContain("spent across 3 runs"));
      expect(gates).toHaveBeenCalledWith("t", "7d", "latest");

      // Empty window: say exactly what is empty and keep EVERY chooser — the
      // workflow and version pickers were the first casualties of an empty
      // window, and a range picker beside nothing says nothing about what it
      // filters.
      vi.setSystemTime(NOW + 40 * 24 * 3_600_000);
      fireEvent.click(screen.getByText("Last 7 days"));
      fireEvent.click(screen.getByText("Last 1 hour"));
      await waitFor(() => expect(document.body.textContent).toContain("No Adaptive Delivery v16 runs were active in the last 1 hour"));
      expect(screen.getByText("Last 1 hour")).toBeTruthy();
      expect(screen.getByText("Adaptive Delivery")).toBeTruthy();
      expect(screen.getByText("v16").parentElement?.textContent).toContain("0 runs");
      expect(document.body.textContent).not.toContain("spent across");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("choosing the step the window is divided into", () => {
  it("offers every step that divides the window evenly into 2 to 168 points", () => {
    // One rule, not eight lists; it reproduces the founder's two examples exactly.
    const labels = (range: string) => intervalsFor(range).map((i) => i.label);
    expect(labels("1h")).toEqual(["1 minute", "5 minutes", "10 minutes", "15 minutes", "30 minutes"]);
    expect(labels("7d")).toEqual(["1 hour", "2 hours", "4 hours", "8 hours", "12 hours", "1 day"]);
    expect(labels("1mo")).toEqual(["8 hours", "12 hours", "1 day", "2 days"]);
    // Every offered step divides the window with nothing left over.
    for (const r of RANGES) for (const i of intervalsFor(r.key)) expect(r.ms % i.ms).toBe(0);
  });

  it("reports how many points each step yields", () => {
    expect(intervalsFor("24h").map((i) => [i.label, i.points])).toEqual([
      ["10 minutes", 144], ["15 minutes", 96], ["30 minutes", 48], ["1 hour", 24],
      ["2 hours", 12], ["4 hours", 6], ["8 hours", 3], ["12 hours", 2],
    ]);
  });

  it("defaults to the step closest to 24 points", () => {
    expect(defaultIntervalFor("1h")).toBe("5m");
    expect(defaultIntervalFor("24h")).toBe("1h");
    expect(defaultIntervalFor("7d")).toBe("8h");
    expect(defaultIntervalFor("1mo")).toBe("1d");
  });

  it("keeps the chosen step across a range change when it still fits, else falls back", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-05T12:00:00.000Z") });
    vi.spyOn(api, "getRunSummaries").mockResolvedValue([run({ startedAt: "2026-09-05T11:00:00.000Z" })]);
    vi.spyOn(api, "getRunDetail").mockResolvedValue({ run: run(), spans: [], interventions: [], harnessErrors: [], toolDecisions: [] });
    vi.spyOn(api, "getTemplateMetricsDetail").mockRejectedValue(new Error("none"));
    render(<WorkflowRollup />);
    await waitFor(() => expect(document.body.textContent).toContain("spent across"));
    expect(screen.getByText("1 hour").parentElement?.textContent).toContain("24 points");

    // Chosen explicitly. An unchosen step is "the default for this window", and
    // follows the window; only a chosen one is worth carrying across.
    fireEvent.click(screen.getByText("1 hour"));
    fireEvent.click(screen.getAllByText("1 hour")[1]!);

    // 1 hour fits a 7-day window, so it survives the change.
    fireEvent.click(screen.getByText("Last 24 hours"));
    fireEvent.click(screen.getByText("Last 7 days"));
    expect(screen.getByText("1 hour").parentElement?.textContent).toContain("168 points");

    // It does not fit a 1-hour window; the default for that window takes over.
    fireEvent.click(screen.getByText("Last 7 days"));
    fireEvent.click(screen.getByText("Last 1 hour"));
    expect(screen.getByText("5 minutes").parentElement?.textContent).toContain("12 points");
  });
});

describe("when the harness failed", () => {
  const err = (at: string, kind: "crash_relaunch" | "infra_failure" | "run_killed", detail: string | null = null) =>
    ({ at, kind, stepName: "Triage", detail });

  it("keeps the events inside the window, from live runs too, in time order", () => {
    const from = Date.parse("2026-09-01T00:00:00.000Z"), to = Date.parse("2026-09-02T00:00:00.000Z");
    const a = aggregate({
      runs: [run({ runId: "a", terminationCause: "completed" }), run({ runId: "live", terminationCause: "running" })],
      details: [
        { run: run({ runId: "a" }), spans: [], interventions: [], toolDecisions: [], harnessErrors: [
          err("2026-09-01T12:00:00.000Z", "run_killed", "crashed 3 times"),
          err("2026-08-31T23:59:00.000Z", "crash_relaunch"),   // before the window
        ] },
        { run: run({ runId: "live", terminationCause: "running" }), spans: [], interventions: [], toolDecisions: [], harnessErrors: [
          err("2026-09-01T04:10:00.000Z", "crash_relaunch"),
        ] },
      ],
      window: { fromMs: from, toMs: to }, intervalMs: 3_600_000,
    });
    expect(a.harnessErrors.map((e) => [e.at, e.kind])).toEqual([
      ["2026-09-01T04:10:00.000Z", "crash_relaunch"],
      ["2026-09-01T12:00:00.000Z", "run_killed"],
    ]);
    const { container } = render(<Dashboard agg={a} />);
    // Under their own Harness heading, ahead of What happened.
    const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings.indexOf("Harness")).toBe(0);
    expect(headings.indexOf("Harness")).toBeLessThan(headings.indexOf("What happened"));
    // One panel per kind, each carrying its own total.
    expect(container.textContent).toContain("Worker crashes");
    expect(container.textContent).toContain("Failures inside the harness");
    expect(container.textContent).toContain("Runs stopped by the harness");
    const counted = [...container.querySelectorAll("[data-bar]")].map((r) => Number(r.getAttribute("data-count")));
    expect(counted.reduce((x, n) => x + n, 0)).toBe(2);
  });

  it("says a kind's window is empty rather than drawing an empty axis", () => {
    const from = Date.parse("2026-09-01T00:00:00.000Z");
    const a = aggregate({ runs: [run({ terminationCause: "completed" })], details: [], window: { fromMs: from, toMs: from + 24 * 3_600_000 }, intervalMs: 3_600_000 });
    const { container } = render(<Dashboard agg={a} />);
    expect((container.textContent?.match(/Nothing recorded in this window/g) ?? []).length).toBe(3);
    expect(container.querySelectorAll("[data-bar]")).toHaveLength(0);
  });
});

describe("occurrences per interval", () => {
  // Local midnight: buckets are in the reader's own time, like every date on the
  // ledger, so the fixtures are built in local time too.
  const midnight = new Date(2026, 8, 1, 0, 0, 0).getTime();
  const H = 3_600_000;

  it("counts events into whole-clock buckets and keeps the zeros", () => {
    const b = bucketize([midnight + 30 * 60_000, midnight + 45 * 60_000, midnight + 5 * H], midnight, midnight + 6 * H, H);
    expect(b.map((x) => x.count)).toEqual([2, 0, 0, 0, 0, 1]);
    expect(b[0]!.startMs).toBe(midnight);
    expect(b[5]!.endMs).toBe(midnight + 6 * H);
  });

  it("snaps to the clock when the window opens mid-hour, keeping the partial edge buckets", () => {
    // A window from 17:22 to 23:22 at one hour: buckets 17:00–18:00 (partial) up
    // to 23:00–00:00 (partial). Seven buckets, not six, and none padded.
    const from = new Date(2026, 8, 1, 17, 22).getTime();
    const b = bucketize([from + 60_000], from, from + 6 * H, H);
    expect(b).toHaveLength(7);
    expect(b[0]!.startMs).toBe(new Date(2026, 8, 1, 17, 0).getTime());
    expect(b[0]!.count).toBe(1);
    expect(b[6]!.endMs).toBe(new Date(2026, 8, 2, 0, 0).getTime());
  });

  it("draws one bar per bucket with the count in its hover text, and whole-number gridlines", () => {
    const b = bucketize([midnight + 60_000, midnight + 120_000, midnight + 2 * H], midnight, midnight + 4 * H, H);
    const { container } = render(<TimeBars buckets={b} fromMs={midnight} toMs={midnight + 4 * H} unit={{ one: "failure", many: "failures" }} />);
    const bars = [...container.querySelectorAll("[data-bar]")];
    expect(bars).toHaveLength(4);
    expect(bars[0]!.querySelector("title")?.textContent).toBe("Sep 01 00:00 → Sep 01 01:00: 2 failures");
    expect(bars[1]!.getAttribute("height")).toBe("0");
    // Gridlines are whole occurrences: 1 and 2, never 0.5.
    const grid = [...container.querySelectorAll("text.mono")].map((t) => t.textContent).filter((t) => /^\d+$/.test(t ?? ""));
    expect(grid).toEqual(["1", "2"]);
  });

  it("labels whole days when the labelled ticks are a day apart", () => {
    const start = new Date(2026, 7, 29, 17, 22).getTime();
    const b = bucketize([start + H], start, start + 7 * 24 * H, 8 * H);
    const { container } = render(<TimeBars buckets={b} fromMs={start} toMs={start + 7 * 24 * H} unit={{ one: "x", many: "x" }} />);
    const labels = [...container.querySelectorAll("text.mono")].map((t) => t.textContent).filter((t) => /[A-Z]/.test(t ?? ""));
    expect(labels.length).toBeLessThanOrEqual(7);
    expect(labels[0]).toBe("Aug 30 00:00");
    expect(new Set(labels).size).toBe(labels.length);
  });
});
