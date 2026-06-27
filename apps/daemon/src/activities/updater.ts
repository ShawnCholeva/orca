import type { ActivityWorkCategory } from "@orca/contracts";

import {
  ACTIVITY_THROTTLE_MS,
  ACTIVITY_WEAK_SIGNAL_MS
} from "./constants.js";
import type { ActivitySignal } from "./signals.js";
import {
  appendActivityStep,
  completeLive,
  expireLive,
  getLiveForStepRun,
  openOrUpdateLive,
  pauseForInput,
  type ActivityStoreCtx
} from "./store.js";

interface StepState {
  lastUpdateMs: number;
  lastCategory: ActivityWorkCategory | null;
  lastReasoningNoteMs?: number;
}

export class ActivityUpdater {
  private readonly perStep = new Map<string, StepState>();

  constructor(private readonly nowMs: () => number = Date.now) {}

  apply(ctx: ActivityStoreCtx, signal: ActivitySignal): void {
    switch (signal.kind) {
      case "step_started":
        this.open(ctx, signal, {
          sourceKind: "step_started",
          currentText: `Watching the step agent start ${signal.stepName ?? "the step"}…`,
          workCategory: null
        });
        this.perStep.set(signal.stepRunId, {
          lastUpdateMs: this.nowMs(),
          lastCategory: null
        });
        return;

      case "tool_use": {
        const now = this.nowMs();
        const state = this.perStep.get(signal.stepRunId);
        if (
          state?.lastCategory === signal.category &&
          now - state.lastUpdateMs < ACTIVITY_THROTTLE_MS
        ) {
          return;
        }

        appendActivityStep(ctx, {
          goalId: signal.goalId,
          workflowRunId: signal.workflowRunId,
          stepRunId: signal.stepRunId,
          agentSessionId: signal.agentSessionId,
          text: signal.detail,
          category: signal.category,
          diff: signal.diff,
        });
        this.perStep.set(signal.stepRunId, { lastUpdateMs: now, lastCategory: signal.category });
        return;
      }

      case "weak_signal_tick": {
        if (getLiveForStepRun(ctx.db, signal.stepRunId) === undefined) return;
        const now = this.nowMs();
        const state = this.perStep.get(signal.stepRunId);
        if (
          state !== undefined &&
          now - state.lastUpdateMs < ACTIVITY_WEAK_SIGNAL_MS
        ) {
          return;
        }

        this.open(ctx, signal, {
          sourceKind: "weak_signal",
          currentText: "Still working on the step; no new output yet.",
          workCategory: null
        });
        this.perStep.set(signal.stepRunId, {
          lastUpdateMs: now,
          lastCategory: null
        });
        return;
      }

      case "permission_pending":
        this.open(ctx, signal, {
          sourceKind: "permission_pending",
          currentText: `The agent wants to run ${signal.toolName} — awaiting your approval.`,
          workCategory: null
        });
        this.perStep.set(signal.stepRunId, {
          lastUpdateMs: this.nowMs(),
          lastCategory: null
        });
        return;

      case "question_pending":
        pauseForInput(ctx, {
          stepRunId: signal.stepRunId,
          currentText: signal.text,
          pendingQuestion: signal.pendingQuestion
        });
        return;

      case "reasoning_note": {
        const text = signal.text.trim();
        if (text.length === 0) return;
        const now = this.nowMs();
        const state = this.perStep.get(signal.stepRunId);
        if (state?.lastReasoningNoteMs !== undefined && now - state.lastReasoningNoteMs < ACTIVITY_THROTTLE_MS) {
          return;
        }
        appendActivityStep(ctx, {
          goalId: signal.goalId,
          workflowRunId: signal.workflowRunId,
          stepRunId: signal.stepRunId,
          agentSessionId: signal.agentSessionId,
          text,
          category: "other",
          diff: null,
        });
        this.perStep.set(signal.stepRunId, { lastUpdateMs: state?.lastUpdateMs ?? now, lastCategory: state?.lastCategory ?? null, lastReasoningNoteMs: now });
        return;
      }

      case "turn_completed": {
        const summary = signal.summary.trim();
        if (summary.length > 0) {
          completeLive(ctx, {
            stepRunId: signal.stepRunId,
            finalSummary: summary,
            confidence: signal.confidence
          });
        } else {
          expireLive(ctx, { stepRunId: signal.stepRunId });
        }
        this.perStep.delete(signal.stepRunId);
      }
    }
  }

  private open(
    ctx: ActivityStoreCtx,
    signal: Extract<
      ActivitySignal,
      { kind: "step_started" | "weak_signal_tick" | "permission_pending" }
    >,
    activity: {
      sourceKind: "step_started" | "tool_use" | "weak_signal" | "permission_pending";
      currentText: string;
      workCategory: ActivityWorkCategory | null;
    }
  ): void {
    openOrUpdateLive(ctx, {
      goalId: signal.goalId,
      workflowRunId: signal.workflowRunId,
      stepRunId: signal.stepRunId,
      agentSessionId: signal.agentSessionId,
      ...activity
    });
  }
}
