/** A composition row where the child run is failed but the composition is still active. */
interface FailedChildCompositionRow {
  childRunId: string;
}

interface ResumeRunRow {
  runId: string;
  goalId: string;
  currentStepRunId: string;
  sessionId: string | null;
  providerRecoveryPending: boolean;
}

export interface ResumeDeps {
  listActiveRuns(): Promise<ResumeRunRow[]>;
  /**
   * Optional: list compositions where status='active' but child run is 'failed'.
   * These represent delegations where the child failed but joinChildRun never ran
   * (e.g. daemon crash after child was set failed but before failure propagation).
   */
  listFailedChildCompositions?(): Promise<FailedChildCompositionRow[]>;
  /**
   * Optional: propagate a failed child run's failure to its parent (by calling
   * joinChildRun or equivalent). One call per row from listFailedChildCompositions.
   */
  propagateChildFailure?(childRunId: string): Promise<void>;
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

  // Propagate failed child compositions: if the daemon crashed after a child run
  // was set to 'failed' but before joinChildRun could propagate the failure to the
  // parent, the composition remains 'active' with a 'failed' child. Re-run
  // propagation here so the parent transitions to 'blocked' on restart.
  if (deps.listFailedChildCompositions && deps.propagateChildFailure) {
    let failedChildren: FailedChildCompositionRow[];
    try {
      failedChildren = await deps.listFailedChildCompositions();
    } catch (err) {
      console.error("[resume] listFailedChildCompositions failed", err);
      return;
    }
    for (const fc of failedChildren) {
      try {
        await deps.propagateChildFailure(fc.childRunId);
      } catch (err) {
        console.error("[resume] propagateChildFailure failed for child run", fc.childRunId, err);
      }
    }
  }
}
