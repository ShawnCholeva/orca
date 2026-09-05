import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Intervention, RunDetail, RunSummary, RunTraceSpan } from "@orca/contracts";
import { Dashboard, WorkflowRollup, aggregate, workflowsOf } from "./WorkflowRollup";
import * as api from "../api";
import { Donut } from "./dashboard-panels";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
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
    { run: run(), spans: [span()], interventions: [park()], toolDecisions: [], ...over },
    { run: run({ runId: "b" }), spans: [span({ workflowStepRunId: "s2", name: "Execution", cost: { usd: 40, tokensIn: 1, tokensOut: 1, cacheReadTokens: null, cacheCreationTokens: null, state: "reported" } })], interventions: [park({ activityId: "a2", sourceKind: "question_pending" })], toolDecisions: [] },
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
        { run: run(), spans: [span({ workflowStepRunId: "s1" }), span({ workflowStepRunId: "s2", attempt: 2 })], interventions: [], toolDecisions: [] },
        { run: run({ runId: "b" }), spans: [span({ workflowRunId: "b", workflowStepRunId: "s3" })], interventions: [], toolDecisions: [] },
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
      details: [{ run: run(), spans: [span()], interventions: [], toolDecisions: [] }],
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
        interventions: [], toolDecisions: [],
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
    const a = aggregate({ runs: [run()], details: [{ run: run(), spans: [over], interventions: [], toolDecisions: [] }] });
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
        interventions: [], toolDecisions: [],
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
      ({ at: "2026-09-01T00:10:00.000Z", model, usd, outcome, failureCode: null, superseded });
    const a = aggregate({
      runs: [run({ terminationCause: "completed" })],
      details: [{ run: run(), spans: [
        span({ workflowStepRunId: "s1", name: "Triage", completionLog: [c("claude-haiku-4-5-20251001", 3, "failed")] }),
        span({ workflowStepRunId: "s2", name: "Proposal", completionLog: [c("claude-haiku-4-5-20251001", 2, "succeeded", true)] }),
        span({ workflowStepRunId: "s3", name: "Execution", completionLog: [c("claude-haiku-4-5-20251001", 42, "failed", true), c("claude-opus-5", 3)] }),
        span({ workflowStepRunId: "s4", name: "Verify", kind: "gate", completionLog: [], cost: null }),
      ], interventions: [], toolDecisions: [] }],
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
      details: [{ run: run(), spans: [span({ completionLog: [{ at: "2026-09-01T00:10:00.000Z", model: null, usd: 7, outcome: "succeeded", failureCode: null, superseded: false }] })], interventions: [], toolDecisions: [] }],
    });
    expect(a.byModel.get("model not recorded")).toEqual({ usd: 7, attempts: 1, failed: 0, replaced: 0 });
  });

  it("totals the pauses by kind over ended runs, with the ones whose reason was lost named as such", () => {
    // Every figure is a count or a sum of park LENGTHS — not a share of wall
    // clock, because parks overlap and the run's own split already owns that.
    const a = aggregate({
      runs: [run({ runId: "a", terminationCause: "completed" }), run({ runId: "live", terminationCause: "running" })],
      details: [
        { run: run({ runId: "a" }), spans: [], toolDecisions: [], interventions: [
          park({ activityId: "p1", sourceKind: "step_confirmation_pending", durationMs: 60_000, exitedAt: "x", open: false, parkState: "resolved" }),
          park({ activityId: "p2", sourceKind: "step_confirmation_pending", durationMs: 30_000, exitedAt: "x", open: false, parkState: "resolved" }),
          park({ activityId: "p3", sourceKind: "unknown", durationMs: 5_000, exitedAt: "x", open: false, parkState: "resolved" }),
          // Abandoned on a dead run: its duration is the card's AGE, still growing,
          // and must be counted but never summed.
          park({ activityId: "p4", sourceKind: "step_confirmation_pending", durationMs: 400 * H, exitedAt: null, open: true, parkState: "abandoned" }),
        ] },
        { run: run({ runId: "live" }), spans: [], toolDecisions: [], interventions: [
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
      ], interventions: [], toolDecisions: [] }],
    });
    expect(a.tokens).toEqual({ fresh: 150, output: 250, cacheRead: 5000, cacheWrite: 300, attempts: 2, spansWithoutCache: 1 });
    const t = render(<Dashboard agg={a} />).container.textContent ?? "";
    expect(t).toContain("5.0k");
    expect(t).toContain("1 of 2 attempts recorded no cache figure");
  });

  it("prints millions of tokens as millions", () => {
    const a = aggregate({
      runs: [run({ terminationCause: "completed" })],
      details: [{ run: run(), spans: [span({ cost: { usd: 1, tokensIn: 100, tokensOut: 200, cacheReadTokens: 88_590_700, cacheCreationTokens: 300, state: "reported" } })], interventions: [], toolDecisions: [] }],
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
        { run: run({ runId: "a" }), spans: [], interventions: [], toolDecisions: [
          { workflowStepRunId: "s1", stepName: "Execution", at: "2026-09-01T00:05:00.000Z", decision: "deny", riskClass: "critical", reasons: ["bash: destructive recursive delete (rm -rf)"] },
          { workflowStepRunId: "s1", stepName: "Execution", at: "2026-09-01T00:06:00.000Z", decision: "deny", riskClass: "critical", reasons: ["bash: destructive recursive delete (rm -rf)"] },
          { workflowStepRunId: "s1", stepName: "Execution", at: "2026-09-01T00:07:00.000Z", decision: "require_approval", riskClass: "medium", reasons: ["bash: writes outside the workspace"] },
        ] },
        { run: run({ runId: "live" }), spans: [], interventions: [], toolDecisions: [
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
  const two = () => [
    run({ runId: "old-a", templateId: "t-a", templateName: "Adaptive Delivery", startedAt: "2026-08-01T00:00:00.000Z" }),
    run({ runId: "b1", templateId: "t-b", templateName: "Bug Triage", startedAt: "2026-09-01T00:00:00.000Z" }),
    run({ runId: "a2", templateId: "t-a", templateName: "Adaptive Delivery", startedAt: "2026-08-15T00:00:00.000Z" }),
  ];

  it("lists each workflow that has runs, most recently run first, with its run count", () => {
    expect(workflowsOf(two())).toEqual([
      { templateId: "t-b", name: "Bug Triage", runs: 1 },
      { templateId: "t-a", name: "Adaptive Delivery", runs: 2 },
    ]);
  });

  it("opens on the most recently run workflow and switches every panel when another is chosen", async () => {
    vi.spyOn(api, "getRunSummaries").mockResolvedValue(two());
    vi.spyOn(api, "getRunDetail").mockImplementation(async (id) => ({
      run: two().find((r) => r.runId === id)!, spans: [], interventions: [], toolDecisions: [],
    }));
    const gates = vi.spyOn(api, "getTemplateMetricsDetail").mockRejectedValue(new Error("no template metrics"));
    render(<WorkflowRollup />);
    await waitFor(() => expect(document.body.textContent).toContain("spent across 1 run"));
    // The gate fetch is keyed to the CHOSEN template, never to the first of several.
    expect(gates).toHaveBeenCalledWith("t-b", "30d", "all");

    fireEvent.click(screen.getByText("Bug Triage"));
    fireEvent.click(screen.getByText("Adaptive Delivery"));
    await waitFor(() => expect(document.body.textContent).toContain("spent across 2 runs"));
    expect(gates).toHaveBeenCalledWith("t-a", "30d", "all");
    // The other workflow's run is not in any figure once it is deselected.
    expect(document.body.textContent).not.toContain("spent across 3 runs");
  });
});
