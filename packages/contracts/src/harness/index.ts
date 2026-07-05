import { z } from "zod";
import { REASONING_MAX } from "../workflows/index.js";

export const HarnessTransitionBoundary = z.enum([
  "step_launch",
  "step_complete",
  "tool_gate",
  "mark_done",
  "delegate_spawn",
  "delegate_join",
]);
export type HarnessTransitionBoundary = z.infer<typeof HarnessTransitionBoundary>;

export const WorkflowSensorKind = z.enum([
  "typecheck",
  "lint",
  "unit",
  "integration",
  "build",
  "static",
]);
export type WorkflowSensorKind = z.infer<typeof WorkflowSensorKind>;

export const SensorResult = z
  .object({
    kind: WorkflowSensorKind,
    command: z.string().min(1).max(512),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    result: z.enum(["passed", "failed", "skipped"]),
    summary: z.string().max(4000),
    artifactRef: z.string().max(256).nullable(),
  })
  .strict();
export type SensorResult = z.infer<typeof SensorResult>;

export const EvidenceFacet = z
  .object({
    sensorsRun: z.array(SensorResult).max(32),
    verdict: z.enum(["passed", "failed", "partial"]),
    untestedRegions: z.array(z.string().max(512)).max(64).default([]),
    residualRisk: z.array(z.string().max(512)).max(64).default([]),
    oracleAdequacy: z
      .object({
        sufficient: z.boolean(),
        gaps: z.array(z.string().max(256)).max(32).default([]),
      })
      .strict(),
  })
  .strict();
export type EvidenceFacet = z.infer<typeof EvidenceFacet>;

export const RiskClass = z.enum(["low", "medium", "high", "critical"]);
export type RiskClass = z.infer<typeof RiskClass>;

export const PermissionTier = z.enum(["read_only", "sandbox_edit", "full_access"]);
export type PermissionTier = z.infer<typeof PermissionTier>;

export const GateDecision = z.enum(["allow", "require_approval", "deny"]);
export type GateDecision = z.infer<typeof GateDecision>;

export const OperatingMode = z.enum(["human_review", "automated"]);
export type OperatingMode = z.infer<typeof OperatingMode>;

export const RiskFacet = z
  .object({
    risk_class: RiskClass,
    permission_tier: PermissionTier,
    classification_reasons: z.array(z.string().max(512)).max(64),
    gate_decision: GateDecision,
    hard_constraint_violations: z.array(z.string().max(512)).max(64),
    mode: OperatingMode.optional(),
    approval: z
      .object({
        approval_id: z.string().max(128),
        approved_by: z.string().max(128),
        decided_at: z.string().datetime(),
        policy_delta: z
          .object({
            action_class: z.string().max(256),
            relaxed: z.boolean(),
            decision_id: z.string().max(128),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RiskFacet = z.infer<typeof RiskFacet>;

export const TransitionStatus = z.enum(["succeeded", "failed", "escalated", "denied"]);
export type TransitionStatus = z.infer<typeof TransitionStatus>;

// Categorical, clusterable failure codes (mirrors the extraction enum, migrations/0005).
export const FailureCode = z.enum([
  "invalid_output", "timeout", "session_not_terminal", "output_unavailable",
  "source_truncated", "goal_archived", "session_archived", "daemon_restart",
  "guardrail_denied", "evidence_veto", "refute_veto", "provider_error", "internal_error",
  "evaluation_failed",
]);
export type FailureCode = z.infer<typeof FailureCode>;

export const CostEntry = z
  .object({
    tokens_in: z.number().int().nonnegative(),
    tokens_out: z.number().int().nonnegative(),
    // Additive (Task 15): default null so existing serialized facets still parse.
    cache_read_tokens: z.number().int().nonnegative().nullable().default(null),
    cache_creation_tokens: z.number().int().nonnegative().nullable().default(null),
    usd: z.number().nonnegative(),
  })
  .strict();
export type CostEntry = z.infer<typeof CostEntry>;

export const TelemetryFacet = z
  .object({
    cost: CostEntry.nullable(),
    latency_ms: z.number().int().nonnegative().nullable(),
    model: z.string().max(128).nullable(),
    provider_id: z.string().max(64).nullable(),
    provider_version: z.string().max(128).nullable(),
    prompt_ref: z.string().max(512).nullable(),
    raw_output_ref: z.string().max(512).nullable(),
    rejected_alternatives: z
      .array(z.object({ option: z.string().max(256), reason: z.string().max(512) }).strict())
      .max(64)
      .default([]),
    human_interventions: z
      .array(z.object({ kind: z.string().max(64), ref: z.string().max(128) }).strict())
      .max(64)
      .default([]),
    outcome: z
      .object({ status: TransitionStatus, failure_code: FailureCode.nullable() })
      .strict(),
  })
  .strict();
export type TelemetryFacet = z.infer<typeof TelemetryFacet>;

export const StateRefKind = z.enum(["file", "memory_item", "decision", "goal_refinement", "task", "workspace_version"]);
export type StateRefKind = z.infer<typeof StateRefKind>;

export const StateChangeKind = z.enum(["created", "modified", "deleted"]);
export type StateChangeKind = z.infer<typeof StateChangeKind>;

export const ConflictPolicy = z.enum(["auto", "escalate"]);
export type ConflictPolicy = z.infer<typeof ConflictPolicy>;

export const StateConflictKind = z.enum(["write_write", "read_stale", "belief_divergence"]);
export type StateConflictKind = z.infer<typeof StateConflictKind>;

export const StateDepReadEntry = z.object({
  kind: StateRefKind, ref: z.string().max(512), version: z.string().max(256).nullable(),
}).strict();
export type StateDepReadEntry = z.infer<typeof StateDepReadEntry>;

export const StateDepWriteEntry = z.object({
  kind: StateRefKind, ref: z.string().max(512), change_kind: StateChangeKind,
}).strict();
export type StateDepWriteEntry = z.infer<typeof StateDepWriteEntry>;

export const StateAssumption = z.object({
  statement: z.string().max(1024), source_ref: z.string().max(512).nullable(), verified: z.boolean(),
}).strict();
export type StateAssumption = z.infer<typeof StateAssumption>;

export const StateVersionDep = z.object({
  ref: z.string().max(512), observed_version: z.string().max(256),
}).strict();
export type StateVersionDep = z.infer<typeof StateVersionDep>;

export const StateConflict = z.object({
  kind: StateConflictKind,
  with_transition_id: z.string().max(128).nullable(),
  refs: z.array(z.string().max(512)).max(64).default([]),
}).strict();
export type StateConflict = z.infer<typeof StateConflict>;

export const StateDepsFacet = z.object({
  read_set: z.array(StateDepReadEntry).max(256).default([]),
  write_set: z.array(StateDepWriteEntry).max(256).default([]),
  assumptions: z.array(StateAssumption).max(64).default([]),
  version_deps: z.array(StateVersionDep).max(64).default([]),
  conflict_policy: ConflictPolicy,
  conflicts: z.array(StateConflict).max(64).default([]),
}).strict();
export type StateDepsFacet = z.infer<typeof StateDepsFacet>;

// ── Facet registry ────────────────────────────────────────────────────────────
// Single source for the closed facet vocabulary. Projection + usecases loop over
// this instead of hand-listing each facet. `HarnessTransition` below stays
// hand-written (no codegen); a conformance guard (daemon) asserts they agree.
export type FacetSpec = {
  key: "risk" | "evidence" | "stateDeps" | "telemetry" | "composition" | "refute";
  column: string;
  schema: z.ZodTypeAny;
};
export type FacetKey = FacetSpec["key"];

const FACET_REGISTRY: FacetSpec[] = [];
function defineFacet(spec: FacetSpec): FacetSpec {
  FACET_REGISTRY.push(spec);
  return spec;
}

defineFacet({ key: "risk", column: "risk_json", schema: RiskFacet });
defineFacet({ key: "evidence", column: "evidence_json", schema: EvidenceFacet });
defineFacet({ key: "stateDeps", column: "state_deps_json", schema: StateDepsFacet });
defineFacet({ key: "telemetry", column: "telemetry_json", schema: TelemetryFacet });

export const CompositionFacet = z.object({
  childRunId: z.string(),
  childTemplateId: z.string(),
  childTemplateVersion: z.number().int(),
  readsKeys: z.array(z.string()),
  writesKeys: z.array(z.string()),
  depth: z.number().int(),
  costRollupUsd: z.number().nullable(),
  childVerdict: z.enum(["passed", "failed", "partial"]).nullable().optional(),
  childUntestedRegions: z.array(z.string()).optional(),
  childResidualRisk: z.array(z.string()).optional(),
  beliefDivergence: z.object({ diverged: z.boolean(), details: z.string().optional() }).nullable().optional(),
  verifyResult: z.object({ ran: z.boolean(), vetoed: z.boolean(), reason: z.string().optional() }).nullable().optional(),
}).strict();
export type CompositionFacet = z.infer<typeof CompositionFacet>;

defineFacet({ key: "composition", column: "composition_json", schema: CompositionFacet });

export const RefuteOutcome = z.enum(["upheld", "refuted", "uncertain", "unavailable"]);
export type RefuteOutcome = z.infer<typeof RefuteOutcome>;

export const RefuteFacet = z
  .object({
    verdict: RefuteOutcome,
    triggered_by: z.array(z.enum(["high_risk", "no_oracle", "weak_oracle"])).max(3),
    risk_class: RiskClass,
    reason: z.string().max(1024).nullable(),
    reasoning: z.string().max(REASONING_MAX).nullable().optional(),
    issue_refs: z.array(z.string().max(128)).max(50),
  })
  .strict();
export type RefuteFacet = z.infer<typeof RefuteFacet>;

defineFacet({ key: "refute", column: "refute_json", schema: RefuteFacet });

export const HARNESS_FACETS: readonly FacetSpec[] = FACET_REGISTRY;

// `risk` (RiskFacet), `evidence` (EvidenceFacet), `telemetry` (TelemetryFacet), and
// `stateDeps` (StateDepsFacet) are all strict schemas — the facet model is complete.
export const HarnessTransition = z
  .object({
    id: z.string().min(1).max(128),
    goalId: z.string().min(1).max(128),
    workflowRunId: z.string().min(1).max(128).nullable(),
    workflowStepRunId: z.string().min(1).max(128).nullable(),
    boundary: HarnessTransitionBoundary,
    risk: RiskFacet.nullable(),
    evidence: EvidenceFacet.nullable(),
    stateDeps: StateDepsFacet.nullable(),
    telemetry: TelemetryFacet.nullable(),
    composition: CompositionFacet.nullable().optional(),
    refute: RefuteFacet.nullable().optional(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type HarnessTransition = z.infer<typeof HarnessTransition>;

// ── Control-plane replay projection ─────────────────────────────────────────
// Client-facing replay wire shape. Each transition is one step; pages are
// keyset-ordered oldest-first, so a goal exceeding one page reconstructs from
// genesis forward (the Inspectable invariant) rather than dropping its history.
export const ReplayStep = z
  .object({
    seq: z.number().int().nonnegative(),
    boundary: HarnessTransitionBoundary,
    at: z.string().datetime(),
    summary: z.string(),
    facets: z
      .object({
        risk: RiskFacet.nullable(),
        evidence: EvidenceFacet.nullable(),
        telemetry: TelemetryFacet.nullable(),
      })
      .strict(),
  })
  .strict();
export type ReplayStep = z.infer<typeof ReplayStep>;

export const ReplayPage = z
  .object({
    steps: z.array(ReplayStep),
    page: z
      .object({ nextCursor: z.string().nullable(), hasMore: z.boolean() })
      .strict(),
  })
  .strict();
export type ReplayPage = z.infer<typeof ReplayPage>;
