import { z } from "zod";

export const MetricPeriod = z.enum(["24h", "7d", "30d"]);
export type MetricPeriod = z.infer<typeof MetricPeriod>;

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

export const TemplateMetricsSummary = z.object({
  templateId: z.string(),
  name: z.string(),
  latestVersion: z.number().int(),
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
}).strict();
export type TemplateMetricsSummary = z.infer<typeof TemplateMetricsSummary>;

export const FailureCluster = z.object({
  failureCode: z.string().nullable(),
  boundary: z.string(),
  count: z.number().int().nonnegative(),
  sampleTransitionIds: z.array(z.string()),
}).strict();
export type FailureCluster = z.infer<typeof FailureCluster>;

export const StepMetrics = z.object({
  stepTemplateId: z.string(),
  name: z.string(),
  ordinal: z.number().int(),
  score: z.number(),
  sampleSize: z.number().int().nonnegative(),
  confidence: z.enum(["low", "ok"]),
  runs: z.number().int().nonnegative(),
  passedFirstTry: z.number().int().nonnegative(),
  recovered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  quality: z.object({
    verdictPassRate: z.number(), sensorPassRate: z.number(), oracleSufficientRate: z.number(),
    untestedRegions: z.array(z.string()), residualRisk: z.array(z.string()),
    oracleGaps: z.array(z.string()), limitingDimension: z.string().nullable(),
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
  trend: z.array(z.number()),
  versionBoundaries: z.array(z.number().int()),
  insights: z.array(z.string()),
  recentReasons: z.array(z.object({ at: z.string(), reason: z.string() }).strict()),
}).strict();
export type StepMetrics = z.infer<typeof StepMetrics>;

export const TemplateMetricsDetail = z.object({
  summary: TemplateMetricsSummary,
  steps: z.array(StepMetrics),
}).strict();
export type TemplateMetricsDetail = z.infer<typeof TemplateMetricsDetail>;
