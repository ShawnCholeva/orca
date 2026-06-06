import type {
  ActivityConfidence,
  ActivityWorkCategory,
  PendingQuestion
} from "@orca/contracts";

/** Provider-neutral supervision signals. Adapters (e.g. Claude) produce these;
 *  the ActivityUpdater consumes them. No provider concepts leak in here. */
export type ActivitySignal =
  | {
      kind: "step_started";
      goalId: string;
      workflowRunId: string;
      stepRunId: string;
      agentSessionId: string | null;
      stepName: string | null;
    }
  | {
      kind: "tool_use";
      goalId: string;
      workflowRunId: string;
      stepRunId: string;
      agentSessionId: string | null;
      category: ActivityWorkCategory;
    }
  | {
      kind: "question_pending";
      stepRunId: string;
      text: string;
      pendingQuestion: PendingQuestion;
    }
  | {
      kind: "permission_pending";
      goalId: string;
      workflowRunId: string;
      stepRunId: string;
      agentSessionId: string | null;
      toolName: string;
    }
  | {
      kind: "turn_completed";
      stepRunId: string;
      summary: string;
      confidence: ActivityConfidence | null;
    }
  | {
      kind: "weak_signal_tick";
      goalId: string;
      workflowRunId: string;
      stepRunId: string;
      agentSessionId: string | null;
    };
