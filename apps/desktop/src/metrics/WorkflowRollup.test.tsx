import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunSummary } from "@orca/contracts";
import { WorkflowCard, rollupByWorkflow } from "./WorkflowRollup";

afterEach(cleanup);
const H = 3_600_000;

function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "r1", goalId: "g1", goalTitle: "A goal", templateId: "t", templateName: "Adaptive Delivery",
    templateVersion: 16, status: "completed", startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T01:00:00.000Z", blockedReason: null,
    terminationCause: "infrastructure_killed", terminationEvidence: null,
    durations: { elapsedMs: 10 * H, workingMs: H, parkedMs: 8 * H, unaccountedMs: H,
                 spanActiveMs: 0, accruing: false, integrityFlag: null },
    cost: { usd: 10, wastedUsd: 0, failedUsd: 0, supersededUsd: 0,
            coverage: { reported: 1, total: 1, silent: 0 }, rollupCheck: "matches" },
    stepsDelivered: 1, stepsBlocked: 0, spanRelaunches: 0, retriedCompletions: 0, openInterventions: 0,
    progress: { lastProgressAt: null, lastProgressChannel: null, lastSignalAt: null,
                lastSignalChannel: null, silenceConclusive: true },
    awaitingYou: { count: 0, sinceMs: null, sourceKind: null },
    ...over,
  };
}

describe("rollupByWorkflow", () => {
  it("sums what can be summed and counts how runs ended", () => {
    // Every figure on this page is arithmetic over observed runs — exact at n=1 and
    // at n=7, with no sampling distribution. That is why they render at full weight
    // rather than hedged: nothing here is an estimate.
    const [g] = rollupByWorkflow([
      run(), run({ runId: "b", terminationCause: "completed" }), run({ runId: "c", terminationCause: "running" }),
    ]);
    expect(g!.runs).toHaveLength(3);
    expect(g!.usd).toBe(30);
    expect(g!.elapsedMs).toBe(30 * H);
    expect(g!.completed).toBe(1);
    expect(g!.stopped).toBe(1);
    expect(g!.running).toBe(1);
    // The counts account for every run — the reader can add them in front of us.
    expect(g!.completed + g!.stopped + g!.running).toBe(g!.runs.length);
  });

  it("keeps the four duration terms addable", () => {
    const [g] = rollupByWorkflow([run(), run({ runId: "b" })]);
    expect(g!.workingMs + g!.parkedMs + g!.unaccountedMs).toBe(g!.elapsedMs);
  });

  it("separates workflows rather than pooling them", () => {
    // Two templates are two different tasks. They are never compared, never deltaed,
    // and never summed together — a difference between them measures what they were
    // asked to do, not how well they did it, and no sample size fixes that.
    const rs = rollupByWorkflow([run(), run({ runId: "b", templateId: "u", templateName: "Other" })]);
    expect(rs).toHaveLength(2);
  });
});

describe("the page says what its denominator is made of", () => {
  it("names how many runs Orca stopped, beside the totals they are computed over", () => {
    // A ratio of sums is dominated by the longest run, so it answers "where did my
    // time go in total" and not "what does a run look like". And most of these runs
    // were killed by the substrate: for total time they legitimately count, for
    // workflow behaviour they do not. Unstated, that is the contamination defect.
    const [g] = rollupByWorkflow([run(), run({ runId: "b" }), run({ runId: "c", terminationCause: "completed" })]);
    const { container } = render(<WorkflowCard rollup={g!} />);
    const text = container.textContent ?? "";
    expect(text).toContain("2 of which Orca stopped before finishing");
    expect(text).toContain("where your time went in total");
  });

  it("renders no mean, no grade, no trend arrow", () => {
    // A mean over a 460x duration range is a number no run resembles, so it is off
    // this page at every n rather than unlocked at eight.
    const [g] = rollupByWorkflow([run(), run({ runId: "b" })]);
    const { container } = render(<WorkflowCard rollup={g!} />);
    expect(container.textContent).not.toMatch(/average|mean|▲|▼|\b[ABCDF]\/100\b/);
  });
});
