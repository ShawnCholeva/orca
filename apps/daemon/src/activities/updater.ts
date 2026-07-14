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
}

export class ActivityUpdater {
  private readonly perStep = new Map<string, StepState>();

  constructor(private readonly nowMs: () => number = Date.now) {}

  apply(ctx: ActivityStoreCtx, signal: ActivitySignal): void {
    switch (signal.kind) {
      case "step_started":
        // Do NOT open an activity row here. The "starting/thinking" state is the
        // frontend's own thinking bubble; the activity thread must carry only
        // real, tool-derived steps. The row is created lazily on the first
        // tool_use (appendActivityStep). This prevents a contentless
        // internal-voice placeholder card — and the phantom turn_completed card
        // it becomes when a step parks with no tool steps. We still seed the
        // throttle baseline so the first tool_use is not coalesced away.
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
          toolUseId: signal.toolUseId,
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

      // reasoning_note signals are intentionally not surfaced: the worker's raw
      // assistant prose leaks first-person voice and internal mechanics. The
      // activity card carries only tool-derived steps; the orchestrator's
      // sanitized paraphrase is the clean narration channel.
      case "reasoning_note":
        return;

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
