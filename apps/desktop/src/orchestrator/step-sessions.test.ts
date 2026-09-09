import { describe, expect, it } from "vitest";
import type { SessionSummary, WorkflowStepRun } from "@orca/contracts";

import { gateSessionKey, mapStepSessions } from "./step-sessions";

function stepRun(over: Partial<WorkflowStepRun> & { id: string; stepTemplateId: string }): WorkflowStepRun {
  return {
    goalId: "goal_1",
    workflowRunId: "run_1",
    ordinal: 0,
    attempt: 1,
    status: "passed",
    startedAt: null,
    finishedAt: null,
    blockedReason: null,
    stepResult: null,
    ...over,
  } as WorkflowStepRun;
}

function session(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    goalId: "goal_1",
    workspaceId: "ws_1",
    adapterId: "claude-code",
    role: "engineer",
    title: "Workflow step",
    status: "running",
    createdAt: "2026-09-08T10:00:00.000Z",
    startedAt: null,
    exitedAt: null,
    ...over,
  } as SessionSummary;
}

describe("mapStepSessions", () => {
  it("keys a step run's session by the step template it ran", () => {
    const map = mapStepSessions(
      [stepRun({ id: "sr_1", stepTemplateId: "build" })],
      [session({ id: "sess_1", workflowStepRunId: "sr_1" })],
    );

    expect(map.get("build")?.id).toBe("sess_1");
  });

  it("ignores sessions with no step run of this run behind them", () => {
    const map = mapStepSessions(
      [stepRun({ id: "sr_1", stepTemplateId: "build" })],
      [
        session({ id: "sess_manual", workflowStepRunId: null }),
        session({ id: "sess_other_run", workflowStepRunId: "sr_from_another_run" }),
      ],
    );

    expect(map.size).toBe(0);
  });

  it("prefers the newest attempt when a step was retried", () => {
    const map = mapStepSessions(
      [
        stepRun({ id: "sr_1", stepTemplateId: "build", attempt: 1 }),
        stepRun({ id: "sr_2", stepTemplateId: "build", attempt: 2 }),
      ],
      [
        session({ id: "sess_attempt_2", workflowStepRunId: "sr_2", createdAt: "2026-09-08T10:00:00.000Z" }),
        // Later wall-clock, but an older attempt: the attempt wins.
        session({ id: "sess_attempt_1", workflowStepRunId: "sr_1", createdAt: "2026-09-08T12:00:00.000Z" }),
      ],
    );

    expect(map.get("build")?.id).toBe("sess_attempt_2");
  });

  it("prefers the newest session within one step run", () => {
    const map = mapStepSessions(
      [stepRun({ id: "sr_1", stepTemplateId: "build" })],
      [
        session({ id: "sess_old", workflowStepRunId: "sr_1", createdAt: "2026-09-08T10:00:00.000Z" }),
        session({ id: "sess_new", workflowStepRunId: "sr_1", createdAt: "2026-09-08T11:00:00.000Z" }),
      ],
    );

    expect(map.get("build")?.id).toBe("sess_new");
  });

  it("files a worker gate's session under its surrogate key", () => {
    // spawnGateWorker binds the gate's worker to a `__gate__:<nodeId>` step run.
    const map = mapStepSessions(
      [stepRun({ id: "sr_gate", stepTemplateId: "__gate__:critique", ordinal: -1 })],
      [session({ id: "sess_gate", workflowStepRunId: "sr_gate" })],
    );

    expect(map.get(gateSessionKey("critique"))?.id).toBe("sess_gate");
  });
});
