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

// `risk` (RiskFacet) and `evidence` (EvidenceFacet) are now strict schemas;
// `stateDeps` and `telemetry` remain opaque `z.record` pending future tightening.
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
    telemetry: z.record(z.unknown()).nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type HarnessTransition = z.infer<typeof HarnessTransition>;
