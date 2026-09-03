import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Intervention, RunDetail, RunSummary, RunTraceSpan } from "@orca/contracts";
import { RunDetailPanel, RunRow, headline, workflowEvidenceRuns } from "./RunLedger";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "r1", goalId: "g1", templateId: "t", templateName: "Adaptive Delivery",
    templateVersion: 16, status: "completed",
    startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T21:00:00.000Z",
    blockedReason: null, terminationCause: "completed", terminationEvidence: null,
    durations: {
      elapsedMs: 3_600_000, workingMs: 600_000, parkedMs: 2_400_000,
      unaccountedMs: 600_000, spanActiveMs: 1_200_000, accruing: false, integrityFlag: null,
    },
    cost: {
      usd: 61.52, wastedUsd: 50.66, failedUsd: 48.02, supersededUsd: 2.64,
      coverage: { reported: 10, total: 11, silent: 0 }, rollupCheck: "matches",
    },
    stepsDelivered: 8, stepsBlocked: 0, spanRelaunches: 1, retriedCompletions: 5,
    openInterventions: 0, ...over,
  };
}

function span(over: Partial<RunTraceSpan> = {}): RunTraceSpan {
  return {
    workflowRunId: "r1", workflowStepRunId: "sr1", goalId: "g1",
    stepTemplateId: "triage", name: "Triage", ordinal: 0, attempt: 1, kind: "step",
    startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:30:00.000Z",
    elapsedMs: 1_800_000, workingMs: 600_000,
    status: "passed", blockedReason: null, restarts: 0, completions: 1, stallRescues: 0,
    cost: { usd: 1.52, tokensIn: 10, tokensOut: 20, state: "reported" },
    tier: "partially_verified",
    verifiers: { executable: false, grounding: true, independentReview: false },
    refuteVerdict: null, conflicts: [], outcomeStatus: "succeeded", failureCode: null, ...over,
  };
}

function park(over: Partial<Intervention> = {}): Intervention {
  return {
    activityId: "a1", goalId: "g1", workflowRunId: "r1", workflowStepRunId: "sr1",
    sourceKind: "step_confirmation_pending",
    enteredAt: "2026-09-01T00:30:00.000Z", exitedAt: null,
    durationMs: 3_000_000, open: true, parkState: "abandoned", ...over,
  };
}

function detail(over: Partial<RunDetail> = {}): RunDetail {
  return { run: summary(), spans: [span()], interventions: [park()], ...over };
}

describe("cost", () => {
  it("renders the typed absence INSTEAD of a figure when nothing reported a cost", () => {
    // "Unmetered reads as free" is the bug the whole cost vocabulary exists to
    // prevent. A typed label beneath a confident $0.00 does not prevent it — the
    // reader takes the number and skips the caption.
    render(<RunRow onOpen={() => {}} run={summary({
      cost: { usd: 0, wastedUsd: 0, failedUsd: 0, supersededUsd: 0,
              coverage: { reported: 0, total: 0, silent: 0 }, rollupCheck: "not_applicable" },
    })} />);
    expect(document.body.textContent).not.toContain("$0.00");
    expect(document.body.textContent).toContain("isn't being recorded yet");
  });

  it("says the total is understated when a node spent money and reported nothing", () => {
    render(<RunRow onOpen={() => {}} run={summary({
      cost: { usd: 5, wastedUsd: 0, failedUsd: 0, supersededUsd: 0,
              coverage: { reported: 3, total: 3, silent: 2 }, rollupCheck: "matches" },
    })} />);
    expect(document.body.textContent).toContain("2 more nodes spent money and reported nothing");
  });

  it("states coverage as a count, never as an interval over a census", () => {
    // Coverage enumerates THIS run's own nodes. There is no larger population it
    // samples, so "3 of 3" is a fact, exact at n=1 — hedging it with a confidence
    // interval is the facts-vs-estimates inversion in the other direction.
    render(<RunRow onOpen={() => {}} run={summary({
      cost: { usd: 5, wastedUsd: 0, failedUsd: 0, supersededUsd: 0,
              coverage: { reported: 3, total: 3, silent: 0 }, rollupCheck: "matches" },
    })} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("3 of 3 nodes reported a cost");
    expect(text).not.toMatch(/between \d+% and \d+%/);
  });
});

describe("workflowEvidenceRuns", () => {
  it("is the single source for both the headline and the sample floor", () => {
    // These two lines must be the SAME quantity, not two predicates that agree
    // today. An n handed to a gate has to be the n of one population; two counts
    // that happen to match are that rule already broken, waiting for an edit.
    const runs = [
      summary({ runId: "a", terminationCause: "completed" }),
      summary({ runId: "b", terminationCause: "infrastructure_killed" }),
      summary({ runId: "c", terminationCause: "running" }),
      summary({ runId: "d", terminationCause: "workflow_failed" }),
    ];
    expect(workflowEvidenceRuns(runs).map((r) => r.runId)).toEqual(["a"]);
    // A run still in flight has reported nothing yet, so it is not yet evidence.
    expect(headline(runs)).toContain("1 finished run");
  });
});

describe("headline", () => {
  it("leads with contamination when runs were killed by the substrate", () => {
    const runs = [
      summary({ runId: "a", terminationCause: "infrastructure_killed", terminationEvidence: "crashed 3 times (worker_exited_no_signal)" }),
      summary({ runId: "b", terminationCause: "infrastructure_killed", terminationEvidence: "crashed 3 times (worker_exited_no_signal)" }),
      summary({ runId: "c", terminationCause: "completed" }),
    ];
    const h = headline(runs);
    // States the OBSERVED outcome; the mechanism is marked as a diagnosis rather
    // than asserted for runs nobody attributed individually.
    expect(h).toContain("2 of your 3 runs ended the same way");
    expect(h).toContain("crashed 3 times (worker_exited_no_signal)");
    expect(h).toContain("root-caused");
    expect(h).not.toContain("were killed by the daemon");
    // The whole point: it says how much workflow evidence is actually left — and
    // names the quantity, so "6 runs minus 4 killed" doesn't invite the reader to
    // expect 2 when a still-running run has reported nothing yet.
    expect(h).toContain("1 finished run");
  });

  it("does not claim a shared cause when the evidence differs", () => {
    const runs = [
      summary({ runId: "a", terminationCause: "infrastructure_killed", terminationEvidence: "crashed 3 times" }),
      summary({ runId: "b", terminationCause: "infrastructure_killed", terminationEvidence: "no progress after 3 restarts" }),
    ];
    const h = headline(runs);
    expect(h).not.toContain("the same way");
    expect(h).toContain("stopped without finishing");
  });

  it("reports the waiting share when nothing was killed", () => {
    expect(headline([summary()])).toContain("waiting on you");
  });

  it("says nothing rather than zero for no runs", () => {
    expect(headline([])).toBe("No runs yet.");
  });
});

describe("RunDetailPanel", () => {
  it("renders all four duration terms, never the residual alone", () => {
    render(<RunDetailPanel detail={detail()} onBack={() => {}} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("1h 0m = 10m working + 40m waiting on you + 10m unaccounted");
  });

  it("names an abandoned card as debris, never as waiting on you", () => {
    // All three of the founder's open cards are abandoned. Telling him they are
    // "waiting on you" would send him to answer cards that accomplish nothing.
    render(<RunDetailPanel detail={detail()} onBack={() => {}} />);
    expect(screen.getAllByText("left open when the run stopped").length).toBeGreaterThan(0);
    expect(screen.queryByText("waiting on you")).toBeNull();
  });

  it("says waiting on you when the run is genuinely still live", () => {
    render(<RunDetailPanel detail={detail({ interventions: [park({ parkState: "awaiting_you" })] })} onBack={() => {}} />);
    expect(screen.getAllByText("waiting on you").length).toBeGreaterThan(0);
  });

  it("renders a gate's known duration as entirely unaccounted, not as an unsummable split", () => {
    // A gate has a step_run bracket (so elapsed is known) but emits no
    // step_complete (so nothing was observed). That is 100% unaccounted — we know
    // it took 100s and watched none of it — not three nulls that fail to sum.
    render(<RunDetailPanel detail={detail({
      spans: [span({ kind: "gate", name: "Critique", elapsedMs: 100_000, workingMs: null, cost: null, tier: null, verifiers: null })],
    })} onBack={() => {}} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("none of it observed");
    expect(text).toContain("emit step_launch/step_complete on its surrogate");
    // The guard that catches an unsummable split must NOT fire here.
    expect(document.querySelectorAll('[data-seg="mismatch"]')).toHaveLength(0);
  });

  it("renders a span with no recorded bracket as an absence, not a zero-width bar", () => {
    render(<RunDetailPanel detail={detail({
      spans: [span({ elapsedMs: null, workingMs: null, cost: null, tier: null, verifiers: null })],
    })} onBack={() => {}} />);
    // An explicit absent material: a zero-width segment would read as "instant",
    // a duration nobody took.
    expect(document.querySelectorAll('[data-seg="absent"]').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-seg="working"]')).toHaveLength(1);
  });

  it("marks an LLM review distinctly from an executed check", () => {
    render(<RunDetailPanel detail={detail({
      spans: [span({ verifiers: { executable: true, grounding: false, independentReview: true } })],
    })} onBack={() => {}} />);
    expect(screen.getByText("tests ran")).toBeTruthy();
    expect(screen.getByText("a model reviewed it")).toBeTruthy();
  });

  it("says nothing checked it rather than leaving the verifier row blank", () => {
    render(<RunDetailPanel detail={detail({
      spans: [span({ verifiers: { executable: false, grounding: false, independentReview: false } })],
    })} onBack={() => {}} />);
    expect(screen.getByText("nothing checked this")).toBeTruthy();
  });

  it("flags a pause whose reason was destroyed as lossy rather than guessing", () => {
    render(<RunDetailPanel detail={detail({ interventions: [park({ sourceKind: "unknown" })] })} onBack={() => {}} />);
    expect(document.body.textContent).toContain("Stamp the pause reason into the event.");
  });

  it("never dims anything", () => {
    // Binding rule: an unmeasured value is a different object, not a faint one.
    const { container } = render(<RunDetailPanel detail={detail({
      spans: [span(), span({ workflowStepRunId: "sr2", kind: "gate", elapsedMs: null, workingMs: null, cost: null, tier: null, verifiers: null })],
    })} onBack={() => {}} />);
    expect(container.innerHTML).not.toMatch(/opacity/i);
  });
});
