import { z } from "zod";
import { ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES, hasMaxSerializedBytes, REASONING_MAX } from "../workflows/index.js";
import { WorkflowStepOutputSchema } from "../workflows/output-schema.js";

export const DimensionKey = z.enum([
  "trajectoryEfficiency", "verificationStrength", "recovery",
  "stateConsistency", "safetyCompliance", "replayability",
]);
export type DimensionKey = z.infer<typeof DimensionKey>;

export const ProposalStatus = z.enum(["pending", "applied", "dismissed", "rolled_back", "superseded"]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const ProposalComponent = z.enum(["step_instructions", "step_output_schema"]);
export type ProposalComponent = z.infer<typeof ProposalComponent>;

export const ProposeSchemaRevisionProposal = z.object({
  proposedOutputSchema: WorkflowStepOutputSchema,
  predictedImprovement: z.string().min(1),
  invariantsPreserved: z.array(DimensionKey),
  rationale: z.string().min(1).max(2000),
}).strict();
export type ProposeSchemaRevisionProposal = z.infer<typeof ProposeSchemaRevisionProposal>;

function parsesAsSchema(text: string): boolean {
  try { return WorkflowStepOutputSchema.safeParse(JSON.parse(text)).success; } catch { return false; }
}

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
    score: z.number().nullable(),
    verdictPassRate: z.number(),
    oracleSufficientRate: z.number().nullable(),
    versionDelta: z.number().nullable(),
  }).strict(),
}).strict();

export const JudgeVerdict = z.enum(["pass", "regression_risk", "uncertain"]);
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

export const JudgeInstructionEditProposal = z.object({
  reasoning: z.string().min(1).max(REASONING_MAX),
  verdict: JudgeVerdict,
  regressionRisk: z.enum(["none", "possible", "likely"]),
  addressesFailureMode: z.enum(["yes", "partial", "no", "unclear"]),
  regressionCases: z.array(z.string().max(256)).max(50),
  reason: z.string().min(1).max(1024),
  inputsConsidered: z.array(z.string().max(512)).max(50),
}).strict();
export type JudgeInstructionEditProposal = z.infer<typeof JudgeInstructionEditProposal>;

const JudgeCase = z.object({ stepRunId: z.string(), output: z.string() }).strict();

export const JudgeInstructionEditRequest = z.object({
  step: z.object({
    name: z.string().max(200),
    currentInstructions: z.string().max(8192),
    proposedInstructions: z.string().max(8192),
    component: ProposalComponent.optional(),
  }).strict(),
  targetedFailureMode: TargetedFailureMode,
  solvedCases: z.array(JudgeCase).max(5),
  failureCases: z.array(JudgeCase).max(5),
}).strict().superRefine((value, ctx) => {
  if (!hasMaxSerializedBytes(value, ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "JudgeInstructionEditRequest too large" });
  }
});
export type JudgeInstructionEditRequest = z.infer<typeof JudgeInstructionEditRequest>;

export const JudgeOutcome = z.enum(["pass", "regression_risk", "uncertain", "unavailable", "insufficient_evidence"]);
export type JudgeOutcome = z.infer<typeof JudgeOutcome>;

export const CounterfactualJudgment = z.object({
  verdict: JudgeOutcome,
  regressionRisk: z.enum(["none", "possible", "likely"]).nullable(),
  addressesFailureMode: z.enum(["yes", "partial", "no", "unclear"]).nullable(),
  regressionCases: z.array(z.string().max(256)),
  reason: z.string().max(1024).nullable(),
  reasoning: z.string().max(REASONING_MAX).nullable().optional(),
  solvedCaseIds: z.array(z.string()),
  failureCaseIds: z.array(z.string()),
  solvedSampleSize: z.number().int(),
  failureSampleSize: z.number().int(),
  judgedAt: z.string(),
  judgedAgainstVersion: z.number().int(),
}).strict();
export type CounterfactualJudgment = z.infer<typeof CounterfactualJudgment>;

export const TemplateInstructionProposal = z.object({
  id: z.string(),
  templateId: z.string(),
  templateVersionAtProposal: z.number().int(),
  stepTemplateId: z.string(),
  component: ProposalComponent,
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
  // server-enriched (F4): the applied version's effect on the TARGETED step's own
  // honest score (0..1 delta). The invariants check above guards against regression;
  // this guards against a proposal that fails its own purpose.
  targetDelta: z.number().nullable().optional(),
  targetImproved: z.boolean().nullable().optional(),
  // server-enriched (F4, schema-canary): latest-vs-prior delta of the step's
  // invalid-output completion rate. A too-tight learned schema shows up here first.
  invalidOutputRateDelta: z.number().nullable().optional(),
  targetDeltaVersions: z.object({ latest: z.number().int(), prior: z.number().int() }).strict().nullable().optional(),
  judgment: CounterfactualJudgment.nullable().optional(),
}).strict().superRefine((p, ctx) => {
  if (p.component !== "step_output_schema") return;
  if (!parsesAsSchema(p.beforeInstructions)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["beforeInstructions"], message: "step_output_schema proposal: beforeInstructions must be a serialized output schema" });
  if (!parsesAsSchema(p.afterInstructions)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["afterInstructions"], message: "step_output_schema proposal: afterInstructions must be a serialized output schema" });
});
export type TemplateInstructionProposal = z.infer<typeof TemplateInstructionProposal>;

export const LearningEventType = z.enum([
  "created", "judged", "applied", "dismissed", "rolled_back", "superseded", "baseline_restored", "analyzed",
]);
export type LearningEventType = z.infer<typeof LearningEventType>;

export const RollbackOutcomeSnapshot = z.object({
  targetDelta: z.number().nullable(),
  targetDeltaVersions: z.object({ latest: z.number().int(), prior: z.number().int() }).strict().nullable(),
  invalidOutputRateDelta: z.number().nullable(),
  regressionDetected: z.boolean(),
}).strict();
export type RollbackOutcomeSnapshot = z.infer<typeof RollbackOutcomeSnapshot>;

export const LearningEventPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), component: ProposalComponent, rule: z.enum(["R1", "R2", "R3", "R4"]), failureCode: z.string().nullable() }).strict(),
  z.object({ kind: z.literal("judged"), verdict: JudgeOutcome, solvedSampleSize: z.number().int(), failureSampleSize: z.number().int() }).strict(),
  z.object({ kind: z.literal("applied"), appliedAsVersion: z.number().int(), humanEdited: z.boolean() }).strict(),
  z.object({ kind: z.literal("dismissed") }).strict(),
  z.object({ kind: z.literal("rolled_back"), outcome: RollbackOutcomeSnapshot }).strict(),
  z.object({ kind: z.literal("superseded"), by: z.enum(["apply", "staleness", "restore"]) }).strict(),
  z.object({ kind: z.literal("baseline_restored"), supersededCount: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("analyzed"), stepsDiagnosed: z.number().int().nonnegative(), proposalsCreated: z.number().int().nonnegative(), skips: z.array(z.object({ stepTemplateId: z.string(), reason: z.string().max(300) }).strict()).max(20) }).strict(),
]);
export type LearningEventPayload = z.infer<typeof LearningEventPayload>;

export const LearningEvent = z.object({
  id: z.string(), templateId: z.string(),
  proposalId: z.string().nullable(), stepTemplateId: z.string().nullable(),
  eventType: LearningEventType, templateVersion: z.number().int(),
  payload: LearningEventPayload, createdAt: z.string(),
}).strict().superRefine((e, ctx) => {
  if (e.payload.kind !== e.eventType) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "payload.kind must equal eventType" });
});
export type LearningEvent = z.infer<typeof LearningEvent>;
