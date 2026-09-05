import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IMPLEMENTATION_VOCABULARY } from "@orca/contracts";
import type { Intervention, RunDetail, RunSummary, RunTraceSpan } from "@orca/contracts";
import { CantTellYou, CostCaveats, RunDetailPanel, RunRow } from "./RunLedger";

afterEach(cleanup);

// Seven developer instructions reached the founder's screen — "Emit
// step_launch/step_complete on the gate surrogate", "Wire the PostToolUse hook",
// "Stamp the pause reason into the event". We removed them from the visible layer and
// one survived another day in every `aria-label`, spoken verbatim, because
// `MeasurementLabel` builds its accessible name from the same strings.
//
// The contracts guard checks what the module RETURNS. It cannot check what callers
// SUPPLY: `reason` and `detail` are passthroughs, so a call site can hand implementation
// talk straight through to the reader, and to the accessible name in particular — the
// channel that already carried one for a day. This is that half.
//
// It asserts over BOTH channels deliberately. Visible text is checked by looking at a
// page; an accessible name is not, and the day this defect survived was a day spent
// verifying copy by looking at rendered pixels. The instrument was correct, used well,
// and had a blind spot shaped exactly like its own strength.
//
// One more property worth naming, because it is counter-intuitive and repeatable:
// moving a string OUT of the visual layer increases its exposure rather than reducing
// it. It removes the only warning that the string exists, and the reader who still
// receives it is the one least able to complain about it.

const H = 3_600_000;

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "r1", goalId: "g1", goalTitle: "Add a Kelvin conversion",
    templateId: "t", templateName: "Adaptive Delivery", templateVersion: 16,
    status: "completed", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T01:00:00.000Z",
    blockedReason: null, terminationCause: "infrastructure_killed",
    terminationEvidence: "crashed 3 times (worker_exited_no_signal)",
    durations: { elapsedMs: H, workingMs: 600_000, parkedMs: 2_400_000, unaccountedMs: 600_000,
                 spanActiveMs: 0, accruing: false, integrityFlag: null },
    cost: { usd: 0, wastedUsd: 0, failedUsd: 0, supersededUsd: 0,
            coverage: { reported: 0, total: 0, silent: 2 }, rollupCheck: "not_applicable" },
    stepsDelivered: 0, stepsBlocked: 1, spanRelaunches: 2, retriedCompletions: 0,
    openInterventions: 1,
    progress: { lastProgressAt: null, lastProgressChannel: null, lastSignalAt: null,
                lastSignalChannel: null, silenceConclusive: true },
    awaitingYou: { count: 0, sinceMs: null, sourceKind: null },
    ...over,
  };
}

function span(over: Partial<RunTraceSpan> = {}): RunTraceSpan {
  return {
    workflowRunId: "r1", workflowStepRunId: "sr1", goalId: "g1", stepTemplateId: "critique",
    name: "Critique", ordinal: 0, attempt: 1, kind: "gate",
    startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:02:00.000Z",
    elapsedMs: 120_000, workingMs: null, status: "passed", blockedReason: null,
    restarts: 0, completions: 1, stallRescues: 0, cost: null, tier: null,
    verifiers: null, refuteVerdict: null, conflicts: [], outcomeStatus: "succeeded",
    failureCode: null, ...over,
  };
}

function park(over: Partial<Intervention> = {}): Intervention {
  return {
    activityId: "a1", goalId: "g1", workflowRunId: "r1", workflowStepRunId: "sr1",
    sourceKind: "unknown", enteredAt: "2026-09-01T00:10:00.000Z", exitedAt: null,
    durationMs: 3_000_000, open: true, parkState: "abandoned", ...over,
  };
}

const detail = (): RunDetail => ({
  run: summary(),
  spans: [span(), span({ workflowStepRunId: "sr2", name: "Verify" })],
  interventions: [park(), park({ activityId: "a2", sourceKind: "step_confirmation_pending" })],
});

/** Every string this surface puts in front of a reader, spoken or seen. */
function readerFacingText(root: HTMLElement): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    const label = el.getAttribute("aria-label");
    if (label) out.push({ where: `aria-label on <${el.tagName.toLowerCase()}>`, text: label });
    const title = el.getAttribute("title");
    if (title) out.push({ where: `title on <${el.tagName.toLowerCase()}>`, text: title });
  }
  out.push({ where: "visible text", text: root.textContent ?? "" });
  return out;
}

describe("no surface speaks to the reader about our backlog", () => {
  const surfaces: [string, () => HTMLElement][] = [
    ["RunRow", () => render(<RunRow run={summary()} onOpen={() => {}} />).container],
    ["RunDetailPanel", () => render(<RunDetailPanel detail={detail()} onBack={() => {}} />).container],
    ["CostCaveats", () => render(<CostCaveats runs={[summary(), summary({ runId: "b" })]} />).container],
    ["CantTellYou", () => render(<CantTellYou runs={[summary(), summary({ runId: "b" })]} />).container],
  ];

  for (const [name, mount] of surfaces) {
    it(`${name} carries none, in visible text or in an accessible name`, () => {
      for (const { where, text } of readerFacingText(mount())) {
        expect(text, `${name} — ${where}`).not.toMatch(IMPLEMENTATION_VOCABULARY);
      }
    });
  }

  it("the detector actually catches a caller-supplied instruction", () => {
    // A guard that cannot fail is decoration. `reason` and `detail` are passthroughs,
    // so this is precisely the hole the contracts test cannot see — and it is how the
    // seven got in.
    expect("Emit step_launch/step_complete on the gate surrogate.").toMatch(IMPLEMENTATION_VOCABULARY);
    expect("Wire the PostToolUse hook.").toMatch(IMPLEMENTATION_VOCABULARY);
    expect("It needs a fix before it can show up here.").toMatch(IMPLEMENTATION_VOCABULARY);
    // And does not fire on the reader-facing replacements, or on `uninstrumented`,
    // where the word boundary saves us from `instrument`.
    expect("This isn't being recorded yet.").not.toMatch(IMPLEMENTATION_VOCABULARY);
    expect("This gate ran a real agent, and its cost and timing weren't recorded.")
      .not.toMatch(IMPLEMENTATION_VOCABULARY);
  });
});
