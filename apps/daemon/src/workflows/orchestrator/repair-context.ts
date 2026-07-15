import type Database from "better-sqlite3";
import { listArtifactsForRun } from "../artifacts/projection.js";
import { listGateDecisionsForRun } from "../gates/projection.js";

/**
 * Collects the most recent step_output artifact per step template (excluding
 * the current step run's own output), returning each as { stepId, outputJson }.
 * Selection is by recency (artifact created_at), NOT ordinal, so a step
 * revisited via a backward gate route still sees the latest DOWNSTREAM step
 * outputs (e.g. Validation, which has a higher ordinal) needed to repair.
 * stepId is the step_template_id of the artifact's step run; outputJson is the
 * parsed artifact body.
 */
export function collectPriorStepArtifacts(
  db: Database.Database,
  runId: string,
  currentStepRunId: string
): Array<{ stepId: string; outputJson: unknown }> {
  const stepRuns = db
    .prepare("SELECT id, step_template_id FROM workflow_step_runs WHERE workflow_run_id = ?")
    .all(runId) as Array<{ id: string; step_template_id: string }>;
  const byId = new Map(stepRuns.map((s) => [s.id, s]));
  // Exclude the current step's OWN template — not merely its exact step_run_id.
  // On a gate-reject loop re-run the current step shares its template with its
  // prior (rejected) attempt; feeding that stale attempt's output back as
  // authoritative prior context makes the re-run reason over a superseded — and
  // sometimes self-contradicting — decision (observed live: a re-run Proposal
  // clung to its rejected "user chose X" instead of the fresh answer). The reject
  // repair context (latestRejectingGate) is the correct channel for what to fix.
  const currentTemplateId = byId.get(currentStepRunId)?.step_template_id;
  // listArtifactsForRun is ordered by created_at ASC; keeping the last seen
  // artifact per template yields the most recent output per step.
  const latestByTemplate = new Map<string, unknown>();
  for (const artifact of listArtifactsForRun(db, runId)) {
    if (artifact.type !== "step_output" || !artifact.stepRunId) continue;
    const owner = byId.get(artifact.stepRunId);
    if (!owner) continue;
    if (owner.step_template_id === currentTemplateId) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(artifact.body);
    } catch {
      parsed = artifact.body;
    }
    latestByTemplate.set(owner.step_template_id, parsed);
  }
  return [...latestByTemplate].map(([stepId, outputJson]) => ({ stepId, outputJson }));
}

/**
 * Returns the most recent rejecting gate decision for the run, used as repair
 * context when a backward gate route re-runs an earlier step. Null when no
 * gate has rejected.
 */
export function latestRejectingGate(
  db: Database.Database,
  runId: string
): { reason: string; issueRefs: string[] } | null {
  const last = listGateDecisionsForRun(db, runId)
    .filter((d) => d.outcome === "rejected")
    .at(-1);
  return last ? { reason: last.reason, issueRefs: last.issueRefs } : null;
}
