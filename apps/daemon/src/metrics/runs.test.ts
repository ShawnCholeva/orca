import { describe, expect, it } from "vitest";
import type { HarnessTransition } from "@orca/contracts";
import {
  buildInterventions, buildRunDetail, clampIntervals, computeCost, computeDurations,
  mergeIntervals, runTerminalMs, totalMs,
} from "./runs.js";
import type { ActivityEvent, RunRow, RunStepRunRow, RunTransition } from "./runs-fetch.js";

const RUN_ID = "run-1";
const GOAL_ID = "goal-1";
const NOW = Date.parse("2026-09-02T00:00:00.000Z");

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    runId: RUN_ID, goalId: GOAL_ID, templateId: "tpl", templateName: "Tpl",
    templateVersion: 1, status: "blocked",
    startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T01:00:00.000Z",
    blockedReason: null, ...over,
  };
}

function stepRun(over: Partial<RunStepRunRow> = {}): RunStepRunRow {
  return {
    stepRunId: "sr-1", goalId: GOAL_ID, stepTemplateId: "triage", ordinal: 0,
    attempt: 1, status: "passed", startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:30:00.000Z", blockedReason: null, stallRescues: 0, ...over,
  };
}

function complete(over: {
  id: string; at: string; stepRunId?: string; stepTemplateId?: string;
  usd?: number | null; latencyMs?: number; status?: "succeeded" | "failed";
}): RunTransition {
  const t: HarnessTransition = {
    id: over.id, goalId: GOAL_ID, workflowRunId: RUN_ID,
    workflowStepRunId: over.stepRunId ?? "sr-1",
    boundary: "step_complete",
    risk: null, evidence: null, stateDeps: null,
    telemetry: {
      cost: over.usd == null ? null : {
        tokens_in: 10, tokens_out: 20, cache_read_tokens: null,
        cache_creation_tokens: null, usd: over.usd,
      },
      latency_ms: over.latencyMs ?? null,
      model: null, provider_id: null, provider_version: null,
      prompt_ref: null, raw_output_ref: null,
      rejected_alternatives: [], human_interventions: [],
      outcome: { status: over.status ?? "succeeded", failure_code: null },
    },
    createdAt: over.at,
  };
  return { transition: t, stepTemplateId: over.stepTemplateId ?? "triage" };
}

function markDone(usd: number): RunTransition {
  const t: HarnessTransition = {
    id: "md-1", goalId: GOAL_ID, workflowRunId: RUN_ID, workflowStepRunId: null,
    boundary: "mark_done", risk: null, evidence: null, stateDeps: null,
    telemetry: {
      cost: { tokens_in: 0, tokens_out: 0, cache_read_tokens: null, cache_creation_tokens: null, usd },
      latency_ms: null, model: null, provider_id: null, provider_version: null,
      prompt_ref: null, raw_output_ref: null, rejected_alternatives: [],
      human_interventions: [], outcome: { status: "succeeded", failure_code: null },
    },
    createdAt: "2026-09-01T01:00:00.000Z",
  };
  return { transition: t, stepTemplateId: null };
}

function ev(activityId: string, status: string, at: string, stepRunId = "sr-1"): ActivityEvent {
  return { createdAt: at, activityId, workflowRunId: RUN_ID, stepRunId, status };
}

describe("mergeIntervals", () => {
  it("merges overlapping and touching intervals and drops empties", () => {
    expect(mergeIntervals([
      { start: 0, end: 10 }, { start: 5, end: 20 }, { start: 20, end: 25 },
      { start: 40, end: 50 }, { start: 7, end: 7 },
    ])).toEqual([{ start: 0, end: 25 }, { start: 40, end: 50 }]);
  });

  it("absorbs a nested interval rather than adding its length", () => {
    expect(totalMs(mergeIntervals([{ start: 0, end: 100 }, { start: 10, end: 20 }]))).toBe(100);
  });

  it("returns nothing for no intervals", () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe("clampIntervals", () => {
  it("clips to the window and drops what falls outside", () => {
    expect(clampIntervals([{ start: 0, end: 100 }, { start: 200, end: 300 }], 50, 150))
      .toEqual([{ start: 50, end: 100 }]);
  });
});

describe("runTerminalMs", () => {
  it("does not tick for a terminated run, however long its card stays open", () => {
    // The live case: run 01a05b0c ran 17 minutes, then blocked. Its confirmation
    // card is still open ~50h later. Duration is a property of the RUN.
    const r = run({ status: "blocked", finishedAt: "2026-09-01T00:17:00.000Z" });
    expect(runTerminalMs(r, [stepRun()], NOW)).toBe(Date.parse("2026-09-01T00:17:00.000Z"));
  });

  it("accrues to now while the run is genuinely live", () => {
    expect(runTerminalMs(run({ status: "active", finishedAt: null }), [stepRun()], NOW)).toBe(NOW);
  });

  it("falls back to the last span end when a terminal run has no finishedAt", () => {
    const r = run({ status: "failed", finishedAt: null });
    const spans = [stepRun({ finishedAt: "2026-09-01T00:20:00.000Z" })];
    expect(runTerminalMs(r, spans, NOW)).toBe(Date.parse("2026-09-01T00:20:00.000Z"));
  });
});

describe("buildInterventions", () => {
  it("closes a park on the next non-park event for the same activity", () => {
    const out = buildInterventions({
      events: [
        ev("a1", "paused_for_input", "2026-09-01T00:10:00.000Z"),
        ev("a1", "active", "2026-09-01T00:25:00.000Z"),
      ],
      sourceKinds: new Map([["a1", "step_confirmation_pending"]]),
      run: run(), nowMs: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(false);
    expect(out[0].durationMs).toBe(15 * 60_000);
    expect(out[0].sourceKind).toBe("step_confirmation_pending");
    expect(out[0].parkState).toBe("resolved");
  });

  it("reports an unterminated park as still open with a live duration", () => {
    const out = buildInterventions({
      events: [ev("a1", "paused_for_input", "2026-09-01T23:00:00.000Z")],
      sourceKinds: new Map([["a1", "step_confirmation_pending"]]),
      run: run(), nowMs: NOW,
    });
    expect(out[0].open).toBe(true);
    expect(out[0].exitedAt).toBeNull();
    expect(out[0].durationMs).toBe(60 * 60_000);
  });

  it("labels an open park on a DEAD run abandoned, not awaiting_you", () => {
    // All three of the founder's open cards are this kind. Telling him they are
    // "waiting on you" would send him to answer cards that accomplish nothing.
    const events = [ev("a1", "paused_for_input", "2026-09-01T00:10:00.000Z")];
    const kinds = new Map([["a1", "step_confirmation_pending"]]);
    expect(buildInterventions({ events, sourceKinds: kinds, run: run({ status: "blocked" }), nowMs: NOW })[0].parkState)
      .toBe("abandoned");
    expect(buildInterventions({ events, sourceKinds: kinds, run: run({ status: "active" }), nowMs: NOW })[0].parkState)
      .toBe("awaiting_you");
  });

  it("reports an unrecognised source kind as unknown rather than guessing", () => {
    const out = buildInterventions({
      events: [ev("a1", "paused_for_input", "2026-09-01T00:10:00.000Z")],
      // The live failure mode: the mutable activities row was overwritten after
      // the park, so its source_kind no longer describes the pause.
      sourceKinds: new Map([["a1", "turn_completed"]]),
      run: run(), nowMs: NOW,
    });
    expect(out[0].sourceKind).toBe("unknown");
  });

  it("ignores events belonging to another run", () => {
    const foreign: ActivityEvent = { ...ev("a2", "paused_for_input", "2026-09-01T00:10:00.000Z"), workflowRunId: "other" };
    expect(buildInterventions({ events: [foreign], sourceKinds: new Map(), run: run(), nowMs: NOW })).toEqual([]);
  });
});

describe("computeDurations", () => {
  const base = {
    run: run({ startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T01:00:00.000Z" }),
    stepRuns: [stepRun()],
    nowMs: NOW,
  };

  it("makes the four durations sum", () => {
    const d = computeDurations({
      ...base,
      transitions: [complete({ id: "c1", at: "2026-09-01T00:20:00.000Z", latencyMs: 10 * 60_000, usd: 1 })],
      interventions: buildInterventions({
        events: [
          ev("a1", "paused_for_input", "2026-09-01T00:30:00.000Z"),
          ev("a1", "active", "2026-09-01T00:50:00.000Z"),
        ],
        sourceKinds: new Map(), run: base.run, nowMs: NOW,
      }),
    });
    expect(d.elapsedMs).toBe(60 * 60_000);
    expect(d.workingMs).toBe(10 * 60_000);
    expect(d.parkedMs).toBe(20 * 60_000);
    expect(d.unaccountedMs).toBe(30 * 60_000);
    expect(d.workingMs + d.parkedMs + d.unaccountedMs).toBe(d.elapsedMs);
    expect(d.integrityFlag).toBeNull();
  });

  it("unions overlapping parks instead of summing them", () => {
    // The regression: the unique index is per STEP RUN, not per run, so two step
    // runs — including two attempts of one step — can be parked at once. Summing
    // exceeds wall-clock and drives the residual negative, firing the integrity
    // flag on healthy data.
    const interventions = buildInterventions({
      events: [
        ev("a1", "paused_for_input", "2026-09-01T00:00:00.000Z", "sr-1"),
        ev("a2", "paused_for_input", "2026-09-01T00:10:00.000Z", "sr-2"),
        ev("a1", "active", "2026-09-01T00:40:00.000Z", "sr-1"),
        ev("a2", "active", "2026-09-01T00:50:00.000Z", "sr-2"),
      ],
      sourceKinds: new Map(), run: base.run, nowMs: NOW,
    });
    // Naive sum would be 40 + 40 = 80 minutes against a 60-minute run.
    expect(interventions.reduce((a, i) => a + i.durationMs, 0)).toBe(80 * 60_000);
    const d = computeDurations({ ...base, transitions: [], interventions });
    expect(d.parkedMs).toBe(50 * 60_000); // union of [00:00,00:40] and [00:10,00:50]
    expect(d.unaccountedMs).toBe(10 * 60_000);
    expect(d.integrityFlag).toBeNull();
  });

  it("clamps a park that outlives its run to the run's own window", () => {
    const d = computeDurations({
      ...base,
      transitions: [],
      interventions: buildInterventions({
        events: [ev("a1", "paused_for_input", "2026-09-01T00:30:00.000Z")],
        sourceKinds: new Map(), run: base.run, nowMs: NOW,
      }),
    });
    // The park is open and ~23.5h old, but the run ended at 01:00.
    expect(d.parkedMs).toBe(30 * 60_000);
    expect(d.elapsedMs).toBe(60 * 60_000);
    expect(d.unaccountedMs).toBe(30 * 60_000);
  });

  it("floors a negative residual and says so rather than hiding it", () => {
    const d = computeDurations({
      ...base,
      transitions: [complete({ id: "c1", at: "2026-09-01T00:20:00.000Z", latencyMs: 90 * 60_000 })],
      interventions: [],
    });
    expect(d.unaccountedMs).toBe(0);
    expect(d.integrityFlag).toContain("do not reconcile");
  });

  it("marks a live run accruing and a dead one not", () => {
    const t = { transitions: [], interventions: [] };
    expect(computeDurations({ ...base, ...t }).accruing).toBe(false);
    expect(computeDurations({ ...base, ...t, run: run({ status: "active" }) }).accruing).toBe(true);
  });
});

describe("computeCost", () => {
  it("sums step_complete only — mark_done is a checksum, never an addend", () => {
    // The live 2x: run 01a04645 reported $61.52 across step_completes and $61.52
    // again on mark_done's cumulative roll-up.
    const c = computeCost([
      complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", stepTemplateId: "triage", usd: 40 }),
      complete({ id: "c2", at: "2026-09-01T00:20:00.000Z", stepTemplateId: "done", usd: 21.52 }),
      markDone(61.52),
    ]);
    expect(c.usd).toBeCloseTo(61.52, 5);
    expect(c.rollupCheck).toBe("matches");
  });

  it("flags a roll-up that disagrees with the sum", () => {
    const c = computeCost([
      complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", usd: 10 }),
      markDone(25),
    ]);
    expect(c.rollupCheck).toBe("diverged");
  });

  it("types the absence of a roll-up rather than reporting a bare null", () => {
    // `null` would read identically to "checked and inconclusive" in the one field
    // whose entire purpose is honesty about absence.
    expect(computeCost([complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", usd: 10 })]).rollupCheck)
      .toBe("not_applicable");
  });

  it("counts failed and superseded completions once, not twice", () => {
    // A failed attempt that was also superseded must not be double-charged.
    const c = computeCost([
      complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", stepTemplateId: "execution", usd: 42.48, status: "failed" }),
      complete({ id: "c2", at: "2026-09-01T00:20:00.000Z", stepTemplateId: "execution", usd: 3.23 }),
    ]);
    expect(c.usd).toBeCloseTo(45.71, 5);
    expect(c.failedUsd).toBeCloseTo(42.48, 5);
    // The delivered attempt is not superseded, so nothing lands in that bucket.
    expect(c.supersededUsd).toBe(0);
    expect(c.wastedUsd).toBeCloseTo(42.48, 5);
  });

  it("splits a succeeded-but-superseded attempt out of failed spend", () => {
    // The live disagreement: execution ran 3x — $42.48 failed, $2.64 succeeded then
    // was replaced, $3.23 delivered. "$48.02 failed" and "$50.66 produced nothing
    // the run kept" are both true and answer different questions, so both are named
    // rather than blended into one figure.
    const c = computeCost([
      complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", stepTemplateId: "execution", usd: 42.48, status: "failed" }),
      complete({ id: "c2", at: "2026-09-01T00:20:00.000Z", stepTemplateId: "execution", usd: 2.64 }),
      complete({ id: "c3", at: "2026-09-01T00:30:00.000Z", stepTemplateId: "execution", usd: 3.23 }),
    ]);
    expect(c.failedUsd).toBeCloseTo(42.48, 5);
    expect(c.supersededUsd).toBeCloseTo(2.64, 5);
    expect(c.wastedUsd).toBeCloseTo(45.12, 5);
    // A completion is counted once: failed-and-superseded is failed, never both.
    expect(c.failedUsd + c.supersededUsd).toBeCloseTo(c.wastedUsd, 5);
  });

  it("counts a span that emitted nothing at all as silent, not as unreported", () => {
    // A worker gate spawns a real agent, spends real money and emits no
    // step_complete, so it is absent from reported/total entirely — the run total
    // is understated by an amount the run itself cannot state. Falls to 0 on its
    // own once gates emit, so it needs no regime marker to maintain.
    const c = computeCost(
      [complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", stepRunId: "sr-1", usd: 5 })],
      [stepRun({ stepRunId: "sr-1" }), stepRun({ stepRunId: "sr-gate", stepTemplateId: "__gate__:critique" })],
    );
    expect(c.coverage).toEqual({ reported: 1, total: 1, silent: 1 });
  });

  it("counts a completion with no cost in the coverage denominator, never as zero", () => {
    const c = computeCost([
      complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", stepTemplateId: "a", usd: 5 }),
      complete({ id: "c2", at: "2026-09-01T00:20:00.000Z", stepTemplateId: "b", usd: null }),
    ]);
    expect(c.coverage).toEqual({ reported: 1, total: 2, silent: 0 });
    expect(c.usd).toBe(5);
  });
});

describe("buildRunDetail", () => {
  it("builds spans with restart counts and an unknown cost state for an unreported span", () => {
    const detail = buildRunDetail({
      run: run(),
      stepRuns: [stepRun({ stepRunId: "sr-1", stepTemplateId: "triage" })],
      transitions: [
        { ...complete({ id: "l1", at: "2026-09-01T00:00:00.000Z" }), transition: {
          ...complete({ id: "l1", at: "2026-09-01T00:00:00.000Z" }).transition, boundary: "step_launch" } },
        { ...complete({ id: "l2", at: "2026-09-01T00:05:00.000Z" }), transition: {
          ...complete({ id: "l2", at: "2026-09-01T00:05:00.000Z" }).transition, boundary: "step_launch" } },
        complete({ id: "c1", at: "2026-09-01T00:20:00.000Z", usd: null }),
      ],
      events: [],
      sourceKinds: new Map(),
      stepNames: new Map([["triage", "Triage"]]),
      nowMs: NOW,
    });
    expect(detail.spans).toHaveLength(1);
    expect(detail.spans[0].name).toBe("Triage");
    expect(detail.spans[0].restarts).toBe(1);   // two launches of one span: a relaunch
    expect(detail.spans[0].completions).toBe(1); // one completion: no revise loop
    expect(detail.run.spanRelaunches).toBe(1);
    expect(detail.run.retriedCompletions).toBe(0);
    expect(detail.spans[0].cost?.state).toBe("unknown");
    expect(detail.run.openInterventions).toBe(0);
  });
});
