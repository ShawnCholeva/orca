import type Database from "better-sqlite3";
import { listTransitionsByGoal } from "../harness-transitions/usecases.js";

export type Metric = { value: number | null; reason?: string };
export type HarnessMetrics = {
  trajectory_efficiency: Metric;
  verification_strength: Metric;
  recovery: Metric;
  state_consistency: Metric;
  safety_compliance: Metric;
  replayability: Metric;
};

export function computeHarnessMetrics(db: Database.Database, goalId: string): HarnessMetrics {
  const ts = listTransitionsByGoal(db, goalId, 10_000);
  const n = ts.length;
  const withRisk = ts.filter((t) => t.risk !== null);
  const withStateDeps = ts.filter((t) => t.stateDeps !== null);
  const tokens = ts.reduce(
    (s, t) => s + (t.telemetry?.cost?.tokens_in ?? 0) + (t.telemetry?.cost?.tokens_out ?? 0),
    0
  );

  // Trajectory efficiency (TelemetryFacet): mean token cost per transition.
  const trajectory_efficiency: Metric =
    n === 0 ? { value: null, reason: "no transitions" } : { value: tokens / n };

  // Verification strength (EvidenceFacet): fraction of step_complete transitions
  // carrying a passing evidence verdict.
  const stepCompletes = ts.filter((t) => t.boundary === "step_complete");
  const verification_strength: Metric =
    stepCompletes.length === 0
      ? { value: null, reason: "no step_complete transitions" }
      : {
          value:
            stepCompletes.filter((t) => t.evidence?.verdict === "passed").length /
            stepCompletes.length,
        };

  // Recovery (TelemetryFacet): whether failed/escalated outcomes were eventually
  // followed by a succeeded transition.
  const failures = ts.filter(
    (t) =>
      t.telemetry?.outcome.status === "failed" || t.telemetry?.outcome.status === "escalated"
  );
  const recovery: Metric =
    failures.length === 0
      ? { value: null, reason: "no failures recorded" }
      : { value: ts.some((t) => t.telemetry?.outcome.status === "succeeded") ? 1 : 0 };

  // State consistency (StateDepsFacet): sourced from the Stateful axis, not yet
  // emitted — `stateDeps` is always null today, so this always degrades to null.
  const state_consistency: Metric =
    withStateDeps.length === 0
      ? { value: null, reason: "StateDepsFacet not yet emitted (Stateful axis pending)" }
      : {
          value:
            withStateDeps.filter(
              (t) => (t.stateDeps as { conflict?: boolean }).conflict !== true
            ).length / withStateDeps.length,
        };

  // Safety compliance (RiskFacet): fraction of gated actions not denied.
  const safety_compliance: Metric =
    withRisk.length === 0
      ? { value: null, reason: "no RiskFacet transitions" }
      : { value: withRisk.filter((t) => t.risk?.gate_decision !== "deny").length / withRisk.length };

  // Replayability (TelemetryFacet): fraction of transitions carrying telemetry.
  const replayability: Metric =
    n === 0
      ? { value: null, reason: "no transitions" }
      : { value: ts.filter((t) => t.telemetry !== null).length / n };

  return {
    trajectory_efficiency,
    verification_strength,
    recovery,
    state_consistency,
    safety_compliance,
    replayability,
  };
}
