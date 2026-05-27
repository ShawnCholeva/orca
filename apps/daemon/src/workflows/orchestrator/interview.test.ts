import { describe, expect, it } from "vitest";
import { reconstructTranscript, nextTurnIndex } from "./interview.js";
import type { WorkflowArtifact } from "@orca/contracts";

function turn(i: number, body: object): WorkflowArtifact {
  return {
    id: `t${i}`, goalId: "g", workflowRunId: "r", stepRunId: "sr",
    type: "interview_turn", title: `turn ${i}`, body: JSON.stringify(body),
    source: "user", linkedSessionId: null, linkedTaskId: null,
    linkedContextPackageId: null, createdAt: `2026-05-27T00:00:0${i}.000Z`,
  } as WorkflowArtifact;
}

describe("reconstructTranscript", () => {
  it("orders turns by turnIndex", () => {
    const arts = [
      turn(1, { turnIndex: 1, questionDecisionId: "d1", question: "q1", answer: "a1", answeredAt: "2026-05-27T00:00:01.000Z" }),
      turn(0, { turnIndex: 0, questionDecisionId: "d0", question: "q0", answer: "a0", answeredAt: "2026-05-27T00:00:00.000Z" }),
    ];
    const t = reconstructTranscript(arts);
    expect(t.map((x) => x.turnIndex)).toEqual([0, 1]);
    expect(nextTurnIndex(arts)).toBe(2);
  });
  it("nextTurnIndex is 0 with no turns", () => {
    expect(nextTurnIndex([])).toBe(0);
  });
});
