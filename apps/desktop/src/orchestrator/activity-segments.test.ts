import { describe, expect, it } from "vitest";
import type { Activity, ActivityDiff, ActivityStep } from "@orca/contracts";
import { splitActivityAtDiffs } from "./activity-segments";

const diff: ActivityDiff = {
  filePath: ".gitignore",
  additions: 4,
  deletions: 0,
  hunks: [{ oldStart: null, newStart: null, lines: [{ kind: "add", text: "node_modules" }] }],
};

const step = (over: Partial<ActivityStep> & { id: string }): ActivityStep => ({
  text: `step ${over.id}`,
  category: null,
  status: "done",
  createdAt: `2026-06-16T00:00:0${over.id}.000Z`,
  ...over,
});

const activity = (over: Partial<Activity>): Activity => ({
  id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null,
  turnOrdinal: 0, status: "active", currentText: "", finalSummary: null,
  sourceKind: "tool_use", workCategory: null, confidence: null, stepName: "Execution",
  steps: [], createdAt: "2026-06-16T00:00:00.000Z", updatedAt: "2026-06-16T00:00:00.000Z",
  completedAt: null, ...over,
});

describe("splitActivityAtDiffs", () => {
  it("puts the steps that came AFTER a diff below it, not above it", () => {
    const parts = splitActivityAtDiffs(
      activity({
        steps: [
          step({ id: "1" }),
          step({ id: "2", diff }),
          step({ id: "3" }),
          step({ id: "4", status: "active" }),
        ],
      }),
      true
    );

    expect(parts.map((p) => p.kind)).toEqual(["card", "diff", "card"]);
    const [before, , after] = parts;
    // The diff-bearing step keeps its narration row above its own diff card.
    expect(before.kind === "card" && before.activity.steps.map((s) => s.id)).toEqual(["1", "2"]);
    // The regression: these two used to render ABOVE the diff, in a card the
    // reader had already scrolled past, so the turn looked finished.
    expect(after.kind === "card" && after.activity.steps.map((s) => s.id)).toEqual(["3", "4"]);
  });

  it("orders each part by the step it belongs to, so it interleaves with messages", () => {
    const parts = splitActivityAtDiffs(
      activity({ steps: [step({ id: "1" }), step({ id: "2", diff }), step({ id: "3" })] }),
      true
    );
    // The opening card anchors at the turn's start; everything after a diff
    // anchors at that diff's own step — never at the turn's start.
    expect(parts.map((p) => p.at)).toEqual([
      "2026-06-16T00:00:00.000Z",
      "2026-06-16T00:00:02.000Z",
      "2026-06-16T00:00:02.000Z",
    ]);
    expect(parts.map((p) => p.seq)).toEqual([0, 1, 2]);
  });

  it("gives the header to the first segment and the live tail to the last", () => {
    const parts = splitActivityAtDiffs(
      activity({ steps: [step({ id: "1", diff }), step({ id: "2" })] }),
      true
    );
    const cards = parts.filter((p) => p.kind === "card");
    expect(cards.map((c) => c.kind === "card" && c.head)).toEqual([true, false]);
    expect(cards.map((c) => c.kind === "card" && c.tail)).toEqual([false, true]);
  });

  it("keeps a trailing card for a running turn whose last step was a diff", () => {
    // This is where the live pulse has to live: the worker is still going, and
    // the only thing below the diff is the segment that says so.
    const parts = splitActivityAtDiffs(activity({ steps: [step({ id: "1", diff })] }), true);
    expect(parts.map((p) => p.kind)).toEqual(["card", "diff", "card"]);
    const last = parts[2];
    expect(last.kind === "card" && last.activity.steps).toEqual([]);
    expect(last.kind === "card" && last.tail).toBe(true);
  });

  it("drops an empty trailing card when the turn is over and has nothing left to say", () => {
    const parts = splitActivityAtDiffs(
      activity({ status: "completed", finalSummary: null, steps: [step({ id: "1", diff })] }),
      true
    );
    expect(parts.map((p) => p.kind)).toEqual(["card", "diff"]);
  });

  it("keeps an empty trailing card that still owns a closing summary", () => {
    const parts = splitActivityAtDiffs(
      activity({ status: "completed", finalSummary: "Added the ignore rules.", steps: [step({ id: "1", diff })] }),
      true
    );
    expect(parts.map((p) => p.kind)).toEqual(["card", "diff", "card"]);
  });

  it("emits one card for a turn with no diffs at all", () => {
    const parts = splitActivityAtDiffs(activity({ steps: [step({ id: "1" }), step({ id: "2" })] }), true);
    expect(parts).toHaveLength(1);
    expect(parts[0].kind === "card" && parts[0].head).toBe(true);
    expect(parts[0].kind === "card" && parts[0].tail).toBe(true);
  });

  it("still surfaces diffs from a turn that earns no card of its own", () => {
    const parts = splitActivityAtDiffs(
      activity({ sourceKind: "orchestrator_reasoning", steps: [step({ id: "1", diff })] }),
      false
    );
    expect(parts.map((p) => p.kind)).toEqual(["diff"]);
  });
});
