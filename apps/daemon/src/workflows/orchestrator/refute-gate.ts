import type Database from "better-sqlite3";
import type { RiskClass } from "@orca/contracts";
import { RISK_RANK, riskClassAtLeast } from "../../harness-risk/rank.js";

export type RefuteTrigger = "high_risk" | "no_oracle" | "weak_oracle";

/** Max deterministic tool-gate risk class recorded for the step run (low when none). */
export function stepToolRiskClass(db: Database.Database, workflowStepRunId: string): RiskClass {
  const rows = db
    .prepare("SELECT risk_json FROM harness_transitions WHERE workflow_step_run_id = ? AND boundary = 'tool_gate' AND risk_json IS NOT NULL")
    .all(workflowStepRunId) as { risk_json: string }[];
  let max: RiskClass = "low";
  for (const r of rows) {
    try {
      const rc = JSON.parse(r.risk_json).risk_class as RiskClass;
      if (rc && RISK_RANK[rc] !== undefined && RISK_RANK[rc] > RISK_RANK[max]) max = rc;
    } catch { /* ignore malformed */ }
  }
  return max;
}

/** Refute unless the step was already adequately verified by a deterministic oracle
 *  and is not high-risk (paper p.47 integrate-both / p.62 oracle adequacy).
 *  Grounding-only evidence (no sensors ran) is not an execution oracle — such
 *  steps still refute: grounding verifies references, not semantic correctness. */
export function shouldRefute(
  riskClass: RiskClass,
  evidence: { sensorsRan: boolean; oracleAdequacy: { gaps: string[] } } | null
): { refute: boolean; triggers: RefuteTrigger[] } {
  const triggers: RefuteTrigger[] = [];
  if (riskClassAtLeast(riskClass, "high")) triggers.push("high_risk");
  if (evidence === null || !evidence.sensorsRan) triggers.push("no_oracle");
  else if (evidence.oracleAdequacy.gaps.length > 0) triggers.push("weak_oracle");
  return { refute: triggers.length > 0, triggers };
}
