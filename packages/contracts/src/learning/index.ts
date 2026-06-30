import { z } from "zod";

export const DimensionKey = z.enum([
  "trajectoryEfficiency", "verificationStrength", "recovery",
  "stateConsistency", "safetyCompliance", "replayability",
]);
export type DimensionKey = z.infer<typeof DimensionKey>;

export const ProposalStatus = z.enum(["pending", "applied", "dismissed", "rolled_back", "superseded"]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const TargetedFailureMode = z.object({
  rule: z.enum(["R1", "R2", "R3", "R4"]),
  failureCode: z.string().nullable(),
  clusterCount: z.number().int().nullable(),
  signalCount: z.number().int().nullable(),
}).strict();
export type TargetedFailureMode = z.infer<typeof TargetedFailureMode>;

// What the LLM fills (broker-validated). invariantsPreserved is a constrained enum so
// the canary regression-alarm has a well-defined byDimension lookup.
export const ProposeInstructionRevisionProposal = z.object({
  proposedInstructions: z.string().min(1).max(8192),
  predictedImprovement: z.string().min(1),
  invariantsPreserved: z.array(DimensionKey),
  rationale: z.string().min(1).max(2000),
}).strict();
export type ProposeInstructionRevisionProposal = z.infer<typeof ProposeInstructionRevisionProposal>;

const EvidenceSnapshot = z.object({
  sampleTransitionIds: z.array(z.string()),
  revisionSignalIds: z.array(z.string()),
  metricSnapshot: z.object({
    score: z.number(),
    verdictPassRate: z.number(),
    oracleSufficientRate: z.number(),
    versionDelta: z.number().nullable(),
  }).strict(),
}).strict();

export const TemplateInstructionProposal = z.object({
  id: z.string(),
  templateId: z.string(),
  templateVersionAtProposal: z.number().int(),
  stepTemplateId: z.string(),
  component: z.literal("step_instructions"),
  beforeInstructions: z.string(),
  afterInstructions: z.string(),
  targetedFailureMode: TargetedFailureMode,
  predictedImprovement: z.string(),
  invariantsPreserved: z.array(DimensionKey),
  falsifier: z.literal("version_comparison"),
  rollbackPlan: z.literal("revert_to_before"),
  evidence: EvidenceSnapshot,
  rationale: z.string(),
  humanEdited: z.boolean(),
  status: ProposalStatus,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  appliedAsVersion: z.number().int().nullable(),
  // server-enriched on GET (not stored) — F4:
  regressionDetected: z.boolean().optional(),
  watchedDeltas: z.record(z.string(), z.number().nullable()).optional(),
}).strict();
export type TemplateInstructionProposal = z.infer<typeof TemplateInstructionProposal>;
