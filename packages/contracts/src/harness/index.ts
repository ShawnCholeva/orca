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

// Facets are opaque in Phase 1; later phases replace each `z.record` with a
// strict schema (Phase 2 tightens `evidence`).
export const HarnessTransition = z
  .object({
    id: z.string().min(1).max(128),
    goalId: z.string().min(1).max(128),
    workflowRunId: z.string().min(1).max(128).nullable(),
    workflowStepRunId: z.string().min(1).max(128).nullable(),
    boundary: HarnessTransitionBoundary,
    risk: z.record(z.unknown()).nullable(),
    evidence: EvidenceFacet.nullable(),
    stateDeps: z.record(z.unknown()).nullable(),
    telemetry: z.record(z.unknown()).nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type HarnessTransition = z.infer<typeof HarnessTransition>;
