import type { SessionSummary, WorkflowStepRun } from "@orca/contracts";

/**
 * The map key a worker gate's session is filed under. A gate has no step
 * template, so the engine binds its worker to a surrogate step run whose
 * step_template_id is `__gate__:<nodeId>` (dispatch-engine spawnGateWorker) —
 * which lets gate nodes resolve through the same map as steps.
 */
export function gateSessionKey(gateId: string): string {
  return `__gate__:${gateId}`;
}

/**
 * Joins a run's step runs to the worker sessions they launched, keyed by
 * step_template_id — the identity the workflow tracker already knows each of
 * its nodes by.
 *
 * A retried step has several step runs, so the newest attempt wins; within one
 * step run the newest session wins. That is the same "created_at DESC" rule the
 * daemon uses when it resolves a step run's live session.
 */
export function mapStepSessions(
  stepRuns: WorkflowStepRun[],
  sessions: SessionSummary[],
): Map<string, SessionSummary> {
  const stepRunById = new Map(stepRuns.map((stepRun) => [stepRun.id, stepRun]));
  const best = new Map<string, { session: SessionSummary; attempt: number }>();
  for (const session of sessions) {
    const stepRun = session.workflowStepRunId
      ? stepRunById.get(session.workflowStepRunId)
      : undefined;
    if (!stepRun) continue;
    const current = best.get(stepRun.stepTemplateId);
    const wins =
      !current ||
      stepRun.attempt > current.attempt ||
      (stepRun.attempt === current.attempt && session.createdAt > current.session.createdAt);
    if (wins) best.set(stepRun.stepTemplateId, { session, attempt: stepRun.attempt });
  }
  return new Map([...best].map(([stepTemplateId, entry]) => [stepTemplateId, entry.session]));
}
