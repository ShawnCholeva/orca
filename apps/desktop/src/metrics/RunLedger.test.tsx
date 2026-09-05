import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Intervention, RunDetail, RunSummary, RunTraceSpan } from "@orca/contracts";
import { CostCaveats, RunDetailPanel, RunLedger, RunRow, headline, terminatedRuns, workflowEvidenceRuns } from "./RunLedger";
import * as api from "../api";

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
    openInterventions: 0,
    // The completed-run case: nothing waits because the run is over. The
    // INTERESTING case is the opposite — a live run holding an open card — so this
    // fixture should not be read as covering it.
    awaitingYou: { count: 0, sinceMs: null, sourceKind: null },
    // A completed run: progress and signal agree, and nothing was mid-flight, so
    // silence is conclusive. A run whose signal outran its progress is the
    // "moving but not advancing" case and is asserted separately.
    progress: {
      lastProgressAt: "2026-09-01T21:00:00.000Z", lastProgressChannel: "step_boundary",
      lastSignalAt: "2026-09-01T21:00:00.000Z", lastSignalChannel: "step_boundary",
      silenceConclusive: true,
    },
    ...over,
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

  it("marks the total as understated, attached to the figure, when a node spent money and reported nothing", () => {
    // The row carries a typed marker rather than the full sentence: at one paragraph
    // per row this repeated verbatim six times on one screen, and repetition is not
    // salience — by the third row it is wallpaper. The sentence itself, with its
    // count, is stated once above the rows by CostCaveats and asserted below.
    //
    // What must NOT weaken: the marker is typed and adjacent to the figure, so the
    // total cannot be read as complete. A bare dash here would be the untyped
    // absence this screen exists to remove.
    render(<RunRow onOpen={() => {}} run={summary({
      cost: { usd: 5, wastedUsd: 0, failedUsd: 0, supersededUsd: 0,
              coverage: { reported: 3, total: 3, silent: 2 }, rollupCheck: "matches" },
    })} />);
    const tag = document.querySelector('[data-compact="true"]');
    expect(tag).toBeTruthy();
    expect(tag!.textContent).toBe("discarded");
    expect(tag!.getAttribute("aria-label")).toContain("2 more nodes spent money and reported nothing");
    expect(document.body.textContent).not.toContain("—");
  });

  it("states the compacted caveats once above the rows", () => {
    // The other half of the row-tag contract. A tag alone is a caveat the reader
    // cannot resolve, so the sentence has to be somewhere. The `fix` stays at full
    // size: it is the entire actionable content.
    //
    // The SILENT-NODE caveat keeps its count — it tallies nodes, the scale is what
    // makes the fix worth doing, and no other number on the screen counts nodes.
    // The NEVER-COMPLETED caveat drops its count deliberately: it tallied a per-row
    // state each affected row already carries, and with seven runs "6 ended" and
    // "6 never completed" are different sets sharing a number. Same numeral, two
    // populations, difference unnamed — the count rule at the copy level.
    render(<CostCaveats runs={[
      summary({ runId: "a", cost: { usd: 5, wastedUsd: 0, failedUsd: 0, supersededUsd: 0,
        coverage: { reported: 3, total: 3, silent: 2 }, rollupCheck: "not_applicable" } }),
      summary({ runId: "b", cost: { usd: 2, wastedUsd: 0, failedUsd: 0, supersededUsd: 0,
        coverage: { reported: 1, total: 1, silent: 1 }, rollupCheck: "not_applicable" } }),
    ]} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("3 nodes across these runs spent money and reported nothing");
    expect(text).toContain("runs that never reached completion have no roll-up");
    // No bare tally of a per-row state: it would collide with the headline's count.
    expect(text).not.toMatch(/\d+ of these runs never/);
    expect(text).toContain("Emit step_launch/step_complete on the gate surrogate.");
  });

  it("says nothing when there is no caveat to state", () => {
    // Never render a container whose content cannot be computed — an empty honesty
    // block is a heading that teaches the reader to skip the honesty blocks.
    const { container } = render(<CostCaveats runs={[summary({
      cost: { usd: 5, wastedUsd: 0, failedUsd: 0, supersededUsd: 0,
              coverage: { reported: 3, total: 3, silent: 0 }, rollupCheck: "matches" },
    })]} />);
    expect(container.firstChild).toBeNull();
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

describe("terminatedRuns", () => {
  it("keeps a live run out of every aggregate while it still renders as a row", () => {
    // A run in progress is a partial observation whose value changes every second.
    // The live case: one run sits at 39.4h elapsed / 39.2h parked and still
    // accruing — pooled, it would dominate any ratio forever and keep growing.
    const runs = [
      summary({ runId: "done", terminationCause: "completed", durations: {
        elapsedMs: 60_000, workingMs: 60_000, parkedMs: 0, unaccountedMs: 0,
        spanActiveMs: 0, accruing: false, integrityFlag: null } }),
      summary({ runId: "live", terminationCause: "running", durations: {
        elapsedMs: 141_840_000, workingMs: 0, parkedMs: 141_120_000, unaccountedMs: 720_000,
        spanActiveMs: 0, accruing: true, integrityFlag: null } }),
    ];
    expect(terminatedRuns(runs).map((r) => r.runId)).toEqual(["done"]);
    // Pooled, the parked share would be ~99% and rising. Over ended runs it is 0.
    expect(headline(runs)).not.toContain("waiting on you");
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
    expect(headline(runs)).toContain("1 completed run");
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
    expect(h).toContain("2 of your 3 runs that ended stopped the same way");
    expect(h).toContain("crashed 3 times (worker_exited_no_signal)");
    expect(h).toContain("root-caused");
    expect(h).not.toContain("were killed by the daemon");
    // The whole point: it says how much workflow evidence is actually left — and
    // names the quantity, so "6 runs minus 4 killed" doesn't invite the reader to
    // expect 2 when a still-running run has reported nothing yet.
    expect(h).toContain("1 completed run");
  });

  it("does not claim a shared cause when the evidence differs", () => {
    const runs = [
      summary({ runId: "a", terminationCause: "infrastructure_killed", terminationEvidence: "crashed 3 times" }),
      summary({ runId: "b", terminationCause: "infrastructure_killed", terminationEvidence: "no progress after 3 restarts" }),
    ];
    const h = headline(runs);
    expect(h).not.toContain("the same way");
    expect(h).toContain("reasons in the substrate");
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
    const tag = document.querySelector('[data-compact="true"]');
    expect(tag!.textContent).toBe("discarded");
    // The tag occupies the reason cell rather than sitting beside a placeholder —
    // the absent thing is the reason, so the reason slot carries its type.
    expect(document.body.textContent).not.toContain("a pause");
  });

  it("states the overwrite finding once, including that the UNTAGGED rows may be wrong", () => {
    // `source_kind` is NOT NULL and is overwritten as the activity advances, so
    // `unknown` fires only when the overwrite lands outside the pause vocabulary.
    // When it lands on another pause kind the row shows a confident, specific,
    // plausible — and wrong — reason, with no tag at all. So the tagged rows are the
    // honest ones and a fallback marks where the system noticed, not where it failed.
    // No per-row treatment can say that; only this statement can, which is why the
    // row tags are quiet and the alarm lives here.
    render(<RunDetailPanel detail={detail({ interventions: [
      park({ activityId: "a1", sourceKind: "unknown" }),
      park({ activityId: "a2", sourceKind: "permission_pending" }),
      park({ activityId: "a3", sourceKind: "question_pending" }),
    ] })} onBack={() => {}} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("1 is missing outright");
    expect(text).toContain("the 2 that show a reason may be showing a later pause's reason instead");
  });

  it("never dims anything", () => {
    // Binding rule: an unmeasured value is a different object, not a faint one.
    const { container } = render(<RunDetailPanel detail={detail({
      spans: [span(), span({ workflowStepRunId: "sr2", kind: "gate", elapsedMs: null, workingMs: null, cost: null, tier: null, verifiers: null })],
    })} onBack={() => {}} />);
    expect(container.innerHTML).not.toMatch(/opacity/i);
  });
});

describe("loading failures", () => {
  it("keeps the loaded list on screen when a run's detail fetch fails", async () => {
    // One `error` flag across both fetches meant a failed DETAIL request replaced
    // every already-loaded row with a dead-end sentence. In this environment any
    // agent saving a file restarts the daemon, so a transient 500 is routine rather
    // than exceptional — and losing six rows the reader was mid-way through reading
    // is a worse failure than the fetch itself.
    vi.spyOn(api, "getRunSummaries").mockResolvedValue([summary()]);
    vi.spyOn(api, "getRunDetail").mockRejectedValue(new Error("500"));
    render(<RunLedger />);

    fireEvent.click(await screen.findByRole("button", { name: /Adaptive Delivery/ }));
    expect(await screen.findByText(/Couldn't load this run/)).toBeInTheDocument();

    // The way back is present, and it lands on a list that never went away.
    fireEvent.click(screen.getByRole("button", { name: /All runs/ }));
    expect(await screen.findByRole("button", { name: /Adaptive Delivery/ })).toBeInTheDocument();
  });

  it("offers a retry that actually refetches, rather than a dead end", async () => {
    const runs = vi.spyOn(api, "getRunSummaries").mockRejectedValueOnce(new Error("500"));
    render(<RunLedger />);
    expect(await screen.findByText(/Couldn't load runs/)).toBeInTheDocument();

    runs.mockResolvedValue([summary()]);
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Adaptive Delivery/ })).toBeInTheDocument());
  });
});
