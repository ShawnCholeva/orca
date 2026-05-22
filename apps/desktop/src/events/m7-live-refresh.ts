import type { DomainEvent, RecommendationType } from "@orca/contracts";

export const M7_LIVE_REFRESH_DEBOUNCE_MS = 200;

export type LiveGenerationNotice = {
  generationId: string;
  status: "pending";
  noticedAt: string;
};

export type RecommendationDetailRefresh = {
  recommendationId: string;
  nonce: number;
};

const TASK_TOUCHING_RECOMMENDATION_TYPES = new Set<RecommendationType>([
  "split_task",
  "run_validation",
  "update_plan",
  "mark_complete",
]);

export function generationNoticeFromEvent(event: DomainEvent): LiveGenerationNotice | null {
  if (
    event.type !== "task.generation.requested" &&
    event.type !== "recommendation.generation.requested"
  ) {
    return null;
  }

  const generationId = event.payload.generationId;
  if (typeof generationId !== "string" || generationId.length === 0) {
    return null;
  }

  return {
    generationId,
    status: "pending",
    noticedAt: event.createdAt,
  };
}

export function recommendationEventMayTouchTask(event: DomainEvent): boolean {
  if (!event.type.startsWith("recommendation.")) return false;
  const type = event.payload.type;
  return (
    typeof type === "string" &&
    TASK_TOUCHING_RECOMMENDATION_TYPES.has(type as RecommendationType)
  );
}

export function feedbackRecommendationId(event: DomainEvent): string | null {
  if (event.type !== "user.feedback.recorded") return null;
  const recommendationId = event.payload.recommendationId;
  return typeof recommendationId === "string" && recommendationId.length > 0
    ? recommendationId
    : null;
}
