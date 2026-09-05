import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Intervention, RunDetail, RunSummary, RunTraceSpan } from "@orca/contracts";
import { Dashboard, aggregate } from "./WorkflowRollup";

afterEach(cleanup);
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
    cost: { usd: 5, tokensIn: 1, tokensOut: 1, state: "reported" },
    tier: null, verifiers: null, refuteVerdict: null, conflicts: [],
    outcomeStatus: "succeeded", failureCode: null, ...over,
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
    { run: run(), spans: [span()], interventions: [park()], ...over },
    { run: run({ runId: "b" }), spans: [span({ workflowStepRunId: "s2", name: "Execution", cost: { usd: 40, tokensIn: 1, tokensOut: 1, state: "reported" } })], interventions: [park({ activityId: "a2", sourceKind: "question_pending" })] },
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
    expect(a.completed + a.stopped + a.running).toBe(2);
    expect(a.running).toBe(1);
  });
});

describe("what the dashboard refuses to render", () => {
  const html = () => render(<Dashboard agg={aggregate(loaded())} />).container.textContent ?? "";

  it("shows no rate, mean, percentile, trend arrow or letter grade", () => {
    const t = html();
    expect(t).not.toMatch(/average|\bmean\b|percentile|p50|p90|▲|▼/i);
    expect(t).not.toMatch(/\/100\b/);
  });

  it("counts pauses without splitting them by a cause we cannot trust", () => {
    // `source_kind` is read from a row overwritten as the activity advances, so a
    // categorical breakdown would be confident about a corrupted field — and the
    // corrupted rows are the ones that look fine, showing another pause kind rather
    // than falling through to "unknown".
    const t = html();
    expect(t).toContain("pauses recorded");
    expect(t).toContain("with no reliable reason");
    expect(t).not.toMatch(/question pending|step confirmation|provider recovery/i);
  });

  it("calls extra completions what they are, not retries", () => {
    // A veto-then-pass step emits two step_completes for ONE attempt, which is how a
    // row came to claim "attempt 1" and "redone 1x" at the same time.
    const t = html();
    expect(t).toContain("Completions beyond the first");
    expect(t).not.toMatch(/\bretries\b|\bredone\b/i);
  });
});
