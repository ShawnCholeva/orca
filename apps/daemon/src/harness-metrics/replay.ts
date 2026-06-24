import type Database from "better-sqlite3";
import type {
  EvidenceFacet,
  HarnessTransition,
  HarnessTransitionBoundary,
  RiskFacet,
  TelemetryFacet,
} from "@orca/contracts";
import { listTransitionsByGoal } from "../harness-transitions/usecases.js";

export interface ReplayStep {
  seq: number;
  boundary: HarnessTransitionBoundary;
  at: string;
  summary: string;
  facets: {
    risk: RiskFacet | null;
    evidence: EvidenceFacet | null;
    telemetry: TelemetryFacet | null;
  };
}

export interface ControlPlaneReplay {
  steps: ReplayStep[];
}

/**
 * Derive a one-line summary for a transition from its facets, keyed by boundary.
 * - `tool_gate`     -> the gate decision (allow / require_approval / deny).
 * - `step_complete` -> the evidence verdict, falling back to the telemetry outcome status.
 * Other boundaries (e.g. `step_launch`, `mark_done`) have no canonical facet summary,
 * so we fall back to the boundary name itself.
 */
function summarize(t: HarnessTransition): string {
  switch (t.boundary) {
    case "tool_gate":
      return t.risk?.gate_decision ?? t.boundary;
    case "step_complete":
      return t.evidence?.verdict ?? t.telemetry?.outcome.status ?? t.boundary;
    default:
      return t.boundary;
  }
}

/**
 * Read-only control-plane replay: an ordered (chronological) reconstruction of a
 * goal's transition trajectory. Locked design D5 — this is NOT full event-sourcing,
 * just a compact projection of recorded transitions in the order they occurred.
 *
 * `listTransitionsByGoal` returns newest-first (`ORDER BY created_at DESC, id ASC`);
 * we reverse it to chronological order and assign `seq` 0..n-1 in that order.
 * An existing goal with no transitions yields `{ steps: [] }`.
 */
export function replayControlPlane(db: Database.Database, goalId: string): ControlPlaneReplay {
  const transitions = listTransitionsByGoal(db, goalId, 10_000);
  const chronological = [...transitions].reverse();
  const steps = chronological.map((t, seq) => ({
    seq,
    boundary: t.boundary,
    at: t.createdAt,
    summary: summarize(t),
    facets: { risk: t.risk, evidence: t.evidence, telemetry: t.telemetry },
  }));
  return { steps };
}
