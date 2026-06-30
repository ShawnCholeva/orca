# Metrics Read Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mocked Metrics tab with a real, per-template, cross-run, version-aware read surface derived from the `harness_transitions` telemetry spine, with zero LLM calls and zero new persisted state.

**Architecture:** A pure control-plane projection read. Two new daemon endpoints aggregate the append-only `harness_transitions` rows (joined to `workflow_runs`/`workflow_step_runs`) entirely in **storage-agnostic TypeScript** over typed transition lists; the only SQL is a portable, JSON-free filtered fetch. The desktop fetches and renders — zero metric arithmetic in the client. The learning-loop rail (proposals/auto-apply) renders a deferred state for a later sub-project (B / FUTURE_WORK 5.2).

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), Fastify, better-sqlite3, Vitest, React + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-30-metrics-read-surface-design.md` (approved). Read it before starting.

## Global Constraints

- **Zero LLM calls** in this entire sub-project — it is a deterministic read surface.
- **Zero new persisted state / no migration** — read existing tables only.
- **F2 (settled):** all aggregation/derivation in TypeScript over typed `HarnessTransition[]`; the only SQL is a portable, JSON-free fetch (no `json_extract`, no SQLite-specific JSON ops).
- **F4:** the desktop performs no metric arithmetic — every number/delta/cluster/insight arrives computed from the server. The desktop mapper is presentation-only.
- **F3:** new `@orca/contracts` fields are additive/optional; never reshape an existing response.
- Period values are exactly the string literals `"24h" | "7d" | "30d"`.
- Test runner: `cd apps/daemon && pnpm vitest run <path>` (daemon); `cd apps/desktop && pnpm vitest run <path>` (desktop).
- Commit after every task (frequent commits). Branch off `main` first (do not commit to `main`).

---

## File structure

**Contracts (new):**
- `packages/contracts/src/metrics/index.ts` — `MetricPeriod`, `Metric`, `TemplateMetricsSummary`, `StepMetrics`, `TemplateMetricsDetail`, `FailureCluster` schemas.
- `packages/contracts/src/index.ts` — add `export * from "./metrics/index.js";`.

**Daemon (new module `apps/daemon/src/metrics/`):**
- `fetch.ts` — `listTransitionsByTemplate`, `listStepRunsByTemplate`, `listTemplatesWithRuns` (portable SQL → typed rows).
- `aggregate.ts` — pure functions: `windowStart`, `summarizeTransitions`, `computeTemplateSummary`, `computeStepMetrics`, `deriveInsights`.
- `usecases.ts` — `getTemplateMetricsSummaries`, `getTemplateMetricsDetail` (fetch + aggregate).
- `routes.ts` — `registerMetricsRoutes` (two endpoints + validation).

**Daemon (modified):**
- `apps/daemon/src/harness-metrics/usecases.ts` — extract `computeHarnessMetricsFromTransitions(ts)`.
- `apps/daemon/src/server.ts` — register the new routes.

**Desktop (modified):**
- `apps/desktop/src/api.ts` — `getTemplateMetricsSummaries`, `getTemplateMetricsDetail`.
- `apps/desktop/src/metrics/metrics-data.ts` — replace mock with contract→view mapper.
- `apps/desktop/src/metrics/MetricsPage.tsx` — fetch hook + four states + refresh.
- `apps/desktop/src/metrics/StepPerformance.tsx` — scope block, insights, clusters, drill-through, approvals, low-confidence.
- `apps/desktop/src/metrics/SelfImprovement.tsx` — deferred state, remove `AutoApplyToggle`.

**Docs (modified):** `ORCA.md`, `FUTURE_WORK.md`.

---

### Task 1: Extract `computeHarnessMetricsFromTransitions`

Refactor the per-goal metric computation so the per-template path can reuse it over a different transition list. Pure extraction; existing per-goal tests are the safety net.

**Files:**
- Modify: `apps/daemon/src/harness-metrics/usecases.ts`
- Test: `apps/daemon/src/harness-metrics/usecases.test.ts` (add a case)

**Interfaces:**
- Produces: `computeHarnessMetricsFromTransitions(ts: HarnessTransition[]): HarnessMetrics` and the existing `computeHarnessMetrics(db, goalId): HarnessMetrics` (unchanged signature, now delegates).
- `HarnessMetrics = { trajectory_efficiency, verification_strength, recovery, state_consistency, safety_compliance, replayability: Metric }`, `Metric = { value: number | null; reason?: string }`.

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/harness-metrics/usecases.test.ts`:

```typescript
import { computeHarnessMetricsFromTransitions } from "./usecases.js";
import type { HarnessTransition } from "@orca/contracts";

it("computeHarnessMetricsFromTransitions returns null metrics for an empty list", () => {
  const metrics = computeHarnessMetricsFromTransitions([]);
  expect(metrics.trajectory_efficiency).toEqual({ value: null, reason: "no transitions" });
  expect(metrics.replayability).toEqual({ value: null, reason: "no transitions" });
});

it("computeHarnessMetricsFromTransitions computes verification_strength from step_complete evidence", () => {
  const base = {
    id: "t1", goalId: "g", workflowRunId: "r", workflowStepRunId: "s",
    boundary: "step_complete" as const,
    risk: null, stateDeps: null,
    evidence: {
      sensorsRun: [], verdict: "passed" as const, untestedRegions: [], residualRisk: [],
      oracleAdequacy: { sufficient: true, gaps: [] },
    },
    telemetry: {
      cost: null, latency_ms: 100, model: null, provider_id: null, provider_version: null,
      prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [],
      outcome: { status: "succeeded" as const, failure_code: null },
    },
    createdAt: "2026-05-01T00:00:00.000Z",
  };
  const ts: HarnessTransition[] = [base];
  const metrics = computeHarnessMetricsFromTransitions(ts);
  expect(metrics.verification_strength.value).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/harness-metrics/usecases.test.ts`
Expected: FAIL — `computeHarnessMetricsFromTransitions` is not exported.

- [ ] **Step 3: Refactor the implementation**

In `apps/daemon/src/harness-metrics/usecases.ts`, change the body so `computeHarnessMetrics` fetches then delegates, and the pure computation is a new exported function. Replace the current `export function computeHarnessMetrics(db, goalId) { const ts = listTransitionsByGoal(db, goalId, 10_000); ... }` with:

```typescript
export function computeHarnessMetrics(db: Database.Database, goalId: string): HarnessMetrics {
  return computeHarnessMetricsFromTransitions(listTransitionsByGoal(db, goalId, 10_000));
}

export function computeHarnessMetricsFromTransitions(ts: HarnessTransition[]): HarnessMetrics {
  const n = ts.length;
  // ... move the existing body here verbatim, operating on `ts` (the existing code
  // already computes every metric over the local `ts` list — cut everything from
  // `const withRisk = ...` down to the `return { ... }` and paste it unchanged) ...
}
```

Add `import type { HarnessTransition } from "@orca/contracts";` at the top if not present. The existing per-goal computation body moves wholesale — no logic change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/harness-metrics/usecases.test.ts`
Expected: PASS (new cases + all pre-existing cases).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-metrics/usecases.ts apps/daemon/src/harness-metrics/usecases.test.ts
git commit -m "refactor(daemon): extract computeHarnessMetricsFromTransitions for reuse"
```

---

### Task 2: Metrics contracts

Add the read-model schemas to the public contracts spine.

**Files:**
- Create: `packages/contracts/src/metrics/index.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/metrics/index.test.ts`

**Interfaces:**
- Produces: `MetricPeriod`, `Metric`, `FailureCluster`, `TemplateMetricsSummary`, `StepMetrics`, `TemplateMetricsDetail` (zod schemas + inferred types).

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/metrics/index.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { MetricPeriod, TemplateMetricsSummary, TemplateMetricsDetail } from "./index.js";

describe("metrics contracts", () => {
  it("accepts the three period literals only", () => {
    expect(MetricPeriod.safeParse("7d").success).toBe(true);
    expect(MetricPeriod.safeParse("1y").success).toBe(false);
  });

  it("round-trips a minimal TemplateMetricsSummary", () => {
    const summary = {
      templateId: "tpl", name: "Brainstorm", latestVersion: 2, runs: 10,
      dimensions: {
        trajectoryEfficiency: { value: null, reason: "no transitions" },
        verificationStrength: { value: 0.8 },
        recovery: { value: 0.5 },
        stateConsistency: { value: 1 },
        safetyCompliance: { value: 1 },
        replayability: { value: 1 },
      },
      firstPass: 0.6, recovered: 0.28, escalated: 0.08,
      latencyP50Ms: 1200,
      deltas: { verificationStrength: 0.05, recovery: null, trajectoryEfficiency: null,
                stateConsistency: 0, safetyCompliance: 0, replayability: 0, latencyP50Ms: -100 },
      versionComparison: null,
      versions: [{ version: 2, runs: 6, firstSeenAt: "2026-05-01T00:00:00.000Z" }],
      confidence: "ok" as const,
    };
    expect(TemplateMetricsSummary.parse(summary)).toEqual(summary);
  });

  it("round-trips a TemplateMetricsDetail with one step", () => {
    const detail = {
      summary: TemplateMetricsSummary.parse({
        templateId: "tpl", name: "Brainstorm", latestVersion: 1, runs: 1,
        dimensions: {
          trajectoryEfficiency: { value: null }, verificationStrength: { value: 1 },
          recovery: { value: null }, stateConsistency: { value: 1 },
          safetyCompliance: { value: 1 }, replayability: { value: 1 },
        },
        firstPass: null, recovered: null, escalated: null,
        latencyP50Ms: null,
        deltas: { trajectoryEfficiency: null, verificationStrength: null, recovery: null,
                  stateConsistency: null, safetyCompliance: null, replayability: null, latencyP50Ms: null },
        versionComparison: null, versions: [], confidence: "low" as const,
      }),
      steps: [{
        stepTemplateId: "s1", name: "Define Intent", ordinal: 0,
        score: 94, sampleSize: 12, confidence: "ok" as const,
        runs: 12, passedFirstTry: 10, recovered: 1, failed: 1,
        quality: { verdictPassRate: 0.9, sensorPassRate: 0.95, oracleSufficientRate: 0.8,
                   untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
        cost: { p50LatencyMs: 1100, meanTokens: 2000, meanUsd: 0.03, meanRetries: 0.2 },
        risk: { riskClassDist: { low: 10 }, gateDecisionDist: { allow: 10 },
                hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
        failureClusters: [{ failureCode: "invalid_output", boundary: "step_complete",
                            count: 1, sampleTransitionIds: ["t9"] }],
        trend: [90, 92, 94], versionBoundaries: [],
        insights: ["Weakest step"], recentReasons: [],
      }],
    };
    expect(TemplateMetricsDetail.parse(detail)).toEqual(detail);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/contracts && pnpm vitest run src/metrics/index.test.ts`
Expected: FAIL — module `./index.js` not found.

- [ ] **Step 3: Write the contracts**

Create `packages/contracts/src/metrics/index.ts`:

```typescript
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
```

- [ ] **Step 4: Export from the contracts index**

In `packages/contracts/src/index.ts`, after the line `export * from "./harness/index.js";` add:

```typescript
export * from "./metrics/index.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/contracts && pnpm vitest run src/metrics/index.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/metrics/index.ts packages/contracts/src/metrics/index.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add metrics read-surface schemas"
```

---

### Task 3: Portable fetch seam

Fetch the typed transitions, step runs, and template list for a template within a time window. JSON-free SQL only (F2).

**Files:**
- Create: `apps/daemon/src/metrics/fetch.ts`
- Test: `apps/daemon/src/metrics/fetch.test.ts`

**Interfaces:**
- Consumes: `HARNESS_FACETS`, `HarnessTransition` from `@orca/contracts`.
- Produces:
  - `type TemplateTransition = { transition: HarnessTransition; templateVersion: number; stepTemplateId: string | null }`
  - `type TemplateStepRun = { workflowRunId: string; stepTemplateId: string; attempt: number; status: string; startedAt: string | null; finishedAt: string | null; blockedReason: string | null; templateVersion: number }`
  - `type TemplateRunInfo = { templateId: string; name: string; latestVersion: number }`
  - `listTransitionsByTemplate(db, templateId, sinceIso, untilIso): TemplateTransition[]`
  - `listStepRunsByTemplate(db, templateId, sinceIso, untilIso): TemplateStepRun[]`
  - `listTemplatesWithRuns(db): TemplateRunInfo[]`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/metrics/fetch.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { listTransitionsByTemplate, listStepRunsByTemplate, listTemplatesWithRuns } from "./fetch.js";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return {
    dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token",
  };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-metrics-fetch-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
function seed(db: Database.Database) {
  db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at)
              VALUES ('g','G','','active',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`).run();
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
              VALUES ('tpl','Brainstorm','',2,1,0,'[]','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_runs (id,goal_id,template_id,template_version,status,current_step_run_id,blocked_reason,started_at,finished_at)
              VALUES ('run1','g','tpl',1,'completed',NULL,NULL,'2026-05-01T00:00:00.000Z','2026-05-01T01:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_step_runs (id,goal_id,workflow_run_id,step_template_id,ordinal,attempt,status,satisfied_exit_criteria_json,outstanding_exit_criteria_json,blocked_reason,started_at,finished_at,fingerprint)
              VALUES ('sr1','g','run1','define-intent',0,1,'passed','[]','[]',NULL,'2026-05-01T00:00:00.000Z','2026-05-01T00:10:00.000Z','fp1')`).run();
  db.prepare(`INSERT INTO harness_transitions (id,goal_id,workflow_run_id,workflow_step_run_id,boundary,risk_json,evidence_json,state_deps_json,telemetry_json,created_at)
              VALUES ('ht1','g','run1','sr1','step_complete',NULL,
                '{"sensorsRun":[],"verdict":"passed","untestedRegions":[],"residualRisk":[],"oracleAdequacy":{"sufficient":true,"gaps":[]}}',
                NULL,
                '{"cost":null,"latency_ms":100,"model":null,"provider_id":null,"provider_version":null,"prompt_ref":null,"raw_output_ref":null,"rejected_alternatives":[],"human_interventions":[],"outcome":{"status":"succeeded","failure_code":null}}',
                '2026-05-01T00:10:00.000Z')`).run();
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); seed(db); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("metrics fetch", () => {
  it("lists transitions joined to template version + step template id, within window", () => {
    const rows = listTransitionsByTemplate(db, "tpl", "2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0].templateVersion).toBe(1);
    expect(rows[0].stepTemplateId).toBe("define-intent");
    expect(rows[0].transition.evidence?.verdict).toBe("passed");
  });

  it("excludes transitions outside the window", () => {
    const rows = listTransitionsByTemplate(db, "tpl", "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    expect(rows).toHaveLength(0);
  });

  it("lists step runs for a template within window", () => {
    const rows = listStepRunsByTemplate(db, "tpl", "2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0].stepTemplateId).toBe("define-intent");
    expect(rows[0].attempt).toBe(1);
    expect(rows[0].status).toBe("passed");
  });

  it("lists templates that have at least one run", () => {
    const rows = listTemplatesWithRuns(db);
    expect(rows).toEqual([{ templateId: "tpl", name: "Brainstorm", latestVersion: 2 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/metrics/fetch.test.ts`
Expected: FAIL — `./fetch.js` not found.

- [ ] **Step 3: Write the fetch module**

Create `apps/daemon/src/metrics/fetch.ts`:

```typescript
import type Database from "better-sqlite3";
import { HARNESS_FACETS, HarnessTransition } from "@orca/contracts";

export type TemplateTransition = {
  transition: HarnessTransition;
  templateVersion: number;
  stepTemplateId: string | null;
};
export type TemplateStepRun = {
  workflowRunId: string;
  stepTemplateId: string;
  attempt: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  blockedReason: string | null;
  templateVersion: number;
};
export type TemplateRunInfo = { templateId: string; name: string; latestVersion: number };

const FACET_COLS = HARNESS_FACETS.map((f) => `ht.${f.column}`).join(", ");

interface TransitionJoinRow {
  id: string; goal_id: string; workflow_run_id: string | null; workflow_step_run_id: string | null;
  boundary: string; created_at: string; template_version: number; step_template_id: string | null;
  [facetColumn: string]: unknown;
}

function rowToTemplateTransition(row: TransitionJoinRow): TemplateTransition {
  const facets: Record<string, unknown> = {};
  for (const f of HARNESS_FACETS) {
    const raw = row[f.column] as string | null;
    facets[f.key] = raw == null ? null : JSON.parse(raw);
  }
  const transition = HarnessTransition.parse({
    id: row.id, goalId: row.goal_id, workflowRunId: row.workflow_run_id,
    workflowStepRunId: row.workflow_step_run_id, boundary: row.boundary,
    ...facets, createdAt: row.created_at,
  });
  return { transition, templateVersion: row.template_version, stepTemplateId: row.step_template_id };
}

// Portable, JSON-free join (F2): no json_extract, no SQLite-specific ops. The facet
// columns are selected as opaque TEXT and parsed in TS.
export function listTransitionsByTemplate(
  db: Database.Database, templateId: string, sinceIso: string, untilIso: string
): TemplateTransition[] {
  const rows = db.prepare(
    `SELECT ht.id, ht.goal_id, ht.workflow_run_id, ht.workflow_step_run_id, ht.boundary, ht.created_at,
            ${FACET_COLS}, wr.template_version AS template_version, wsr.step_template_id AS step_template_id
     FROM harness_transitions ht
     JOIN workflow_runs wr ON wr.id = ht.workflow_run_id
     LEFT JOIN workflow_step_runs wsr ON wsr.id = ht.workflow_step_run_id
     WHERE wr.template_id = ? AND ht.created_at >= ? AND ht.created_at < ?
     ORDER BY ht.created_at ASC, ht.id ASC`
  ).all(templateId, sinceIso, untilIso) as TransitionJoinRow[];
  return rows.map(rowToTemplateTransition);
}

export function listStepRunsByTemplate(
  db: Database.Database, templateId: string, sinceIso: string, untilIso: string
): TemplateStepRun[] {
  const rows = db.prepare(
    `SELECT wsr.workflow_run_id, wsr.step_template_id, wsr.attempt, wsr.status,
            wsr.started_at, wsr.finished_at, wsr.blocked_reason, wr.template_version
     FROM workflow_step_runs wsr
     JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
     WHERE wr.template_id = ? AND wsr.started_at >= ? AND wsr.started_at < ?
     ORDER BY wsr.started_at ASC, wsr.id ASC`
  ).all(templateId, sinceIso, untilIso) as {
    workflow_run_id: string; step_template_id: string; attempt: number; status: string;
    started_at: string | null; finished_at: string | null; blocked_reason: string | null; template_version: number;
  }[];
  return rows.map((r) => ({
    workflowRunId: r.workflow_run_id, stepTemplateId: r.step_template_id, attempt: r.attempt,
    status: r.status, startedAt: r.started_at, finishedAt: r.finished_at,
    blockedReason: r.blocked_reason, templateVersion: r.template_version,
  }));
}

export function listTemplatesWithRuns(db: Database.Database): TemplateRunInfo[] {
  const rows = db.prepare(
    `SELECT t.id AS template_id, t.name AS name, t.version AS latest_version
     FROM workflow_templates t
     WHERE EXISTS (SELECT 1 FROM workflow_runs r WHERE r.template_id = t.id)
     ORDER BY t.name ASC`
  ).all() as { template_id: string; name: string; latest_version: number }[];
  return rows.map((r) => ({ templateId: r.template_id, name: r.name, latestVersion: r.latest_version }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/metrics/fetch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/metrics/fetch.ts apps/daemon/src/metrics/fetch.test.ts
git commit -m "feat(daemon): portable JSON-free fetch seam for template metrics"
```

---

### Task 4: Aggregation — window + summary

Compute the per-template summary (six dimensions, run/version info, escalated/firstPass/recovered, latency, deltas, version comparison, confidence) in pure TS.

**Files:**
- Create: `apps/daemon/src/metrics/aggregate.ts`
- Test: `apps/daemon/src/metrics/aggregate.test.ts`

**Interfaces:**
- Consumes: `TemplateTransition`, `TemplateStepRun` (Task 3); `computeHarnessMetricsFromTransitions` (Task 1); `TemplateMetricsSummary`, `MetricPeriod` (Task 2).
- Produces:
  - `SAMPLE_MIN = 5`
  - `windowStart(nowIso: string, period: MetricPeriod): string`
  - `computeTemplateSummary(input: { templateId; name; latestVersion; nowIso; period; current: { transitions; stepRuns; versions }; prior: { transitions; stepRuns } }): TemplateMetricsSummary` — where `versions: { version: number; firstSeenAt: string }[]` come from run rows (see step 3).
  - `medianLatencyMs(ts: TemplateTransition[]): number | null`
  - `escalatedRate / firstPassRate / recoveredCount` helpers (exported for step reuse in Task 5).

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/metrics/aggregate.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { TemplateTransition, TemplateStepRun } from "./fetch.js";
import { windowStart, SAMPLE_MIN, medianLatencyMs, firstPassRate } from "./aggregate.js";

function stepComplete(id: string, runId: string, step: string, version: number, latency: number, verdict: "passed" | "failed", at: string): TemplateTransition {
  return {
    templateVersion: version, stepTemplateId: step,
    transition: {
      id, goalId: "g", workflowRunId: runId, workflowStepRunId: `${runId}-${step}`,
      boundary: "step_complete", risk: null, stateDeps: null,
      evidence: { sensorsRun: [], verdict, untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } },
      telemetry: { cost: null, latency_ms: latency, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: verdict === "passed" ? "succeeded" : "failed", failure_code: verdict === "passed" ? null : "invalid_output" } },
      createdAt: at,
    },
  };
}

describe("windowStart", () => {
  it("subtracts the period from now", () => {
    expect(windowStart("2026-05-08T00:00:00.000Z", "7d")).toBe("2026-05-01T00:00:00.000Z");
    expect(windowStart("2026-05-02T00:00:00.000Z", "24h")).toBe("2026-05-01T00:00:00.000Z");
  });
});

describe("medianLatencyMs", () => {
  it("returns the median latency over step_complete transitions", () => {
    const ts = [
      stepComplete("a", "r1", "s", 1, 100, "passed", "2026-05-01T00:00:00.000Z"),
      stepComplete("b", "r2", "s", 1, 300, "passed", "2026-05-01T00:00:00.000Z"),
      stepComplete("c", "r3", "s", 1, 200, "passed", "2026-05-01T00:00:00.000Z"),
    ];
    expect(medianLatencyMs(ts)).toBe(200);
  });
  it("returns null with no latency data", () => { expect(medianLatencyMs([])).toBeNull(); });
});

describe("firstPassRate", () => {
  it("counts distinct (run, step) passing on attempt 1", () => {
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:01:00.000Z", blockedReason: null, templateVersion: 1 },
      { workflowRunId: "r2", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:01:00.000Z", blockedReason: "boom", templateVersion: 1 },
      { workflowRunId: "r2", stepTemplateId: "s", attempt: 2, status: "passed", startedAt: "2026-05-01T00:02:00.000Z", finishedAt: "2026-05-01T00:03:00.000Z", blockedReason: null, templateVersion: 1 },
    ];
    expect(firstPassRate(runs)).toBeCloseTo(0.5); // r1 first-pass; r2 recovered (not first-pass)
  });

  it("SAMPLE_MIN is 5", () => { expect(SAMPLE_MIN).toBe(5); });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/metrics/aggregate.test.ts`
Expected: FAIL — `./aggregate.js` not found.

- [ ] **Step 3: Write the aggregate module (summary half)**

Create `apps/daemon/src/metrics/aggregate.ts`:

```typescript
import type { HarnessMetrics } from "../harness-metrics/usecases.js";
import { computeHarnessMetricsFromTransitions } from "../harness-metrics/usecases.js";
import type { MetricPeriod, TemplateMetricsSummary } from "@orca/contracts";
import type { TemplateTransition, TemplateStepRun } from "./fetch.js";

export const SAMPLE_MIN = 5;

const PERIOD_MS: Record<MetricPeriod, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function windowStart(nowIso: string, period: MetricPeriod): string {
  return new Date(new Date(nowIso).getTime() - PERIOD_MS[period]).toISOString();
}

export function medianLatencyMs(ts: TemplateTransition[]): number | null {
  const xs = ts
    .map((t) => t.transition.telemetry?.latency_ms)
    .filter((x): x is number => typeof x === "number")
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
}

const PASSED = new Set(["passed"]);
const FAILED_STATUSES = new Set(["failed", "blocked"]);

// Final attempt per distinct (run, step).
function finalAttempts(runs: TemplateStepRun[]): TemplateStepRun[] {
  const byKey = new Map<string, TemplateStepRun>();
  for (const r of runs) {
    const key = `${r.workflowRunId}::${r.stepTemplateId}`;
    const prev = byKey.get(key);
    if (!prev || r.attempt > prev.attempt) byKey.set(key, r);
  }
  return [...byKey.values()];
}

export function firstPassRate(runs: TemplateStepRun[]): number | null {
  const finals = finalAttempts(runs);
  if (finals.length === 0) return null;
  const firstPass = finals.filter((r) => r.attempt === 1 && PASSED.has(r.status)).length;
  return firstPass / finals.length;
}

export function recoveredRate(runs: TemplateStepRun[]): number | null {
  const finals = finalAttempts(runs);
  if (finals.length === 0) return null;
  const recovered = finals.filter((r) => r.attempt > 1 && PASSED.has(r.status)).length;
  return recovered / finals.length;
}

export function failedCount(runs: TemplateStepRun[]): number {
  return finalAttempts(runs).filter((r) => FAILED_STATUSES.has(r.status)).length;
}

// Escalated: distinct (run, step) that had a require_approval/deny gate or a human
// intervention, over distinct (run, step) total.
export function escalatedRate(ts: TemplateTransition[]): number | null {
  const keys = new Set<string>();
  const escalated = new Set<string>();
  for (const { transition: t } of ts) {
    if (!t.workflowRunId || !t.workflowStepRunId) continue;
    const key = `${t.workflowRunId}::${t.workflowStepRunId}`;
    keys.add(key);
    const gate = t.risk?.gate_decision;
    const humans = t.telemetry?.human_interventions?.length ?? 0;
    if (gate === "require_approval" || gate === "deny" || humans > 0) escalated.add(key);
  }
  if (keys.size === 0) return null;
  return escalated.size / keys.size;
}

function toSummaryDimensions(m: HarnessMetrics): TemplateMetricsSummary["dimensions"] {
  return {
    trajectoryEfficiency: m.trajectory_efficiency,
    verificationStrength: m.verification_strength,
    recovery: m.recovery,
    stateConsistency: m.state_consistency,
    safetyCompliance: m.safety_compliance,
    replayability: m.replayability,
  };
}

function delta(a: number | null, b: number | null): number | null {
  return a == null || b == null ? null : a - b;
}

function dimsFromTransitions(ts: TemplateTransition[]): HarnessMetrics {
  return computeHarnessMetricsFromTransitions(ts.map((t) => t.transition));
}

export function computeTemplateSummary(input: {
  templateId: string;
  name: string;
  latestVersion: number;
  runCount: number;
  versions: { version: number; runs: number; firstSeenAt: string }[];
  current: { transitions: TemplateTransition[]; stepRuns: TemplateStepRun[] };
  prior: { transitions: TemplateTransition[]; stepRuns: TemplateStepRun[] };
}): TemplateMetricsSummary {
  const cur = dimsFromTransitions(input.current.transitions);
  const prev = dimsFromTransitions(input.prior.transitions);
  const curLatency = medianLatencyMs(input.current.transitions);
  const priorLatency = medianLatencyMs(input.prior.transitions);

  // Version comparison: latest vs immediately-prior version present in the window.
  const presentVersions = [...new Set(input.current.transitions.map((t) => t.templateVersion))].sort((a, b) => b - a);
  let versionComparison: TemplateMetricsSummary["versionComparison"] = null;
  if (presentVersions.length >= 2) {
    const [latestV, priorV] = presentVersions;
    const latestDims = dimsFromTransitions(input.current.transitions.filter((t) => t.templateVersion === latestV));
    const priorDims = dimsFromTransitions(input.current.transitions.filter((t) => t.templateVersion === priorV));
    versionComparison = {
      latest: latestV, prior: priorV,
      byDimension: {
        trajectoryEfficiency: delta(latestDims.trajectory_efficiency.value, priorDims.trajectory_efficiency.value),
        verificationStrength: delta(latestDims.verification_strength.value, priorDims.verification_strength.value),
        recovery: delta(latestDims.recovery.value, priorDims.recovery.value),
        stateConsistency: delta(latestDims.state_consistency.value, priorDims.state_consistency.value),
        safetyCompliance: delta(latestDims.safety_compliance.value, priorDims.safety_compliance.value),
        replayability: delta(latestDims.replayability.value, priorDims.replayability.value),
      },
    };
  }

  return {
    templateId: input.templateId, name: input.name, latestVersion: input.latestVersion,
    runs: input.runCount,
    dimensions: toSummaryDimensions(cur),
    firstPass: firstPassRate(input.current.stepRuns),
    recovered: recoveredRate(input.current.stepRuns),
    escalated: escalatedRate(input.current.transitions),
    latencyP50Ms: curLatency,
    deltas: {
      trajectoryEfficiency: delta(cur.trajectory_efficiency.value, prev.trajectory_efficiency.value),
      verificationStrength: delta(cur.verification_strength.value, prev.verification_strength.value),
      recovery: delta(cur.recovery.value, prev.recovery.value),
      stateConsistency: delta(cur.state_consistency.value, prev.state_consistency.value),
      safetyCompliance: delta(cur.safety_compliance.value, prev.safety_compliance.value),
      replayability: delta(cur.replayability.value, prev.replayability.value),
      latencyP50Ms: delta(curLatency, priorLatency),
    },
    versionComparison,
    versions: input.versions,
    confidence: input.runCount < SAMPLE_MIN ? "low" : "ok",
  };
}
```

Note: `HarnessMetrics` must be exported from `harness-metrics/usecases.ts` — it already is a `type` there; if it is not `export`ed, add `export` to its declaration in that file as part of this step.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/metrics/aggregate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/aggregate.test.ts apps/daemon/src/harness-metrics/usecases.ts
git commit -m "feat(daemon): per-template summary aggregation (dims, deltas, version comparison)"
```

---

### Task 5: Aggregation — per-step metrics + clusters + scope + insights

Compute `StepMetrics[]` (three channels, scope, failure clusters, trend, insights, recentReasons) in pure TS.

**Files:**
- Modify: `apps/daemon/src/metrics/aggregate.ts`
- Test: `apps/daemon/src/metrics/aggregate.steps.test.ts`

**Interfaces:**
- Consumes: everything from Task 4; `StepMetrics` (Task 2).
- Produces:
  - `computeStepMetrics(input: { transitions: TemplateTransition[]; stepRuns: TemplateStepRun[]; stepNames: Map<string, { name: string; ordinal: number }>; nowIso: string; period: MetricPeriod }): StepMetrics[]`
  - `deriveInsights(step: StepMetrics): string[]`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/metrics/aggregate.steps.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { TemplateTransition, TemplateStepRun } from "./fetch.js";
import { computeStepMetrics, deriveInsights } from "./aggregate.js";

function sc(id: string, runId: string, step: string, verdict: "passed" | "failed", oracleSufficient: boolean, at: string): TemplateTransition {
  return {
    templateVersion: 1, stepTemplateId: step,
    transition: {
      id, goalId: "g", workflowRunId: runId, workflowStepRunId: `${runId}-${step}`,
      boundary: "step_complete", risk: null, stateDeps: null,
      evidence: { sensorsRun: [], verdict, untestedRegions: verdict === "failed" ? ["auth path"] : [], residualRisk: [], oracleAdequacy: { sufficient: oracleSufficient, gaps: oracleSufficient ? [] : ["no integration test"] } },
      telemetry: { cost: { tokens_in: 100, tokens_out: 50, cache_read_tokens: null, cache_creation_tokens: null, usd: 0.01 }, latency_ms: 100, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: verdict === "passed" ? "succeeded" : "failed", failure_code: verdict === "passed" ? null : "invalid_output" } },
      createdAt: at,
    },
  };
}

const names = new Map([["s", { name: "Generate Proposal", ordinal: 2 }]]);

describe("computeStepMetrics", () => {
  it("rolls up a step's three channels and failure clusters", () => {
    const ts = [
      sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z"),
      sc("b", "r2", "s", "failed", false, "2026-05-01T01:00:00.000Z"),
      sc("c", "r3", "s", "failed", false, "2026-05-01T02:00:00.000Z"),
    ];
    const runs: TemplateStepRun[] = ts.map((t, i) => ({
      workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1,
      status: t.transition.evidence!.verdict === "passed" ? "passed" : "failed",
      startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z",
      blockedReason: t.transition.evidence!.verdict === "passed" ? null : `fail ${i}`, templateVersion: 1,
    }));
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.stepTemplateId).toBe("s");
    expect(step.name).toBe("Generate Proposal");
    expect(step.runs).toBe(3);
    expect(step.quality.verdictPassRate).toBeCloseTo(1 / 3);
    expect(step.quality.untestedRegions).toContain("auth path");
    expect(step.quality.oracleGaps).toContain("no integration test");
    expect(step.failureClusters).toEqual([
      { failureCode: "invalid_output", boundary: "step_complete", count: 2, sampleTransitionIds: ["b", "c"] },
    ]);
    expect(step.recentReasons.map((r) => r.reason)).toContain("fail 2");
  });
});

describe("deriveInsights", () => {
  it("flags false confidence: high pass rate, low oracle adequacy", () => {
    const insights = deriveInsights({
      stepTemplateId: "s", name: "X", ordinal: 0, score: 95, sampleSize: 10, confidence: "ok",
      runs: 10, passedFirstTry: 9, recovered: 1, failed: 0,
      quality: { verdictPassRate: 0.95, sensorPassRate: 1, oracleSufficientRate: 0.2, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
      cost: { p50LatencyMs: 100, meanTokens: 100, meanUsd: 0.01, meanRetries: 0 },
      risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
      failureClusters: [], trend: [], versionBoundaries: [], insights: [], recentReasons: [],
    });
    expect(insights.some((i) => /oracle/i.test(i))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/metrics/aggregate.steps.test.ts`
Expected: FAIL — `computeStepMetrics`/`deriveInsights` not exported.

- [ ] **Step 3: Append the step computation to `aggregate.ts`**

Add to `apps/daemon/src/metrics/aggregate.ts`:

```typescript
import type { StepMetrics } from "@orca/contracts";

const FAILED_OUTCOME = new Set(["failed", "escalated", "denied"]);
const TREND_BUCKETS = 12;

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function p50(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function uniqueCapped(values: string[], cap = 12): string[] {
  return [...new Set(values)].slice(0, cap);
}
function countBy<T>(items: T[], key: (t: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) { const k = key(it); if (k != null) out[k] = (out[k] ?? 0) + 1; }
  return out;
}

export function deriveInsights(step: StepMetrics): string[] {
  const out: string[] = [];
  // I4a — false confidence: passes but the oracle is inadequate.
  if (step.quality.verdictPassRate >= 0.8 && step.quality.oracleSufficientRate < 0.5) {
    out.push("Passes, but the oracle is inadequate — verified output may not be the full specification.");
  }
  // I4b — cost without verification gain.
  if ((step.cost.meanTokens ?? 0) > 0 && (step.score ?? 0) < 70 && (step.cost.meanTokens ?? 0) >= 4000) {
    out.push("High token cost with low verification gain.");
  }
  // I4c — loop / churn.
  if ((step.cost.meanRetries ?? 0) >= 1.5) {
    out.push("Loops between failed strategies — high retry churn.");
  }
  return out;
}

export function computeStepMetrics(input: {
  transitions: TemplateTransition[];
  stepRuns: TemplateStepRun[];
  stepNames: Map<string, { name: string; ordinal: number }>;
  nowIso: string;
  period: MetricPeriod;
}): StepMetrics[] {
  const byStep = new Map<string, TemplateTransition[]>();
  for (const t of input.transitions) {
    if (!t.stepTemplateId) continue;
    (byStep.get(t.stepTemplateId) ?? byStep.set(t.stepTemplateId, []).get(t.stepTemplateId)!).push(t);
  }
  const runsByStep = new Map<string, TemplateStepRun[]>();
  for (const r of input.stepRuns) {
    (runsByStep.get(r.stepTemplateId) ?? runsByStep.set(r.stepTemplateId, []).get(r.stepTemplateId)!).push(r);
  }

  const sinceIso = windowStart(input.nowIso, input.period);
  const sinceMs = new Date(sinceIso).getTime();
  const spanMs = new Date(input.nowIso).getTime() - sinceMs;

  const steps: StepMetrics[] = [];
  for (const [stepTemplateId, ts] of byStep) {
    const meta = input.stepNames.get(stepTemplateId) ?? { name: stepTemplateId, ordinal: 999 };
    const stepRuns = runsByStep.get(stepTemplateId) ?? [];
    const completes = ts.filter((t) => t.transition.boundary === "step_complete" && t.transition.evidence);
    const verification = dimsFromTransitions(ts).verification_strength.value ?? 0;

    // CHANNEL 1 — quality / scope.
    const verdictPassRate = completes.length === 0 ? 0 :
      completes.filter((t) => t.transition.evidence!.verdict === "passed").length / completes.length;
    const allSensors = completes.flatMap((t) => t.transition.evidence!.sensorsRun);
    const sensorPassRate = allSensors.length === 0 ? 1 :
      allSensors.filter((s) => s.result === "passed").length / allSensors.length;
    const oracleSufficientRate = completes.length === 0 ? 0 :
      completes.filter((t) => t.transition.evidence!.oracleAdequacy.sufficient).length / completes.length;

    // CHANNEL 2 — cost / trajectory.
    const latencies = ts.map((t) => t.transition.telemetry?.latency_ms).filter((x): x is number => typeof x === "number");
    const tokens = ts.map((t) => t.transition.telemetry?.cost).filter((c): c is NonNullable<typeof c> => c != null)
      .map((c) => c.tokens_in + c.tokens_out);
    const usds = ts.map((t) => t.transition.telemetry?.cost?.usd).filter((x): x is number => typeof x === "number");
    const finals = (() => {
      const byKey = new Map<string, TemplateStepRun>();
      for (const r of stepRuns) {
        const k = r.workflowRunId; const prev = byKey.get(k);
        if (!prev || r.attempt > prev.attempt) byKey.set(k, r);
      }
      return [...byKey.values()];
    })();
    const meanRetries = finals.length === 0 ? null : mean(finals.map((r) => r.attempt - 1));

    // CHANNEL 3 — risk / boundary.
    const riskTs = ts.filter((t) => t.transition.risk);
    const riskClassDist = countBy(riskTs, (t) => t.transition.risk!.risk_class);
    const gateDecisionDist = countBy(riskTs, (t) => t.transition.risk!.gate_decision);
    const hardConstraintViolations = riskTs.reduce((n, t) => n + t.transition.risk!.hard_constraint_violations.length, 0);
    const approvalTs = riskTs.filter((t) => t.transition.risk!.approval);
    const approvals = { count: approvalTs.length, sampleTransitionIds: approvalTs.slice(0, 3).map((t) => t.transition.id) };

    // Failure clusters (categorical, deterministic).
    const failedTs = ts.filter((t) => FAILED_OUTCOME.has(t.transition.telemetry?.outcome.status ?? ""));
    const clusterMap = new Map<string, { failureCode: string | null; boundary: string; ids: string[] }>();
    for (const t of failedTs) {
      const fc = t.transition.telemetry!.outcome.failure_code;
      const key = `${fc ?? "null"}::${t.transition.boundary}`;
      const entry = clusterMap.get(key) ?? { failureCode: fc, boundary: t.transition.boundary, ids: [] };
      entry.ids.push(t.transition.id);
      clusterMap.set(key, entry);
    }
    const failureClusters = [...clusterMap.values()]
      .map((c) => ({ failureCode: c.failureCode, boundary: c.boundary, count: c.ids.length, sampleTransitionIds: c.ids.slice(0, 3) }))
      .sort((a, b) => b.count - a.count);

    // Counts.
    const passedFirstTry = finals.filter((r) => r.attempt === 1 && r.status === "passed").length;
    const recovered = finals.filter((r) => r.attempt > 1 && r.status === "passed").length;
    const failed = finals.filter((r) => FAILED_STATUSES.has(r.status)).length;
    const sampleSize = Math.max(finals.length, completes.length);

    // Trend (bucketed verification strength) + version boundaries.
    const trend: number[] = [];
    const versionBoundaries: number[] = [];
    if (sampleSize >= SAMPLE_MIN && spanMs > 0) {
      let lastVersion: number | null = null;
      for (let i = 0; i < TREND_BUCKETS; i++) {
        const lo = sinceMs + (spanMs * i) / TREND_BUCKETS;
        const hi = sinceMs + (spanMs * (i + 1)) / TREND_BUCKETS;
        const bucket = completes.filter((t) => {
          const at = new Date(t.transition.createdAt).getTime();
          return at >= lo && at < hi;
        });
        if (bucket.length > 0) {
          trend.push(Math.round((dimsFromTransitions(bucket).verification_strength.value ?? 0) * 100));
          const v = bucket[bucket.length - 1].templateVersion;
          if (lastVersion !== null && v !== lastVersion) versionBoundaries.push(i);
          lastVersion = v;
        } else {
          trend.push(trend.length > 0 ? trend[trend.length - 1] : 0);
        }
      }
    }

    // Recent raw reasons (full-fidelity tail) from step-run blocked_reason.
    const recentReasons = [...stepRuns]
      .filter((r) => r.blockedReason)
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
      .slice(0, 5)
      .map((r) => ({ at: r.finishedAt ?? r.startedAt ?? "", reason: r.blockedReason! }));

    const step: StepMetrics = {
      stepTemplateId, name: meta.name, ordinal: meta.ordinal,
      score: Math.round(verification * 100), sampleSize, confidence: sampleSize < SAMPLE_MIN ? "low" : "ok",
      runs: finals.length, passedFirstTry, recovered, failed,
      quality: {
        verdictPassRate, sensorPassRate, oracleSufficientRate,
        untestedRegions: uniqueCapped(completes.flatMap((t) => t.transition.evidence!.untestedRegions)),
        residualRisk: uniqueCapped(completes.flatMap((t) => t.transition.evidence!.residualRisk)),
        oracleGaps: uniqueCapped(completes.flatMap((t) => t.transition.evidence!.oracleAdequacy.gaps)),
        limitingDimension: null,
      },
      cost: { p50LatencyMs: p50(latencies), meanTokens: mean(tokens), meanUsd: mean(usds), meanRetries },
      risk: { riskClassDist, gateDecisionDist, hardConstraintViolations, approvals },
      failureClusters, trend, versionBoundaries, insights: [], recentReasons,
    };
    step.insights = deriveInsights(step);
    steps.push(step);
  }
  return steps.sort((a, b) => a.ordinal - b.ordinal);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/metrics/aggregate.steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/aggregate.steps.test.ts
git commit -m "feat(daemon): per-step metrics, failure clusters, scope, insights"
```

---

### Task 6: Usecases + routes + server registration

Wire fetch + aggregate into two endpoints and register them.

**Files:**
- Create: `apps/daemon/src/metrics/usecases.ts`
- Create: `apps/daemon/src/metrics/routes.ts`
- Modify: `apps/daemon/src/server.ts`
- Test: `apps/daemon/src/metrics/routes.test.ts`

**Interfaces:**
- Consumes: Task 3 fetch fns, Task 4/5 aggregate fns, `MetricPeriod`.
- Produces:
  - `getTemplateMetricsSummaries(db, period, nowIso?): TemplateMetricsSummary[]`
  - `getTemplateMetricsDetail(db, templateId, period, nowIso?): TemplateMetricsDetail | null` (null = unknown template)
  - `registerMetricsRoutes(server, { db })`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/metrics/routes.test.ts` (reuse the seeding helpers; full file):

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { registerMetricsRoutes } from "./routes.js";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-metrics-routes-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
function seed(db: Database.Database) {
  db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at)
              VALUES ('g','G','','active',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`).run();
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
              VALUES ('tpl','Brainstorm','',1,1,0,'[{"id":"define-intent","name":"Define Intent"}]','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_runs (id,goal_id,template_id,template_version,status,current_step_run_id,blocked_reason,started_at,finished_at)
              VALUES ('run1','g','tpl',1,'completed',NULL,NULL,'2026-05-01T00:00:00.000Z','2026-05-01T01:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_step_runs (id,goal_id,workflow_run_id,step_template_id,ordinal,attempt,status,satisfied_exit_criteria_json,outstanding_exit_criteria_json,blocked_reason,started_at,finished_at,fingerprint)
              VALUES ('sr1','g','run1','define-intent',0,1,'passed','[]','[]',NULL,'2026-05-01T00:00:00.000Z','2026-05-01T00:10:00.000Z','fp1')`).run();
  db.prepare(`INSERT INTO harness_transitions (id,goal_id,workflow_run_id,workflow_step_run_id,boundary,risk_json,evidence_json,state_deps_json,telemetry_json,created_at)
              VALUES ('ht1','g','run1','sr1','step_complete',NULL,
                '{"sensorsRun":[],"verdict":"passed","untestedRegions":[],"residualRisk":[],"oracleAdequacy":{"sufficient":true,"gaps":[]}}',NULL,
                '{"cost":null,"latency_ms":100,"model":null,"provider_id":null,"provider_version":null,"prompt_ref":null,"raw_output_ref":null,"rejected_alternatives":[],"human_interventions":[],"outcome":{"status":"succeeded","failure_code":null}}',
                '2026-05-01T00:10:00.000Z')`).run();
}

afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("metrics routes", () => {
  it("GET /v1/metrics/templates returns a summary array", async () => {
    const db = openTestDb(); seed(db);
    const f = Fastify(); registerMetricsRoutes(f, { db });
    const res = await f.inject({ method: "GET", url: "/v1/metrics/templates?period=30d" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { summaries: Array<{ templateId: string }> };
    expect(body.summaries.map((s) => s.templateId)).toContain("tpl");
  });

  it("GET /v1/metrics/templates/:id returns detail with steps", async () => {
    const db = openTestDb(); seed(db);
    const f = Fastify(); registerMetricsRoutes(f, { db });
    const res = await f.inject({ method: "GET", url: "/v1/metrics/templates/tpl?period=30d" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { detail: { steps: Array<{ name: string }> } };
    expect(body.detail.steps.map((s) => s.name)).toContain("Define Intent");
  });

  it("400 on invalid period", async () => {
    const db = openTestDb(); seed(db);
    const f = Fastify(); registerMetricsRoutes(f, { db });
    const res = await f.inject({ method: "GET", url: "/v1/metrics/templates?period=1y" });
    expect(res.statusCode).toBe(400);
  });

  it("404 on unknown template", async () => {
    const db = openTestDb(); seed(db);
    const f = Fastify(); registerMetricsRoutes(f, { db });
    const res = await f.inject({ method: "GET", url: "/v1/metrics/templates/nope?period=7d" });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/metrics/routes.test.ts`
Expected: FAIL — `./routes.js` not found.

- [ ] **Step 3: Write usecases**

Create `apps/daemon/src/metrics/usecases.ts`:

```typescript
import type Database from "better-sqlite3";
import type { MetricPeriod, TemplateMetricsDetail, TemplateMetricsSummary } from "@orca/contracts";
import { listStepRunsByTemplate, listTemplatesWithRuns, listTransitionsByTemplate } from "./fetch.js";
import { computeStepMetrics, computeTemplateSummary, windowStart } from "./aggregate.js";

function nowOr(nowIso?: string): string {
  return nowIso ?? new Date().toISOString();
}

interface RunRow { template_version: number; started_at: string }

function versionsInWindow(db: Database.Database, templateId: string, sinceIso: string, untilIso: string) {
  const rows = db.prepare(
    `SELECT template_version, started_at FROM workflow_runs
     WHERE template_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at ASC`
  ).all(templateId, sinceIso, untilIso) as RunRow[];
  const byVersion = new Map<number, { version: number; runs: number; firstSeenAt: string }>();
  for (const r of rows) {
    const v = byVersion.get(r.template_version);
    if (v) v.runs += 1;
    else byVersion.set(r.template_version, { version: r.template_version, runs: 1, firstSeenAt: r.started_at });
  }
  return { runCount: rows.length, versions: [...byVersion.values()].sort((a, b) => b.version - a.version) };
}

function buildSummary(db: Database.Database, t: { templateId: string; name: string; latestVersion: number }, period: MetricPeriod, nowIso: string): TemplateMetricsSummary {
  const until = nowIso;
  const since = windowStart(nowIso, period);
  const priorUntil = since;
  const priorSince = windowStart(since, period);
  const { runCount, versions } = versionsInWindow(db, t.templateId, since, until);
  return computeTemplateSummary({
    templateId: t.templateId, name: t.name, latestVersion: t.latestVersion, runCount, versions,
    current: {
      transitions: listTransitionsByTemplate(db, t.templateId, since, until),
      stepRuns: listStepRunsByTemplate(db, t.templateId, since, until),
    },
    prior: {
      transitions: listTransitionsByTemplate(db, t.templateId, priorSince, priorUntil),
      stepRuns: listStepRunsByTemplate(db, t.templateId, priorSince, priorUntil),
    },
  });
}

export function getTemplateMetricsSummaries(db: Database.Database, period: MetricPeriod, nowIso?: string): TemplateMetricsSummary[] {
  const now = nowOr(nowIso);
  return listTemplatesWithRuns(db).map((t) => buildSummary(db, t, period, now));
}

interface StepDef { id: string; name: string }

function stepNames(db: Database.Database, templateId: string): Map<string, { name: string; ordinal: number }> {
  const row = db.prepare(`SELECT steps_json FROM workflow_templates WHERE id = ?`).get(templateId) as { steps_json: string } | undefined;
  const map = new Map<string, { name: string; ordinal: number }>();
  if (!row) return map;
  const defs = JSON.parse(row.steps_json) as StepDef[];
  defs.forEach((d, i) => map.set(d.id, { name: d.name ?? d.id, ordinal: i }));
  return map;
}

export function getTemplateMetricsDetail(db: Database.Database, templateId: string, period: MetricPeriod, nowIso?: string): TemplateMetricsDetail | null {
  const now = nowOr(nowIso);
  const info = listTemplatesWithRuns(db).find((t) => t.templateId === templateId);
  if (!info) return null;
  const since = windowStart(now, period);
  return {
    summary: buildSummary(db, info, period, now),
    steps: computeStepMetrics({
      transitions: listTransitionsByTemplate(db, templateId, since, now),
      stepRuns: listStepRunsByTemplate(db, templateId, since, now),
      stepNames: stepNames(db, templateId),
      nowIso: now, period,
    }),
  };
}
```

- [ ] **Step 4: Write routes**

Create `apps/daemon/src/metrics/routes.ts`:

```typescript
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { MetricPeriod } from "@orca/contracts";
import { getTemplateMetricsDetail, getTemplateMetricsSummaries } from "./usecases.js";

export interface MetricsRouteDeps { db: Database.Database }

export function registerMetricsRoutes(server: FastifyInstance, deps: MetricsRouteDeps): void {
  const { db } = deps;

  server.get("/v1/metrics/templates", async (request, reply) => {
    const period = MetricPeriod.safeParse((request.query as { period?: string }).period);
    if (!period.success) {
      reply.status(400);
      return { error: { code: "invalid_period", message: "period must be one of 24h, 7d, 30d" } };
    }
    return { summaries: getTemplateMetricsSummaries(db, period.data) };
  });

  server.get("/v1/metrics/templates/:templateId", async (request, reply) => {
    const period = MetricPeriod.safeParse((request.query as { period?: string }).period);
    if (!period.success) {
      reply.status(400);
      return { error: { code: "invalid_period", message: "period must be one of 24h, 7d, 30d" } };
    }
    const { templateId } = request.params as { templateId: string };
    const detail = getTemplateMetricsDetail(db, templateId, period.data);
    if (!detail) {
      reply.status(404);
      return { error: { code: "template_not_found", message: `Template not found or has no runs: ${templateId}` } };
    }
    return { detail };
  });
}
```

- [ ] **Step 5: Register in server.ts**

In `apps/daemon/src/server.ts`, add an import next to the other harness imports (near line 184):

```typescript
import { registerMetricsRoutes } from './metrics/routes.js';
```

And next to the `registerHarnessMetricsRoutes(server, { db });` call (line ~2200) add:

```typescript
  registerMetricsRoutes(server, { db });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/metrics/routes.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/metrics/usecases.ts apps/daemon/src/metrics/routes.ts apps/daemon/src/server.ts apps/daemon/src/metrics/routes.test.ts
git commit -m "feat(daemon): /v1/metrics/templates endpoints"
```

---

### Task 7: Desktop API client

Add the two fetch functions.

**Files:**
- Modify: `apps/desktop/src/api.ts`
- Test: `apps/desktop/src/api.metrics.test.ts`

**Interfaces:**
- Consumes: `TemplateMetricsSummary`, `TemplateMetricsDetail`, `MetricPeriod` from `@orca/contracts`.
- Produces:
  - `getTemplateMetricsSummaries(period: MetricPeriod): Promise<TemplateMetricsSummary[]>`
  - `getTemplateMetricsDetail(templateId: string, period: MetricPeriod): Promise<TemplateMetricsDetail>`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/api.metrics.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTemplateMetricsSummaries } from "./api";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("getTemplateMetricsSummaries", () => {
  it("requests the templates endpoint with the period and returns summaries", async () => {
    const summaries = [{
      templateId: "tpl", name: "Brainstorm", latestVersion: 1, runs: 3,
      dimensions: {
        trajectoryEfficiency: { value: null }, verificationStrength: { value: 0.8 },
        recovery: { value: null }, stateConsistency: { value: 1 },
        safetyCompliance: { value: 1 }, replayability: { value: 1 },
      },
      firstPass: null, recovered: null, escalated: null,
      latencyP50Ms: null,
      deltas: { trajectoryEfficiency: null, verificationStrength: null, recovery: null,
                stateConsistency: null, safetyCompliance: null, replayability: null, latencyP50Ms: null },
      versionComparison: null, versions: [], confidence: "low",
    }];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ summaries }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getTemplateMetricsSummaries("7d");
    expect(result[0].templateId).toBe("tpl");
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/metrics/templates?period=7d");
  });
});
```

Note: `loadConfig()` reads the daemon endpoint; in the non-Tauri test path it falls back to `VITE_ORCA_BASE_URL`/localhost. If the test environment makes `loadConfig` throw, wrap the assertion to stub it — but the existing api tests in this repo already exercise `fetch`-level mocks, so follow the closest existing example in `apps/desktop/src/*.test.ts*` for stubbing `loadConfig` if needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/api.metrics.test.ts`
Expected: FAIL — `getTemplateMetricsSummaries` not exported.

- [ ] **Step 3: Add the client functions**

Add near the other list functions in `apps/desktop/src/api.ts`. First add the imports to the existing `@orca/contracts` import block:

```typescript
  TemplateMetricsSummary,
  TemplateMetricsDetail,
  type MetricPeriod,
```

Then add the functions (use the established `loadConfig`/`authHeaders` pattern; parse arrays/objects with zod):

```typescript
export async function getTemplateMetricsSummaries(period: MetricPeriod): Promise<TemplateMetricsSummary[]> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/metrics/templates?period=${period}`, { headers: authHeaders(token) });
  const body = await parseResponse(res, z.object({ summaries: z.array(TemplateMetricsSummary) }));
  return body.summaries;
}

export async function getTemplateMetricsDetail(templateId: string, period: MetricPeriod): Promise<TemplateMetricsDetail> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/metrics/templates/${encodeURIComponent(templateId)}?period=${period}`, { headers: authHeaders(token) });
  const body = await parseResponse(res, z.object({ detail: TemplateMetricsDetail }));
  return body.detail;
}
```

If `z` is not already imported in `api.ts`, add `import { z } from "zod";` at the top.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/api.metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/api.metrics.test.ts
git commit -m "feat(desktop): metrics API client functions"
```

---

### Task 8: Desktop data mapper (presentation-only)

Replace the mock in `metrics-data.ts` with a presentation-only mapper from the contract types to the view types the components consume. No arithmetic (F4).

**Files:**
- Modify: `apps/desktop/src/metrics/metrics-data.ts`
- Test: `apps/desktop/src/metrics/metrics-data.test.ts` (rewrite the mock-dependent cases)

**Interfaces:**
- Consumes: `TemplateMetricsSummary`, `StepMetrics`, `TemplateMetricsDetail`.
- Produces (view types, keep names the components already import):
  - `WorkflowSummaryView` — `{ id, name, runs, confidence, health, firstPassPct, recoveredPct, escalatedPct, latencyLabel }` (health = `verificationStrength*100` rounded; pct fields formatted server values).
  - Keep `statusMeta` and `gradeFor` exports unchanged.
  - `toStepView(step: StepMetrics)` → the shape `StepRow` renders (Task 9/10 consume).

Because this is a pure presentation reshape and the component contracts are settled in Tasks 9–10, define the view types as a thin pass-through: expose the contract `StepMetrics`/`TemplateMetricsSummary` directly and add only formatting helpers. Concretely:

- [ ] **Step 1: Write the failing test**

Replace the body of `apps/desktop/src/metrics/metrics-data.test.ts` with:

```typescript
import { describe, expect, it } from "vitest";
import { gradeFor, healthOf, pctLabel } from "./metrics-data";
import type { TemplateMetricsSummary } from "@orca/contracts";

describe("metrics-data formatting helpers", () => {
  it("gradeFor maps scores to letters", () => {
    expect(gradeFor(95)).toBe("A");
    expect(gradeFor(61)).toBe("D");
    expect(gradeFor(40)).toBe("F");
  });

  it("healthOf reads verificationStrength as a 0..100 health", () => {
    const summary = { dimensions: { verificationStrength: { value: 0.82 } } } as TemplateMetricsSummary;
    expect(healthOf(summary)).toBe(82);
  });

  it("pctLabel renders a 0..1 metric as a percentage, or — when null", () => {
    expect(pctLabel({ value: 0.64 })).toBe("64%");
    expect(pctLabel({ value: null })).toBe("—");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/metrics/metrics-data.test.ts`
Expected: FAIL — `healthOf`/`pctLabel` not exported.

- [ ] **Step 3: Rewrite `metrics-data.ts`**

Replace the entire contents of `apps/desktop/src/metrics/metrics-data.ts` with the presentation-only module (delete the `WORKFLOW_METRICS`/`LEARNING_LOG` mock arrays and `getWorkflowMetrics`/`getLearningLog`):

```typescript
// Presentation-only helpers for the Metrics tab. All numbers are computed server-side
// (F4); this module only formats them. Re-exports the contract types the views consume.
import type { Metric, StepMetrics, TemplateMetricsSummary } from "@orca/contracts";

export type { StepMetrics, TemplateMetricsSummary } from "@orca/contracts";

export type StepStatus = "healthy" | "watch" | "degraded";

export const statusMeta: Record<StepStatus, { tone: "run" | "warn" | "err"; color: string; label: string }> = {
  healthy: { tone: "run", color: "var(--run)", label: "Healthy" },
  watch: { tone: "warn", color: "var(--warn)", label: "Watch" },
  degraded: { tone: "err", color: "var(--err)", label: "Degraded" },
};

export function gradeFor(score: number): "A" | "B" | "C" | "D" | "F" {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
}

export function statusForScore(score: number): StepStatus {
  return score >= 80 ? "healthy" : score >= 70 ? "watch" : "degraded";
}

export function healthOf(summary: TemplateMetricsSummary): number {
  return Math.round((summary.dimensions.verificationStrength.value ?? 0) * 100);
}

export function pctLabel(m: Metric): string {
  return m.value == null ? "—" : `${Math.round(m.value * 100)}%`;
}

export function latencyLabel(ms: number | null): string {
  return ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/metrics/metrics-data.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics/metrics-data.ts apps/desktop/src/metrics/metrics-data.test.ts
git commit -m "feat(desktop): presentation-only metrics-data mapper (remove mock)"
```

---

### Task 8b: Update charts/types consumers to compile

Removing the mock breaks imports in the chart/step/rail components. This task only fixes type wiring so the project compiles; behavior lands in Tasks 9–11.

**Files:**
- Modify: `apps/desktop/src/metrics/metrics-charts.tsx` (and any file importing removed names)

**Interfaces:**
- Consumes: the new exports from Task 8.

- [ ] **Step 1: Find broken imports**

Run: `cd apps/desktop && pnpm tsc --noEmit 2>&1 | head -40`
Expected: errors referencing `WorkflowMetrics`, `StepMetrics.failures`, `getWorkflowMetrics`, `getLearningLog`, `Proposal`, `LearningLogEntry`.

- [ ] **Step 2: Triage**

For each error, the fix is one of: (a) replace `WorkflowMetrics`→`TemplateMetricsSummary`, (b) replace `StepMetrics` (old) usages with the contract `StepMetrics`, (c) delete proposal/learning-log usages now owned by Tasks 10–11. Defer (c) by leaving the components compiling against empty/placeholder data — full behavior is Tasks 9–11. Do not implement features here; only restore compilation.

This task is a checkpoint: it has no new test. Its deliverable is `pnpm tsc --noEmit` passing for files **not** owned by Tasks 9–11, with the Task 9–11 files stubbed minimally to compile.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/metrics/
git commit -m "chore(desktop): restore metrics compilation after mock removal"
```

---

### Task 9: MetricsPage — fetch hook + four states

**Files:**
- Modify: `apps/desktop/src/metrics/MetricsPage.tsx`
- Test: `apps/desktop/src/metrics/MetricsPage.test.tsx` (rewrite)

**Interfaces:**
- Consumes: `getTemplateMetricsSummaries`, `getTemplateMetricsDetail` (Task 7); `healthOf`, `pctLabel`, `latencyLabel`, `gradeFor` (Task 8).

- [ ] **Step 1: Write the failing test**

Replace `apps/desktop/src/metrics/MetricsPage.test.tsx` with:

```typescript
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricsPage } from "./MetricsPage";
import * as api from "../api";

afterEach(() => vi.restoreAllMocks());

const summary = {
  templateId: "tpl", name: "Brainstorm", latestVersion: 1, runs: 12,
  dimensions: { trajectoryEfficiency: { value: null }, verificationStrength: { value: 0.82 },
    recovery: { value: 0.28 }, stateConsistency: { value: 1 }, safetyCompliance: { value: 0.92 }, replayability: { value: 1 } },
  firstPass: 0.64, recovered: 0.28, escalated: 0.08,
  latencyP50Ms: 2400,
  deltas: { trajectoryEfficiency: null, verificationStrength: 0.04, recovery: 0.05,
    stateConsistency: 0, safetyCompliance: -0.03, replayability: 0, latencyP50Ms: -300 },
  versionComparison: null, versions: [{ version: 1, runs: 12, firstSeenAt: "2026-05-01T00:00:00.000Z" }], confidence: "ok" as const,
};

describe("MetricsPage", () => {
  it("shows a loading state then renders the health tile", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([summary]);
    vi.spyOn(api, "getTemplateMetricsDetail").mockResolvedValue({ summary, steps: [] });
    render(<MetricsPage />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Workflow health")).toBeInTheDocument());
    expect(screen.getByText("Brainstorm")).toBeInTheDocument();
  });

  it("shows the empty state when no templates have runs", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([]);
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText(/Run a workflow to see metrics/i)).toBeInTheDocument());
  });

  it("shows an error state on fetch failure", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockRejectedValue(new Error("boom"));
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText(/Couldn't load metrics/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/metrics/MetricsPage.test.tsx`
Expected: FAIL (loading/empty/error text absent).

- [ ] **Step 3: Rewrite `MetricsPage.tsx`**

Replace the contents with a data-driven page (preserve the existing layout/style tokens; swap the mock for fetch state):

```tsx
import { useEffect, useState } from "react";
import type { TemplateMetricsSummary, TemplateMetricsDetail } from "@orca/contracts";
import { getTemplateMetricsSummaries, getTemplateMetricsDetail } from "../api";
import { gradeFor, healthOf } from "./metrics-data";
import { StatTile } from "./metrics-charts";
import { StepPerformancePanel, WorkflowDropdown } from "./StepPerformance";
import { SelfImprovementRail } from "./SelfImprovement";
import { Workflow } from "./metrics-icons";

const PERIODS = ["24h", "7d", "30d"] as const;
type Period = (typeof PERIODS)[number];

export function MetricsPage() {
  const [period, setPeriod] = useState<Period>("7d");
  const [summaries, setSummaries] = useState<TemplateMetricsSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [wfId, setWfId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TemplateMetricsDetail | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    setSummaries(null); setError(false);
    getTemplateMetricsSummaries(period)
      .then((s) => { if (!live) return; setSummaries(s); setWfId((cur) => cur ?? s[0]?.templateId ?? null); })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [period, reloadKey]);

  useEffect(() => {
    if (!wfId) { setDetail(null); return; }
    let live = true;
    getTemplateMetricsDetail(wfId, period).then((d) => { if (live) setDetail(d); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [wfId, period, reloadKey]);

  if (error) {
    return <CenterNote>Couldn't load metrics. <button type="button" onClick={() => setReloadKey((k) => k + 1)} style={linkBtn}>Retry</button></CenterNote>;
  }
  if (summaries === null) return <CenterNote>Loading metrics…</CenterNote>;
  if (summaries.length === 0) return <CenterNote>Run a workflow to see metrics.</CenterNote>;

  const wf = summaries.find((s) => s.templateId === wfId) ?? summaries[0];
  const health = healthOf(wf);
  const healthColor = health >= 80 ? "var(--run)" : health >= 70 ? "var(--warn)" : "var(--err)";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 12, padding: 12, height: "100%", minHeight: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <Workflow size={14} color="var(--text-3)" />
          <span className="mono" style={{ fontSize: 10.5, letterSpacing: 1.1, textTransform: "uppercase", color: "var(--text-3)", marginRight: 2 }}>Workflow</span>
          <WorkflowDropdown summaries={summaries} value={wf.templateId} onChange={(id) => { setWfId(id); setOpenStep(null); }} />
          <div style={{ flex: 1 }} />
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="mono" style={linkBtn}>Refresh</button>
          <div style={{ display: "flex", background: "rgba(255,255,255,0.03)", border: "1px solid var(--hairline)", borderRadius: 8, padding: 2 }}>
            {PERIODS.map((p) => (
              <button key={p} type="button" onClick={() => setPeriod(p)} className="mono"
                style={{ background: period === p ? "rgba(255,255,255,0.08)" : "transparent", color: period === p ? "var(--text)" : "var(--text-3)", border: "none", borderRadius: 6, padding: "4px 9px", cursor: "pointer", fontSize: 11 }}>
                {p}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexShrink: 0, opacity: wf.confidence === "low" ? 0.55 : 1 }}>
          <StatTile label="Workflow health" value={health} accent={healthColor} grade={gradeFor(health)} delta={pctDelta(wf.deltas.verificationStrength)} deltaGood="up" />
          <StatTile label="First-pass" value={rate(wf.firstPass)} unit="%" />
          <StatTile label="Self-recovered" value={rate(wf.recovered)} unit="%" accent="var(--warn)" />
          <StatTile label="Escalated" value={rate(wf.escalated)} unit="%" accent="var(--err)" />
        </div>

        <StepPerformancePanel detail={detail} loading={detail === null} openStep={openStep} onToggleStep={(name) => setOpenStep((o) => (o === name ? null : name))} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <SelfImprovementRail detail={detail} workflowName={wf.name} />
      </div>
    </div>
  );
}

const linkBtn: React.CSSProperties = { background: "transparent", color: "var(--accent)", border: "none", cursor: "pointer", fontSize: 11, padding: "4px 6px" };
function rate(r: number | null): number { return r == null ? 0 : Math.round(r * 100); }
function pctDelta(d: number | null): number { return d == null ? 0 : Math.round(d * 100); }
function CenterNote({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-3)", fontSize: 13 }}>{children}</div>;
}
```

The `StatTile` props used here (`label`, `value`, `unit?`, `accent?`, `grade?`, `delta?`, `deltaGood?`) already exist in `metrics-charts.tsx`. If `StatTile` previously required a `spark`/`sparkColor` prop, make them optional in `metrics-charts.tsx` (omit the sparkline when absent) as part of this step.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/metrics/MetricsPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics/MetricsPage.tsx apps/desktop/src/metrics/MetricsPage.test.tsx apps/desktop/src/metrics/metrics-charts.tsx
git commit -m "feat(desktop): MetricsPage real data fetch with loading/empty/error states"
```

---

### Task 10: StepPerformance — dropdown, rows, scope, insights, clusters, drill-through

**Files:**
- Modify: `apps/desktop/src/metrics/StepPerformance.tsx`
- Test: `apps/desktop/src/metrics/StepPerformance.test.tsx` (rewrite)

**Interfaces:**
- Consumes: `TemplateMetricsSummary`, `TemplateMetricsDetail`, `StepMetrics`; `statusForScore`, `statusMeta`, `gradeFor`, `latencyLabel`.
- Produces: `WorkflowDropdown({ summaries, value, onChange })`, `StepPerformancePanel({ detail, loading, openStep, onToggleStep })`.

- [ ] **Step 1: Write the failing test**

Replace `apps/desktop/src/metrics/StepPerformance.test.tsx` with:

```typescript
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepPerformancePanel } from "./StepPerformance";
import type { TemplateMetricsDetail, StepMetrics } from "@orca/contracts";

const step: StepMetrics = {
  stepTemplateId: "verify", name: "Verify Proposal", ordinal: 3,
  score: 61, sampleSize: 20, confidence: "ok",
  runs: 20, passedFirstTry: 8, recovered: 6, failed: 6,
  quality: { verdictPassRate: 0.6, sensorPassRate: 0.7, oracleSufficientRate: 0.3,
    untestedRegions: ["proration edge"], residualRisk: ["rounding drift"], oracleGaps: ["no e2e"], limitingDimension: null },
  cost: { p50LatencyMs: 3000, meanTokens: 5000, meanUsd: 0.05, meanRetries: 1.6 },
  risk: { riskClassDist: { medium: 12 }, gateDecisionDist: { allow: 18, require_approval: 2 },
    hardConstraintViolations: 3, approvals: { count: 2, sampleTransitionIds: ["t1", "t2"] } },
  failureClusters: [{ failureCode: "invalid_output", boundary: "step_complete", count: 4, sampleTransitionIds: ["a"] }],
  trend: [], versionBoundaries: [], insights: ["Loops between failed strategies — high retry churn."],
  recentReasons: [{ at: "2026-05-01T00:00:00.000Z", reason: "constraint X violated" }],
};

const detail = { summary: { name: "Brainstorm" }, steps: [step] } as unknown as TemplateMetricsDetail;

describe("StepPerformancePanel", () => {
  it("renders a step row with its score and expands to show scope + clusters + insights", () => {
    render(<StepPerformancePanel detail={detail} loading={false} openStep="Verify Proposal" onToggleStep={() => {}} />);
    expect(screen.getByText("Verify Proposal")).toBeInTheDocument();
    expect(screen.getByText("61")).toBeInTheDocument();
    expect(screen.getByText(/invalid_output/)).toBeInTheDocument();
    expect(screen.getByText(/proration edge/)).toBeInTheDocument(); // untested region scope
    expect(screen.getByText(/Loops between failed strategies/)).toBeInTheDocument(); // insight
  });

  it("renders an empty step state when there are no steps", () => {
    render(<StepPerformancePanel detail={{ summary: { name: "X" }, steps: [] } as unknown as TemplateMetricsDetail} loading={false} openStep={null} onToggleStep={() => {}} />);
    expect(screen.getByText(/No step activity/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/metrics/StepPerformance.test.tsx`
Expected: FAIL — panel props changed / new content absent.

- [ ] **Step 3: Rewrite `StepPerformance.tsx`**

Replace the file. Keep the existing visual primitives (`Pill`, `Panel`, `OutcomeBar`, `Sparkline`, `Delta`, icons). The dropdown now takes `summaries`; the row consumes the contract `StepMetrics`; the expanded panel shows clusters + scope + insights + approvals + recentReasons, with drill-through anchors for `sampleTransitionIds`. Full file:

```tsx
import { useEffect, useRef, useState } from "react";
import type { StepMetrics, TemplateMetricsDetail, TemplateMetricsSummary } from "@orca/contracts";
import { Pill } from "../workspaces/primitives";
import { gradeFor, latencyLabel, statusForScore, statusMeta } from "./metrics-data";
import { Delta, OutcomeBar, Panel, SectionLabel, Sparkline } from "./metrics-charts";
import { ChevronDown, ChevronRight, Sparkle, Workflow } from "./metrics-icons";

const GRID = "34px minmax(0,1fr) 88px 64px 22px";

export function WorkflowDropdown({ summaries, value, onChange }: { summaries: TemplateMetricsSummary[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = summaries.find((w) => w.templateId === value) ?? summaries[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 8, background: open ? "var(--accent-soft)" : "rgba(255,255,255,0.03)", border: `1px solid ${open ? "var(--accent-line)" : "var(--hairline)"}`, color: "var(--text)", borderRadius: 8, padding: "5px 9px 5px 11px", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 500, minWidth: 200 }}>
        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cur.name}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{cur.runs} runs</span>
        <ChevronDown size={13} color="var(--text-3)" style={{ transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      {open && (
        <div className="scroll" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 30, minWidth: 260, maxHeight: 320, overflow: "auto", background: "var(--panel)", border: "1px solid var(--hairline-strong)", borderRadius: 10, boxShadow: "0 16px 48px rgba(0,0,0,0.5)", padding: 4 }}>
          {summaries.map((w) => {
            const active = w.templateId === value;
            return (
              <button key={w.templateId} type="button" onClick={() => { onChange(w.templateId); setOpen(false); }}
                style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", background: active ? "var(--accent-soft)" : "transparent", border: "none", borderRadius: 7, padding: "8px 10px", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                <Workflow size={13} color={active ? "var(--accent)" : "var(--text-3)"} />
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, color: active ? "var(--accent)" : "var(--text)" }}>{w.name}</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{w.runs}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Chips({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-4)", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {items.map((t, i) => <span key={i} style={{ fontSize: 11, color: "var(--text-2)", background: "rgba(255,255,255,0.04)", border: "1px solid var(--hairline)", borderRadius: 6, padding: "2px 6px" }}>{t}</span>)}
      </div>
    </div>
  );
}

export function StepRow({ step, index, isLast, open, onToggle }: { step: StepMetrics; index: number; isLast: boolean; open: boolean; onToggle: () => void }) {
  const status = statusForScore(step.score);
  const m = statusMeta[status];
  const low = step.confidence === "low";
  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--hairline)", opacity: low ? 0.6 : 1 }}>
      <div onClick={onToggle} style={{ display: "grid", gridTemplateColumns: GRID, alignItems: "center", gap: 12, padding: "12px 14px", cursor: "pointer" }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, border: `1px solid ${m.color}`, background: `color-mix(in srgb, ${m.color} 12%, transparent)`, color: m.color, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 600 }}>
            {String(index + 1).padStart(2, "0")}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{step.name}</span>
            <Pill tone={m.tone} size="xs">{m.label}</Pill>
            {low && <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>n={step.sampleSize}</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
            <div style={{ flex: 1, maxWidth: 220 }}><OutcomeBar passed={step.passedFirstTry} recovered={step.recovered} failed={step.failed} /></div>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{step.runs} runs · {latencyLabel(step.cost.p50LatencyMs)}</span>
          </div>
        </div>
        {step.trend.length > 0 ? <Sparkline data={step.trend} color={m.color} w={84} h={26} /> : <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", textAlign: "center" }}>—</span>}
        <div style={{ textAlign: "right" }}>
          <span style={{ fontSize: 20, fontWeight: 600, color: m.color, letterSpacing: -0.5 }}>{step.score}</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-4)" }}>/100 {gradeFor(step.score)}</span>
        </div>
        <ChevronRight size={13} color="var(--text-3)" style={{ transform: open ? "rotate(90deg)" : "none", justifySelf: "center" }} />
      </div>
      {open && (
        <div style={{ padding: "2px 16px 16px 60px" }}>
          <div style={{ background: "var(--panel-2)", border: "1px solid var(--hairline)", borderRadius: 10, padding: 12 }}>
            <SectionLabel style={{ paddingTop: 0 }}>Failure modes</SectionLabel>
            {step.failureClusters.length === 0 && <div style={{ fontSize: 12, color: "var(--run)" }}>No failures recorded this period.</div>}
            {step.failureClusters.map((c, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: "var(--text-2)", padding: "3px 0" }}>
                <span>{c.failureCode ?? "unclassified"} <span className="mono" style={{ color: "var(--text-4)" }}>· {c.boundary}</span></span>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{c.count}×</span>
              </div>
            ))}

            <SectionLabel>Verification scope</SectionLabel>
            <div style={{ fontSize: 12, color: "var(--text-2)" }}>
              Verdict pass {Math.round(step.quality.verdictPassRate * 100)}% · sensors {Math.round(step.quality.sensorPassRate * 100)}% · oracle adequate {Math.round(step.quality.oracleSufficientRate * 100)}%
            </div>
            <Chips label="Untested regions" items={step.quality.untestedRegions} />
            <Chips label="Residual risk" items={step.quality.residualRisk} />
            <Chips label="Oracle gaps" items={step.quality.oracleGaps} />

            {step.risk.approvals.count > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-2)" }}>
                {step.risk.approvals.count} human approval(s) · {step.risk.hardConstraintViolations} hard-constraint violation(s)
              </div>
            )}

            {step.insights.length > 0 && (
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--hairline)" }}>
                {step.insights.map((t, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                    <Sparkle size={14} color="var(--accent-2)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>{t}</div>
                  </div>
                ))}
              </div>
            )}

            {step.recentReasons.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-4)", marginBottom: 4 }}>Recent reasons</div>
                {step.recentReasons.map((r, i) => <div key={i} style={{ fontSize: 11.5, color: "var(--text-3)", padding: "2px 0" }}>{r.reason}</div>)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function StepPerformancePanel({ detail, loading, openStep, onToggleStep }: { detail: TemplateMetricsDetail | null; loading: boolean; openStep: string | null; onToggleStep: (name: string) => void }) {
  const steps = detail?.steps ?? [];
  const attention = steps.filter((s) => statusForScore(s.score) !== "healthy").length;
  return (
    <Panel title="Step performance" kicker={(detail?.summary.name ?? "").toUpperCase()}
      right={<span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{attention > 0 ? `${attention} need attention` : "all healthy"}</span>}
      style={{ flex: 1, minHeight: 0 }} bodyStyle={{ padding: 0, display: "flex", flexDirection: "column" }}>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        {loading && <div style={{ padding: 16, color: "var(--text-3)", fontSize: 12 }}>Loading steps…</div>}
        {!loading && steps.length === 0 && <div style={{ padding: 16, color: "var(--text-3)", fontSize: 12 }}>No step activity in this period.</div>}
        {steps.map((s, i) => (
          <StepRow key={s.stepTemplateId} step={s} index={i} isLast={i === steps.length - 1} open={openStep === s.name} onToggle={() => onToggleStep(s.name)} />
        ))}
      </div>
    </Panel>
  );
}
```

If `SectionLabel` is not currently exported from `metrics-charts.tsx`, it is (it was imported by the old `StepPerformance.tsx`); keep that import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/metrics/StepPerformance.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics/StepPerformance.tsx apps/desktop/src/metrics/StepPerformance.test.tsx
git commit -m "feat(desktop): step rows with scope, clusters, insights, approvals"
```

---

### Task 11: SelfImprovement — deferred learning-loop state

The rail is B's territory. Render a deterministic header + an explicit deferred placeholder, and remove the auto-apply toggle.

**Files:**
- Modify: `apps/desktop/src/metrics/SelfImprovement.tsx`
- Test: `apps/desktop/src/metrics/SelfImprovement.test.tsx` (rewrite)

**Interfaces:**
- Consumes: `TemplateMetricsDetail`, `statusForScore`.
- Produces: `SelfImprovementRail({ detail, workflowName })`.

- [ ] **Step 1: Write the failing test**

Replace `apps/desktop/src/metrics/SelfImprovement.test.tsx` with:

```typescript
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelfImprovementRail } from "./SelfImprovement";
import type { TemplateMetricsDetail } from "@orca/contracts";

function detailWith(scores: number[]): TemplateMetricsDetail {
  return { summary: { name: "Brainstorm" }, steps: scores.map((score, i) => ({ stepTemplateId: `s${i}`, name: `Step ${i}`, score })) } as unknown as TemplateMetricsDetail;
}

describe("SelfImprovementRail", () => {
  it("summarizes underperforming steps deterministically", () => {
    render(<SelfImprovementRail detail={detailWith([95, 61, 58])} workflowName="Brainstorm" />);
    expect(screen.getByText(/2 steps underperforming/i)).toBeInTheDocument();
  });

  it("shows the deferred learning-loop state and no auto-apply toggle", () => {
    render(<SelfImprovementRail detail={detailWith([95])} workflowName="Brainstorm" />);
    expect(screen.getByText(/Learning loop not yet enabled/i)).toBeInTheDocument();
    expect(screen.queryByText(/Auto-apply/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/metrics/SelfImprovement.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Rewrite `SelfImprovement.tsx`**

Replace the file (drop `ProposalModal`, `ImprovementCard`, `LearningLogRow`, `AutoApplyToggle`, and the mock import):

```tsx
import type { TemplateMetricsDetail } from "@orca/contracts";
import { Panel } from "./metrics-charts";
import { statusForScore } from "./metrics-data";
import { Sparkle } from "./metrics-icons";

export function SelfImprovementRail({ detail, workflowName }: { detail: TemplateMetricsDetail | null; workflowName: string }) {
  const steps = detail?.steps ?? [];
  const attention = steps.filter((s) => statusForScore(s.score) !== "healthy").length;
  return (
    <Panel title="Self-improvement" kicker="ORCA LEARNS" style={{ flex: 1, minHeight: 0 }}
      bodyStyle={{ padding: 12, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.55, marginBottom: 12 }}>
        {attention > 0
          ? <>Orca sees <strong style={{ color: "var(--text)" }}>{attention} step{attention !== 1 ? "s" : ""} underperforming</strong> in {workflowName}.</>
          : <>Every step in {workflowName} is healthy.</>}
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", color: "var(--text-3)", gap: 8, padding: "24px 12px" }}>
        <Sparkle size={22} color="var(--text-4)" />
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)" }}>Learning loop not yet enabled</div>
        <div style={{ fontSize: 11.5, lineHeight: 1.5, maxWidth: 240 }}>
          Orca isn't proposing instruction changes yet. When the learning loop ships, drafted improvements and an activity log will appear here.
        </div>
      </div>
    </Panel>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/metrics/SelfImprovement.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify whole metrics suite + typecheck**

Run:
```bash
cd apps/desktop && pnpm vitest run src/metrics && pnpm tsc --noEmit
```
Expected: PASS, no type errors. (If `metrics-icons` exports referenced by deleted code are now unused, that's fine; if a deleted file is imported elsewhere, fix the import.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/metrics/SelfImprovement.tsx apps/desktop/src/metrics/SelfImprovement.test.tsx
git commit -m "feat(desktop): deferred learning-loop rail (no proposals/auto-apply)"
```

---

### Task 12: Full build + doc updates

**Files:**
- Modify: `ORCA.md`, `FUTURE_WORK.md`

- [ ] **Step 1: Run the full test + typecheck across the affected packages**

Run:
```bash
cd /Users/shawncholeva/projects/orca
pnpm -C packages/contracts vitest run src/metrics
pnpm -C apps/daemon vitest run src/metrics src/harness-metrics
pnpm -C apps/desktop vitest run src/metrics src/api.metrics.test.ts
```
Expected: all PASS.

- [ ] **Step 2: Update ORCA.md**

In the Inspectable-axis bullet (around `ORCA.md` line 305), append a sentence:

```
A per-template, cross-run, version-aware metrics surface (`/v1/metrics/templates`) generalizes the per-goal `/harness-metrics` projection: it aggregates the same harness-transition facets across every run of a template, entirely in storage-agnostic TypeScript (no SQLite-specific JSON SQL), for the Metrics tab and the future learning loop.
```

- [ ] **Step 3: Update FUTURE_WORK.md**

In Appendix A (Inspectable axis non-goals, line ~147), change the bullet `cross-run/global dashboards beyond per-goal /harness-metrics` to read `global / cross-owner dashboards (per-template cross-run is now in-scope as the 5.2 substrate)`. And under Phase 5.2, append a note: `Read-side substrate landed (Metrics Read Surface, 2026-06-30): per-template scoring/transition aggregation now exists; 5.2 still owns the learning (propose/promote) half.`

- [ ] **Step 4: Commit**

```bash
git add ORCA.md FUTURE_WORK.md
git commit -m "docs: record per-template metrics read surface (Inspectable axis + Phase 5.2 substrate)"
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** grain (Tasks 3–6), three channels + scope I1 (Task 5), version comparison I2 (Task 4), drill-through ids I3 (Tasks 5, 10), insights I4 (Task 5), approvals I5 (Tasks 5, 10), deterministic-only/no-LLM (entire daemon path), storage-agnostic F2 (Task 3 SQL + Tasks 4–5 TS), thin-client F4 (Task 8), cold-start confidence (Tasks 4, 5, 10), deferred rail (Task 11), doc updates (Task 12).
- **The `recentReasons` source** is `workflow_step_runs.blocked_reason` (the available free-text on the transition substrate), since `TelemetryFacet.outcome` carries only `{status, failure_code}` — no free-text reason. This is the honest substitute noted in the spec.
- **Tile rates are server-computed fields**, not client math: `TemplateMetricsSummary.firstPass`/`recovered`/`escalated` (0..1 rates) are populated in `computeTemplateSummary` (Task 4) via the `firstPassRate`/`recoveredRate`/`escalatedRate` helpers and rendered by the tiles (Task 9). The desktop only multiplies by 100 for display (F4 — formatting, not derivation).
