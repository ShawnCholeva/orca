import type Database from "better-sqlite3";
import type { HarnessTransition } from "@orca/contracts";
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
  return computeHarnessMetricsFromTransitions(listTransitionsByGoal(db, goalId, 10_000));
}

export function computeHarnessMetricsFromTransitions(ts: HarnessTransition[]): HarnessMetrics {
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

  // Verification strength: fraction of VERIFIED step_complete transitions that passed.
  // The execution oracle (EvidenceFacet) is primary; for a no-oracle step (no
  // EvidenceFacet) the independent refute (RefuteFacet, 5.4) is the oracle — p.62
  // oracle-adequacy. A completion with neither a conclusive evidence verdict nor a
  // conclusive refute is genuinely UNVERIFIED and is excluded from the denominator
  // (insufficient signal → null, not a failure) rather than dragging the score to 0.
  const stepCompletes = ts.filter((t) => t.boundary === "step_complete");
  const verifiedPass = (t: HarnessTransition): boolean =>
    t.evidence?.verdict === "passed" || (t.evidence == null && t.refute?.verdict === "upheld");
  const verifiedFail = (t: HarnessTransition): boolean =>
    t.evidence?.verdict === "failed" ||
    t.evidence?.verdict === "partial" ||
    (t.evidence == null && t.refute?.verdict === "refuted");
  const verified = stepCompletes.filter((t) => verifiedPass(t) || verifiedFail(t));
  const verification_strength: Metric =
    verified.length === 0
      ? {
          value: null,
          reason:
            stepCompletes.length === 0
              ? "no step_complete transitions"
              : "no verified step_complete transitions",
        }
      : { value: verified.filter(verifiedPass).length / verified.length };

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

  // State consistency (StateDepsFacet): sourced from the Stateful axis; a transition
  // is consistent when it recorded no conflicts.
  const state_consistency: Metric =
    withStateDeps.length === 0
      ? { value: null, reason: "no transitions carry a StateDepsFacet" }
      : {
          value:
            withStateDeps.filter((t) => t.stateDeps!.conflicts.length === 0).length /
            withStateDeps.length,
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
