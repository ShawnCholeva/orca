import { z } from "zod";

export const HarnessTransitionBoundary = z.enum([
  "step_launch",
  "step_complete",
  "tool_gate",
  "mark_done",
]);
export type HarnessTransitionBoundary = z.infer<typeof HarnessTransitionBoundary>;

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
    evidence: z.record(z.unknown()).nullable(),
    stateDeps: z.record(z.unknown()).nullable(),
    telemetry: z.record(z.unknown()).nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type HarnessTransition = z.infer<typeof HarnessTransition>;
