import { describe, expect, it } from "vitest";
import type { RunSummary } from "@orca/contracts";
import { waitingByGoal, waitingLabel, waitingRuns } from "./waiting-on-you";

const HOUR = 3_600_000;

function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "r1", goalId: "g1", goalTitle: "Add a Kelvin conversion",
    templateId: "t", templateName: "Adaptive Delivery",
    templateVersion: 16, status: "running",
    startedAt: "2026-09-01T00:00:00.000Z", finishedAt: null,
    blockedReason: null, terminationCause: "running", terminationEvidence: null,
    durations: {
      elapsedMs: 39 * HOUR, workingMs: HOUR, parkedMs: 38 * HOUR,
      unaccountedMs: 0, spanActiveMs: 0, accruing: true, integrityFlag: null,
    },
    cost: {
      usd: 1.6, wastedUsd: 0, failedUsd: 0, supersededUsd: 0,
      coverage: { reported: 4, total: 4, silent: 0 }, rollupCheck: "not_applicable",
    },
    stepsDelivered: 5, stepsBlocked: 0, spanRelaunches: 5, retriedCompletions: 0,
    openInterventions: 1,
    progress: {
      lastProgressAt: null, lastProgressChannel: null,
      lastSignalAt: null, lastSignalChannel: null, silenceConclusive: true,
    },
    awaitingYou: { count: 0, sinceMs: null, sourceKind: null },
    ...over,
  };
}

describe("waitingLabel", () => {
  it("names the wait and what the run actually wants", () => {
    // "Waiting on you" alone is a label a reader learns to ignore. The pause kind
    // is what turns it into one they act on.
    expect(waitingLabel({ count: 1, sinceMs: 39 * HOUR, sourceKind: "step_confirmation_pending" }))
      .toBe("Waiting on you for 39h 0m · a step waiting for your OK");
  });

  it("states the wait and stops when the pause reason was not recorded", () => {
    // Never invent a plausible reason for an absent one: it would send the reader to
    // the wrong card.
    expect(waitingLabel({ count: 1, sinceMs: 2 * HOUR, sourceKind: "unknown" }))
      .toBe("Waiting on you for 2h 0m");
  });
});

describe("waitingRuns", () => {
  it("excludes a run whose open parks are abandoned rather than actionable", () => {
    // All of the founder's currently-open cards are `abandoned` — their runs died
    // holding them. `openInterventions` counts those too, so deriving "waiting on
    // you" from it would send him to answer cards that accomplish nothing.
    const abandoned = run({ openInterventions: 3, terminationCause: "infrastructure_killed" });
    expect(waitingRuns([abandoned])).toEqual([]);
  });

  it("orders the longest wait first", () => {
    const short = run({ runId: "a", awaitingYou: { count: 1, sinceMs: HOUR, sourceKind: "question_pending" } });
    const long = run({ runId: "b", awaitingYou: { count: 1, sinceMs: 39 * HOUR, sourceKind: "mark_done_pending" } });
    expect(waitingRuns([short, long]).map((r) => r.runId)).toEqual(["b", "a"]);
  });
});

describe("waitingByGoal", () => {
  it("keeps the longest wait for a goal with several waiting runs, and skips quiet goals", () => {
    const quiet = run({ runId: "q", goalId: "g-quiet" });
    const recent = run({ runId: "a", goalId: "g1", awaitingYou: { count: 1, sinceMs: HOUR, sourceKind: "question_pending" } });
    const old = run({ runId: "b", goalId: "g1", awaitingYou: { count: 1, sinceMs: 39 * HOUR, sourceKind: "mark_done_pending" } });
    const byGoal = waitingByGoal([quiet, recent, old]);
    expect(byGoal.get("g1")).toEqual(old.awaitingYou);
    expect(byGoal.has("g-quiet")).toBe(false);
  });
});
