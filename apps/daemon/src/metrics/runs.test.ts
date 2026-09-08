import { describe, expect, it } from "vitest";
import type { HarnessTransition, Intervention } from "@orca/contracts";
import {
  buildInterventions, buildRunDetail, clampIntervals, computeAwaitingYou, computeCost,
  computeDurations, computeProgress, computeStopCompliance, mergeIntervals, runTerminalMs,
  subtractIntervals, totalMs,
} from "./runs.js";
import type { ActivityEvent, RunEvent, RunRow, RunStepRunRow, RunTransition, StepPhaseEvent } from "./runs-fetch.js";

const RUN_ID = "run-1";
const GOAL_ID = "goal-1";
const NOW = Date.parse("2026-09-02T00:00:00.000Z");

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    runId: RUN_ID, goalId: GOAL_ID, goalTitle: "Add a Kelvin conversion",
    templateId: "tpl", templateName: "Tpl",
    templateVersion: 1, status: "blocked",
    startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T01:00:00.000Z",
    blockedReason: null, ...over,
  };
}

function stepRun(over: Partial<RunStepRunRow> = {}): RunStepRunRow {
  return {
    stepRunId: "sr-1", goalId: GOAL_ID, stepTemplateId: "triage", ordinal: 0,
    attempt: 1, status: "passed", startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:30:00.000Z", blockedReason: null, stallRescues: 0,
    reviseAttempts: 0, ...over,
  };
}

function complete(over: {
  id: string; at: string; stepRunId?: string; stepTemplateId?: string;
  usd?: number | null; latencyMs?: number; status?: "succeeded" | "failed";
  source?: "provider" | "price_map" | null;
  model?: string | null;
  cacheRead?: number | null; cacheWrite?: number | null;
  evidence?: HarnessTransition["evidence"];
  refute?: HarnessTransition["refute"];
}): RunTransition {
  const t: HarnessTransition = {
    id: over.id, goalId: GOAL_ID, workflowRunId: RUN_ID,
    workflowStepRunId: over.stepRunId ?? "sr-1",
    boundary: "step_complete",
    risk: null, evidence: over.evidence ?? null, stateDeps: null,
    refute: over.refute ?? null,
    telemetry: {
      cost: over.usd == null ? null : {
        tokens_in: 10, tokens_out: 20, cache_read_tokens: over.cacheRead ?? null,
        cache_creation_tokens: over.cacheWrite ?? null, usd: over.usd, source: over.source ?? null,
      },
      latency_ms: over.latencyMs ?? null,
      model: over.model ?? null, provider_id: null, provider_version: null,
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
      cost: { tokens_in: 0, tokens_out: 0, cache_read_tokens: null, cache_creation_tokens: null, usd, source: null },
      latency_ms: null, model: null, provider_id: null, provider_version: null,
      prompt_ref: null, raw_output_ref: null, rejected_alternatives: [],
      human_interventions: [], outcome: { status: "succeeded", failure_code: null },
    },
    createdAt: "2026-09-01T01:00:00.000Z",
  };
  return { transition: t, stepTemplateId: null };
}

function ev(activityId: string, status: string, at: string, stepRunId = "sr-1", sourceKind: string | null = null): ActivityEvent {
  return { createdAt: at, activityId, workflowRunId: RUN_ID, stepRunId, status, sourceKind };
}

function runEv(type: string, at: string, workflowRunId = RUN_ID, stepRunId: string | null = null): RunEvent {
  return { createdAt: at, type, workflowRunId, stepRunId };
}

function phase(phase: string | null, at: string, stepRunId = "sr-1", workflowRunId = RUN_ID): StepPhaseEvent {
  return { createdAt: at, workflowRunId, stepRunId, phase };
}

describe("subtractIntervals", () => {
  it("keeps only the parts of a that no interval of b covers", () => {
    expect(subtractIntervals([{ start: 0, end: 100 }], [{ start: 10, end: 20 }, { start: 15, end: 30 }, { start: 90, end: 200 }]))
      .toEqual([{ start: 0, end: 10 }, { start: 30, end: 90 }]);
  });

  it("returns a untouched when b misses it, and nothing when b swallows it", () => {
    expect(subtractIntervals([{ start: 0, end: 10 }], [{ start: 20, end: 30 }])).toEqual([{ start: 0, end: 10 }]);
    expect(subtractIntervals([{ start: 5, end: 10 }], [{ start: 0, end: 30 }])).toEqual([]);
  });
});

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

  it("names the time a blocked run sat until someone restarted it", () => {
    // Live: run 01a07568 blocked at 07:16 on a crashed worker and was restarted at
    // 07:23. Nothing was parked — the card had expired — so those seven minutes
    // read as unaccounted, when the record says exactly what they were.
    const d = computeDurations({
      ...base,
      transitions: [],
      interventions: [],
      runEvents: [
        runEv("workflow.run.started", "2026-09-01T00:00:00.000Z"),
        runEv("workflow.run.blocked", "2026-09-01T00:30:00.000Z"),
        runEv("workflow.run.started", "2026-09-01T00:40:00.000Z"),
      ],
    });
    expect(d.haltedMs).toBe(10 * 60_000);
    expect(d.unaccountedMs).toBe(50 * 60_000);
    expect(d.workingMs + d.parkedMs + d.haltedMs + d.reviewingMs + d.unaccountedMs).toBe(d.elapsedMs);
  });

  it("gives a block that was never resumed no halted time — the run ended there", () => {
    // A still-blocked run's terminal moment IS the block (§2.1), so the interval is
    // empty and the age of its abandoned cards stays off the clock.
    const d = computeDurations({
      ...base,
      run: run({ status: "blocked", finishedAt: null }),
      stepRuns: [stepRun({ finishedAt: "2026-09-01T00:30:00.000Z" })],
      transitions: [],
      interventions: [],
      runEvents: [runEv("workflow.run.blocked", "2026-09-01T00:30:00.000Z")],
    });
    expect(d.elapsedMs).toBe(30 * 60_000);
    expect(d.haltedMs).toBe(0);
  });

  it("counts a run the operator stopped as halted, not unaccounted", () => {
    // A stop is the same standstill as a block — the run is not working and no
    // park explains it. Left out of the halted term, every minute of it landed in
    // `unaccounted`, the bucket reserved for time we genuinely cannot explain.
    const d = computeDurations({
      ...base, transitions: [], interventions: [],
      runEvents: [
        runEv("workflow.run.paused", "2026-09-01T00:10:00.000Z"),
        runEv("workflow.run.started", "2026-09-01T00:40:00.000Z"),
      ],
    });
    expect(d.haltedMs).toBe(30 * 60_000);
  });

  it("ignores another run's blocks", () => {
    const d = computeDurations({
      ...base, transitions: [], interventions: [],
      runEvents: [runEv("workflow.run.blocked", "2026-09-01T00:30:00.000Z", "other"), runEv("workflow.run.started", "2026-09-01T00:40:00.000Z", "other")],
    });
    expect(d.haltedMs).toBe(0);
  });

  it("names the orchestrator's judge and independent-check turns as reviewing", () => {
    const d = computeDurations({
      ...base,
      transitions: [],
      interventions: [],
      phaseEvents: [
        phase("reviewing", "2026-09-01T00:10:00.000Z"),
        phase("independent_check", "2026-09-01T00:12:00.000Z"),
        phase(null, "2026-09-01T00:15:00.000Z"),
      ],
    });
    expect(d.reviewingMs).toBe(5 * 60_000);
    expect(d.unaccountedMs).toBe(55 * 60_000);
    expect(d.integrityFlag).toBeNull();
  });

  it("clips a phase a restart left open to its step run's own bracket", () => {
    // The phase is live-only state that boot reconciliation clears without an
    // event. Left to run to the end of the run it would claim 40 minutes of judging
    // for a step that finished 10 minutes after the phase began.
    const d = computeDurations({
      ...base,
      transitions: [],
      interventions: [],
      phaseEvents: [phase("reviewing", "2026-09-01T00:20:00.000Z")],
    });
    expect(d.reviewingMs).toBe(10 * 60_000);
  });

  it("keeps the placed terms disjoint — a park wins over a halt, and a halt over reviewing", () => {
    const d = computeDurations({
      ...base,
      stepRuns: [stepRun({ finishedAt: "2026-09-01T01:00:00.000Z" })],
      transitions: [],
      interventions: buildInterventions({
        events: [
          ev("a1", "paused_for_input", "2026-09-01T00:30:00.000Z"),
          ev("a1", "active", "2026-09-01T00:50:00.000Z"),
        ],
        sourceKinds: new Map(), run: base.run, nowMs: NOW,
      }),
      runEvents: [
        runEv("workflow.run.blocked", "2026-09-01T00:40:00.000Z"),
        runEv("workflow.run.started", "2026-09-01T00:55:00.000Z"),
      ],
      phaseEvents: [phase("reviewing", "2026-09-01T00:25:00.000Z"), phase(null, "2026-09-01T00:45:00.000Z")],
    });
    expect(d.parkedMs).toBe(20 * 60_000);    // [00:30, 00:50]
    expect(d.haltedMs).toBe(5 * 60_000);     // [00:40, 00:55] less the park
    expect(d.reviewingMs).toBe(5 * 60_000);  // [00:25, 00:45] less the park
    expect(d.unaccountedMs).toBe(30 * 60_000);
    expect(d.workingMs + d.parkedMs + d.haltedMs + d.reviewingMs + d.unaccountedMs).toBe(d.elapsedMs);
    expect(d.integrityFlag).toBeNull();
  });

  it("counts the orchestrator's unphased turns as reviewing, from the mediator's turn brackets", () => {
    // The next-decision and user-message turns never set a phase. On the live run
    // one such turn was lost to a daemon restart and re-issued 7.5 minutes later;
    // the run was the orchestrator's for all of it.
    const d = computeDurations({
      ...base,
      stepRuns: [stepRun({ finishedAt: "2026-09-01T01:00:00.000Z" })],
      transitions: [],
      interventions: [],
      runEvents: [
        // A turn that finished normally.
        runEv("workflow.orchestrator.turn_started", "2026-09-01T00:10:00.000Z", RUN_ID, "sr-1"),
        runEv("workflow.orchestrator.turn_finished", "2026-09-01T00:12:00.000Z", RUN_ID, "sr-1"),
        // A turn that never finished, replaced by the next one.
        runEv("workflow.orchestrator.turn_started", "2026-09-01T00:20:00.000Z", RUN_ID, "sr-1"),
        runEv("workflow.orchestrator.turn_started", "2026-09-01T00:27:00.000Z", RUN_ID, "sr-1"),
        runEv("workflow.orchestrator.turn_finished", "2026-09-01T00:28:00.000Z", RUN_ID, "sr-1"),
      ],
      // A phase overlapping the first turn is unioned, not double-counted.
      phaseEvents: [phase("reviewing", "2026-09-01T00:11:00.000Z"), phase(null, "2026-09-01T00:13:00.000Z")],
    });
    expect(d.reviewingMs).toBe(11 * 60_000); // [00:10,00:13] + [00:20,00:28]
    expect(d.unaccountedMs).toBe(49 * 60_000);
  });

  it("places the worker's turns and names the part that was not model time", () => {
    const d = computeDurations({
      ...base,
      stepRuns: [stepRun({ finishedAt: "2026-09-01T01:00:00.000Z" })],
      transitions: [complete({ id: "c1", at: "2026-09-01T00:30:00.000Z", latencyMs: 8 * 60_000 })],
      interventions: [],
      runEvents: [
        runEv("workflow.worker.prompted", "2026-09-01T00:05:00.000Z", RUN_ID, "sr-1"),
        runEv("workflow.worker.responded", "2026-09-01T00:25:00.000Z", RUN_ID, "sr-1"),
      ],
      // The judge runs after the Stop; adjacent, not overlapping.
      phaseEvents: [phase("reviewing", "2026-09-01T00:25:00.000Z"), phase(null, "2026-09-01T00:27:00.000Z")],
    });
    expect(d.workingMs).toBe(8 * 60_000);
    expect(d.agentMs).toBe(12 * 60_000);      // a 20m turn, 8m of it inference
    expect(d.reviewingMs).toBe(2 * 60_000);
    expect(d.unaccountedMs).toBe(38 * 60_000);
    expect(d.workingMs + d.agentMs + d.parkedMs + d.haltedMs + d.reviewingMs + d.unaccountedMs).toBe(d.elapsedMs);
    expect(d.integrityFlag).toBeNull();
  });

  it("gives a run recorded before turn brackets existed no agent time, and reads as before", () => {
    const d = computeDurations({
      ...base,
      transitions: [complete({ id: "c1", at: "2026-09-01T00:20:00.000Z", latencyMs: 10 * 60_000 })],
      interventions: [],
    });
    expect(d.agentMs).toBe(0);
    expect(d.workingMs).toBe(10 * 60_000);
    expect(d.unaccountedMs).toBe(50 * 60_000);
  });

  it("does not let a worker turn overlap a park inside it — the park wins", () => {
    const d = computeDurations({
      ...base,
      stepRuns: [stepRun({ finishedAt: "2026-09-01T01:00:00.000Z" })],
      transitions: [],
      interventions: buildInterventions({
        events: [ev("a1", "paused_for_input", "2026-09-01T00:10:00.000Z"), ev("a1", "active", "2026-09-01T00:20:00.000Z")],
        sourceKinds: new Map(), run: base.run, nowMs: NOW,
      }),
      runEvents: [
        runEv("workflow.worker.prompted", "2026-09-01T00:05:00.000Z", RUN_ID, "sr-1"),
        runEv("workflow.worker.responded", "2026-09-01T00:25:00.000Z", RUN_ID, "sr-1"),
      ],
    });
    expect(d.parkedMs).toBe(10 * 60_000);
    expect(d.agentMs).toBe(10 * 60_000);
  });

  it("clips the halted and reviewing terms to a window like the others", () => {
    const d = computeDurations({
      ...base,
      stepRuns: [stepRun({ finishedAt: "2026-09-01T01:00:00.000Z" })],
      transitions: [],
      interventions: [],
      runEvents: [runEv("workflow.run.blocked", "2026-09-01T00:10:00.000Z"), runEv("workflow.run.started", "2026-09-01T00:40:00.000Z")],
      phaseEvents: [phase("reviewing", "2026-09-01T00:45:00.000Z"), phase(null, "2026-09-01T00:55:00.000Z")],
      fromMs: Date.parse("2026-09-01T00:30:00.000Z"),
    });
    expect(d.elapsedMs).toBe(30 * 60_000);
    expect(d.haltedMs).toBe(10 * 60_000);
    expect(d.reviewingMs).toBe(10 * 60_000);
    expect(d.unaccountedMs).toBe(10 * 60_000);
  });

  it("marks a live run accruing and a dead one not", () => {
    const t = { transitions: [], interventions: [] };
    expect(computeDurations({ ...base, ...t }).accruing).toBe(false);
    expect(computeDurations({ ...base, ...t, run: run({ status: "active" }) }).accruing).toBe(true);
  });

  it("clips every term to a window that opens inside the run", () => {
    // The Workflows page summed the LIFETIME of two runs that began three days
    // before its 8-hour window: 179h of wall clock against 8h. With a window
    // start, each term is the part that happened at or after it.
    const d = computeDurations({
      ...base,
      transitions: [
        // Model time that all lies before the window: none of it counts.
        complete({ id: "c1", at: "2026-09-01T00:25:00.000Z", latencyMs: 10 * 60_000 }),
        // Model time that all lies inside it: counts in full.
        complete({ id: "c2", at: "2026-09-01T00:45:00.000Z", latencyMs: 8 * 60_000 }),
      ],
      interventions: buildInterventions({
        events: [
          ev("a1", "paused_for_input", "2026-09-01T00:10:00.000Z"),
          ev("a1", "active", "2026-09-01T00:32:00.000Z"),
          ev("a2", "paused_for_input", "2026-09-01T00:48:00.000Z", "sr-2"),
          ev("a2", "active", "2026-09-01T00:58:00.000Z", "sr-2"),
        ],
        sourceKinds: new Map(), run: base.run, nowMs: NOW,
      }),
      fromMs: Date.parse("2026-09-01T00:30:00.000Z"),
    });
    expect(d.elapsedMs).toBe(30 * 60_000);   // 00:30 → 01:00, not 00:00 → 01:00
    expect(d.parkedMs).toBe(12 * 60_000);    // [00:30,00:32] + [00:48,00:58]
    expect(d.workingMs).toBe(8 * 60_000);
    expect(d.unaccountedMs).toBe(10 * 60_000);
    expect(d.integrityFlag).toBeNull();
  });

  it("places a completion's model time ending at the completion and keeps the part after the window opened", () => {
    // Working time is a magnitude, not a placed interval, so a window cannot cut
    // it exactly. The bound it does have: the model time ended when the step
    // completed. Placed there, only the part after the window start counts —
    // counting all of it would put 8m of work inside 4m of wall clock.
    const d = computeDurations({
      ...base,
      transitions: [complete({ id: "c1", at: "2026-09-01T00:34:00.000Z", latencyMs: 8 * 60_000 })],
      interventions: [],
      fromMs: Date.parse("2026-09-01T00:30:00.000Z"),
    });
    expect(d.workingMs).toBe(4 * 60_000);
    expect(d.elapsedMs).toBe(30 * 60_000);
    expect(d.integrityFlag).toBeNull();
  });

  it("reads zero for a window that opened after the run ended", () => {
    const d = computeDurations({
      ...base,
      transitions: [complete({ id: "c1", at: "2026-09-01T00:20:00.000Z", latencyMs: 10 * 60_000 })],
      interventions: [],
      fromMs: Date.parse("2026-09-01T02:00:00.000Z"),
    });
    expect(d).toMatchObject({ elapsedMs: 0, workingMs: 0, parkedMs: 0, unaccountedMs: 0, integrityFlag: null });
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
  it("clips reviewing into the span it happened in, under the same precedence as the run", () => {
    const detail = buildRunDetail({
      run: run(),
      stepRuns: [
        stepRun({ stepRunId: "sr-1", finishedAt: "2026-09-01T00:30:00.000Z" }),
        stepRun({ stepRunId: "sr-2", stepTemplateId: "execution", ordinal: 1, startedAt: "2026-09-01T00:30:00.000Z", finishedAt: "2026-09-01T01:00:00.000Z" }),
      ],
      transitions: [],
      events: [
        ev("a1", "paused_for_input", "2026-09-01T00:40:00.000Z", "sr-2"),
        ev("a1", "active", "2026-09-01T00:50:00.000Z", "sr-2"),
      ],
      runEvents: [],
      phaseEvents: [
        phase("reviewing", "2026-09-01T00:20:00.000Z", "sr-1"), phase(null, "2026-09-01T00:25:00.000Z", "sr-1"),
        phase("reviewing", "2026-09-01T00:35:00.000Z", "sr-2"), phase(null, "2026-09-01T00:45:00.000Z", "sr-2"),
      ],
      sourceKinds: new Map(),
      stepNames: new Map(),
      nowMs: NOW,
    });
    expect(detail.spans.map((s) => s.reviewingMs)).toEqual([5 * 60_000, 5 * 60_000]);
    expect(detail.spans.map((s) => s.turnMs)).toEqual([0, 0]);
    expect(detail.spans[1].parkedMs).toBe(10 * 60_000);
    expect(detail.run.durations.reviewingMs).toBe(10 * 60_000);
    // A span with no bracket has no reviewing figure either, not a zero.
    const open = buildRunDetail({
      run: run({ status: "active", finishedAt: null }), stepRuns: [stepRun({ finishedAt: null, status: "active" })],
      transitions: [], events: [], runEvents: [], sourceKinds: new Map(), stepNames: new Map(), nowMs: NOW,
    });
    expect(open.spans[0].reviewingMs).toBeNull();
    expect(open.spans[0].turnMs).toBeNull();
  });

  it("clips a worker turn into its span, outside that span's orchestrator turns", () => {
    const detail = buildRunDetail({
      run: run(),
      stepRuns: [stepRun({ stepRunId: "sr-1", finishedAt: "2026-09-01T00:30:00.000Z" })],
      transitions: [complete({ id: "c1", at: "2026-09-01T00:20:00.000Z", latencyMs: 4 * 60_000 })],
      events: [],
      runEvents: [
        runEv("workflow.worker.prompted", "2026-09-01T00:02:00.000Z", RUN_ID, "sr-1"),
        runEv("workflow.worker.responded", "2026-09-01T00:20:00.000Z", RUN_ID, "sr-1"),
        runEv("workflow.orchestrator.turn_started", "2026-09-01T00:20:00.000Z", RUN_ID, "sr-1"),
        runEv("workflow.orchestrator.turn_finished", "2026-09-01T00:22:00.000Z", RUN_ID, "sr-1"),
      ],
      sourceKinds: new Map(), stepNames: new Map(), nowMs: NOW,
    });
    expect(detail.spans[0].turnMs).toBe(18 * 60_000);
    expect(detail.spans[0].reviewingMs).toBe(2 * 60_000);
    expect(detail.run.durations.agentMs).toBe(14 * 60_000);
  });

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
      runEvents: [],
      sourceKinds: new Map(),
      stepNames: new Map([["triage", "Triage"]]),
      nowMs: NOW,
    });
    expect(detail.spans).toHaveLength(1);
    expect(detail.spans[0].name).toBe("Triage");
    expect(detail.spans[0].restarts).toBe(1);   // two launches of one span: a relaunch
    expect(detail.spans[0].completions).toBe(1); // one completion: no revise loop
    expect(detail.run.spanRelaunches).toBe(1);
    expect(detail.run.retriedAttempts).toBe(0);
    expect(detail.spans[0].cost?.state).toBe("unknown");
    expect(detail.run.openInterventions).toBe(0);
  });

  it("lists the distinct models across a span's completions, and none when none was recorded", () => {
    // Operator selection is a harness decision, and the model is on every
    // completion's telemetry — it was simply never projected. A LIST, because the
    // span's cost is already summed across its completions: a step revised under a
    // second model has one cost and two models, and naming only the last would
    // attribute the whole figure to it.
    const detail = buildRunDetail({
      run: run(),
      stepRuns: [
        stepRun({ stepRunId: "sr-1", stepTemplateId: "triage" }),
        stepRun({ stepRunId: "sr-2", stepTemplateId: "verify", ordinal: 1 }),
      ],
      transitions: [
        complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", usd: 1, model: "claude-haiku-4-5-20251001" }),
        complete({ id: "c2", at: "2026-09-01T00:15:00.000Z", usd: 1, model: "claude-haiku-4-5-20251001" }),
        complete({ id: "c3", at: "2026-09-01T00:20:00.000Z", usd: 1, model: "claude-opus-5" }),
      ],
      events: [],
      runEvents: [],
      sourceKinds: new Map(),
      stepNames: new Map([["triage", "Triage"], ["verify", "Verify"]]),
      nowMs: NOW,
    });
    expect(detail.spans[0].models).toEqual(["claude-haiku-4-5-20251001", "claude-opus-5"]);
    expect(detail.spans[1].models).toEqual([]);
  });

  it("logs every completion of a span with its own model, cost and outcome, marking the ones a later attempt replaced", () => {
    // Span cost is a sum across completions and the model list is a set; neither
    // can say that the $42 attempt was haiku and failed while the $3 attempt was
    // opus and passed. The log is the per-completion record those two are summed
    // from — the only way to attribute rework to the model that produced it.
    const detail = buildRunDetail({
      run: run(),
      stepRuns: [stepRun({ stepRunId: "sr-1", stepTemplateId: "triage" })],
      transitions: [
        complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", usd: 42.48, model: "claude-haiku-4-5-20251001", status: "failed",
                   evidence: { sensorsRun: [], verdict: "failed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] } } }),
        complete({ id: "c2", at: "2026-09-01T00:15:00.000Z", usd: 2.64, model: "claude-opus-5" }),
        complete({ id: "c3", at: "2026-09-01T00:20:00.000Z", usd: 3.23, model: "claude-opus-5" }),
      ],
      events: [], runEvents: [], sourceKinds: new Map(), stepNames: new Map(), nowMs: NOW,
    });
    expect(detail.spans[0].completionLog).toEqual([
      // Only the first carried an evidence record, so only the first was gated.
      { at: "2026-09-01T00:10:00.000Z", model: "claude-haiku-4-5-20251001", usd: 42.48, outcome: "failed", failureCode: null, superseded: true, gated: true },
      { at: "2026-09-01T00:15:00.000Z", model: "claude-opus-5", usd: 2.64, outcome: "succeeded", failureCode: null, superseded: true, gated: false },
      { at: "2026-09-01T00:20:00.000Z", model: "claude-opus-5", usd: 3.23, outcome: "succeeded", failureCode: null, superseded: false, gated: false },
    ]);
    // The log and the sum are the same money.
    expect(detail.spans[0].cost?.usd).toBeCloseTo(48.35);
  });

  it("marks a completion superseded by a later attempt of the same step in ANOTHER span", () => {
    // A crash relaunch is a second span of the same step template. Its completion
    // replaces the first span's, exactly as computeCost already counts it.
    const detail = buildRunDetail({
      run: run(),
      stepRuns: [
        stepRun({ stepRunId: "sr-1", stepTemplateId: "triage" }),
        stepRun({ stepRunId: "sr-2", stepTemplateId: "triage", attempt: 2 }),
      ],
      transitions: [
        complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", usd: 1, stepRunId: "sr-1" }),
        complete({ id: "c2", at: "2026-09-01T00:20:00.000Z", usd: 1, stepRunId: "sr-2" }),
      ],
      events: [], runEvents: [], sourceKinds: new Map(), stepNames: new Map(), nowMs: NOW,
    });
    expect(detail.spans[0].completionLog[0]!.superseded).toBe(true);
    expect(detail.spans[1].completionLog[0]!.superseded).toBe(false);
  });

  it("sums cache tokens into the span cost, and keeps them null when no completion carried them", () => {
    // Cache reads outnumber fresh input roughly 300 to 1 on the live data and were
    // priced into `usd` without ever being projected — the largest term in the
    // cost story was invisible. Null, not zero, when absent: a completion written
    // before the field existed did not have zero cache traffic.
    const build = (transitions: RunTransition[]) => buildRunDetail({
      run: run(), stepRuns: [stepRun({ stepRunId: "sr-1" })], transitions,
      events: [], runEvents: [], sourceKinds: new Map(), stepNames: new Map(), nowMs: NOW,
    });
    const withCache = build([
      complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", usd: 1, cacheRead: 1000, cacheWrite: 50 }),
      complete({ id: "c2", at: "2026-09-01T00:20:00.000Z", usd: 1, cacheRead: 500, cacheWrite: null }),
    ]);
    expect(withCache.spans[0].cost?.cacheReadTokens).toBe(1500);
    expect(withCache.spans[0].cost?.cacheCreationTokens).toBe(50);
    const without = build([complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", usd: 1 })]);
    expect(without.spans[0].cost?.cacheReadTokens).toBeNull();
    expect(without.spans[0].cost?.cacheCreationTokens).toBeNull();
  });

  it("carries why the evidence fell short, from the final completion's evidence record", () => {
    // The matrix shows a zero; the evidence record says WHY — "nothing was executed
    // to check this" and the regions left untested. The reason beside the zero is
    // what tells the reader whether to add a sensor or a test.
    const detail = buildRunDetail({
      run: run(), stepRuns: [stepRun({ stepRunId: "sr-1" })],
      transitions: [complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", usd: 1, evidence: {
        sensorsRun: [], verdict: "passed",
        untestedRegions: ["semantic correctness", "runtime behavior"], residualRisk: [],
        oracleAdequacy: { sufficient: false, gaps: ["nothing was executed to check this"] },
      } })],
      events: [], runEvents: [], sourceKinds: new Map(), stepNames: new Map(), nowMs: NOW,
    });
    expect(detail.spans[0].evidenceGaps).toEqual({
      untestedRegions: ["semantic correctness", "runtime behavior"],
      oracleGaps: ["nothing was executed to check this"],
    });
    const none = buildRunDetail({
      run: run(), stepRuns: [stepRun({ stepRunId: "sr-1" })],
      transitions: [complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", usd: 1 })],
      events: [], runEvents: [], sourceKinds: new Map(), stepNames: new Map(), nowMs: NOW,
    });
    expect(none.spans[0].evidenceGaps).toBeNull();
  });

  it("carries the reviewer's reason and what triggered the review, beside its verdict", () => {
    const detail = buildRunDetail({
      run: run(), stepRuns: [stepRun({ stepRunId: "sr-1" })],
      transitions: [complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", usd: 1, refute: {
        verdict: "upheld", triggered_by: ["no_oracle"], risk_class: "low",
        reason: "Codebase is genuinely pre-existing and the constant is correct.", issue_refs: [],
      } })],
      events: [], runEvents: [], sourceKinds: new Map(), stepNames: new Map(), nowMs: NOW,
    });
    expect(detail.spans[0].refuteVerdict).toBe("upheld");
    expect(detail.spans[0].refuteTriggeredBy).toEqual(["no_oracle"]);
    expect(detail.spans[0].refuteReason).toBe("Codebase is genuinely pre-existing and the constant is correct.");
  });

  it("lists when the harness failed on the run: relaunches, infrastructure failure codes, and the kill", () => {
    // A scatter of "when did the harness fail" needs timestamps, and the counts
    // the summary carries (spanRelaunches, terminationCause) have none. Each
    // relaunch is dated by its launch, each infra failure by its completion, and
    // the kill by the run's terminal moment.
    const launch = (id: string, at: string, stepRunId = "sr-1"): RunTransition => ({
      ...complete({ id, at, stepRunId }), transition: { ...complete({ id, at, stepRunId }).transition, boundary: "step_launch" },
    });
    const detail = buildRunDetail({
      run: run({ status: "blocked", blockedReason: "crashed 3 times (worker_exited_no_signal)", finishedAt: null }),
      stepRuns: [stepRun({ stepRunId: "sr-1", stepTemplateId: "triage", status: "blocked", finishedAt: "2026-09-01T00:30:00.000Z" })],
      transitions: [
        launch("l1", "2026-09-01T00:00:00.000Z"),
        launch("l2", "2026-09-01T00:05:00.000Z"),
        launch("l3", "2026-09-01T00:10:00.000Z"),
        { ...complete({ id: "c1", at: "2026-09-01T00:20:00.000Z", usd: 1, status: "failed" }),
          transition: { ...complete({ id: "c1", at: "2026-09-01T00:20:00.000Z", usd: 1, status: "failed" }).transition,
            telemetry: { ...complete({ id: "c1", at: "2026-09-01T00:20:00.000Z", usd: 1, status: "failed" }).transition.telemetry!,
              outcome: { status: "failed", failure_code: "provider_error" } } } },
      ],
      events: [], runEvents: [], sourceKinds: new Map(), stepNames: new Map([["triage", "Triage"]]), nowMs: NOW,
    });
    expect(detail.harnessErrors).toEqual([
      { at: "2026-09-01T00:05:00.000Z", kind: "crash_relaunch", stepName: "Triage", detail: null },
      { at: "2026-09-01T00:10:00.000Z", kind: "crash_relaunch", stepName: "Triage", detail: null },
      { at: "2026-09-01T00:20:00.000Z", kind: "infra_failure", stepName: "Triage", detail: "provider_error" },
      { at: "2026-09-01T00:30:00.000Z", kind: "run_killed", stepName: null, detail: "crashed 3 times (worker_exited_no_signal)" },
    ]);
  });

  it("records no harness error for a workflow veto or a completed run", () => {
    const detail = buildRunDetail({
      run: run(),
      stepRuns: [stepRun({ stepRunId: "sr-1" })],
      transitions: [{ ...complete({ id: "c1", at: "2026-09-01T00:20:00.000Z", usd: 1, status: "failed" }),
        transition: { ...complete({ id: "c1", at: "2026-09-01T00:20:00.000Z", usd: 1, status: "failed" }).transition,
          telemetry: { ...complete({ id: "c1", at: "2026-09-01T00:20:00.000Z", usd: 1, status: "failed" }).transition.telemetry!,
            outcome: { status: "failed", failure_code: "evidence_veto" } } } }],
      events: [], runEvents: [], sourceKinds: new Map(), stepNames: new Map(), nowMs: NOW,
    });
    expect(detail.harnessErrors).toEqual([]);
  });

  it("lists every tool-gate decision on the run, with the reasons the policy gave", () => {
    // The Workflows panel counts denials; the reasons — "rm -rf", "a credential
    // file" — are on the risk facet of the tool_gate transition and never left the
    // daemon. A denial with its reason is a fact about what the agent reached for.
    const gate = (id: string, at: string, decision: "deny" | "allow" | "require_approval", reasons: string[], hard: string[]): RunTransition => ({
      stepTemplateId: "triage",
      transition: {
        id, goalId: GOAL_ID, workflowRunId: RUN_ID, workflowStepRunId: "sr-1", boundary: "tool_gate",
        risk: { risk_class: decision === "deny" ? "critical" : "medium", permission_tier: "full_access",
                classification_reasons: reasons, gate_decision: decision, hard_constraint_violations: hard },
        evidence: null, stateDeps: null, telemetry: null, createdAt: at,
      },
    });
    const detail = buildRunDetail({
      run: run(), stepRuns: [stepRun({ stepRunId: "sr-1" })],
      transitions: [
        gate("g1", "2026-09-01T00:05:00.000Z", "deny", ["bash: destructive recursive delete (rm -rf)"], ["bash: destructive recursive delete (rm -rf)"]),
        gate("g2", "2026-09-01T00:06:00.000Z", "require_approval", ["bash: writes outside the workspace"], []),
        complete({ id: "c1", at: "2026-09-01T00:10:00.000Z", usd: 1 }),
      ],
      events: [], runEvents: [], sourceKinds: new Map(), stepNames: new Map([["triage", "Triage"]]), nowMs: NOW,
    });
    expect(detail.toolDecisions).toEqual([
      { workflowStepRunId: "sr-1", stepName: "Triage", at: "2026-09-01T00:05:00.000Z", decision: "deny",
        riskClass: "critical", reasons: ["bash: destructive recursive delete (rm -rf)"] },
      { workflowStepRunId: "sr-1", stepName: "Triage", at: "2026-09-01T00:06:00.000Z", decision: "require_approval",
        riskClass: "medium", reasons: ["bash: writes outside the workspace"] },
    ]);
  });
});

describe("computeProgress", () => {
  const base = {
    run: run({ startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T01:00:00.000Z" }),
    stepRuns: [stepRun({ status: "passed" })],
    transitions: [],
    activityEvents: [],
    runEvents: [],
    nowMs: NOW,
  };

  it("ignores an activity event that repeats the same status", () => {
    // The live stuck run: eight `activity.changed` events for one activity, all
    // carrying `paused_for_input`, two of them 38.6 hours after the last real
    // progress. `activities.updated_at` — the obvious source, and the one whose
    // name promises exactly this — would report "last activity 5 minutes ago" on
    // a run that had not advanced in a day and a half.
    const p = computeProgress({
      ...base,
      activityEvents: [
        ev("a1", "paused_for_input", "2026-09-01T00:10:00.000Z"),
        ev("a1", "paused_for_input", "2026-09-01T00:50:00.000Z"),
      ],
    });
    expect(p.lastProgressAt).toBe("2026-09-01T00:30:00.000Z"); // the span's finish
    expect(p.lastProgressChannel).toBe("step_boundary");
  });

  it("counts an activity event that CHANGED status — a park resolving is progress", () => {
    const p = computeProgress({
      ...base,
      activityEvents: [
        ev("a1", "paused_for_input", "2026-09-01T00:10:00.000Z"),
        ev("a1", "active", "2026-09-01T00:45:00.000Z"),
      ],
    });
    expect(p.lastProgressAt).toBe("2026-09-01T00:45:00.000Z");
    expect(p.lastProgressChannel).toBe("activity_transition");
  });

  it("keeps signal >= progress by construction, so the pair cannot invert", () => {
    const p = computeProgress({
      ...base,
      transitions: [complete({ id: "c1", at: "2026-09-01T00:20:00.000Z" })],
      runEvents: [],
    });
    expect(p.lastSignalAt).toBe(p.lastProgressAt);
  });

  it("moves signal ahead of progress when only a run event fired — the spinning case", () => {
    const p = computeProgress({
      ...base,
      runEvents: [{ createdAt: "2026-09-01T00:55:00.000Z", type: "workflow.step.phase_changed", workflowRunId: RUN_ID, stepRunId: null }],
    });
    expect(p.lastSignalAt).toBe("2026-09-01T00:55:00.000Z");
    expect(p.lastSignalChannel).toBe("run_event");
    expect(p.lastProgressAt).toBe("2026-09-01T00:30:00.000Z");
  });

  it("ignores an event belonging to a sibling run of the same goal", () => {
    // `events` is goal-scoped; "any event" would let a sibling run's activity
    // register as this run's signal.
    const p = computeProgress({
      ...base,
      runEvents: [{ createdAt: "2026-09-01T00:55:00.000Z", type: "workflow.step.started", workflowRunId: "other-run", stepRunId: null }],
    });
    expect(p.lastSignalAt).toBe("2026-09-01T00:30:00.000Z");
  });

  it("clips both clocks to the run's own window", () => {
    const p = computeProgress({
      ...base,
      runEvents: [{ createdAt: "2026-09-02T00:00:00.000Z", type: "activity.changed", workflowRunId: RUN_ID, stepRunId: null }],
    });
    // The event is a day after the run ended; the run was not still moving.
    expect(p.lastSignalAt).toBe("2026-09-01T00:30:00.000Z");
  });

  it("refuses to call silence conclusive while a step is mid-flight", () => {
    // Only Stop and PermissionRequest are wired, so an agent working inside a step
    // emits nothing. An old signal there cannot tell "idle" from "working,
    // unobserved", and calling it silent asserts idleness the record cannot support.
    expect(computeProgress({ ...base, stepRuns: [stepRun({ status: "active" })] }).silenceConclusive)
      .toBe(false);
    expect(computeProgress(base).silenceConclusive).toBe(true);
  });
});

describe("park episodes", () => {
  it("treats a re-raised park on one activity as ONE park, not one per event", () => {
    // The stuck run re-raised `provider_recovery_pending` every few seconds for 41
    // hours: 57 park events for one activity, and the screen said "57 cards still
    // open" against a database holding exactly one. A repeated status is one state
    // continuing — the same rule the progress clock already applies to this stream.
    const events = Array.from({ length: 57 }, (_, i) =>
      ev("a1", "paused_for_input", `2026-09-01T00:${String(i % 60).padStart(2, "0")}:00.000Z`, "sr-1", "provider_recovery_pending"));
    const out = buildInterventions({ events, sourceKinds: new Map(), run: run({ status: "active" }), nowMs: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(true);
    expect(out[0].enteredAt).toBe("2026-09-01T00:00:00.000Z"); // the FIRST, not the last
    expect(out[0].sourceKind).toBe("provider_recovery_pending");
  });

  it("still counts a genuine re-park after a resolution as a second park", () => {
    const out = buildInterventions({
      events: [
        ev("a1", "paused_for_input", "2026-09-01T00:10:00.000Z"),
        ev("a1", "active", "2026-09-01T00:20:00.000Z"),
        ev("a1", "paused_for_input", "2026-09-01T00:30:00.000Z"),
      ],
      sourceKinds: new Map(), run: run(), nowMs: NOW,
    });
    expect(out).toHaveLength(2);
    expect(out[0].exitedAt).toBe("2026-09-01T00:20:00.000Z");
    expect(out[1].open).toBe(true);
  });

  it("takes the episode's own strongest park reason over a stale row", () => {
    // The live park: its FIRST event predates the sourceKind payload, and the
    // activities row has since been overwritten to `tool_use` — not a park kind at
    // all. Both obvious readings yield `unknown` while 21 of that episode's own
    // events say `provider_recovery_pending`. The known-kind filter is what makes
    // using them safe: a row value leaking through the emitter is excluded rather
    // than quoted.
    const out = buildInterventions({
      events: [
        ev("a1", "paused_for_input", "2026-09-01T00:00:00.000Z", "sr-1", null),
        ev("a1", "paused_for_input", "2026-09-01T00:05:00.000Z", "sr-1", "provider_recovery_pending"),
        ev("a1", "paused_for_input", "2026-09-01T00:10:00.000Z", "sr-1", "tool_use"),
      ],
      sourceKinds: new Map([["a1", "tool_use"]]),
      run: run({ status: "active" }), nowMs: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0].sourceKind).toBe("provider_recovery_pending");
    expect(out[0].enteredAt).toBe("2026-09-01T00:00:00.000Z"); // still the FIRST
  });

  it("prefers the event's sourceKind over the mutable activities row", () => {
    // The row holds the LATEST value, so a reused activity reports a later pause's
    // reason with full confidence.
    const out = buildInterventions({
      events: [ev("a1", "paused_for_input", "2026-09-01T00:10:00.000Z", "sr-1", "gate_decision_pending")],
      sourceKinds: new Map([["a1", "mark_done_pending"]]),
      run: run(), nowMs: NOW,
    });
    expect(out[0].sourceKind).toBe("gate_decision_pending");
  });
});

describe("computeAwaitingYou", () => {
  it("counts the parks no activity row holds — an open question, a chat reply — beside the card parks", () => {
    // The goals rail read only the activity half and showed no WAITING under an
    // open question. Only the union is complete; the longest wait names the kind.
    const out = computeAwaitingYou([], [
      { sourceKind: "question_pending", sinceMs: 5 * 60_000 },
      { sourceKind: "chat_reply_pending", sinceMs: 60_000 },
    ]);
    expect(out).toEqual({ count: 2, sinceMs: 5 * 60_000, sourceKind: "question_pending" });
  });

  const park = (over: Partial<Intervention>): Intervention => ({
    activityId: "a1", goalId: GOAL_ID, workflowRunId: RUN_ID, workflowStepRunId: "sr-1",
    sourceKind: "step_confirmation_pending", enteredAt: "2026-09-01T00:00:00.000Z",
    exitedAt: null, durationMs: 1000, open: true, parkState: "awaiting_you", ...over,
  });

  it("reports zero as an observation rather than an absence", () => {
    expect(computeAwaitingYou([])).toEqual({ count: 0, sinceMs: null, sourceKind: null });
  });

  it("excludes an abandoned card — its run is dead and answering it achieves nothing", () => {
    expect(computeAwaitingYou([park({ parkState: "abandoned" })]).count).toBe(0);
  });

  it("reports the longest open park and its kind", () => {
    const out = computeAwaitingYou([
      park({ activityId: "a1", durationMs: 1000 }),
      park({ activityId: "a2", durationMs: 90_000, sourceKind: "permission_pending" }),
    ]);
    expect(out).toEqual({ count: 2, sinceMs: 90_000, sourceKind: "permission_pending" });
  });
});

describe("cost provenance", () => {
  const span = (sources: Array<"provider" | "price_map" | null>) =>
    buildRunDetail({
      run: run(), stepRuns: [stepRun({ stepRunId: "sr-1" })],
      transitions: sources.map((source, i) =>
        complete({ id: `c${i}`, at: `2026-09-01T00:0${i}:00.000Z`, stepRunId: "sr-1", usd: 1, source })),
      events: [], runEvents: [], sourceKinds: new Map(),
      stepNames: new Map(), nowMs: NOW,
    }).spans[0].cost?.state;

  it("distinguishes a provider figure from our own estimate", () => {
    // The price map does not price cache, so an estimate is systematically low on
    // a cache-heavy run. Rendering the two identically is "absence is never zero"
    // one level in: not a missing number shown as zero, but an ESTIMATE shown as
    // a measurement.
    expect(span(["provider"])).toBe("measured");
    expect(span(["price_map"])).toBe("estimated");
  });

  it("claims neither provenance when a span's completions disagree", () => {
    // A total mixing an authoritative figure with an estimate has neither, and
    // claiming either would be worse than claiming none.
    expect(span(["provider", "price_map"])).toBe("reported");
  });

  it("reports a pre-field completion as reported rather than guessing", () => {
    expect(span([null])).toBe("reported");
  });
});

describe("span parked time", () => {
  it("attributes a park that falls INSIDE a span to that span", () => {
    // Live: one Triage span is 78 minutes elapsed with 74.6 of them a
    // confirmation card. Forcing span parked to 0 pushed all of it into
    // `unaccounted`, so the step row said "unaccounted" about the same minutes
    // the run header called "waiting on you".
    const detail = buildRunDetail({
      run: run({ status: "active" }),
      stepRuns: [stepRun({ stepRunId: "sr-1", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T01:00:00.000Z" })],
      transitions: [],
      events: [
        ev("a1", "paused_for_input", "2026-09-01T00:10:00.000Z", "sr-1"),
        ev("a1", "active", "2026-09-01T00:50:00.000Z", "sr-1"),
      ],
      runEvents: [], sourceKinds: new Map(), stepNames: new Map(), nowMs: NOW,
    });
    expect(detail.spans[0].parkedMs).toBe(40 * 60_000);
  });

  it("attributes a park BETWEEN two spans to neither", () => {
    // The original rule, which stays true and now needs no special case: a park
    // that overlaps no span lands in no span.
    const detail = buildRunDetail({
      run: run({ status: "active" }),
      stepRuns: [
        stepRun({ stepRunId: "sr-1", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:10:00.000Z" }),
        stepRun({ stepRunId: "sr-2", startedAt: "2026-09-01T00:50:00.000Z", finishedAt: "2026-09-01T01:00:00.000Z" }),
      ],
      transitions: [],
      events: [
        ev("a1", "paused_for_input", "2026-09-01T00:20:00.000Z", "sr-1"),
        ev("a1", "active", "2026-09-01T00:40:00.000Z", "sr-1"),
      ],
      runEvents: [], sourceKinds: new Map(), stepNames: new Map(), nowMs: NOW,
    });
    expect(detail.spans.map((s) => s.parkedMs)).toEqual([0, 0]);
  });

  it("clips a park that straddles the span boundary", () => {
    const detail = buildRunDetail({
      run: run({ status: "active" }),
      stepRuns: [stepRun({ stepRunId: "sr-1", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:30:00.000Z" })],
      transitions: [],
      events: [
        ev("a1", "paused_for_input", "2026-09-01T00:20:00.000Z", "sr-1"),
        ev("a1", "active", "2026-09-01T00:50:00.000Z", "sr-1"),
      ],
      runEvents: [], sourceKinds: new Map(), stepNames: new Map(), nowMs: NOW,
    });
    expect(detail.spans[0].parkedMs).toBe(10 * 60_000);
  });
});


describe("computeStopCompliance", () => {
  it("does not answer a question that was never asked", () => {
    // Null, never true. "No stop was requested" and "the stop was obeyed" are
    // different facts; collapsing them would report perfect compliance for a
    // harness that had never once been tested on it.
    const c = computeStopCompliance([runEv("workflow.run.started", "2026-09-01T00:00:00.000Z")], RUN_ID);
    expect(c.requested).toBe(0);
    expect(c.honored).toBeNull();
  });

  it("is honored when nothing starts work after the request", () => {
    const c = computeStopCompliance(
      [
        runEv("workflow.worker.prompted", "2026-09-01T00:00:00.000Z"),
        runEv("workflow.run.stop_requested", "2026-09-01T00:10:00.000Z"),
        runEv("workflow.run.paused", "2026-09-01T00:10:01.000Z"),
      ],
      RUN_ID
    );
    expect(c).toMatchObject({ requested: 1, honored: true, violationEvidence: null });
    expect(c.lastRequestedAt).toBe("2026-09-01T00:10:00.000Z");
  });

  it("is violated when the harness starts work anyway, and says what did", () => {
    // The live failure: "stop" was acknowledged, then the watchdog restarted the
    // step three times and blocked the run. Nothing recorded that a stop had ever
    // been asked for, so this was unanswerable.
    const c = computeStopCompliance(
      [
        runEv("workflow.run.stop_requested", "2026-09-01T00:10:00.000Z"),
        runEv("workflow.step.started", "2026-09-01T00:20:00.000Z"),
      ],
      RUN_ID
    );
    expect(c.honored).toBe(false);
    expect(c.violationEvidence).toBe("workflow.step.started");
  });

  it("closes the window at a resume — work the operator asked for is not a violation", () => {
    const c = computeStopCompliance(
      [
        runEv("workflow.run.stop_requested", "2026-09-01T00:10:00.000Z"),
        runEv("workflow.run.started", "2026-09-01T00:30:00.000Z"),
        runEv("workflow.worker.prompted", "2026-09-01T00:31:00.000Z"),
      ],
      RUN_ID
    );
    expect(c.honored).toBe(true);
  });

  it("does not count an in-flight turn LANDING as starting work", () => {
    const c = computeStopCompliance(
      [
        runEv("workflow.run.stop_requested", "2026-09-01T00:10:00.000Z"),
        runEv("workflow.worker.responded", "2026-09-01T00:10:30.000Z"),
        runEv("workflow.step.completed", "2026-09-01T00:10:40.000Z"),
      ],
      RUN_ID
    );
    expect(c.honored).toBe(true);
  });

  it("judges from the LAST request when the operator asked twice", () => {
    const c = computeStopCompliance(
      [
        runEv("workflow.run.stop_requested", "2026-09-01T00:10:00.000Z"),
        runEv("workflow.step.started", "2026-09-01T00:15:00.000Z"),
        runEv("workflow.run.stop_requested", "2026-09-01T00:20:00.000Z"),
      ],
      RUN_ID
    );
    expect(c.requested).toBe(2);
    expect(c.honored).toBe(true);
  });

  it("ignores another run's stop", () => {
    const c = computeStopCompliance(
      [runEv("workflow.run.stop_requested", "2026-09-01T00:10:00.000Z", "other")],
      RUN_ID
    );
    expect(c.honored).toBeNull();
  });
});
