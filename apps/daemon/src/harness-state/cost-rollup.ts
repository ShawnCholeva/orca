import type Database from "better-sqlite3";
import type { CostEntry } from "@orca/contracts";
import { listTransitionsByGoal } from "../harness-transitions/projection.js";

/**
 * Goal-total cost for a completed workflow run: the sum of every step_complete
 * transition's `telemetry.cost` for that run. The cost twin of
 * `buildGoalWriteSetRollup`, carried on the mark_done terminal boundary (and
 * fuel for the future learning loop).
 *
 * Returns null when no step in the run reported a cost — the antigravity
 * (no usage channel) and pre-OTEL realities both surface as a null cost facet,
 * so a roll-up of nothing stays null rather than a misleading all-zero CostEntry.
 *
 * `stepTemplateId` scopes the sum to step runs of that template (the per-step-type
 * budget cap reuses this); omit it for the whole-run total.
 */
export function buildGoalCostRollup(
  db: Database.Database,
  goalId: string,
  workflowRunId: string,
  opts: { stepTemplateId?: string } = {}
): CostEntry | null {
  const scopedStepRunIds =
    opts.stepTemplateId === undefined
      ? null
      : new Set(
          (
            db
              .prepare(
                "SELECT id FROM workflow_step_runs WHERE workflow_run_id = ? AND step_template_id = ?"
              )
              .all(workflowRunId, opts.stepTemplateId) as Array<{ id: string }>
          ).map((r) => r.id)
        );

  let any = false;
  let tokens_in = 0;
  let tokens_out = 0;
  let usd = 0;
  let cache_read = 0;
  let anyCacheRead = false;
  let cache_creation = 0;
  let anyCacheCreation = false;

  for (const t of listTransitionsByGoal(db, goalId, 10_000)) {
    if (t.boundary !== "step_complete" || t.workflowRunId !== workflowRunId) continue;
    if (scopedStepRunIds !== null && !scopedStepRunIds.has(t.workflowStepRunId ?? "")) continue;
    const c = t.telemetry?.cost;
    if (!c) continue;
    any = true;
    tokens_in += c.tokens_in;
    tokens_out += c.tokens_out;
    usd += c.usd;
    if (c.cache_read_tokens !== null) {
      anyCacheRead = true;
      cache_read += c.cache_read_tokens;
    }
    if (c.cache_creation_tokens !== null) {
      anyCacheCreation = true;
      cache_creation += c.cache_creation_tokens;
    }
  }

  if (!any) return null;
  return {
    tokens_in,
    tokens_out,
    cache_read_tokens: anyCacheRead ? cache_read : null,
    cache_creation_tokens: anyCacheCreation ? cache_creation : null,
    usd,
  };
}
