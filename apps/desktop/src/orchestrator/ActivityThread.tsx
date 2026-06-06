import type { Activity } from "@orca/contracts";
import type { ComponentType } from "react";

type QuestionFormProps = {
  goalId: string;
  pending: NonNullable<Activity["pendingQuestion"]>;
};

type ActivityThreadProps = {
  goalId: string;
  activities: Activity[];
  renderQuestionForm: ComponentType<QuestionFormProps>;
};

function isMeaningfulCompleted(activity: Activity): boolean {
  return (
    activity.status === "completed" &&
    activity.finalSummary !== null &&
    activity.finalSummary.trim().length > 0 &&
    activity.sourceKind !== "weak_signal"
  );
}

export function ActivityThread({
  goalId,
  activities,
  renderQuestionForm: QuestionForm,
}: ActivityThreadProps) {
  const completed = activities.filter(isMeaningfulCompleted);
  let live: Activity | null = null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.status === "active" || activity?.status === "paused_for_input") {
      live = activity;
      break;
    }
  }

  return (
    <div className="activity-thread">
      {completed.map((activity) => (
        <div key={activity.id} className="activity-summary" data-testid="activity-summary">
          {activity.finalSummary}
        </div>
      ))}
      {live ? (
        <div
          className="activity-bubble"
          data-testid="activity-bubble"
          data-status={live.status}
        >
          <div className="activity-bubble-text">{live.currentText}</div>
          {live.status === "paused_for_input" && live.pendingQuestion ? (
            <QuestionForm goalId={goalId} pending={live.pendingQuestion} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
