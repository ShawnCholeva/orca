import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSummary } from "@orca/contracts";
import { WaitingOnYouBanner, waitingRuns } from "./WaitingOnYouBanner";

afterEach(cleanup);

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

describe("WaitingOnYouBanner", () => {
  it("says nothing when nothing is waiting", () => {
    const { container } = render(<WaitingOnYouBanner runs={[run()]} onOpenGoal={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("names the run, the wait, and what it actually wants", () => {
    // "Orca is waiting on you" is a sentence a reader learns to ignore. The pause
    // kind is what turns it into one they act on.
    render(<WaitingOnYouBanner onOpenGoal={() => {}} runs={[run({
      awaitingYou: { count: 1, sinceMs: 39 * HOUR, sourceKind: "step_confirmation_pending" },
    })]} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Adaptive Delivery has been waiting on you for 39h 0m");
    expect(text).toContain("a step waiting for your OK");
  });

  it("states the wait and stops when the pause reason was not recorded", () => {
    // Never invent a plausible reason for an absent one: it would send the reader to
    // the wrong card, and it is the label-outliving-its-evidence failure in the one
    // place where acting on it costs them a trip.
    render(<WaitingOnYouBanner onOpenGoal={() => {}} runs={[run({
      awaitingYou: { count: 1, sinceMs: 2 * HOUR, sourceKind: "unknown" },
    })]} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("has been waiting on you for 2h 0m");
    expect(text).not.toMatch(/waiting for your OK|a question from|permission request/);
  });

  it("leads with the longest wait and counts the rest", () => {
    render(<WaitingOnYouBanner onOpenGoal={() => {}} runs={[
      run({ runId: "a", goalId: "ga", templateName: "Short one",
            awaitingYou: { count: 1, sinceMs: HOUR, sourceKind: "question_pending" } }),
      run({ runId: "b", goalId: "gb", templateName: "Long one",
            awaitingYou: { count: 1, sinceMs: 39 * HOUR, sourceKind: "mark_done_pending" } }),
    ]} />);
    expect(document.body.textContent).toContain("Long one has been waiting");
    expect(document.body.textContent).toContain("and 1 other run");
  });

  it("opens the goal the lead run belongs to", () => {
    const onOpenGoal = vi.fn();
    render(<WaitingOnYouBanner onOpenGoal={onOpenGoal} runs={[run({
      goalId: "g-42", awaitingYou: { count: 1, sinceMs: HOUR, sourceKind: "question_pending" },
    })]} />);
    fireEvent.click(screen.getByRole("button", { name: /Open it/ }));
    expect(onOpenGoal).toHaveBeenCalledWith("g-42");
  });

  it("has no dismiss control", () => {
    // A banner that can be dismissed is dismissed at hour one and absent at hour
    // thirty-nine — which is exactly the failure it exists to prevent. It goes away
    // when the park does, and not before.
    render(<WaitingOnYouBanner onOpenGoal={() => {}} runs={[run({
      awaitingYou: { count: 1, sinceMs: 39 * HOUR, sourceKind: "question_pending" },
    })]} />);
    expect(screen.queryByRole("button", { name: /dismiss|close|hide/i })).toBeNull();
  });

  it("never fades anything", () => {
    const { container } = render(<WaitingOnYouBanner onOpenGoal={() => {}} runs={[run({
      awaitingYou: { count: 1, sinceMs: HOUR, sourceKind: "question_pending" },
    })]} />);
    expect(container.innerHTML).not.toMatch(/opacity:\s*0?\.\d/i);
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
});
