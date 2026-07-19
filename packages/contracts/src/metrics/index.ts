import { z } from "zod";

export { labelForFailure } from "./failure-labels.js";
export { labelForGateFailure, GATE_FAILURE_CODES } from "./gate-failure-labels.js";

export const MetricPeriod = z.enum(["24h", "7d", "30d"]);
export type MetricPeriod = z.infer<typeof MetricPeriod>;

export const MetricScope = z.enum(["current", "latest", "all"]);
export type MetricScope = z.infer<typeof MetricScope>;

// Mirrors the daemon HarnessMetrics Metric shape (value 0..1 or a count, or null+reason).
export const Metric = z.object({ value: z.number().nullable(), reason: z.string().optional() }).strict();
export type Metric = z.infer<typeof Metric>;

const SixDimensions = z.object({
  trajectoryEfficiency: Metric,
  verificationStrength: Metric,
  recovery: Metric,
  stateConsistency: Metric,
  safetyCompliance: Metric,
  replayability: Metric,
}).strict();

const SixDeltas = z.object({
  trajectoryEfficiency: z.number().nullable(),
  verificationStrength: z.number().nullable(),
  recovery: z.number().nullable(),
  stateConsistency: z.number().nullable(),
  safetyCompliance: z.number().nullable(),
  replayability: z.number().nullable(),
  latencyP50Ms: z.number().nullable(),
}).strict();

export const VerificationTier = z.enum([
  "verified_executed", "partially_verified", "ai_reviewed", "self_reported", "unverified",
]);
export type VerificationTier = z.infer<typeof VerificationTier>;

export const TemplateMetricsSummary = z.object({
  templateId: z.string(),
  name: z.string(),
  latestVersion: z.number().int(),
  // Echoes the active MetricScope this detail response was computed under.
  scope: MetricScope,
  runs: z.number().int().nonnegative(),
  dimensions: SixDimensions,
  // Tile rates (0..1 or null) — the four legacy tiles, computed server-side.
  firstPass: z.number().nullable(),
  recovered: z.number().nullable(),
  escalated: z.number().nullable(),
  latencyP50Ms: z.number().nullable(),
  deltas: SixDeltas,
  versionComparison: z.object({
    latest: z.number().int(),
    prior: z.number().int(),
    byDimension: z.record(z.string(), z.number().nullable()),
  }).strict().nullable(),
  versions: z.array(z.object({
    version: z.number().int(), runs: z.number().int().nonnegative(), firstSeenAt: z.string(),
  }).strict()),
  confidence: z.enum(["low", "ok"]),
  calibration: z.array(z.object({
    source: z.enum(["executable", "grounding", "independent_review", "self_report"]),
    assumed: z.number(), measured: z.number().nullable(),
    sampleSize: z.number().int().nonnegative(),
    state: z.enum(["measured", "insufficient", "unmeasurable"]),
  }).strict()),
  gateHealth: z.object({
    value: z.number().nullable(), grade: z.enum(["A", "B", "C", "D", "F"]).nullable(),
    delta: z.number().nullable(), confidence: z.enum(["low", "ok"]),
  }).strict(),
}).strict();
export type TemplateMetricsSummary = z.infer<typeof TemplateMetricsSummary>;

export const FailureCluster = z.object({
  failureCode: z.string().nullable(),
  boundary: z.string(),
  count: z.number().int().nonnegative(),
  sampleTransitionIds: z.array(z.string()),
}).strict();
export type FailureCluster = z.infer<typeof FailureCluster>;

export const EvidenceArtifact = z.object({
  source: z.enum(["executable", "grounding", "independent_review", "self_report"]),
  verifies: z.string(),
  cannotVerify: z.string(),
  confidence: z.number(),
  verdict: z.enum(["pass", "fail", "partial", "inconclusive"]),
}).strict();
export type EvidenceArtifact = z.infer<typeof EvidenceArtifact>;

export const GateFailureMode = z.object({
  label: z.string(), count: z.number().int().nonnegative(), pct: z.number(),
  sampleDecisionIds: z.array(z.string()),
}).strict();
export type GateFailureMode = z.infer<typeof GateFailureMode>;

// Cross-version node lineage derived from per-run template snapshots (id-keyed —
// Orca renames nodes in place, so the node id is stable across renames/type changes).
export const NodeVersionHistory = z.object({
  changedFrom: z.enum(["step", "gate"]).optional(),
  renamedFrom: z.string().optional(),
  eras: z.array(z.object({
    type: z.enum(["step", "gate"]),
    fromVersion: z.number().int(),
    toVersion: z.number().int(),
    runs: z.number().int().nonnegative(),
  }).strict()),
}).strict();
export type NodeVersionHistory = z.infer<typeof NodeVersionHistory>;

export const GateMetrics = z.object({
  nodeId: z.string(),
  name: z.string(),
  evalSubstrate: z.enum(["shadow", "worker"]),
  health: z.number().nullable(),
  grade: z.enum(["A", "B", "C", "D", "F"]).nullable(),
  confidence: z.enum(["low", "ok"]),
  sampleSize: z.number().int().nonnegative(),
  delta: z.number().nullable(),
  scored: z.object({
    overturnRate: z.number().nullable(),
    overturnSampleSize: z.number().int().nonnegative(),
    overturnDecisionIds: z.array(z.string()),
    groundedness: z.number().nullable(),
    ungroundedDecisionIds: z.array(z.string()),
    convergence: z.number().nullable(),
    limitingTerm: z.enum(["overturn", "groundedness", "convergence"]).nullable(),
  }).strict(),
  cost: z.object({
    p50LatencyMs: z.number().nullable(),
    meanTokens: z.number().nullable(),
    meanUsd: z.number().nullable(),
    tokensSpentOnOverturned: z.number().nullable(),
  }).strict(),
  failureModes: z.array(GateFailureMode),
  context: z.object({
    approvalRate: z.number().nullable(),
    rejectRate: z.number().nullable(),
    decisions: z.number().int().nonnegative(),
    meanLoops: z.number().nullable(),
    capHitRate: z.number().nullable(),
    stagnationRate: z.number().nullable(),
    parkRate: z.number().nullable(),
    residualRiskBurden: z.number().nullable(),
    recentRejectReasons: z.array(z.object({ at: z.string(), reason: z.string(), issueRefs: z.array(z.string()) }).strict()),
  }).strict(),
  trend: z.array(z.number()),
  versionBoundaries: z.array(z.number().int()),
  versionHistory: NodeVersionHistory.optional(),
}).strict();
export type GateMetrics = z.infer<typeof GateMetrics>;

export const PolicyGatewayMetrics = z.object({
  decisionDist: z.object({ allow: z.number(), require_approval: z.number(), deny: z.number() }).strict(),
  overPermissive: z.object({ count: z.number().int().nonnegative(), sampleTransitionIds: z.array(z.string()) }).strict(),
  boundaryViolations: z.array(FailureCluster),
}).strict();
export type PolicyGatewayMetrics = z.infer<typeof PolicyGatewayMetrics>;

export const CompletionGateMetrics = z.object({
  verdictDist: z.object({
    upheld: z.number().int().nonnegative(),
    escalated: z.number().int().nonnegative(),
    evidence_veto: z.number().int().nonnegative(),
    refute_veto: z.number().int().nonnegative(),
  }).strict(),
  vetoed: z.object({
    count: z.number().int().nonnegative(),
    sampleTransitionIds: z.array(z.string()),
  }).strict(),
}).strict();
export type CompletionGateMetrics = z.infer<typeof CompletionGateMetrics>;

export const FailureMode = z.object({
  label: z.string(), count: z.number().int().nonnegative(), pct: z.number(),
}).strict();
export type FailureMode = z.infer<typeof FailureMode>;

export const StepMetrics = z.object({
  stepTemplateId: z.string(),
  name: z.string(),
  ordinal: z.number().int(),
  description: z.string().optional(),
  completionPolicy: z.string().optional(),
  score: z.number().nullable(),
  sampleSize: z.number().int().nonnegative(),
  confidence: z.enum(["low", "ok"]),
  runs: z.number().int().nonnegative(),
  passedFirstTry: z.number().int().nonnegative(),
  recovered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  quality: z.object({
    verdictPassRate: z.number(), sensorPassRate: z.number().nullable(), oracleSufficientRate: z.number().nullable(),
    // Denominator of `score`: conclusive completions + hard-failed runs. Workflow
    // health must weight by THIS, not sampleSize — the score was computed over it.
    scoredSampleSize: z.number().int().nonnegative(),
    // Count of completions that produced a CONCLUSIVE verdict (evidence or refute).
    // 0 means the step's delivery was never independently verified — low verification
    // COVERAGE, distinct from low quality. The score reflects verification strength, so
    // a 0-coverage step must render "unverified", not a failing grade.
    verifiedSampleSize: z.number().int().nonnegative(),
    untestedRegions: z.array(z.string()), residualRisk: z.array(z.string()),
    oracleGaps: z.array(z.string()), limitingDimension: z.string().nullable(),
    scoreBreakdown: z.object({
      meanBase: z.number().nullable(),
      meanCoverage: z.number().nullable(),
      coverageLimited: z.number().int().nonnegative(),
      verifierMix: z.object({
        executable: z.number().int().nonnegative(),
        grounding: z.number().int().nonnegative(),
        independentReview: z.number().int().nonnegative(),
        selfReportOnly: z.number().int().nonnegative(),
      }).strict(),
    }).strict().optional(),
  }).strict(),
  cost: z.object({
    p50LatencyMs: z.number().nullable(), meanTokens: z.number().nullable(),
    meanUsd: z.number().nullable(), meanRetries: z.number().nullable(),
  }).strict(),
  risk: z.object({
    riskClassDist: z.record(z.string(), z.number()),
    gateDecisionDist: z.record(z.string(), z.number()),
    hardConstraintViolations: z.number().int().nonnegative(),
    approvals: z.object({ count: z.number().int().nonnegative(), sampleTransitionIds: z.array(z.string()) }).strict(),
  }).strict(),
  failureClusters: z.array(FailureCluster),
  verification: z.object({
    tier: VerificationTier, tierLabel: z.string(), confidence: z.number(),
    falseAcceptanceRate: z.number(), artifacts: z.array(EvidenceArtifact),
    // The independent reviewer's own words for recently overturned claims (≤3).
    recentRefuteReasons: z.array(z.string()),
    band: z.object({ level: z.enum(["strong", "weak", "needs_evidence"]), label: z.string() }).strict(),
  }).strict(),
  failureModes: z.array(FailureMode),
  reconciliation: z.object({
    claimedComplete: z.boolean(), verifiedTierLabel: z.string(), refuted: z.boolean(),
    refuteReason: z.string().nullable(),
  }).strict().nullable(),
  trend: z.array(z.number()),
  versionBoundaries: z.array(z.number().int()),
  // Latest-vs-prior template version delta of THIS step's honest score (0..1 scale);
  // null unless both versions have enough scored samples in the window.
  versionScoreDelta: z.number().nullable(),
  // The version pair versionScoreDelta compares (latest vs prior with enough scored
  // samples). Lets the falsifier verify the delta actually spans the applied version.
  versionScoreDeltaVersions: z.object({ latest: z.number().int(), prior: z.number().int() }).strict().nullable().optional(),
  // Latest-vs-prior version delta of the step's invalid-output completion rate.
  // The schema-canary signal: a too-tight learned schema shows up here first.
  versionInvalidOutputRateDelta: z.number().nullable(),
  insights: z.array(z.string()),
  recentReasons: z.array(z.object({ at: z.string(), reason: z.string() }).strict()),
  versionHistory: NodeVersionHistory.optional(),
}).strict();
export type StepMetrics = z.infer<typeof StepMetrics>;

export const PipelineNode = z.object({
  nodeId: z.string(),
  name: z.string(),
  type: z.enum(["step", "gate", "splitter"]),
  guards: z.object({ from: z.string(), to: z.string() }).strict().optional(),
  branchesTo: z.array(z.string()).optional(),
}).strict();
export type PipelineNode = z.infer<typeof PipelineNode>;

export const SampleDetail = z.object({
  transitionId: z.string(),
  goalId: z.string(),
  workflowRunId: z.string().nullable(),
  createdAt: z.string(),
  templateVersion: z.number().int().nullable(),
  failureCode: z.string().nullable(),
  status: z.string(),
  checks: z.array(z.object({ label: z.string(), detail: z.string().nullable(), result: z.string() }).strict()),
}).strict();
export type SampleDetail = z.infer<typeof SampleDetail>;

export const TemplateMetricsDetail = z.object({
  summary: TemplateMetricsSummary,
  steps: z.array(StepMetrics),
  gates: z.array(GateMetrics),
  policyGateway: PolicyGatewayMetrics,
  completionGate: CompletionGateMetrics,
  pipeline: z.array(PipelineNode).optional(),
}).strict();
export type TemplateMetricsDetail = z.infer<typeof TemplateMetricsDetail>;
