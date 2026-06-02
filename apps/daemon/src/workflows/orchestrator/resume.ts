interface ResumeRunRow {
  runId: string;
  goalId: string;
  currentStepRunId: string;
  sessionId: string | null;
}

export interface ResumeDeps {
  listActiveRuns(): Promise<ResumeRunRow[]>;
  isSessionAlive(sessionId: string): Promise<boolean>;
  reattach(args: { runId: string; sessionId: string }): Promise<void>;
  respawn(args: { runId: string; stepRunId: string; goalId: string }): Promise<void>;
}

export async function resumeActiveRuns(deps: ResumeDeps): Promise<void> {
  const runs = await deps.listActiveRuns();
  for (const r of runs) {
    try {
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
