# Gate & Policy-Gateway Telemetry Metrics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate workflow gates and the tool-gate policy channel out of the step-score path and surface them as first-class, honestly-scored harness components in the Metrics tab.

**Architecture:** A small write-path capture fix persists each gate's *proposed* verdict alongside the human's resolution so reviewer-overturn (false acceptance) becomes computable. New daemon aggregators (`buildGateMetrics`, `buildPolicyGatewayMetrics`) compute gate-native metrics from `workflow_gate_decisions` + gate transitions + the reviewed step's evidence. The desktop Metrics tab gains a two-readout top strip (Step health ⟂ Gate health), a Gates section, and a Policy-gateway readout. Gate health is overturn-dominant, evidence-grounded, convergence-aware, with honest-null "unproven" when correctness coverage is thin. Cost is surfaced but never folded into health.

**Tech Stack:** TypeScript, better-sqlite3, Zod (`@orca/contracts`), React + Vitest + @testing-library/react (desktop), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-07-16-gate-policy-telemetry-metrics-design.md`

## Global Constraints

- **No new dependencies.** Everything uses the existing workspace toolset.
- **`.strict()` Zod contracts** — every new field must be added to the schema or parsing throws.
- **Honest-null discipline** — an unmeasured signal is `null`, never `0`. A gate without overturn coverage renders "unproven", not a passing grade (mirrors step `score == null` ⇒ "No check yet").
- **Cost is never an input to health** (§5.2.1 — efficiency is a distinct axis from correctness).
- **No jargon in UI** — never render `oracle`, `sensor`, `verdict`, `refute`, `veto`, or raw `__gate__:` ids to users (guarded by `no-jargon.test.tsx`).
- **Migrations:** add the new file to the `migrationFiles` array in `apps/daemon/src/migrations.ts` (convention) — a plain `ADD COLUMN` runs on the default path.
- **Fixed weighting** (decided here; spec §9): gate health = `0.5·(1−overturnRate) + 0.3·groundedness + 0.2·convergence`, scaled ×100. Overturn dominant. `null` when `overturnRate` is `null`.
- **Coverage floor** `GATE_OVERTURN_MIN = 5` supervised-with-recommendation decisions before `overturnRate` (and thus `health`) is non-null. **Audit-id cap** `GATE_SAMPLE_CAP = 5`. **Reject cap** `GATE_REJECT_CAP = 3` (mirrors `gate-evaluation.ts:12`).

---

## File Structure

**Create:**
- `apps/daemon/migrations/0062_gate_recommended_outcome.sql` — capture the gate's proposed verdict.
- `packages/contracts/src/metrics/gate-failure-labels.ts` — readable gate failure-mode labels.
- `apps/daemon/src/metrics/gate-metrics.ts` — `buildGateMetrics` + `buildPolicyGatewayMetrics` + constants.
- `apps/daemon/src/metrics/gate-metrics.test.ts` — fixture unit tests.
- `apps/desktop/src/metrics/GatePerformance.tsx` — `GateRow` + `GatePerformancePanel` + `PolicyGatewayReadout`.
- `apps/desktop/src/metrics/GatePerformance.test.tsx` — render/expand/no-jargon tests.

**Modify:**
- `packages/contracts/src/metrics/index.ts` — `GateMetrics`, `PolicyGatewayMetrics`, summary/detail additions, `labelForGateFailure` re-export.
- `apps/daemon/src/workflows/gates/usecases.ts` — extend `GateDecisionInput` + `recordGateDecision`.
- `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts:2737` — pass the stashed proposal into `recordGateDecision`.
- `apps/daemon/src/metrics/fetch.ts` — `listGateDecisionsByTemplate` + `GateDecisionRow` type.
- `apps/daemon/src/metrics/usecases.ts` — `gateNodeNames` helper; attach `gates`/`policyGateway` in `getTemplateMetricsDetail`.
- `apps/daemon/src/metrics/aggregate.ts:227` — skip `__gate__:` step-template ids in `computeStepMetrics`.
- `apps/desktop/src/metrics/MetricsPage.tsx` — two-readout strip; mount Gates section + policy readout.

---

## Task 1: Capture the gate's proposed verdict (write path)

**Files:**
- Create: `apps/daemon/migrations/0062_gate_recommended_outcome.sql`
- Modify: `apps/daemon/src/migrations.ts` (append to `migrationFiles`)
- Modify: `apps/daemon/src/workflows/gates/usecases.ts:4-58`
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts:2737-2749`
- Test: `apps/daemon/src/workflows/gates/usecases.test.ts` (create if absent)

**Interfaces:**
- Produces: `workflow_gate_decisions.recommended_outcome` (`'approved'|'rejected'|NULL`), `recommended_reason TEXT NULL`, `recommended_issue_refs_json TEXT NULL`. `GateDecisionInput` gains `recommendedOutcome: "approved"|"rejected"|null`, `recommendedReason: string|null`, `recommendedIssueRefs: string[]`.

- [ ] **Step 1: Write the migration**

Create `apps/daemon/migrations/0062_gate_recommended_outcome.sql`:
```sql
-- Phase 1 scoring: persist the gate's PROPOSED verdict distinctly from the human's
-- resolution so reviewer-overturn (false acceptance) is computable. Nullable: historical
-- rows and automated-path rows (no human) legitimately have no proposal to compare.
ALTER TABLE workflow_gate_decisions ADD COLUMN recommended_outcome TEXT;
ALTER TABLE workflow_gate_decisions ADD COLUMN recommended_reason TEXT;
ALTER TABLE workflow_gate_decisions ADD COLUMN recommended_issue_refs_json TEXT;
```

- [ ] **Step 2: Register the migration**

In `apps/daemon/src/migrations.ts`, add to the `migrationFiles` array after `"0061_step_run_pending_worker_hitl.sql",`:
```ts
  "0062_gate_recommended_outcome.sql",
```

- [ ] **Step 3: Write the failing test**

Create `apps/daemon/src/workflows/gates/usecases.test.ts`:
```ts
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, defaultMigrationsDir } from "../../migrations.js";
import { recordGateDecision } from "./usecases.js";

const NOW = () => "2026-07-16T00:00:00.000Z";

function seed(db: Database.Database) {
  db.prepare("INSERT INTO goals (id, title, workspace_id, status, created_at, updated_at) VALUES ('g1','G','ws',' active',?,?)").run(NOW(), NOW());
}

describe("recordGateDecision — proposed-vs-human capture", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db, defaultMigrationsDir()); });

  it("persists recommended_outcome alongside the human outcome so overturn is reconstructable", () => {
    db.prepare("INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, created_at, updated_at, traversal_seq) VALUES ('r1','g1','t1',1,'active',?,?,0)").run(NOW(), NOW());
    recordGateDecision(db, NOW, {
      id: "d1", goalId: "g1", workflowRunId: "r1", nodeId: "review", traversalSeq: 1,
      outcome: "rejected", reason: "rejected by user", reasoning: null, selectedEdgeTo: "proposal",
      inputsConsidered: [], issueRefs: [], ledgerVersion: 0,
      recommendedOutcome: "approved", recommendedReason: "looks done", recommendedIssueRefs: [],
    });
    const row = db.prepare("SELECT outcome, recommended_outcome FROM workflow_gate_decisions WHERE id='d1'").get() as { outcome: string; recommended_outcome: string | null };
    expect(row.outcome).toBe("rejected");
    expect(row.recommended_outcome).toBe("approved");
    expect(row.recommended_outcome !== row.outcome).toBe(true); // overturn
  });
});
```
> Note: adjust the `goals`/`workflow_runs` INSERT column lists to the actual schema if the migration set differs — open `0001_init.sql` etc. The assertion is the contract.

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- gates/usecases.test.ts`
Expected: FAIL — `recordGateDecision` does not accept `recommendedOutcome` / column does not exist.

- [ ] **Step 5: Extend `GateDecisionInput` and the INSERT**

In `apps/daemon/src/workflows/gates/usecases.ts`, add three fields to `GateDecisionInput` (after `ledgerVersion: number;` on line 16):
```ts
  recommendedOutcome: "approved" | "rejected" | null;
  recommendedReason: string | null;
  recommendedIssueRefs: string[];
```
Update the INSERT in `recordGateDecision` to include the three columns:
```ts
  db.prepare(
    `INSERT INTO workflow_gate_decisions
       (id, goal_id, workflow_run_id, node_id, traversal_seq, outcome, reason, reasoning,
        selected_edge_to, inputs_considered_json, issue_refs_json, ledger_version, created_at,
        recommended_outcome, recommended_reason, recommended_issue_refs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.goalId, input.workflowRunId, input.nodeId, input.traversalSeq, input.outcome,
    input.reason.slice(0, 1024), input.reasoning, input.selectedEdgeTo,
    JSON.stringify(input.inputsConsidered), JSON.stringify(input.issueRefs), input.ledgerVersion, now(),
    input.recommendedOutcome, input.recommendedReason?.slice(0, 1024) ?? null,
    JSON.stringify(input.recommendedIssueRefs)
  );
```

- [ ] **Step 6: Feed the stashed proposal in `decideGate`**

In `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts`, update the `recordGateDecision(...)` call at line 2737 to pass the proposal already parsed into `stash` (the park wrote `recommendedOutcome`/`reason`/`issueRefs` at lines 1692-1697). Add these three fields to the call object:
```ts
      recommendedOutcome: stash.recommendedOutcome ?? null,
      recommendedReason: stash.reason ?? null,
      recommendedIssueRefs: stash.issueRefs ?? [],
```
> `stash` is read before line 2736 nulls the column, so the values are still in memory. Also update the automated-path call in `applyGateProposal` (search `recordGateDecision(` in this file) to pass `recommendedOutcome: null, recommendedReason: null, recommendedIssueRefs: []` (no human ⇒ no overturn concept).

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- gates/usecases.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: no errors (all `recordGateDecision` callers now supply the three fields).

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/migrations/0062_gate_recommended_outcome.sql apps/daemon/src/migrations.ts apps/daemon/src/workflows/gates/usecases.ts apps/daemon/src/workflows/orchestrator/dispatch-engine.ts apps/daemon/src/workflows/gates/usecases.test.ts
git commit -m "feat(daemon): persist gate-proposed verdict for overturn telemetry (Phase 1 capture fix)"
```

---

## Task 2: Gate metrics contracts

**Files:**
- Modify: `packages/contracts/src/metrics/index.ts`
- Test: `packages/contracts/src/metrics/gate-metrics.contract.test.ts` (create)

**Interfaces:**
- Produces: `GateMetrics`, `PolicyGatewayMetrics` Zod schemas + inferred types; `TemplateMetricsSummary.gateHealth`; `TemplateMetricsDetail.gates` / `.policyGateway`.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/metrics/gate-metrics.contract.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { GateMetrics, PolicyGatewayMetrics } from "./index.js";

const validGate = {
  nodeId: "review", name: "Review", evalSubstrate: "shadow" as const,
  health: null, grade: null, confidence: "low" as const, sampleSize: 3, delta: null,
  scored: { overturnRate: null, overturnSampleSize: 0, overturnDecisionIds: [], groundedness: 0.5, ungroundedDecisionIds: [], convergence: 1, limitingTerm: null },
  cost: { p50LatencyMs: null, meanTokens: null, meanUsd: null, tokensSpentOnOverturned: null },
  failureModes: [], context: { approvalRate: 1, rejectRate: 0, decisions: 3, meanLoops: 1, capHitRate: 0, stagnationRate: 0, parkRate: 0, residualRiskBurden: null, recentRejectReasons: [] },
  trend: [], versionBoundaries: [],
};

describe("GateMetrics contract", () => {
  it("parses a valid honest-null gate", () => { expect(() => GateMetrics.parse(validGate)).not.toThrow(); });
  it("rejects an unknown key (strict)", () => { expect(() => GateMetrics.parse({ ...validGate, bogus: 1 })).toThrow(); });
});

describe("PolicyGatewayMetrics contract", () => {
  it("parses", () => {
    expect(() => PolicyGatewayMetrics.parse({
      decisionDist: { allow: 5, require_approval: 1, deny: 0 },
      overPermissive: { count: 0, sampleTransitionIds: [] },
      boundaryViolations: [],
    })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/contracts test -- gate-metrics.contract.test.ts`
Expected: FAIL — `GateMetrics` / `PolicyGatewayMetrics` are not exported.

- [ ] **Step 3: Add the schemas**

In `packages/contracts/src/metrics/index.ts`, after `EvidenceArtifact` (line 80) add:
```ts
export const GateFailureMode = z.object({
  label: z.string(), count: z.number().int().nonnegative(), pct: z.number(),
  sampleDecisionIds: z.array(z.string()),
}).strict();
export type GateFailureMode = z.infer<typeof GateFailureMode>;

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
}).strict();
export type GateMetrics = z.infer<typeof GateMetrics>;

export const PolicyGatewayMetrics = z.object({
  decisionDist: z.record(z.string(), z.number()),
  overPermissive: z.object({ count: z.number().int().nonnegative(), sampleTransitionIds: z.array(z.string()) }).strict(),
  boundaryViolations: z.array(FailureCluster),
}).strict();
export type PolicyGatewayMetrics = z.infer<typeof PolicyGatewayMetrics>;
```

- [ ] **Step 4: Widen summary + detail**

In `TemplateMetricsSummary` (line 36), add before the closing `}).strict()`:
```ts
  gateHealth: z.object({
    value: z.number().nullable(), grade: z.enum(["A", "B", "C", "D", "F"]).nullable(),
    delta: z.number().nullable(), confidence: z.enum(["low", "ok"]),
  }).strict(),
```
In `TemplateMetricsDetail` (line 149), add:
```ts
  gates: z.array(GateMetrics),
  policyGateway: PolicyGatewayMetrics,
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @orca/contracts test -- gate-metrics.contract.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/metrics/index.ts packages/contracts/src/metrics/gate-metrics.contract.test.ts
git commit -m "feat(contracts): GateMetrics + PolicyGatewayMetrics + summary/detail additions"
```

---

## Task 3: Gate failure-label catalog

**Files:**
- Create: `packages/contracts/src/metrics/gate-failure-labels.ts`
- Modify: `packages/contracts/src/metrics/index.ts:3` (re-export)
- Test: `packages/contracts/src/metrics/gate-failure-labels.test.ts` (create)

**Interfaces:**
- Produces: `labelForGateFailure(code: string): string`; the code set `overturned_approve | blind_approve | cap_hit | stagnation | reviewer_unavailable_park`.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/metrics/gate-failure-labels.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { labelForGateFailure, GATE_FAILURE_CODES } from "./gate-failure-labels.js";

describe("labelForGateFailure", () => {
  it("has a readable, jargon-free label for every code", () => {
    for (const code of GATE_FAILURE_CODES) {
      const label = labelForGateFailure(code);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
    }
  });
  it("false acceptance reads plainly", () => {
    expect(labelForGateFailure("overturned_approve")).toMatch(/approved.*a person then/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/contracts test -- gate-failure-labels.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the catalog**

Create `packages/contracts/src/metrics/gate-failure-labels.ts`:
```ts
// Readable, jargon-free labels for gate failure modes. Mirrors metrics/failure-labels.ts.
export const GATE_FAILURE_CODES = [
  "overturned_approve", "blind_approve", "cap_hit", "stagnation", "reviewer_unavailable_park",
] as const;

const CATALOG: Record<string, string> = {
  overturned_approve: "Approved work a person then sent back",
  blind_approve: "Approved without any checks run behind it",
  cap_hit: "Kept sending work back until it ran out of retries",
  stagnation: "Looped on the same unresolved issues without progress",
  reviewer_unavailable_park: "Paused for a person because no reviewer was available",
};

export function labelForGateFailure(code: string): string {
  return CATALOG[code] ?? code.replace(/_/g, " ");
}
```

- [ ] **Step 4: Re-export from the metrics barrel**

In `packages/contracts/src/metrics/index.ts`, line 3 currently re-exports `labelForFailure`. Add below it:
```ts
export { labelForGateFailure, GATE_FAILURE_CODES } from "./gate-failure-labels.js";
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @orca/contracts test -- gate-failure-labels.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/metrics/gate-failure-labels.ts packages/contracts/src/metrics/gate-failure-labels.test.ts packages/contracts/src/metrics/index.ts
git commit -m "feat(contracts): readable gate failure-mode label catalog"
```

---

## Task 4: Fetch gate decisions + resolve gate names (daemon)

**Files:**
- Modify: `apps/daemon/src/metrics/fetch.ts`
- Modify: `apps/daemon/src/metrics/usecases.ts` (add `gateNodeNames`)
- Test: `apps/daemon/src/metrics/fetch.gate.test.ts` (create)

**Interfaces:**
- Produces: `GateDecisionRow` type; `listGateDecisionsByTemplate(db, templateId, sinceIso, untilIso): GateDecisionRow[]`; `gateNodeNames(db, templateId): Map<string, { name: string; evalSubstrate: "shadow"|"worker" }>`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/metrics/fetch.gate.test.ts`:
```ts
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, defaultMigrationsDir } from "../migrations.js";
import { listGateDecisionsByTemplate } from "./fetch.js";

const NOW = "2026-07-16T00:00:00.000Z";

describe("listGateDecisionsByTemplate", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db, defaultMigrationsDir()); });

  it("returns gate-decision rows for a template within the window, newest fields intact", () => {
    db.prepare("INSERT INTO goals (id, title, workspace_id, status, created_at, updated_at) VALUES ('g1','G','ws','active',?,?)").run(NOW, NOW);
    db.prepare("INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, created_at, updated_at, traversal_seq) VALUES ('r1','g1','tpl',1,'active',?,?,1)").run(NOW, NOW);
    db.prepare(`INSERT INTO workflow_gate_decisions (id, goal_id, workflow_run_id, node_id, traversal_seq, outcome, reason, selected_edge_to, inputs_considered_json, issue_refs_json, ledger_version, created_at, recommended_outcome, recommended_reason, recommended_issue_refs_json) VALUES ('d1','g1','r1','review',1,'rejected','x','proposal','[]','["a"]',0,?, 'approved','looks done','[]')`).run(NOW);
    const rows = listGateDecisionsByTemplate(db, "tpl", "2026-07-15T00:00:00.000Z", "2026-07-17T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0].nodeId).toBe("review");
    expect(rows[0].outcome).toBe("rejected");
    expect(rows[0].recommendedOutcome).toBe("approved");
    expect(rows[0].issueRefs).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- fetch.gate.test.ts`
Expected: FAIL — `listGateDecisionsByTemplate` not exported.

- [ ] **Step 3: Add the row type + query**

In `apps/daemon/src/metrics/fetch.ts`, add after `TemplateStepRun` (line 18):
```ts
export type GateDecisionRow = {
  id: string;
  workflowRunId: string;
  nodeId: string;
  traversalSeq: number;
  outcome: "approved" | "rejected";
  reason: string;
  issueRefs: string[];
  recommendedOutcome: "approved" | "rejected" | null;
  recommendedReason: string | null;
  createdAt: string;
  templateVersion: number;
};

export function listGateDecisionsByTemplate(
  db: Database.Database, templateId: string, sinceIso: string, untilIso: string
): GateDecisionRow[] {
  const rows = db.prepare(
    `SELECT gd.id, gd.workflow_run_id, gd.node_id, gd.traversal_seq, gd.outcome, gd.reason,
            gd.issue_refs_json, gd.recommended_outcome, gd.recommended_reason,
            gd.created_at, wr.template_version
     FROM workflow_gate_decisions gd
     JOIN workflow_runs wr ON wr.id = gd.workflow_run_id
     WHERE wr.template_id = ? AND gd.created_at >= ? AND gd.created_at < ?
     ORDER BY gd.created_at ASC, gd.id ASC`
  ).all(templateId, sinceIso, untilIso) as {
    id: string; workflow_run_id: string; node_id: string; traversal_seq: number;
    outcome: "approved" | "rejected"; reason: string; issue_refs_json: string;
    recommended_outcome: "approved" | "rejected" | null; recommended_reason: string | null;
    created_at: string; template_version: number;
  }[];
  return rows.map((r) => ({
    id: r.id, workflowRunId: r.workflow_run_id, nodeId: r.node_id, traversalSeq: r.traversal_seq,
    outcome: r.outcome, reason: r.reason, issueRefs: JSON.parse(r.issue_refs_json) as string[],
    recommendedOutcome: r.recommended_outcome, recommendedReason: r.recommended_reason,
    createdAt: r.created_at, templateVersion: r.template_version,
  }));
}
```

- [ ] **Step 4: Add `gateNodeNames`**

In `apps/daemon/src/metrics/usecases.ts`, mirror `stepNames` (lines 53-60). Add:
```ts
function gateNodeNames(db: Database.Database, templateId: string): Map<string, { name: string; evalSubstrate: "shadow" | "worker" }> {
  const row = db.prepare(`SELECT graph_json FROM workflow_templates WHERE id = ?`).get(templateId) as { graph_json: string | null } | undefined;
  const map = new Map<string, { name: string; evalSubstrate: "shadow" | "worker" }>();
  if (!row?.graph_json) return map;
  const graph = JSON.parse(row.graph_json) as { nodes: { id: string; type: string; name?: string; evalSubstrate?: "shadow" | "worker" }[] };
  for (const n of graph.nodes) {
    if (n.type !== "gate") continue;
    map.set(n.id, { name: n.name || n.id, evalSubstrate: n.evalSubstrate ?? "shadow" });
  }
  return map;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- fetch.gate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/metrics/fetch.ts apps/daemon/src/metrics/usecases.ts apps/daemon/src/metrics/fetch.gate.test.ts
git commit -m "feat(daemon): fetch gate decisions + resolve gate node names for metrics"
```

---

## Task 5: `buildGateMetrics` — the gate-health aggregator

**Files:**
- Create: `apps/daemon/src/metrics/gate-metrics.ts`
- Test: `apps/daemon/src/metrics/gate-metrics.test.ts`

**Interfaces:**
- Consumes: `GateDecisionRow[]` (Task 4), `TemplateTransition[]` (fetch.ts), `Map<nodeId,{name,evalSubstrate}>` (Task 4), `labelForGateFailure` (Task 3), `GateMetrics` type (Task 2).
- Produces: `buildGateMetrics(input): GateMetrics[]` and the constants `GATE_OVERTURN_MIN`, `GATE_SAMPLE_CAP`, `GATE_REJECT_CAP`, `W_OVERTURN`, `W_GROUNDED`, `W_CONVERGE`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/metrics/gate-metrics.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildGateMetrics } from "./gate-metrics.js";
import type { GateDecisionRow, TemplateTransition } from "./fetch.js";

const names = new Map([["review", { name: "Review", evalSubstrate: "shadow" as const }]]);
const decision = (over: Partial<GateDecisionRow>): GateDecisionRow => ({
  id: "d", workflowRunId: "r1", nodeId: "review", traversalSeq: 1, outcome: "approved",
  reason: "ok", issueRefs: [], recommendedOutcome: "approved", recommendedReason: null,
  createdAt: "2026-07-16T00:00:00.000Z", templateVersion: 1, ...over,
});

describe("buildGateMetrics", () => {
  it("renders health null ('unproven') when overturn coverage is below the floor", () => {
    const gates = buildGateMetrics({ decisions: [decision({})], transitions: [], names, period: "7d" });
    expect(gates).toHaveLength(1);
    expect(gates[0].health).toBeNull();
    expect(gates[0].scored.overturnRate).toBeNull();
    expect(gates[0].name).toBe("Review"); // no __gate__: leak
  });

  it("computes overturnRate once coverage is met and grades the gate", () => {
    // 5 supervised decisions with a recommendation; 1 overturned (recommended approve, human rejected).
    const decisions: GateDecisionRow[] = [];
    for (let i = 0; i < 5; i++) {
      const overturned = i === 0;
      decisions.push(decision({
        id: `d${i}`, workflowRunId: `r${i}`, traversalSeq: 1,
        recommendedOutcome: "approved", outcome: overturned ? "rejected" : "approved",
      }));
    }
    const gates = buildGateMetrics({ decisions, transitions: [], names, period: "7d" });
    expect(gates[0].scored.overturnSampleSize).toBe(5);
    expect(gates[0].scored.overturnRate).toBeCloseTo(0.2, 5);
    expect(gates[0].health).not.toBeNull();
    expect(gates[0].failureModes.find((f) => f.label.match(/sent back/i))?.count).toBe(1);
  });

  it("classifies a park (reviewer_unavailable) as NOT a failure and never lets cost move health", () => {
    const decisions = Array.from({ length: 5 }, (_, i) => decision({ id: `d${i}`, workflowRunId: `r${i}`, recommendedOutcome: "approved", outcome: "approved" }));
    const withCost = buildGateMetrics({ decisions, transitions: costTransitions(9999), names, period: "7d" });
    const noCost = buildGateMetrics({ decisions, transitions: [], names, period: "7d" });
    expect(withCost[0].health).toBe(noCost[0].health); // cost never folded into health
    expect(withCost[0].cost.meanUsd).not.toBeNull();
  });
});

function costTransitions(usd: number): TemplateTransition[] {
  return [{
    templateVersion: 1, stepTemplateId: "__gate__:review",
    transition: { workflowRunId: "r0", boundary: "step_complete", createdAt: "2026-07-16T00:00:00.000Z",
      telemetry: { latency_ms: 100, cost: { usd, tokens_in: 10, tokens_out: 5 } } } as never,
  }];
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- gate-metrics.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `buildGateMetrics`**

Create `apps/daemon/src/metrics/gate-metrics.ts`:
```ts
import type { GateMetrics, GateFailureMode, MetricPeriod } from "@orca/contracts";
import { labelForGateFailure } from "@orca/contracts";
import type { GateDecisionRow, TemplateTransition } from "./fetch.js";

export const GATE_OVERTURN_MIN = 5;   // supervised-with-recommendation decisions before overturnRate is non-null
export const GATE_SAMPLE_CAP = 5;     // max artifact ids per drill-through list
export const GATE_REJECT_CAP = 3;     // mirrors gate-evaluation.ts:12
export const W_OVERTURN = 0.5;
export const W_GROUNDED = 0.3;
export const W_CONVERGE = 0.2;

const grade = (s: number): GateMetrics["grade"] => (s >= 90 ? "A" : s >= 80 ? "B" : s >= 70 ? "C" : s >= 60 ? "D" : "F");
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function buildGateMetrics(input: {
  decisions: GateDecisionRow[];
  transitions: TemplateTransition[];
  names: Map<string, { name: string; evalSubstrate: "shadow" | "worker" }>;
  period: MetricPeriod;
}): GateMetrics[] {
  const byNode = new Map<string, GateDecisionRow[]>();
  for (const d of input.decisions) (byNode.get(d.nodeId) ?? byNode.set(d.nodeId, []).get(d.nodeId)!).push(d);

  // Step-completion transitions per run, sorted by time — used for the gate→evidence join.
  const stepCompletesByRun = new Map<string, TemplateTransition[]>();
  for (const t of input.transitions) {
    if (t.stepTemplateId?.startsWith("__gate__:")) continue;
    if (t.transition.boundary !== "step_complete") continue;
    (stepCompletesByRun.get(t.transition.workflowRunId) ?? stepCompletesByRun.set(t.transition.workflowRunId, []).get(t.transition.workflowRunId)!).push(t);
  }
  for (const arr of stepCompletesByRun.values()) arr.sort((a, b) => a.transition.createdAt.localeCompare(b.transition.createdAt));

  const gates: GateMetrics[] = [];
  for (const [nodeId, decisions] of byNode) {
    const meta = input.names.get(nodeId) ?? { name: nodeId.replace(/^__gate__:/, ""), evalSubstrate: "shadow" as const };

    // --- Overturn (dominant term) ---
    const withRec = decisions.filter((d) => d.recommendedOutcome != null);
    const overturned = withRec.filter((d) => d.recommendedOutcome !== d.outcome);
    const overturnSampleSize = withRec.length;
    const overturnRate = overturnSampleSize >= GATE_OVERTURN_MIN ? overturned.length / overturnSampleSize : null;
    const overturnDecisionIds = overturned.slice(0, GATE_SAMPLE_CAP).map((d) => d.id);

    // --- Groundedness: did the reviewed step's evidence stand on checks? ---
    const isGrounded = (d: GateDecisionRow): boolean => {
      const completes = stepCompletesByRun.get(d.workflowRunId) ?? [];
      const reviewed = [...completes].reverse().find((t) => t.transition.createdAt < d.createdAt);
      const ev = (reviewed?.transition as { evidence?: { sensorsRun?: unknown[]; oracleAdequacy?: { sufficient?: boolean } } } | undefined)?.evidence;
      return !!ev && (ev.sensorsRun?.length ?? 0) > 0 && ev.oracleAdequacy?.sufficient === true;
    };
    const grounded = decisions.filter(isGrounded);
    const groundedness = decisions.length ? grounded.length / decisions.length : null;
    const ungroundedDecisionIds = decisions.filter((d) => !isGrounded(d)).slice(0, GATE_SAMPLE_CAP).map((d) => d.id);

    // --- Convergence: resolutions = decisions grouped per run; loops penalize toward the cap ---
    const byRun = new Map<string, GateDecisionRow[]>();
    for (const d of decisions) (byRun.get(d.workflowRunId) ?? byRun.set(d.workflowRunId, []).get(d.workflowRunId)!).push(d);
    const resolutions = [...byRun.values()];
    const loopsPer = resolutions.map((r) => r.length);
    const convScores = loopsPer.map((n) => Math.max(0, Math.min(1, (GATE_REJECT_CAP - (n - 1)) / GATE_REJECT_CAP)));
    const convergence = mean(convScores);
    const capHitRate = resolutions.length ? loopsPer.filter((n) => n >= GATE_REJECT_CAP).length / resolutions.length : null;
    const stagnated = resolutions.filter((r) => {
      const sorted = [...r].sort((a, b) => a.traversalSeq - b.traversalSeq);
      for (let i = 1; i < sorted.length; i++) {
        const a = [...sorted[i - 1].issueRefs].sort().join("|"); const b = [...sorted[i].issueRefs].sort().join("|");
        if (a && a === b) return true;
      }
      return false;
    });
    const stagnationRate = resolutions.length ? stagnated.length / resolutions.length : null;

    // --- Health (honest-null when overturn coverage is thin) ---
    let health: number | null = null;
    if (overturnRate != null && groundedness != null && convergence != null) {
      health = Math.round(100 * (W_OVERTURN * (1 - overturnRate) + W_GROUNDED * groundedness + W_CONVERGE * convergence));
    }
    const limitingTerm = health == null ? null : ([
      ["overturn", 1 - (overturnRate ?? 0)], ["groundedness", groundedness ?? 0], ["convergence", convergence ?? 0],
    ] as const).sort((a, b) => a[1] - b[1])[0][0];

    // --- Cost (never folded into health) ---
    const gateTs = input.transitions.filter((t) => t.stepTemplateId === `__gate__:${nodeId}`);
    const tel = (t: TemplateTransition) => t.transition.telemetry as { latency_ms?: number | null; cost?: { usd?: number; tokens_in?: number; tokens_out?: number } | null } | undefined;
    const usd = gateTs.map((t) => tel(t)?.cost?.usd).filter((x): x is number => typeof x === "number");
    const tokens = gateTs.map((t) => { const c = tel(t)?.cost; return c ? (c.tokens_in ?? 0) + (c.tokens_out ?? 0) : null; }).filter((x): x is number => x != null);
    const latencies = gateTs.map((t) => tel(t)?.latency_ms).filter((x): x is number => typeof x === "number");
    const overturnedRuns = new Set(overturned.map((d) => d.workflowRunId));
    const overturnedTokens = gateTs.filter((t) => overturnedRuns.has(t.transition.workflowRunId))
      .map((t) => { const c = tel(t)?.cost; return c ? (c.tokens_in ?? 0) + (c.tokens_out ?? 0) : 0; });

    // --- Failure-mode taxonomy ---
    const modes: GateFailureMode[] = [];
    const pushMode = (code: string, rows: GateDecisionRow[]) => {
      if (!rows.length) return;
      modes.push({ label: labelForGateFailure(code), count: rows.length, pct: rows.length / decisions.length, sampleDecisionIds: rows.slice(0, GATE_SAMPLE_CAP).map((d) => d.id) });
    };
    pushMode("overturned_approve", overturned.filter((d) => d.recommendedOutcome === "approved" && d.outcome === "rejected"));
    pushMode("blind_approve", decisions.filter((d) => d.outcome === "approved" && !isGrounded(d)));
    pushMode("cap_hit", resolutions.filter((r) => r.length >= GATE_REJECT_CAP).flat());
    pushMode("stagnation", stagnated.flat());

    const approvals = decisions.filter((d) => d.outcome === "approved").length;
    const recentRejectReasons = decisions.filter((d) => d.outcome === "rejected").slice(-3)
      .map((d) => ({ at: d.createdAt, reason: d.reason, issueRefs: d.issueRefs }));

    gates.push({
      nodeId, name: meta.name, evalSubstrate: meta.evalSubstrate,
      health, grade: health == null ? null : grade(health),
      confidence: decisions.length >= GATE_OVERTURN_MIN ? "ok" : "low",
      sampleSize: decisions.length, delta: null,
      scored: { overturnRate, overturnSampleSize, overturnDecisionIds, groundedness, ungroundedDecisionIds, convergence, limitingTerm },
      cost: { p50LatencyMs: median(latencies), meanTokens: mean(tokens), meanUsd: mean(usd), tokensSpentOnOverturned: overturnedTokens.length ? overturnedTokens.reduce((a, b) => a + b, 0) : null },
      failureModes: modes,
      context: {
        approvalRate: decisions.length ? approvals / decisions.length : null,
        rejectRate: decisions.length ? (decisions.length - approvals) / decisions.length : null,
        decisions: decisions.length, meanLoops: mean(loopsPer), capHitRate, stagnationRate, parkRate: null,
        residualRiskBurden: null, recentRejectReasons,
      },
      trend: [], versionBoundaries: [],
    });
  }
  return gates.sort((a, b) => a.name.localeCompare(b.name));
}
```
> `parkRate` and `residualRiskBurden` are `null` in Phase 1 (their source — the transient park stash and reviewer residual-risk bundle — isn't in the decisions table); they are declared for forward-compat and filled in a follow-up. `delta`/`trend`/`versionBoundaries` are populated in a follow-up alongside the step version-comparison machinery. This is honest-null, not a placeholder.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- gate-metrics.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/metrics/gate-metrics.ts apps/daemon/src/metrics/gate-metrics.test.ts
git commit -m "feat(daemon): buildGateMetrics — overturn-dominant, evidence-grounded, honest-null gate health"
```

---

## Task 6: `buildPolicyGatewayMetrics` — tool-gate channel

**Files:**
- Modify: `apps/daemon/src/metrics/gate-metrics.ts` (add the function)
- Test: `apps/daemon/src/metrics/gate-metrics.test.ts` (add a describe block)

**Interfaces:**
- Produces: `buildPolicyGatewayMetrics(transitions: TemplateTransition[]): PolicyGatewayMetrics`.

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/metrics/gate-metrics.test.ts`:
```ts
import { buildPolicyGatewayMetrics } from "./gate-metrics.js";

const riskT = (gate: string, risk: string): TemplateTransition => ({
  templateVersion: 1, stepTemplateId: "s1",
  transition: { id: `t-${gate}-${risk}`, workflowRunId: "r1", boundary: "tool_gate", createdAt: "2026-07-16T00:00:00.000Z",
    risk: { boundary: "tool_gate", gate_decision: gate, risk_class: risk } } as never,
});

describe("buildPolicyGatewayMetrics", () => {
  it("aggregates the tool-gate decision distribution and flags over-permissive allows", () => {
    const pg = buildPolicyGatewayMetrics([riskT("allow", "low"), riskT("allow", "high"), riskT("deny", "critical"), riskT("require_approval", "high")]);
    expect(pg.decisionDist.allow).toBe(2);
    expect(pg.decisionDist.deny).toBe(1);
    expect(pg.overPermissive.count).toBe(1); // the allow at high risk
    expect(pg.overPermissive.sampleTransitionIds).toContain("t-allow-high");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- gate-metrics.test.ts`
Expected: FAIL — `buildPolicyGatewayMetrics` not exported.

- [ ] **Step 3: Implement it**

Append to `apps/daemon/src/metrics/gate-metrics.ts`:
```ts
import type { PolicyGatewayMetrics } from "@orca/contracts";

export function buildPolicyGatewayMetrics(transitions: TemplateTransition[]): PolicyGatewayMetrics {
  const dist: Record<string, number> = { allow: 0, require_approval: 0, deny: 0 };
  const overIds: string[] = [];
  const violationsByClass = new Map<string, { count: number; ids: string[] }>();
  for (const t of transitions) {
    const risk = (t.transition as { id?: string; risk?: { boundary?: string; gate_decision?: string; risk_class?: string } }).risk;
    if (!risk || risk.boundary !== "tool_gate" || !risk.gate_decision) continue;
    dist[risk.gate_decision] = (dist[risk.gate_decision] ?? 0) + 1;
    const id = (t.transition as { id?: string }).id ?? "";
    if (risk.gate_decision === "allow" && (risk.risk_class === "high" || risk.risk_class === "critical")) {
      if (overIds.length < GATE_SAMPLE_CAP) overIds.push(id);
    }
    if (risk.gate_decision === "deny" || risk.gate_decision === "require_approval") {
      const key = risk.risk_class ?? "unknown";
      const bucket = violationsByClass.get(key) ?? { count: 0, ids: [] };
      bucket.count++; if (bucket.ids.length < GATE_SAMPLE_CAP) bucket.ids.push(id);
      violationsByClass.set(key, bucket);
    }
  }
  return {
    decisionDist: dist,
    overPermissive: { count: overIds.length, sampleTransitionIds: overIds },
    boundaryViolations: [...violationsByClass.entries()].map(([risk_class, b]) => ({
      failureCode: null, boundary: `tool_gate:${risk_class}`, count: b.count, sampleTransitionIds: b.ids,
    })),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- gate-metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/metrics/gate-metrics.ts apps/daemon/src/metrics/gate-metrics.test.ts
git commit -m "feat(daemon): buildPolicyGatewayMetrics — tool-gate channel + over-permissive flag"
```

---

## Task 7: Wire gates out of steps and into the detail response

**Files:**
- Modify: `apps/daemon/src/metrics/aggregate.ts:213-215` (skip `__gate__:` in `computeStepMetrics`)
- Modify: `apps/daemon/src/metrics/usecases.ts:62-78` (attach `gates` + `policyGateway`; `gateHealth` in summary)
- Test: `apps/daemon/src/metrics/usecases.gate.test.ts` (create)

**Interfaces:**
- Consumes: `buildGateMetrics`, `buildPolicyGatewayMetrics` (Tasks 5-6); `listGateDecisionsByTemplate`, `gateNodeNames` (Task 4).
- Produces: `TemplateMetricsDetail` with `gates` + `policyGateway`; `TemplateMetricsSummary.gateHealth`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/metrics/usecases.gate.test.ts`:
```ts
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, defaultMigrationsDir } from "../migrations.js";
import { getTemplateMetricsDetail } from "./usecases.js";

const NOW = "2026-07-16T12:00:00.000Z";

describe("getTemplateMetricsDetail — gates isolated from steps", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db, defaultMigrationsDir()); });

  it("excludes __gate__: rows from steps[] and returns them under gates[]", () => {
    db.prepare("INSERT INTO goals (id, title, workspace_id, status, created_at, updated_at) VALUES ('g1','G','ws','active',?,?)").run(NOW, NOW);
    db.prepare(`INSERT INTO workflow_templates (id, name, steps_json, graph_json, latest_version, created_at, updated_at) VALUES ('tpl','T','[]',?,1,?,?)`)
      .run(JSON.stringify({ nodes: [{ id: "review", type: "gate", name: "Review", evalSubstrate: "shadow" }], edges: [] }), NOW, NOW);
    db.prepare("INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, created_at, updated_at, traversal_seq) VALUES ('r1','g1','tpl',1,'active',?,?,1)").run(NOW, NOW);
    db.prepare(`INSERT INTO workflow_gate_decisions (id, goal_id, workflow_run_id, node_id, traversal_seq, outcome, reason, selected_edge_to, inputs_considered_json, issue_refs_json, ledger_version, created_at) VALUES ('d1','g1','r1','review',1,'approved','ok','next','[]','[]',0,?)`).run(NOW);

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", "2026-07-17T00:00:00.000Z");
    expect(detail).not.toBeNull();
    expect(detail!.steps.some((s) => s.stepTemplateId.startsWith("__gate__:"))).toBe(false);
    expect(detail!.gates.map((g) => g.name)).toContain("Review");
    expect(detail!.policyGateway.decisionDist).toBeDefined();
    expect(detail!.summary.gateHealth).toBeDefined();
  });
});
```
> Adjust the `workflow_templates` INSERT column list to the real schema (open the CREATE TABLE) — the assertions are the contract.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- usecases.gate.test.ts`
Expected: FAIL — `detail.gates` is undefined / gate rows still in `steps`.

- [ ] **Step 3: Skip gate surrogates in `computeStepMetrics`**

In `apps/daemon/src/metrics/aggregate.ts`, inside `computeStepMetrics` where transitions are grouped by step (line 214, `if (!t.stepTemplateId) continue;`), add immediately after it:
```ts
    if (t.stepTemplateId.startsWith("__gate__:")) continue;
```
And where step runs are grouped (line 218-219), guard the same way:
```ts
    if (r.stepTemplateId.startsWith("__gate__:")) continue;
```

- [ ] **Step 4: Attach gates + policyGateway + gateHealth**

In `apps/daemon/src/metrics/usecases.ts`, import at top (the grade is inlined below — no extra helper needed):
```ts
import { listGateDecisionsByTemplate } from "./fetch.js";
import { buildGateMetrics, buildPolicyGatewayMetrics } from "./gate-metrics.js";
```
Then rewrite the `getTemplateMetricsDetail` return (lines 68-77) to compute gates once and attach both:
```ts
  const gateDecisions = listGateDecisionsByTemplate(db, templateId, since, now);
  const gates = buildGateMetrics({ decisions: gateDecisions, transitions, names: gateNodeNames(db, templateId), period });
  const scored = gates.filter((g) => g.health != null);
  const gateHealthValue = scored.length ? Math.round(scored.reduce((n, g) => n + g.health!, 0) / scored.length) : null;
  const gateHealth = {
    value: gateHealthValue,
    grade: gateHealthValue == null ? null : (gateHealthValue >= 90 ? "A" : gateHealthValue >= 80 ? "B" : gateHealthValue >= 70 ? "C" : gateHealthValue >= 60 ? "D" : "F") as "A"|"B"|"C"|"D"|"F",
    delta: null, confidence: (scored.length >= 1 ? "ok" : "low") as "ok"|"low",
  };
  const summary = { ...buildSummary(db, info, period, now), gateHealth };
  return {
    summary,
    steps: computeStepMetrics({
      transitions,
      stepRuns: listStepRunsByTemplate(db, templateId, since, now),
      stepNames: stepNames(db, templateId),
      nowIso: now, period,
      calibration: computeCalibration(transitions),
    }),
    gates,
    policyGateway: buildPolicyGatewayMetrics(transitions),
  };
```
> If `buildSummary` builds a `.strict()` object without `gateHealth`, spreading then adding the key is fine — the schema now includes it. If `buildSummary` itself Zod-parses, move the `gateHealth` merge inside it instead.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- usecases.gate.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full daemon metrics suite (regression guard)**

Run: `pnpm --filter @orca/daemon test -- metrics`
Expected: PASS — existing step/aggregate/calibration tests still green (gates simply no longer appear in `steps`).

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/usecases.ts apps/daemon/src/metrics/usecases.gate.test.ts
git commit -m "feat(daemon): isolate gates from steps; attach gates + policyGateway + gateHealth to detail"
```

---

## Task 8: Two-readout top strip (Step health ⟂ Gate health)

**Files:**
- Modify: `apps/desktop/src/metrics/MetricsPage.tsx:70-75`
- Test: `apps/desktop/src/metrics/MetricsPage.test.tsx` (add an assertion; file exists)

**Interfaces:**
- Consumes: `TemplateMetricsSummary.gateHealth` (Task 2/7).

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/metrics/MetricsPage.test.tsx`, add (mirror the file's existing mock of `getTemplateMetricsSummaries`/`getTemplateMetricsDetail`; ensure the mocked summary includes `gateHealth: { value: 78, grade: "C", delta: null, confidence: "ok" }`):
```tsx
  it("shows Step health and Gate health as two distinct readouts", async () => {
    render(<MetricsPage />);
    expect(await screen.findByText("Step health")).toBeInTheDocument();
    expect(screen.getByText("Gate health")).toBeInTheDocument();
    expect(screen.queryByText("Workflow health")).toBeNull();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/desktop test -- MetricsPage.test.tsx`
Expected: FAIL — "Step health"/"Gate health" not found; "Workflow health" still present.

- [ ] **Step 3: Replace the health tile with two tiles**

In `apps/desktop/src/metrics/MetricsPage.tsx`, replace the first `StatTile` (line 71, "Workflow health") with two tiles. Keep the existing `health`/`healthColor`/`pctDelta` locals for Step health; read Gate health from `wf.gateHealth`:
```tsx
          <StatTile label="Step health" value={health} accent={healthColor} grade={health == null ? null : gradeFor(health)} delta={pctDelta(wf.deltas.verificationStrength)} deltaGood="up" />
          <StatTile label="Gate health" value={wf.gateHealth.value} accent={wf.gateHealth.value == null ? "var(--text-3)" : wf.gateHealth.value >= 80 ? "var(--run)" : wf.gateHealth.value >= 60 ? "var(--warn)" : "var(--err)"} grade={wf.gateHealth.grade} delta={pctDelta(wf.gateHealth.delta)} deltaGood="up" />
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/desktop test -- MetricsPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics/MetricsPage.tsx apps/desktop/src/metrics/MetricsPage.test.tsx
git commit -m "feat(desktop): Step health + Gate health as two distinct top-strip readouts"
```

---

## Task 9: Gates section (GateRow + panel)

**Files:**
- Create: `apps/desktop/src/metrics/GatePerformance.tsx`
- Modify: `apps/desktop/src/metrics/MetricsPage.tsx` (mount `<GatePerformancePanel />` under `<StepPerformancePanel />`)
- Test: `apps/desktop/src/metrics/GatePerformance.test.tsx`

**Interfaces:**
- Consumes: `GateMetrics`, `TemplateMetricsDetail` (Task 2); `gradeFor` from `metrics-data.ts`; `Panel`, `SectionLabel`, `Sparkline` from `metrics-charts.tsx`; `Pill` from `../workspaces/primitives`.
- Produces: `GatePerformancePanel`, `GateRow`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/metrics/GatePerformance.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GateRow } from "./GatePerformance";
import type { GateMetrics } from "@orca/contracts";

const gate = (over: Partial<GateMetrics> = {}): GateMetrics => ({
  nodeId: "review", name: "Review", evalSubstrate: "shadow", health: 72, grade: "C",
  confidence: "ok", sampleSize: 8, delta: null,
  scored: { overturnRate: 0.2, overturnSampleSize: 8, overturnDecisionIds: ["d1"], groundedness: 0.75, ungroundedDecisionIds: [], convergence: 0.9, limitingTerm: "overturn" },
  cost: { p50LatencyMs: 1200, meanTokens: 3400, meanUsd: 0.02, tokensSpentOnOverturned: 800 },
  failureModes: [{ label: "Approved work a person then sent back", count: 2, pct: 0.25, sampleDecisionIds: ["d1"] }],
  context: { approvalRate: 0.75, rejectRate: 0.25, decisions: 8, meanLoops: 1.4, capHitRate: 0, stagnationRate: 0, parkRate: null, residualRiskBurden: null, recentRejectReasons: [{ at: "2026-07-16", reason: "missing test", issueRefs: ["t1"] }] },
  trend: [], versionBoundaries: [], ...over,
});

describe("GateRow", () => {
  it("renders the resolved gate name, grade, and expands to cost + failure modes — no jargon or raw id", () => {
    const { container } = render(<GateRow gate={gate()} index={0} isLast open onToggle={() => {}} />);
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByText(/Approved work a person then sent back/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/__gate__:/);
    expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });

  it("shows 'unproven' when health is null instead of a failing grade", () => {
    render(<GateRow gate={gate({ health: null, grade: null, scored: { ...gate().scored, overturnRate: null } })} index={0} isLast open onToggle={() => {}} />);
    expect(screen.getByText(/unproven/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/desktop test -- GatePerformance.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `GatePerformance.tsx`**

Create `apps/desktop/src/metrics/GatePerformance.tsx`:
```tsx
import type { GateMetrics, TemplateMetricsDetail } from "@orca/contracts";
import { Pill } from "../workspaces/primitives";
import { gradeFor } from "./metrics-data";
import { Panel, SectionLabel, Sparkline } from "./metrics-charts";
import { ChevronRight } from "./metrics-icons";

const GATE_GRID = "34px minmax(0,1fr) 96px 64px 22px";

function pct(x: number | null): string { return x == null ? "—" : `${Math.round(x * 100)}%`; }

export function GateRow({ gate, index, isLast, open, onToggle }: { gate: GateMetrics; index: number; isLast: boolean; open: boolean; onToggle: () => void }) {
  const color = gate.health == null ? "var(--accent)" : gate.health >= 80 ? "var(--run)" : gate.health >= 60 ? "var(--warn)" : "var(--err)";
  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--hairline)" }}>
      <div onClick={onToggle} style={{ display: "grid", gridTemplateColumns: GATE_GRID, alignItems: "center", gap: 12, padding: "12px 14px", cursor: "pointer" }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, border: `1px solid ${color}`, background: `color-mix(in srgb, ${color} 12%, transparent)`, color, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}>◈</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{gate.name}</span>
            <Pill tone="accent" size="xs">{gate.evalSubstrate === "worker" ? "Agent-reviewed" : "Quick review"}</Pill>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>
              {pct(gate.context.approvalRate)} approved · {gate.context.meanLoops == null ? "—" : `${gate.context.meanLoops.toFixed(1)} loops`}
              {gate.scored.overturnRate != null ? ` · ${pct(gate.scored.overturnRate)} sent back` : ""}
            </span>
          </div>
        </div>
        {gate.trend.length > 0 ? <Sparkline data={gate.trend} color={color} w={84} h={26} /> : <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", textAlign: "center" }}>—</span>}
        <div style={{ textAlign: "right" }}>
          {gate.health == null ? (
            <span className="mono" style={{ fontSize: 12, fontWeight: 600, color }} title="No independent check has confirmed this gate's calls yet — not a failing grade.">unproven</span>
          ) : (
            <>
              <span style={{ fontSize: 20, fontWeight: 600, color, letterSpacing: -0.5 }}>{gate.health}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--text-4)" }}>/100 {gradeFor(gate.health)}</span>
            </>
          )}
        </div>
        <ChevronRight size={13} color="var(--text-3)" style={{ transform: open ? "rotate(90deg)" : "none", justifySelf: "center" }} />
      </div>
      {open && (
        <div style={{ padding: "2px 16px 16px 60px" }}>
          <div style={{ background: "var(--panel-2)", border: "1px solid var(--hairline)", borderRadius: 10, padding: 12 }}>
            <SectionLabel style={{ paddingTop: 0 }}>What's going wrong</SectionLabel>
            {gate.failureModes.length === 0 && <div style={{ fontSize: 12, color: "var(--run)" }}>No problems detected this period.</div>}
            {gate.failureModes.map((f, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: "var(--text-2)", padding: "3px 0" }}>
                <span>{f.label}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{f.count}× · {Math.round(f.pct * 100)}%</span>
              </div>
            ))}
            <SectionLabel>Grounded in checks</SectionLabel>
            <div style={{ fontSize: 12, color: "var(--text-2)" }}>{pct(gate.scored.groundedness)} of calls stood on checks that actually ran.</div>
            <SectionLabel>Cost</SectionLabel>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--text-3)" }}>
              {gate.cost.p50LatencyMs == null ? "—" : `${Math.round(gate.cost.p50LatencyMs)}ms`} · {gate.cost.meanTokens == null ? "—" : `${Math.round(gate.cost.meanTokens)} tok`} · {gate.cost.meanUsd == null ? "—" : `$${gate.cost.meanUsd.toFixed(3)}`}
              {gate.cost.tokensSpentOnOverturned ? ` · ${gate.cost.tokensSpentOnOverturned} tok spent on calls later sent back` : ""}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function GatePerformancePanel({ detail, openGate, onToggleGate }: { detail: TemplateMetricsDetail | null; openGate: string | null; onToggleGate: (nodeId: string) => void }) {
  const gates = detail?.gates ?? [];
  if (gates.length === 0) return null;
  return (
    <Panel title="Gates" kicker="REVIEW POINTS" style={{ marginTop: 12 }} bodyStyle={{ padding: 0 }}>
      {gates.map((g, i) => (
        <GateRow key={g.nodeId} gate={g} index={i} isLast={i === gates.length - 1} open={openGate === g.nodeId} onToggle={() => onToggleGate(g.nodeId)} />
      ))}
    </Panel>
  );
}

export function PolicyGatewayReadout({ detail }: { detail: TemplateMetricsDetail | null }) {
  const pg = detail?.policyGateway;
  if (!pg) return null;
  const total = (pg.decisionDist.allow ?? 0) + (pg.decisionDist.require_approval ?? 0) + (pg.decisionDist.deny ?? 0);
  if (total === 0) return null;
  return (
    <Panel title="Tool safety gateway" kicker="PERMISSIONS" style={{ marginTop: 12 }}>
      <div className="mono" style={{ fontSize: 11.5, color: "var(--text-2)" }}>
        {pg.decisionDist.allow ?? 0} allowed · {pg.decisionDist.require_approval ?? 0} asked first · {pg.decisionDist.deny ?? 0} blocked
      </div>
      {pg.overPermissive.count > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--warn)" }}>⚠ {pg.overPermissive.count} risky action(s) allowed without asking</div>
      )}
    </Panel>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/desktop test -- GatePerformance.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount in MetricsPage**

In `apps/desktop/src/metrics/MetricsPage.tsx`, import and add openGate state + mount below the `<StepPerformancePanel />` (line 77):
```tsx
import { GatePerformancePanel, PolicyGatewayReadout } from "./GatePerformance";
// ...inside the component, near the other useState hooks:
  const [openGate, setOpenGate] = useState<string | null>(null);
// ...directly after <StepPerformancePanel ... />:
        <GatePerformancePanel detail={detail} openGate={openGate} onToggleGate={(id) => setOpenGate((o) => (o === id ? null : id))} />
        <PolicyGatewayReadout detail={detail} />
```

- [ ] **Step 6: Run the full desktop metrics suite**

Run: `pnpm --filter @orca/desktop test -- metrics`
Expected: PASS — including `no-jargon.test.tsx` (GateRow renders no jargon / no `__gate__:`).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/metrics/GatePerformance.tsx apps/desktop/src/metrics/GatePerformance.test.tsx apps/desktop/src/metrics/MetricsPage.tsx
git commit -m "feat(desktop): Gates section + tool-safety gateway readout in Metrics tab"
```

---

## Task 10: End-to-end verification (live app)

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck + test across the workspace**

Run: `pnpm -w typecheck && pnpm -w test`
Expected: all green.

- [ ] **Step 2: Drive the live Metrics tab**

Using the browser at http://localhost:5174/ (Playwright MCP), select the **Adaptive Delivery** workflow in the Metrics dropdown and confirm:
- `__gate__:review` no longer appears in Step performance.
- A **Gates** section renders with named gates (`review`, `verify`, `critique`), each with an approval %, loops, and either a health grade or **"unproven"** where overturn coverage is absent.
- The top strip shows **Step health** and **Gate health** as two tiles.
- A **Tool safety gateway** readout renders when tool-gate decisions exist.
- No raw `__gate__:` id and no jargon anywhere.

- [ ] **Step 3: Add an overturn to see health populate (optional smoke)**

Drive a supervised gate to a park and resolve it AGAINST the gate's recommendation; re-open Metrics and confirm that gate's Gate health becomes a number (overturn coverage now accruing) and a "Approved work a person then sent back" failure mode appears if applicable.

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "test(metrics): live-verify gate telemetry surfaces end-to-end"
```

---

## Self-Review notes
- **Spec coverage:** capture fix (§3 → Task 1); GateMetrics/PolicyGatewayMetrics/summary+detail (§4 → Task 2); gate failure-labels (§4.1/§5.2 → Task 3); fetch + name resolution (§5.2/§5.4 → Task 4); buildGateMetrics incl. overturn/groundedness/convergence/cost/failureModes/honest-null/artifact-ids (§5.2 → Task 5); policy gateway (§5.3 → Task 6); isolate-from-steps + wiring + gateHealth (§5.1/§5.4/§4.3 → Task 7); two-readout strip (§6 → Task 8); Gates section + cost line + failure-mode list + policy readout + no-jargon (§6/§7 → Task 9); live verify (§7 → Task 10).
- **Deferred-honestly (declared null, not placeholder):** `parkRate`, `residualRiskBurden`, gate `delta`/`trend`/`versionBoundaries` — sourced in a follow-up; called out in Task 5.
- **Type consistency:** `GateMetrics` field names match across contract (Task 2), aggregator (Task 5), and UI (Task 9); `buildGateMetrics` input/output signatures match the Task 7 caller.
