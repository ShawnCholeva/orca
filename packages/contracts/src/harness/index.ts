import { z } from "zod";

export const HarnessTransitionBoundary = z.enum([
  "step_launch",
  "step_complete",
  "tool_gate",
  "mark_done",
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
  "guardrail_denied", "evidence_veto", "provider_error", "internal_error",
]);
export type FailureCode = z.infer<typeof FailureCode>;

export const CostEntry = z
  .object({
    tokens_in: z.number().int().nonnegative(),
    tokens_out: z.number().int().nonnegative(),
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

// `risk` (RiskFacet), `evidence` (EvidenceFacet), and `telemetry` (TelemetryFacet)
// are now strict schemas; `stateDeps` remains opaque `z.record` pending future tightening.
export const HarnessTransition = z
  .object({
    id: z.string().min(1).max(128),
    goalId: z.string().min(1).max(128),
    workflowRunId: z.string().min(1).max(128).nullable(),
    workflowStepRunId: z.string().min(1).max(128).nullable(),
    boundary: HarnessTransitionBoundary,
    risk: RiskFacet.nullable(),
    evidence: EvidenceFacet.nullable(),
    stateDeps: z.record(z.unknown()).nullable(),
    telemetry: TelemetryFacet.nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type HarnessTransition = z.infer<typeof HarnessTransition>;
