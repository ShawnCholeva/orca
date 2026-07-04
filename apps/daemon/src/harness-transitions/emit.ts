import type {
  CompositionFacet, EvidenceFacet, FacetKey, HarnessTransition, HarnessTransitionBoundary,
  RefuteFacet, RiskFacet, StateDepsFacet, TelemetryFacet,
} from "@orca/contracts";
import { recordHarnessTransition, type HarnessTransitionCtx } from "./usecases.js";

type FacetValues = {
  risk: RiskFacet;
  evidence: EvidenceFacet;
  stateDeps: StateDepsFacet;
  telemetry: TelemetryFacet;
  composition: CompositionFacet;
  refute: RefuteFacet;
};

type EmitInput<F extends FacetKey> = {
  goalId: string;
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
} & { [K in F]?: FacetValues[K] | null };

export const HARNESS_BOUNDARIES: { key: HarnessTransitionBoundary; facets: readonly FacetKey[] }[] = [];

function defineBoundary<F extends readonly FacetKey[]>(
  key: HarnessTransitionBoundary,
  facets: F
): (ctx: HarnessTransitionCtx, input: EmitInput<F[number]>) => HarnessTransition {
  HARNESS_BOUNDARIES.push({ key, facets });
  return (ctx, input) => recordHarnessTransition(ctx, { ...input, boundary: key });
}

// The only sanctioned write path. Each emitter type-accepts only its declared
// facets; validate-on-write lives in recordHarnessTransition (the choke point).
export const emitToolGate = defineBoundary("tool_gate", ["risk"] as const);
export const emitStepComplete = defineBoundary("step_complete", ["evidence", "stateDeps", "telemetry", "refute"] as const);
export const emitStepLaunch = defineBoundary("step_launch", ["stateDeps"] as const);
export const emitMarkDone = defineBoundary("mark_done", ["telemetry", "stateDeps"] as const);
export const emitDelegateSpawn = defineBoundary("delegate_spawn", ["composition"] as const);
export const emitDelegateJoin = defineBoundary("delegate_join", ["composition"] as const);
