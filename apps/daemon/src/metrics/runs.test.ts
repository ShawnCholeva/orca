import { describe, expect, it } from "vitest";
import type { HarnessTransition, Intervention } from "@orca/contracts";
import {
  buildInterventions, buildRunDetail, clampIntervals, computeAwaitingYou, computeCost,
  computeDurations, computeProgress, mergeIntervals, runTerminalMs, totalMs,
} from "./runs.js";
import type { ActivityEvent, RunRow, RunStepRunRow, RunTransition } from "./runs-fetch.js";

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
    finishedAt: "2026-09-01T00:30:00.000Z", blockedReason: null, stallRescues: 0, ...over,
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
    expect(detail.run.retriedCompletions).toBe(0);
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
      runEvents: [{ createdAt: "2026-09-01T00:55:00.000Z", type: "workflow.step.phase_changed", workflowRunId: RUN_ID }],
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
      runEvents: [{ createdAt: "2026-09-01T00:55:00.000Z", type: "workflow.step.started", workflowRunId: "other-run" }],
    });
    expect(p.lastSignalAt).toBe("2026-09-01T00:30:00.000Z");
  });

  it("clips both clocks to the run's own window", () => {
    const p = computeProgress({
      ...base,
      runEvents: [{ createdAt: "2026-09-02T00:00:00.000Z", type: "activity.changed", workflowRunId: RUN_ID }],
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
