import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@orca/contracts";
import {
  feedbackRecommendationId,
  generationNoticeFromEvent,
  recommendationEventMayTouchTask,
  workflowEventMayTouchGoalDetail,
} from "./orchestration-live-refresh";

const now = "2026-01-01T00:00:00.000Z";

function event(type: DomainEvent["type"], payload: Record<string, unknown>): DomainEvent {
  return {
    seq: 1,
    id: "evt-1",
    type,
    goalId: "goal-1",
    payload,
    createdAt: now,
  };
}

describe("orchestration live-refresh event helpers", () => {
  it("extracts content-free generation banner state from requested events", () => {
    expect(
      generationNoticeFromEvent(
        event("task.generation.requested", {
          generationId: "gen-1",
          goalId: "goal-1",
          trigger: "manual",
          triggerSourceId: null,
        }),
      ),
    ).toEqual({
      generationId: "gen-1",
      status: "pending",
      noticedAt: now,
    });
  });

  it("detects recommendation events that can affect task-scoped panels", () => {
    expect(
      recommendationEventMayTouchTask(
        event("recommendation.accepted", {
          recommendationId: "rec-1",
          goalId: "goal-1",
          type: "update_plan",
        }),
      ),
    ).toBe(true);

    expect(
      recommendationEventMayTouchTask(
        event("recommendation.accepted", {
          recommendationId: "rec-2",
          goalId: "goal-1",
          type: "create_session",
        }),
      ),
    ).toBe(false);
  });

  it("extracts affected recommendation id from feedback events only", () => {
    expect(
      feedbackRecommendationId(
        event("user.feedback.recorded", {
          feedbackId: "fb-1",
          goalId: "goal-1",
          recommendationId: "rec-1",
          action: "modify",
        }),
      ),
    ).toBe("rec-1");

    expect(feedbackRecommendationId(event("task.updated", { taskId: "task-1" }))).toBeNull();
  });

  it("flags workflow events for goal-detail refresh", () => {
    expect(
      workflowEventMayTouchGoalDetail(
        event("workflow.step.completed", {
          goalId: "goal-1",
          workflowRunId: "run-1",
          workflowStepRunId: "step-1",
          stepTemplateId: "research",
        }),
      ),
    ).toBe(true);

    expect(workflowEventMayTouchGoalDetail(event("task.updated", { taskId: "task-1" }))).toBe(
      false,
    );
  });
});
