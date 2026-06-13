interface ResumeRunRow {
  runId: string;
  goalId: string;
  currentStepRunId: string;
  sessionId: string | null;
  providerRecoveryPending: boolean;
}

export interface ResumeDeps {
  listActiveRuns(): Promise<ResumeRunRow[]>;
  isSessionAlive(sessionId: string): Promise<boolean>;
  reattach(args: { runId: string; sessionId: string }): Promise<void>;
  respawn(args: { runId: string; stepRunId: string; goalId: string }): Promise<void>;
  markRecoverySessionMissing(args: {
    runId: string;
    stepRunId: string;
    sessionId: string | null;
  }): Promise<void>;
}

export async function resumeActiveRuns(deps: ResumeDeps): Promise<void> {
  const runs = await deps.listActiveRuns();
  for (const r of runs) {
    try {
      // Runs paused for provider-limit recovery never respawn: a fresh worker
      // would discard the preserved checkpoint. Reattach a surviving worker, or
      // flip the checkpoint to a fresh-session restart and republish the card.
      if (r.providerRecoveryPending) {
        if (r.sessionId && (await deps.isSessionAlive(r.sessionId))) {
          await deps.reattach({ runId: r.runId, sessionId: r.sessionId });
        } else {
          await deps.markRecoverySessionMissing({
            runId: r.runId,
            stepRunId: r.currentStepRunId,
            sessionId: r.sessionId,
          });
        }
        continue;
      }

      if (r.sessionId && (await deps.isSessionAlive(r.sessionId))) {
        await deps.reattach({ runId: r.runId, sessionId: r.sessionId });
      } else {
        await deps.respawn({ runId: r.runId, stepRunId: r.currentStepRunId, goalId: r.goalId });
      }
    } catch (err) {
      console.error("[resume] failed for run", r.runId, err);
    }
  }
}
