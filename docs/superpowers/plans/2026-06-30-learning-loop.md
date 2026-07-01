# Learning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the per-template reflective optimizer (the paper's Evolution Agent): deterministic diagnosis of a template's underperforming steps from A's metrics + revision signals, a single gated LLM call that proposes an instruction edit carrying a full change contract, and a propose → confirm → privileged-apply → canary-watch → rollback/restore lifecycle.

**Architecture:** Control-plane only. A new `apps/daemon/src/learning/` module reads A's `TemplateMetricsDetail` + `step_revision_signals`, runs deterministic trigger rules to pick the worst steps, makes one `broker.propose` call per step to fill the proposal text, and persists change-contract records. A route-gated privileged write applies a confirmed proposal in place even on locked built-ins (capturing a pristine baseline first), and A's `versionComparison` serves as the forward falsifier with an on-read regression alarm. The desktop Self-Improvement rail renders the full lifecycle; the client does zero metric arithmetic.

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), Fastify, better-sqlite3, Vitest, React + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-30-learning-loop-design.md` (approved). Read it before starting.

## Global Constraints

- **Propose-and-confirm — never silent mutation.** No template is edited without a human-confirmed proposal.
- **No execution-plane access.** B touches no `sessions/ pty/ tmux/ adapters/` code. The falsifier is A's forward `versionComparison`, not a re-run.
- **Deterministic core, selective AI.** The engine diagnoses/routes/persists/gates/applies; the LLM fills only `{proposedInstructions, predictedImprovement, invariantsPreserved, rationale}`.
- **Per-template only** (not cross-goal). **Edit target is step `instructions` only** (≤8192 bytes — the field's own cap).
- **Thin client (F4):** every number/flag/delta arrives computed from the server; the desktop performs no metric arithmetic.
- **Additive contracts (F3):** new `@orca/contracts` fields are optional/additive; `OrchestrationDecisionKind` gains a value; no existing response is reshaped.
- **Sample gate:** `SAMPLE_MIN = 5` (reuse A's). Trigger constants: `K = 3` (min cluster count, R2), `M = 3` (min feedback-signal count, R3), `REGRESSION_THRESHOLD = 0.1`, `TOP_N = 3` (proposals per analyze).
- **Instruction-addressable failure codes (R2 eligible):** `invalid_output, output_unavailable, source_truncated, evidence_veto, guardrail_denied`. All other codes are infra/lifecycle and excluded.
- Test runner: `cd apps/daemon && pnpm vitest run <path>` (daemon); `cd packages/contracts && pnpm vitest run <path>` (contracts); `cd apps/desktop && pnpm vitest run <path>` (desktop).
- Commit after every task. Branch is `phase5b-learning-loop` (already created off `main`; the spec commit is on it). Do not commit to `main`.

---

## File structure

**Contracts (new):**
- `packages/contracts/src/learning/index.ts` — `DimensionKey`, `ProposeInstructionRevisionProposal`, `TemplateInstructionProposal`, `ProposalStatus`, `TargetedFailureMode`.
- `packages/contracts/src/index.ts` — add `export * from "./learning/index.js";`.
- `packages/contracts/src/workflows/index.ts` — add `"propose_instruction_revision"` to `OrchestrationDecisionKind`.

**Daemon (new module `apps/daemon/src/learning/`):**
- `migrations/0049_learning_proposals.sql` — the two tables.
- `store.ts` — proposal + baseline CRUD (portable SQL → typed rows).
- `fetch.ts` — `listRevisionSignalsByTemplate` (signals joined to step_template_id, windowed).
- `diagnose.ts` — `diagnoseTemplate` (deterministic rules → diagnosis bundles).
- `propose.ts` — `proposeInstructionRevision` (broker call + validation).
- `apply.ts` — `applyLearnedInstructionEdit`, `rollbackProposal`, `restoreDefault` (privileged writes).
- `canary.ts` — `enrichWithRegression` (on-read version-comparison alarm).
- `usecases.ts` — `analyzeTemplate`, `listProposals`, `applyProposal`, `dismissProposal`, `rollback`, `restore`.
- `routes.ts` — `registerLearningRoutes`.

**Daemon (modified):**
- `apps/daemon/src/server.ts` — register the new routes.

**Desktop (modified):**
- `apps/desktop/src/api.ts` — six learning client fns.
- `apps/desktop/src/metrics/SelfImprovement.tsx` — replace the deferred placeholder with the full rail.
- `apps/desktop/src/metrics/MetricsPage.tsx` — pass `templateId`/`period` to the rail and wire a refetch after mutations.

**Docs (modified):** `ORCA.md`, `FUTURE_WORK.md`, `FUTURE_ARCHITECTURE.md`.

---

### Task 1: Learning contracts + new OrchestrationDecisionKind

Add the read-model schemas to the public spine and the new broker decision kind.

**Files:**
- Create: `packages/contracts/src/learning/index.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/workflows/index.ts`
- Test: `packages/contracts/src/learning/index.test.ts`

**Interfaces:**
- Produces: `DimensionKey`, `ProposalStatus`, `TargetedFailureMode`, `ProposeInstructionRevisionProposal`, `TemplateInstructionProposal` (zod schemas + inferred types).

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/learning/index.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  ProposeInstructionRevisionProposal,
  TemplateInstructionProposal,
} from "./index.js";
import { OrchestrationDecisionKind } from "../workflows/index.js";

describe("learning contracts", () => {
  it("accepts a valid proposal fill and rejects a non-dimension invariant", () => {
    const ok = ProposeInstructionRevisionProposal.safeParse({
      proposedInstructions: "Do X, then verify Y.",
      predictedImprovement: "Higher instruction adherence.",
      invariantsPreserved: ["safetyCompliance", "verificationStrength"],
      rationale: "Targets invalid_output cluster.",
    });
    expect(ok.success).toBe(true);

    const bad = ProposeInstructionRevisionProposal.safeParse({
      proposedInstructions: "x",
      predictedImprovement: "y",
      invariantsPreserved: ["not_a_dimension"],
      rationale: "z",
    });
    expect(bad.success).toBe(false);
  });

  it("round-trips a TemplateInstructionProposal", () => {
    const p = {
      id: "p1", templateId: "tpl", templateVersionAtProposal: 2, stepTemplateId: "s1",
      component: "step_instructions" as const,
      beforeInstructions: "old", afterInstructions: "new",
      targetedFailureMode: { rule: "R2" as const, failureCode: "invalid_output", clusterCount: 8, signalCount: null },
      predictedImprovement: "fewer invalid outputs",
      invariantsPreserved: ["safetyCompliance" as const],
      falsifier: "version_comparison" as const,
      rollbackPlan: "revert_to_before" as const,
      evidence: { sampleTransitionIds: ["t1"], revisionSignalIds: [], metricSnapshot: { score: 62, verdictPassRate: 0.57, oracleSufficientRate: 0.8, versionDelta: null } },
      rationale: "because",
      humanEdited: false,
      status: "pending" as const,
      createdAt: "2026-06-30T00:00:00.000Z",
      decidedAt: null, decidedBy: null, appliedAsVersion: null,
    };
    expect(TemplateInstructionProposal.parse(p)).toMatchObject(p);
  });

  it("includes propose_instruction_revision in OrchestrationDecisionKind", () => {
    expect(OrchestrationDecisionKind.safeParse("propose_instruction_revision").success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/contracts && pnpm vitest run src/learning/index.test.ts`
Expected: FAIL — module `./index.js` not found.

- [ ] **Step 3: Write the contracts**

Create `packages/contracts/src/learning/index.ts`:

```typescript
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
```

- [ ] **Step 4: Add the decision kind + index export**

In `packages/contracts/src/workflows/index.ts`, find `export const OrchestrationDecisionKind = z.enum([` and add `"propose_instruction_revision",` to the array (additive — keep all existing values).

In `packages/contracts/src/index.ts`, after `export * from "./metrics/index.js";` add:

```typescript
export * from "./learning/index.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/contracts && pnpm vitest run src/learning/index.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/learning packages/contracts/src/index.ts packages/contracts/src/workflows/index.ts
git commit -m "feat(contracts): learning-loop schemas + propose_instruction_revision kind"
```

---

### Task 2: Migration + proposal/baseline store

Create the two additive tables and a typed store over them.

**Files:**
- Create: `apps/daemon/migrations/0049_learning_proposals.sql`, `apps/daemon/src/learning/store.ts`
- Test: `apps/daemon/src/learning/store.test.ts`

**Interfaces:**
- Produces:
  - `insertProposal(db, p: TemplateInstructionProposal): void`
  - `getProposal(db, id): TemplateInstructionProposal | null`
  - `listProposalsByTemplate(db, templateId): TemplateInstructionProposal[]`
  - `pendingProposalForStep(db, templateId, stepTemplateId): TemplateInstructionProposal | null`
  - `updateProposalDecision(db, id, patch: { status: ProposalStatus; decidedAt?: string | null; decidedBy?: string | null; appliedAsVersion?: number | null; afterInstructions?: string; humanEdited?: boolean }): void`
  - `supersedeOtherPending(db, templateId, stepTemplateId, exceptId): void`
  - `supersedeAppliedForTemplate(db, templateId): void`
  - `getBaseline(db, templateId): { templateId: string; baselineStepsJson: string; capturedAt: string; restoredAt: string | null } | null`
  - `captureBaseline(db, templateId, stepsJson, now): void` (no-op if a baseline row already exists)
  - `markBaselineRestored(db, templateId, now): void`

- [ ] **Step 1: Write the migration**

Create `apps/daemon/migrations/0049_learning_proposals.sql`:

```sql
CREATE TABLE template_instruction_proposals (
  id                           TEXT PRIMARY KEY,
  template_id                  TEXT NOT NULL,
  template_version_at_proposal INTEGER NOT NULL,
  step_template_id             TEXT NOT NULL,
  before_instructions          TEXT NOT NULL,
  after_instructions           TEXT NOT NULL,
  targeted_failure_mode_json   TEXT NOT NULL,
  predicted_improvement        TEXT NOT NULL,
  invariants_preserved_json    TEXT NOT NULL,
  evidence_json                TEXT NOT NULL,
  rationale                    TEXT NOT NULL,
  human_edited                 INTEGER NOT NULL DEFAULT 0,
  status                       TEXT NOT NULL,
  created_at                   TEXT NOT NULL,
  decided_at                   TEXT,
  decided_by                   TEXT,
  applied_as_version           INTEGER
);
CREATE INDEX idx_proposals_template ON template_instruction_proposals (template_id, status);

CREATE TABLE learning_template_baselines (
  template_id         TEXT PRIMARY KEY,
  baseline_steps_json TEXT NOT NULL,
  captured_at         TEXT NOT NULL,
  restored_at         TEXT
);
```

- [ ] **Step 2: Write the failing test**

Create `apps/daemon/src/learning/store.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { TemplateInstructionProposal } from "@orca/contracts";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import {
  insertProposal, getProposal, listProposalsByTemplate, pendingProposalForStep,
  updateProposalDecision, supersedeOtherPending, captureBaseline, getBaseline, markBaselineRestored,
} from "./store.js";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-learning-store-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
function proposal(over: Partial<TemplateInstructionProposal> = {}): TemplateInstructionProposal {
  return {
    id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1",
    component: "step_instructions", beforeInstructions: "old", afterInstructions: "new",
    targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
    predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"],
    falsifier: "version_comparison", rollbackPlan: "revert_to_before",
    evidence: { sampleTransitionIds: ["t1"], revisionSignalIds: [], metricSnapshot: { score: 62, verdictPassRate: 0.5, oracleSufficientRate: 0.8, versionDelta: null } },
    rationale: "r", humanEdited: false, status: "pending",
    createdAt: "2026-06-30T00:00:00.000Z", decidedAt: null, decidedBy: null, appliedAsVersion: null, ...over,
  };
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("learning store", () => {
  it("inserts and reads back a proposal", () => {
    insertProposal(db, proposal());
    expect(getProposal(db, "p1")).toMatchObject({ id: "p1", status: "pending" });
    expect(listProposalsByTemplate(db, "tpl")).toHaveLength(1);
    expect(pendingProposalForStep(db, "tpl", "s1")?.id).toBe("p1");
  });

  it("updates decision and supersedes other pending for the step", () => {
    insertProposal(db, proposal({ id: "p1" }));
    insertProposal(db, proposal({ id: "p2" }));
    updateProposalDecision(db, "p1", { status: "applied", decidedAt: "2026-06-30T01:00:00.000Z", decidedBy: "owner", appliedAsVersion: 2 });
    supersedeOtherPending(db, "tpl", "s1", "p1");
    expect(getProposal(db, "p1")).toMatchObject({ status: "applied", appliedAsVersion: 2, decidedBy: "owner" });
    expect(getProposal(db, "p2")?.status).toBe("superseded");
  });

  it("captures a baseline once and marks it restored", () => {
    captureBaseline(db, "tpl", '[{"id":"s1"}]', "2026-06-30T00:00:00.000Z");
    captureBaseline(db, "tpl", '[{"id":"CHANGED"}]', "2026-06-30T02:00:00.000Z"); // no-op
    expect(getBaseline(db, "tpl")?.baselineStepsJson).toBe('[{"id":"s1"}]');
    markBaselineRestored(db, "tpl", "2026-06-30T03:00:00.000Z");
    expect(getBaseline(db, "tpl")?.restoredAt).toBe("2026-06-30T03:00:00.000Z");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/learning/store.test.ts`
Expected: FAIL — `./store.js` not found.

- [ ] **Step 4: Write the store**

Create `apps/daemon/src/learning/store.ts`:

```typescript
import type Database from "better-sqlite3";
import { TemplateInstructionProposal, type ProposalStatus } from "@orca/contracts";

interface Row {
  id: string; template_id: string; template_version_at_proposal: number; step_template_id: string;
  before_instructions: string; after_instructions: string; targeted_failure_mode_json: string;
  predicted_improvement: string; invariants_preserved_json: string; evidence_json: string;
  rationale: string; human_edited: number; status: string; created_at: string;
  decided_at: string | null; decided_by: string | null; applied_as_version: number | null;
}

function rowToProposal(r: Row): TemplateInstructionProposal {
  return TemplateInstructionProposal.parse({
    id: r.id, templateId: r.template_id, templateVersionAtProposal: r.template_version_at_proposal,
    stepTemplateId: r.step_template_id, component: "step_instructions",
    beforeInstructions: r.before_instructions, afterInstructions: r.after_instructions,
    targetedFailureMode: JSON.parse(r.targeted_failure_mode_json),
    predictedImprovement: r.predicted_improvement,
    invariantsPreserved: JSON.parse(r.invariants_preserved_json),
    falsifier: "version_comparison", rollbackPlan: "revert_to_before",
    evidence: JSON.parse(r.evidence_json), rationale: r.rationale,
    humanEdited: r.human_edited === 1, status: r.status,
    createdAt: r.created_at, decidedAt: r.decided_at, decidedBy: r.decided_by,
    appliedAsVersion: r.applied_as_version,
  });
}

export function insertProposal(db: Database.Database, p: TemplateInstructionProposal): void {
  db.prepare(
    `INSERT INTO template_instruction_proposals
      (id, template_id, template_version_at_proposal, step_template_id, before_instructions,
       after_instructions, targeted_failure_mode_json, predicted_improvement, invariants_preserved_json,
       evidence_json, rationale, human_edited, status, created_at, decided_at, decided_by, applied_as_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    p.id, p.templateId, p.templateVersionAtProposal, p.stepTemplateId, p.beforeInstructions,
    p.afterInstructions, JSON.stringify(p.targetedFailureMode), p.predictedImprovement,
    JSON.stringify(p.invariantsPreserved), JSON.stringify(p.evidence), p.rationale,
    p.humanEdited ? 1 : 0, p.status, p.createdAt, p.decidedAt, p.decidedBy, p.appliedAsVersion,
  );
}

export function getProposal(db: Database.Database, id: string): TemplateInstructionProposal | null {
  const r = db.prepare(`SELECT * FROM template_instruction_proposals WHERE id = ?`).get(id) as Row | undefined;
  return r ? rowToProposal(r) : null;
}

export function listProposalsByTemplate(db: Database.Database, templateId: string): TemplateInstructionProposal[] {
  const rows = db.prepare(
    `SELECT * FROM template_instruction_proposals WHERE template_id = ? ORDER BY created_at DESC, id DESC`
  ).all(templateId) as Row[];
  return rows.map(rowToProposal);
}

export function pendingProposalForStep(db: Database.Database, templateId: string, stepTemplateId: string): TemplateInstructionProposal | null {
  const r = db.prepare(
    `SELECT * FROM template_instruction_proposals WHERE template_id = ? AND step_template_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`
  ).get(templateId, stepTemplateId) as Row | undefined;
  return r ? rowToProposal(r) : null;
}

export function updateProposalDecision(
  db: Database.Database, id: string,
  patch: { status: ProposalStatus; decidedAt?: string | null; decidedBy?: string | null;
           appliedAsVersion?: number | null; afterInstructions?: string; humanEdited?: boolean },
): void {
  const cur = db.prepare(`SELECT * FROM template_instruction_proposals WHERE id = ?`).get(id) as Row | undefined;
  if (!cur) return;
  db.prepare(
    `UPDATE template_instruction_proposals
       SET status = ?, decided_at = ?, decided_by = ?, applied_as_version = ?, after_instructions = ?, human_edited = ?
     WHERE id = ?`
  ).run(
    patch.status,
    patch.decidedAt !== undefined ? patch.decidedAt : cur.decided_at,
    patch.decidedBy !== undefined ? patch.decidedBy : cur.decided_by,
    patch.appliedAsVersion !== undefined ? patch.appliedAsVersion : cur.applied_as_version,
    patch.afterInstructions !== undefined ? patch.afterInstructions : cur.after_instructions,
    patch.humanEdited !== undefined ? (patch.humanEdited ? 1 : 0) : cur.human_edited,
    id,
  );
}

export function supersedeOtherPending(db: Database.Database, templateId: string, stepTemplateId: string, exceptId: string): void {
  db.prepare(
    `UPDATE template_instruction_proposals SET status = 'superseded'
     WHERE template_id = ? AND step_template_id = ? AND status = 'pending' AND id != ?`
  ).run(templateId, stepTemplateId, exceptId);
}

export function supersedeAppliedForTemplate(db: Database.Database, templateId: string): void {
  db.prepare(
    `UPDATE template_instruction_proposals SET status = 'superseded' WHERE template_id = ? AND status = 'applied'`
  ).run(templateId);
}

export function getBaseline(db: Database.Database, templateId: string) {
  const r = db.prepare(`SELECT * FROM learning_template_baselines WHERE template_id = ?`).get(templateId) as
    { template_id: string; baseline_steps_json: string; captured_at: string; restored_at: string | null } | undefined;
  return r ? { templateId: r.template_id, baselineStepsJson: r.baseline_steps_json, capturedAt: r.captured_at, restoredAt: r.restored_at } : null;
}

export function captureBaseline(db: Database.Database, templateId: string, stepsJson: string, now: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO learning_template_baselines (template_id, baseline_steps_json, captured_at, restored_at)
     VALUES (?,?,?,NULL)`
  ).run(templateId, stepsJson, now);
}

export function markBaselineRestored(db: Database.Database, templateId: string, now: string): void {
  db.prepare(`UPDATE learning_template_baselines SET restored_at = ? WHERE template_id = ?`).run(now, templateId);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/learning/store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/migrations/0049_learning_proposals.sql apps/daemon/src/learning/store.ts apps/daemon/src/learning/store.test.ts
git commit -m "feat(daemon): learning proposal + baseline store (migration 0049)"
```

---

### Task 3: Revision-signal-by-template fetch

Fetch revision signals for a template's steps within a window, grouped by `step_template_id` — the R3 signal and the LLM's feedback evidence. Portable JSON-free join.

**Files:**
- Create: `apps/daemon/src/learning/fetch.ts`
- Test: `apps/daemon/src/learning/fetch.test.ts`

**Interfaces:**
- Produces:
  - `type TemplateRevisionSignal = { id: string; stepTemplateId: string; feedbackText: string | null; createdAt: string }`
  - `listRevisionSignalsByTemplate(db, templateId, sinceIso, untilIso): TemplateRevisionSignal[]`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/learning/fetch.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { listRevisionSignalsByTemplate } from "./fetch.js";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-learning-fetch-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
function seed(db: Database.Database) {
  db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at)
              VALUES ('g','G','','active',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`).run();
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
              VALUES ('tpl','Brainstorm','',1,1,1,'[{"id":"s1","name":"Generate"}]','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_runs (id,goal_id,template_id,template_version,status,current_step_run_id,blocked_reason,started_at,finished_at)
              VALUES ('run1','g','tpl',1,'completed',NULL,NULL,'2026-05-01T00:00:00.000Z','2026-05-01T01:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_step_runs (id,goal_id,workflow_run_id,step_template_id,ordinal,attempt,status,satisfied_exit_criteria_json,outstanding_exit_criteria_json,blocked_reason,started_at,finished_at,fingerprint)
              VALUES ('sr1','g','run1','s1',0,1,'passed','[]','[]',NULL,'2026-05-01T00:00:00.000Z','2026-05-01T00:10:00.000Z','fp1')`).run();
  const scoring = JSON.stringify({ successScore: 0.5, quality: { outputCompleteness: 0.5, outputCorrectness: 0.5, instructionAdherence: 0.5, downstreamReadiness: 0.5, riskLevel: 0.2 }, reason: "x", handoffReady: false });
  db.prepare(`INSERT INTO step_revision_signals (id,step_run_id,goal_id,revision_index,superseded_scoring_json,feedback_text,created_at)
              VALUES ('rs1','sr1','g',0,?,'follow the output schema','2026-05-01T00:05:00.000Z')`).run(scoring);
  db.prepare(`INSERT INTO step_revision_signals (id,step_run_id,goal_id,revision_index,superseded_scoring_json,feedback_text,created_at)
              VALUES ('rs2','sr1','g',1,?,NULL,'2026-05-01T00:06:00.000Z')`).run(scoring);
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); seed(db); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("listRevisionSignalsByTemplate", () => {
  it("joins signals to step_template_id within the window", () => {
    const rows = listRevisionSignalsByTemplate(db, "tpl", "2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z");
    expect(rows).toHaveLength(2);
    expect(rows[0].stepTemplateId).toBe("s1");
    expect(rows.map((r) => r.feedbackText)).toContain("follow the output schema");
  });
  it("excludes signals outside the window", () => {
    const rows = listRevisionSignalsByTemplate(db, "tpl", "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/learning/fetch.test.ts`
Expected: FAIL — `./fetch.js` not found.

- [ ] **Step 3: Write the fetch**

Create `apps/daemon/src/learning/fetch.ts`:

```typescript
import type Database from "better-sqlite3";

export type TemplateRevisionSignal = {
  id: string;
  stepTemplateId: string;
  feedbackText: string | null;
  createdAt: string;
};

// Portable JSON-free join: step_revision_signals -> workflow_step_runs (step_template_id)
// -> workflow_runs (template_id), windowed on the signal's created_at.
export function listRevisionSignalsByTemplate(
  db: Database.Database, templateId: string, sinceIso: string, untilIso: string,
): TemplateRevisionSignal[] {
  const rows = db.prepare(
    `SELECT srs.id AS id, wsr.step_template_id AS step_template_id,
            srs.feedback_text AS feedback_text, srs.created_at AS created_at
     FROM step_revision_signals srs
     JOIN workflow_step_runs wsr ON wsr.id = srs.step_run_id
     JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
     WHERE wr.template_id = ? AND srs.created_at >= ? AND srs.created_at < ?
     ORDER BY srs.created_at ASC, srs.id ASC`
  ).all(templateId, sinceIso, untilIso) as {
    id: string; step_template_id: string; feedback_text: string | null; created_at: string;
  }[];
  return rows.map((r) => ({ id: r.id, stepTemplateId: r.step_template_id, feedbackText: r.feedback_text, createdAt: r.created_at }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/learning/fetch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning/fetch.ts apps/daemon/src/learning/fetch.test.ts
git commit -m "feat(daemon): revision-signal-by-template fetch for diagnosis"
```

---

### Task 4: Deterministic diagnosis

Turn A's `TemplateMetricsDetail` + the revision signals into diagnosis bundles via the four trigger rules, the sample gate, the instruction-addressable filter, and the top-3 cap.

**Files:**
- Create: `apps/daemon/src/learning/diagnose.ts`
- Test: `apps/daemon/src/learning/diagnose.test.ts`

**Interfaces:**
- Consumes: `TemplateMetricsDetail`, `StepMetrics` (`@orca/contracts`); `TemplateRevisionSignal` (Task 3).
- Produces:
  - `INSTRUCTION_ADDRESSABLE: ReadonlySet<string>`
  - `type DiagnosisBundle = { stepTemplateId: string; currentInstructions: string; targetedFailureMode: TargetedFailureMode; evidence: { sampleTransitionIds: string[]; revisionSignalIds: string[]; revisionFeedbackTexts: string[]; metricSnapshot: { score: number; verdictPassRate: number; oracleSufficientRate: number; versionDelta: number | null } } }`
  - `diagnoseTemplate(input: { detail: TemplateMetricsDetail; signals: TemplateRevisionSignal[]; stepInstructions: Map<string, string> }): DiagnosisBundle[]`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/learning/diagnose.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { StepMetrics, TemplateMetricsDetail } from "@orca/contracts";
import { diagnoseTemplate, INSTRUCTION_ADDRESSABLE } from "./diagnose.js";

function step(over: Partial<StepMetrics> = {}): StepMetrics {
  return {
    stepTemplateId: "s1", name: "Generate", ordinal: 0,
    score: 60, sampleSize: 12, confidence: "ok",
    runs: 12, passedFirstTry: 6, recovered: 2, failed: 4,
    quality: { verdictPassRate: 0.57, sensorPassRate: 0.9, oracleSufficientRate: 0.8, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
    cost: { p50LatencyMs: 100, meanTokens: 1000, meanUsd: 0.01, meanRetries: 0.2 },
    risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
    failureClusters: [{ failureCode: "invalid_output", boundary: "step_complete", count: 8, sampleTransitionIds: ["t1", "t2"] }],
    trend: [], versionBoundaries: [], insights: [], recentReasons: [], ...over,
  };
}
function detail(steps: StepMetrics[]): TemplateMetricsDetail {
  return {
    summary: {
      templateId: "tpl", name: "Brainstorm", latestVersion: 2, runs: 12,
      dimensions: { trajectoryEfficiency: { value: 0.8 }, verificationStrength: { value: 0.6 }, recovery: { value: 0.5 }, stateConsistency: { value: 1 }, safetyCompliance: { value: 1 }, replayability: { value: 1 } },
      firstPass: 0.5, recovered: 0.2, escalated: 0.05, latencyP50Ms: 100,
      deltas: { trajectoryEfficiency: null, verificationStrength: null, recovery: null, stateConsistency: null, safetyCompliance: null, replayability: null, latencyP50Ms: null },
      versionComparison: { latest: 2, prior: 1, byDimension: { verificationStrength: -0.05 } },
      versions: [], confidence: "ok",
    },
    steps,
  };
}
const instr = new Map([["s1", "Generate a proposal."]]);

describe("diagnoseTemplate", () => {
  it("flags an instruction-addressable cluster (R2) and carries evidence", () => {
    const out = diagnoseTemplate({ detail: detail([step()]), signals: [], stepInstructions: instr });
    expect(out).toHaveLength(1);
    expect(out[0].stepTemplateId).toBe("s1");
    expect(out[0].targetedFailureMode.rule).toBe("R2");
    expect(out[0].targetedFailureMode.failureCode).toBe("invalid_output");
    expect(out[0].evidence.sampleTransitionIds).toEqual(["t1", "t2"]);
    expect(out[0].currentInstructions).toBe("Generate a proposal.");
  });

  it("suppresses steps below the sample threshold", () => {
    const out = diagnoseTemplate({ detail: detail([step({ sampleSize: 3, confidence: "low" })]), signals: [], stepInstructions: instr });
    expect(out).toHaveLength(0);
  });

  it("excludes infra-coded clusters but keeps revision-signal density (R3)", () => {
    const infra = step({ score: 95, failureClusters: [{ failureCode: "daemon_restart", boundary: "step_complete", count: 9, sampleTransitionIds: ["t9"] }] });
    const signals = [
      { id: "rs1", stepTemplateId: "s1", feedbackText: "fix the schema", createdAt: "2026-05-01T00:00:00.000Z" },
      { id: "rs2", stepTemplateId: "s1", feedbackText: "still wrong", createdAt: "2026-05-01T00:01:00.000Z" },
      { id: "rs3", stepTemplateId: "s1", feedbackText: "again", createdAt: "2026-05-01T00:02:00.000Z" },
    ];
    const out = diagnoseTemplate({ detail: detail([infra]), signals, stepInstructions: instr });
    expect(out).toHaveLength(1);
    expect(out[0].targetedFailureMode.rule).toBe("R3");
    expect(out[0].targetedFailureMode.signalCount).toBe(3);
    expect(out[0].evidence.revisionSignalIds).toEqual(["rs1", "rs2", "rs3"]);
  });

  it("INSTRUCTION_ADDRESSABLE excludes infra codes", () => {
    expect(INSTRUCTION_ADDRESSABLE.has("invalid_output")).toBe(true);
    expect(INSTRUCTION_ADDRESSABLE.has("daemon_restart")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/learning/diagnose.test.ts`
Expected: FAIL — `./diagnose.js` not found.

- [ ] **Step 3: Write the diagnosis module**

Create `apps/daemon/src/learning/diagnose.ts`:

```typescript
import type { StepMetrics, TargetedFailureMode, TemplateMetricsDetail } from "@orca/contracts";
import type { TemplateRevisionSignal } from "./fetch.js";

export const SAMPLE_MIN = 5;
const K = 3; // R2 min cluster count
const M = 3; // R3 min feedback-signal count
const TOP_N = 3;

export const INSTRUCTION_ADDRESSABLE: ReadonlySet<string> = new Set([
  "invalid_output", "output_unavailable", "source_truncated", "evidence_veto", "guardrail_denied",
]);

export type DiagnosisBundle = {
  stepTemplateId: string;
  currentInstructions: string;
  targetedFailureMode: TargetedFailureMode;
  evidence: {
    sampleTransitionIds: string[];
    revisionSignalIds: string[];
    revisionFeedbackTexts: string[];
    metricSnapshot: { score: number; verdictPassRate: number; oracleSufficientRate: number; versionDelta: number | null };
  };
};

function chooseRule(step: StepMetrics, feedbackSignals: TemplateRevisionSignal[]): TargetedFailureMode | null {
  // R3 — revision-signal density (highest signal; instruction-related regardless of code).
  if (feedbackSignals.length >= M) {
    return { rule: "R3", failureCode: null, clusterCount: null, signalCount: feedbackSignals.length };
  }
  // R2 — dominant instruction-addressable cluster.
  const cluster = step.failureClusters
    .filter((c) => c.failureCode != null && INSTRUCTION_ADDRESSABLE.has(c.failureCode) && c.count >= K)
    .sort((a, b) => b.count - a.count)[0];
  if (cluster) {
    return { rule: "R2", failureCode: cluster.failureCode, clusterCount: cluster.count, signalCount: null };
  }
  // R4 — false confidence (high pass, low oracle).
  if (step.quality.verdictPassRate >= 0.8 && step.quality.oracleSufficientRate < 0.5) {
    return { rule: "R4", failureCode: null, clusterCount: null, signalCount: null };
  }
  // R1 — underperforming headline (degraded/watch ~ score < 80).
  if (step.score < 80) {
    return { rule: "R1", failureCode: null, clusterCount: null, signalCount: null };
  }
  return null;
}

export function diagnoseTemplate(input: {
  detail: TemplateMetricsDetail;
  signals: TemplateRevisionSignal[];
  stepInstructions: Map<string, string>;
}): DiagnosisBundle[] {
  const versionDelta = input.detail.summary.versionComparison?.byDimension.verificationStrength ?? null;
  const signalsByStep = new Map<string, TemplateRevisionSignal[]>();
  for (const s of input.signals) {
    if (s.feedbackText == null) continue;
    (signalsByStep.get(s.stepTemplateId) ?? signalsByStep.set(s.stepTemplateId, []).get(s.stepTemplateId)!).push(s);
  }

  const eligible = input.detail.steps.filter((s) => s.confidence === "ok" && s.sampleSize >= SAMPLE_MIN);
  const bundles: DiagnosisBundle[] = [];
  for (const step of eligible) {
    const feedback = signalsByStep.get(step.stepTemplateId) ?? [];
    const mode = chooseRule(step, feedback);
    if (!mode) continue;
    const sampleTransitionIds = step.failureClusters.flatMap((c) => c.sampleTransitionIds).slice(0, 6);
    bundles.push({
      stepTemplateId: step.stepTemplateId,
      currentInstructions: input.stepInstructions.get(step.stepTemplateId) ?? "",
      targetedFailureMode: mode,
      evidence: {
        sampleTransitionIds,
        revisionSignalIds: feedback.map((f) => f.id),
        revisionFeedbackTexts: feedback.map((f) => f.feedbackText!).slice(0, 5),
        metricSnapshot: { score: step.score, verdictPassRate: step.quality.verdictPassRate, oracleSufficientRate: step.quality.oracleSufficientRate, versionDelta },
      },
    });
  }
  // Worst-first, capped.
  return bundles.sort((a, b) => a.evidence.metricSnapshot.score - b.evidence.metricSnapshot.score).slice(0, TOP_N);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/learning/diagnose.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning/diagnose.ts apps/daemon/src/learning/diagnose.test.ts
git commit -m "feat(daemon): deterministic diagnosis (R1-R4, sample gate, top-3)"
```

---

### Task 5: Propose (broker call + validation)

Turn one diagnosis bundle into a validated proposal fill via the broker.

**Files:**
- Create: `apps/daemon/src/learning/propose.ts`
- Test: `apps/daemon/src/learning/propose.test.ts`

**Interfaces:**
- Consumes: `DiagnosisBundle` (Task 4); `OrchestrationRequest`, `ProposeInstructionRevisionProposal` (`@orca/contracts`).
- Produces:
  - `type BrokerLike = { propose(request: OrchestrationRequest, options: { validateProposal: (raw: unknown) => { accepted: true; parsed?: unknown } | { accepted: false; failureMessage?: string | null } }): Promise<{ status: "proposed"; parsed: unknown } | { status: "needs_human_review"; reviewPayloadId: string }> }`
  - `buildProposePayload(bundle: DiagnosisBundle): Record<string, unknown>`
  - `validateRevisionProposal(currentInstructions: string): (raw: unknown) => { accepted: true; parsed: ProposeInstructionRevisionProposal } | { accepted: false; failureMessage: string }`
  - `proposeInstructionRevision(deps: { broker: BrokerLike; providerId: string; modelId: string }, ctx: { goalId: string; workflowRunId: string; stepRunId: string }, bundle: DiagnosisBundle): Promise<ProposeInstructionRevisionProposal | null>` (null when the broker can't produce a valid fill)

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/learning/propose.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import type { DiagnosisBundle } from "./diagnose.js";
import { buildProposePayload, validateRevisionProposal, proposeInstructionRevision, type BrokerLike } from "./propose.js";

const bundle: DiagnosisBundle = {
  stepTemplateId: "s1", currentInstructions: "Generate a proposal.",
  targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
  evidence: { sampleTransitionIds: ["t1"], revisionSignalIds: ["rs1"], revisionFeedbackTexts: ["follow the schema"], metricSnapshot: { score: 60, verdictPassRate: 0.57, oracleSufficientRate: 0.8, versionDelta: -0.05 } },
};

describe("buildProposePayload", () => {
  it("compacts the bundle (instruction, failure mode, feedback, snapshot)", () => {
    const payload = buildProposePayload(bundle);
    expect(payload).toMatchObject({ currentInstructions: "Generate a proposal.", targetedFailureMode: { rule: "R2" } });
    expect(JSON.stringify(payload).length).toBeLessThan(65536);
  });
});

describe("validateRevisionProposal", () => {
  const validate = validateRevisionProposal("Generate a proposal.");
  it("rejects empty / oversized / identical / bad-invariant fills", () => {
    expect(validate({ proposedInstructions: "", predictedImprovement: "x", invariantsPreserved: [], rationale: "r" }).accepted).toBe(false);
    expect(validate({ proposedInstructions: "Generate a proposal.", predictedImprovement: "x", invariantsPreserved: [], rationale: "r" }).accepted).toBe(false);
    expect(validate({ proposedInstructions: "New text.", predictedImprovement: "x", invariantsPreserved: ["nope"], rationale: "r" }).accepted).toBe(false);
  });
  it("accepts a valid fill", () => {
    const res = validate({ proposedInstructions: "Generate a proposal and validate it against the output schema.", predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], rationale: "r" });
    expect(res.accepted).toBe(true);
  });
});

describe("proposeInstructionRevision", () => {
  it("returns the parsed fill on a proposed result", async () => {
    const parsed = { proposedInstructions: "New, schema-aware instruction.", predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], rationale: "r" };
    const broker: BrokerLike = { propose: vi.fn(async (_req, opts) => { opts.validateProposal(parsed); return { status: "proposed", parsed }; }) };
    const out = await proposeInstructionRevision({ broker, providerId: "orca/anthropic", modelId: "m" }, { goalId: "g", workflowRunId: "r", stepRunId: "sr" }, bundle);
    expect(out?.proposedInstructions).toBe("New, schema-aware instruction.");
  });
  it("returns null when the broker escalates to human review", async () => {
    const broker: BrokerLike = { propose: vi.fn(async () => ({ status: "needs_human_review", reviewPayloadId: "x" })) };
    const out = await proposeInstructionRevision({ broker, providerId: "p", modelId: "m" }, { goalId: "g", workflowRunId: "r", stepRunId: "sr" }, bundle);
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/learning/propose.test.ts`
Expected: FAIL — `./propose.js` not found.

- [ ] **Step 3: Write the propose module**

Create `apps/daemon/src/learning/propose.ts`:

```typescript
import { ProposeInstructionRevisionProposal, type OrchestrationRequest } from "@orca/contracts";
import type { DiagnosisBundle } from "./diagnose.js";

export type BrokerLike = {
  propose(
    request: OrchestrationRequest,
    options: { validateProposal: (raw: unknown) => { accepted: true; parsed?: unknown } | { accepted: false; failureMessage?: string | null } },
  ): Promise<{ status: "proposed"; parsed: unknown } | { status: "needs_human_review"; reviewPayloadId: string }>;
};

const INSTRUCTION =
  "You are improving one step's instruction text for a workflow template. Produce a MINIMAL, targeted edit " +
  "that addresses the diagnosed failure mode while preserving the listed invariants. Fix the diagnosed failure; " +
  "do not rewrite what already works. Return only the structured proposal.";

export function buildProposePayload(bundle: DiagnosisBundle): Record<string, unknown> {
  return {
    instruction: INSTRUCTION,
    currentInstructions: bundle.currentInstructions,
    targetedFailureMode: bundle.targetedFailureMode,
    revisionFeedbackTexts: bundle.evidence.revisionFeedbackTexts,
    metricSnapshot: bundle.evidence.metricSnapshot,
  };
}

export function validateRevisionProposal(currentInstructions: string) {
  return (raw: unknown): { accepted: true; parsed: ProposeInstructionRevisionProposal } | { accepted: false; failureMessage: string } => {
    const parsed = ProposeInstructionRevisionProposal.safeParse(raw);
    if (!parsed.success) return { accepted: false, failureMessage: "proposal failed schema (check invariant keys / length)" };
    if (parsed.data.proposedInstructions.trim() === currentInstructions.trim()) {
      return { accepted: false, failureMessage: "proposed instructions are identical to current (no-op)" };
    }
    return { accepted: true, parsed: parsed.data };
  };
}

export async function proposeInstructionRevision(
  deps: { broker: BrokerLike; providerId: string; modelId: string },
  ctx: { goalId: string; workflowRunId: string; stepRunId: string },
  bundle: DiagnosisBundle,
): Promise<ProposeInstructionRevisionProposal | null> {
  const request: OrchestrationRequest = {
    kind: "propose_instruction_revision",
    goalId: ctx.goalId, workflowRunId: ctx.workflowRunId, stepRunId: ctx.stepRunId,
    providerId: deps.providerId, modelId: deps.modelId,
    payload: buildProposePayload(bundle),
  } as OrchestrationRequest;

  const result = await deps.broker.propose(request, { validateProposal: validateRevisionProposal(bundle.currentInstructions) });
  if (result.status !== "proposed") return null;
  const parsed = ProposeInstructionRevisionProposal.safeParse(result.parsed);
  return parsed.success ? parsed.data : null;
}
```

Note: `OrchestrationRequest` is cast because B sets the run-scoped fields from a representative evidence transition; the cast documents that B reuses the run-scoped shape with anchor ids. If `OrchestrationRequest` carries fields beyond those set here, the implementer fills them from the same place `step-result-scoring.ts` builds its request (mirror its construction).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/learning/propose.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning/propose.ts apps/daemon/src/learning/propose.test.ts
git commit -m "feat(daemon): broker-backed instruction-revision proposal + validation"
```

---

### Task 6: Privileged apply / rollback / restore

The governed writes. Each edits `steps_json` for one step, bumps `version`, and is reachable only here (bypassing the lock that the generic PATCH enforces).

**Files:**
- Create: `apps/daemon/src/learning/apply.ts`
- Test: `apps/daemon/src/learning/apply.test.ts`

**Interfaces:**
- Consumes: store fns (Task 2).
- Produces:
  - `setStepInstructionsInPlace(db, templateId, stepTemplateId, instructions): number` (returns the new version; throws `StepNotFoundError` if the step id is absent)
  - `applyLearnedInstructionEdit(db, proposalId, opts: { editedInstructions?: string; decidedBy: string; now: string }): { newVersion: number }` (throws `StaleProposalError` / `ProposalNotPendingError`)
  - `rollbackAppliedProposal(db, proposalId, opts: { decidedBy: string; now: string }): { newVersion: number }` (throws `ProposalNotAppliedError`)
  - `restoreTemplateDefault(db, templateId, now): { newVersion: number }` (throws `NoBaselineError`)

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/learning/apply.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { insertProposal, getProposal, getBaseline } from "./store.js";
import { applyLearnedInstructionEdit, rollbackAppliedProposal, restoreTemplateDefault, StaleProposalError, NoBaselineError } from "./apply.js";
import type { TemplateInstructionProposal } from "@orca/contracts";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-learning-apply-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
function seedLockedTemplate(db: Database.Database) {
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
              VALUES ('tpl','Brainstorm','',1,1,1,'[{"id":"s1","name":"Generate","instructions":"old"}]','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
}
function proposal(over: Partial<TemplateInstructionProposal> = {}): TemplateInstructionProposal {
  return {
    id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1",
    component: "step_instructions", beforeInstructions: "old", afterInstructions: "new schema-aware text",
    targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
    predictedImprovement: "x", invariantsPreserved: ["safetyCompliance"],
    falsifier: "version_comparison", rollbackPlan: "revert_to_before",
    evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 60, verdictPassRate: 0.5, oracleSufficientRate: 0.8, versionDelta: null } },
    rationale: "r", humanEdited: false, status: "pending",
    createdAt: "2026-06-30T00:00:00.000Z", decidedAt: null, decidedBy: null, appliedAsVersion: null, ...over,
  };
}
function stepsJson(db: Database.Database): string {
  return (db.prepare(`SELECT steps_json FROM workflow_templates WHERE id = 'tpl'`).get() as { steps_json: string }).steps_json;
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); seedLockedTemplate(db); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("applyLearnedInstructionEdit", () => {
  it("writes in place on a locked built-in, captures baseline, bumps version", () => {
    insertProposal(db, proposal());
    const { newVersion } = applyLearnedInstructionEdit(db, "p1", { decidedBy: "owner", now: "2026-06-30T01:00:00.000Z" });
    expect(newVersion).toBe(2);
    expect(stepsJson(db)).toContain("new schema-aware text");
    expect(getProposal(db, "p1")).toMatchObject({ status: "applied", appliedAsVersion: 2, decidedBy: "owner" });
    expect(getBaseline(db, "tpl")?.baselineStepsJson).toContain('"instructions":"old"');
  });

  it("honors editedInstructions and sets humanEdited", () => {
    insertProposal(db, proposal());
    applyLearnedInstructionEdit(db, "p1", { editedInstructions: "human final text", decidedBy: "owner", now: "2026-06-30T01:00:00.000Z" });
    expect(stepsJson(db)).toContain("human final text");
    expect(getProposal(db, "p1")?.humanEdited).toBe(true);
  });

  it("rejects a stale proposal (template moved)", () => {
    insertProposal(db, proposal({ templateVersionAtProposal: 99 }));
    expect(() => applyLearnedInstructionEdit(db, "p1", { decidedBy: "owner", now: "2026-06-30T01:00:00.000Z" })).toThrow(StaleProposalError);
    expect(getProposal(db, "p1")?.status).toBe("superseded");
  });
});

describe("rollback + restore", () => {
  it("rolls back to before text on a forward version", () => {
    insertProposal(db, proposal());
    applyLearnedInstructionEdit(db, "p1", { decidedBy: "owner", now: "2026-06-30T01:00:00.000Z" });
    const { newVersion } = rollbackAppliedProposal(db, "p1", { decidedBy: "owner", now: "2026-06-30T02:00:00.000Z" });
    expect(newVersion).toBe(3);
    expect(stepsJson(db)).toContain('"instructions":"old"');
    expect(getProposal(db, "p1")?.status).toBe("rolled_back");
  });

  it("restore-default requires a baseline and supersedes applied", () => {
    expect(() => restoreTemplateDefault(db, "tpl", "2026-06-30T02:00:00.000Z")).toThrow(NoBaselineError);
    insertProposal(db, proposal());
    applyLearnedInstructionEdit(db, "p1", { decidedBy: "owner", now: "2026-06-30T01:00:00.000Z" });
    restoreTemplateDefault(db, "tpl", "2026-06-30T03:00:00.000Z");
    expect(stepsJson(db)).toContain('"instructions":"old"');
    expect(getProposal(db, "p1")?.status).toBe("superseded");
    expect(getBaseline(db, "tpl")?.restoredAt).toBe("2026-06-30T03:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/learning/apply.test.ts`
Expected: FAIL — `./apply.js` not found.

- [ ] **Step 3: Write the apply module**

Create `apps/daemon/src/learning/apply.ts`:

```typescript
import type Database from "better-sqlite3";
import {
  getProposal, updateProposalDecision, supersedeOtherPending, supersedeAppliedForTemplate,
  captureBaseline, getBaseline, markBaselineRestored,
} from "./store.js";

export class StaleProposalError extends Error {}
export class ProposalNotPendingError extends Error {}
export class ProposalNotAppliedError extends Error {}
export class NoBaselineError extends Error {}
export class StepNotFoundError extends Error {}

interface TemplateRow { version: number; steps_json: string; is_built_in: number }

function readTemplate(db: Database.Database, templateId: string): TemplateRow | undefined {
  return db.prepare(`SELECT version, steps_json, is_built_in FROM workflow_templates WHERE id = ?`).get(templateId) as TemplateRow | undefined;
}

// Privileged in-place write. Bypasses the is_locked/is_built_in guard the generic PATCH enforces;
// reachable only from the learning module behind a confirmed proposal / explicit user action.
export function setStepInstructionsInPlace(db: Database.Database, templateId: string, stepTemplateId: string, instructions: string, now: string): number {
  const tpl = readTemplate(db, templateId);
  if (!tpl) throw new StepNotFoundError(`template ${templateId} not found`);
  const steps = JSON.parse(tpl.steps_json) as { id: string; instructions?: string }[];
  const step = steps.find((s) => s.id === stepTemplateId);
  if (!step) throw new StepNotFoundError(`step ${stepTemplateId} not in template ${templateId}`);
  step.instructions = instructions;
  const newVersion = tpl.version + 1;
  db.prepare(`UPDATE workflow_templates SET steps_json = ?, version = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(steps), newVersion, now, templateId);
  return newVersion;
}

// Overwrite all steps (restore path).
function setStepsJsonInPlace(db: Database.Database, templateId: string, stepsJson: string, now: string): number {
  const tpl = readTemplate(db, templateId);
  if (!tpl) throw new StepNotFoundError(`template ${templateId} not found`);
  const newVersion = tpl.version + 1;
  db.prepare(`UPDATE workflow_templates SET steps_json = ?, version = ?, updated_at = ? WHERE id = ?`)
    .run(stepsJson, newVersion, now, templateId);
  return newVersion;
}

export function applyLearnedInstructionEdit(
  db: Database.Database, proposalId: string,
  opts: { editedInstructions?: string; decidedBy: string; now: string },
): { newVersion: number } {
  const p = getProposal(db, proposalId);
  if (!p) throw new StepNotFoundError(`proposal ${proposalId} not found`);
  if (p.status !== "pending") throw new ProposalNotPendingError(`proposal ${proposalId} is ${p.status}`);
  const tpl = readTemplate(db, p.templateId);
  if (!tpl) throw new StepNotFoundError(`template ${p.templateId} not found`);
  // Staleness guard.
  if (tpl.version !== p.templateVersionAtProposal) {
    updateProposalDecision(db, proposalId, { status: "superseded" });
    throw new StaleProposalError(`template moved from v${p.templateVersionAtProposal} to v${tpl.version}`);
  }
  // First learned edit on a built-in -> capture pristine baseline.
  if (tpl.is_built_in === 1) captureBaseline(db, p.templateId, tpl.steps_json, opts.now);

  const finalText = opts.editedInstructions ?? p.afterInstructions;
  const newVersion = setStepInstructionsInPlace(db, p.templateId, p.stepTemplateId, finalText, opts.now);

  updateProposalDecision(db, proposalId, {
    status: "applied", decidedAt: opts.now, decidedBy: opts.decidedBy, appliedAsVersion: newVersion,
    afterInstructions: finalText, humanEdited: opts.editedInstructions !== undefined,
  });
  supersedeOtherPending(db, p.templateId, p.stepTemplateId, proposalId);
  return { newVersion };
}

export function rollbackAppliedProposal(db: Database.Database, proposalId: string, opts: { decidedBy: string; now: string }): { newVersion: number } {
  const p = getProposal(db, proposalId);
  if (!p) throw new StepNotFoundError(`proposal ${proposalId} not found`);
  if (p.status !== "applied") throw new ProposalNotAppliedError(`proposal ${proposalId} is ${p.status}`);
  const newVersion = setStepInstructionsInPlace(db, p.templateId, p.stepTemplateId, p.beforeInstructions, opts.now);
  updateProposalDecision(db, proposalId, { status: "rolled_back", decidedAt: opts.now, decidedBy: opts.decidedBy });
  return { newVersion };
}

export function restoreTemplateDefault(db: Database.Database, templateId: string, now: string): { newVersion: number } {
  const baseline = getBaseline(db, templateId);
  if (!baseline) throw new NoBaselineError(`no baseline for ${templateId}`);
  const newVersion = setStepsJsonInPlace(db, templateId, baseline.baselineStepsJson, now);
  supersedeAppliedForTemplate(db, templateId);
  markBaselineRestored(db, templateId, now);
  return { newVersion };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/learning/apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning/apply.ts apps/daemon/src/learning/apply.test.ts
git commit -m "feat(daemon): privileged apply/rollback/restore for learned edits"
```

---

### Task 7: Canary regression enrichment (on-read)

Given a list of proposals + A's `versionComparison`, mark applied proposals with `regressionDetected` + the watched-dimension deltas. Pure function, no new state.

**Files:**
- Create: `apps/daemon/src/learning/canary.ts`
- Test: `apps/daemon/src/learning/canary.test.ts`

**Interfaces:**
- Consumes: `TemplateInstructionProposal`, `TemplateMetricsSummary` (`@orca/contracts`).
- Produces:
  - `REGRESSION_THRESHOLD = 0.1`, `SAMPLE_MIN` (re-exported = 5)
  - `enrichWithRegression(proposals: TemplateInstructionProposal[], summary: TemplateMetricsSummary): TemplateInstructionProposal[]`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/learning/canary.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { TemplateInstructionProposal, TemplateMetricsSummary } from "@orca/contracts";
import { enrichWithRegression } from "./canary.js";

function summary(over: Partial<TemplateMetricsSummary> = {}): TemplateMetricsSummary {
  return {
    templateId: "tpl", name: "B", latestVersion: 2, runs: 10,
    dimensions: { trajectoryEfficiency: { value: 0.8 }, verificationStrength: { value: 0.6 }, recovery: { value: 0.5 }, stateConsistency: { value: 1 }, safetyCompliance: { value: 1 }, replayability: { value: 1 } },
    firstPass: 0.5, recovered: 0.2, escalated: 0.05, latencyP50Ms: 100,
    deltas: { trajectoryEfficiency: null, verificationStrength: null, recovery: null, stateConsistency: null, safetyCompliance: null, replayability: null, latencyP50Ms: null },
    versionComparison: { latest: 2, prior: 1, byDimension: { safetyCompliance: -0.2, verificationStrength: 0.05 } },
    versions: [{ version: 2, runs: 6, firstSeenAt: "2026-05-01T00:00:00.000Z" }], confidence: "ok", ...over,
  };
}
function applied(over: Partial<TemplateInstructionProposal> = {}): TemplateInstructionProposal {
  return {
    id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1", component: "step_instructions",
    beforeInstructions: "old", afterInstructions: "new",
    targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
    predictedImprovement: "x", invariantsPreserved: ["safetyCompliance"], falsifier: "version_comparison", rollbackPlan: "revert_to_before",
    evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 60, verdictPassRate: 0.5, oracleSufficientRate: 0.8, versionDelta: null } },
    rationale: "r", humanEdited: false, status: "applied",
    createdAt: "2026-06-30T00:00:00.000Z", decidedAt: "2026-06-30T01:00:00.000Z", decidedBy: "owner", appliedAsVersion: 2, ...over,
  };
}

describe("enrichWithRegression", () => {
  it("flags regression when a watched invariant drops past threshold above sample-min", () => {
    const [p] = enrichWithRegression([applied()], summary());
    expect(p.regressionDetected).toBe(true);
    expect(p.watchedDeltas).toMatchObject({ safetyCompliance: -0.2 });
  });
  it("does not flag below sample-min on the applied version", () => {
    const [p] = enrichWithRegression([applied()], summary({ versions: [{ version: 2, runs: 2, firstSeenAt: "2026-05-01T00:00:00.000Z" }] }));
    expect(p.regressionDetected).toBe(false);
  });
  it("leaves non-applied proposals untouched", () => {
    const [p] = enrichWithRegression([applied({ status: "pending", appliedAsVersion: null })], summary());
    expect(p.regressionDetected).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/learning/canary.test.ts`
Expected: FAIL — `./canary.js` not found.

- [ ] **Step 3: Write the canary module**

Create `apps/daemon/src/learning/canary.ts`:

```typescript
import type { TemplateInstructionProposal, TemplateMetricsSummary } from "@orca/contracts";

export const REGRESSION_THRESHOLD = 0.1;
export const SAMPLE_MIN = 5;

export function enrichWithRegression(
  proposals: TemplateInstructionProposal[], summary: TemplateMetricsSummary,
): TemplateInstructionProposal[] {
  const vc = summary.versionComparison;
  return proposals.map((p) => {
    if (p.status !== "applied" || p.appliedAsVersion == null) return p;
    // Only judge once the applied version has accrued enough runs.
    const versionRuns = summary.versions.find((v) => v.version === p.appliedAsVersion)?.runs ?? 0;
    if (versionRuns < SAMPLE_MIN || !vc || vc.latest !== p.appliedAsVersion) {
      return { ...p, regressionDetected: false, watchedDeltas: {} };
    }
    const watchedDeltas: Record<string, number | null> = {};
    let regressed = false;
    for (const dim of p.invariantsPreserved) {
      const delta = vc.byDimension[dim] ?? null;
      watchedDeltas[dim] = delta;
      if (delta != null && delta < -REGRESSION_THRESHOLD) regressed = true;
    }
    return { ...p, regressionDetected: regressed, watchedDeltas };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/learning/canary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning/canary.ts apps/daemon/src/learning/canary.test.ts
git commit -m "feat(daemon): on-read canary regression enrichment"
```

---

### Task 8: Usecases + routes + server registration

Wire diagnose → propose → persist, the lifecycle actions, and the six endpoints.

**Files:**
- Create: `apps/daemon/src/learning/usecases.ts`, `apps/daemon/src/learning/routes.ts`
- Modify: `apps/daemon/src/server.ts`
- Test: `apps/daemon/src/learning/routes.test.ts`

**Interfaces:**
- Consumes: Tasks 2–7; `getTemplateMetricsDetail` (`../metrics/usecases.js`); `windowStart` (`../metrics/aggregate.js`); the broker (`daemonContext.orchestrationTransportBroker`). Provider/model are resolved per-anchor from the goal's `orchestrator_provider`/`orchestrator_model` (the most recent run's goal — B has no goal of its own).
- Produces:
  - `AnalyzeDeps = { broker: BrokerLike }`
  - `analyzeTemplate(deps, db, templateId, period, nowIso?): Promise<TemplateInstructionProposal[]>`
  - `listProposalsEnriched(db, templateId, period, nowIso?): TemplateInstructionProposal[]`
  - `LearningRouteDeps = { db; broker: BrokerLike; actor: () => string }`
  - `registerLearningRoutes(server, deps)`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/learning/routes.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { registerLearningRoutes } from "./routes.js";
import type { BrokerLike } from "./propose.js";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-learning-routes-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
// Seed a locked built-in with >= SAMPLE_MIN passing+failing step_complete transitions on step s1.
function seed(db: Database.Database) {
  db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at)
              VALUES ('g','G','','active',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`).run();
  // B resolves provider/model from the anchor run's goal — set them.
  db.prepare(`UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-opus-4-8' WHERE id = 'g'`).run();
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
              VALUES ('tpl','Brainstorm','',1,1,1,'[{"id":"s1","name":"Generate","instructions":"Generate a proposal."}]','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_runs (id,goal_id,template_id,template_version,status,current_step_run_id,blocked_reason,started_at,finished_at)
              VALUES ('run1','g','tpl',1,'completed',NULL,NULL,'2026-05-01T00:00:00.000Z','2026-05-01T01:00:00.000Z')`).run();
  for (let i = 0; i < 6; i++) {
    const verdict = i < 2 ? "passed" : "failed";
    const status = verdict === "passed" ? "succeeded" : "failed";
    const fc = verdict === "passed" ? "null" : '"invalid_output"';
    db.prepare(`INSERT INTO workflow_step_runs (id,goal_id,workflow_run_id,step_template_id,ordinal,attempt,status,satisfied_exit_criteria_json,outstanding_exit_criteria_json,blocked_reason,started_at,finished_at,fingerprint)
                VALUES (?, 'g','run1','s1',0,1,?,'[]','[]',NULL,'2026-05-01T00:00:00.000Z','2026-05-01T00:10:00.000Z',?)`)
      .run(`sr${i}`, verdict === "passed" ? "passed" : "failed", `fp${i}`);
    db.prepare(`INSERT INTO harness_transitions (id,goal_id,workflow_run_id,workflow_step_run_id,boundary,risk_json,evidence_json,state_deps_json,telemetry_json,created_at)
                VALUES (?, 'g','run1',?, 'step_complete',NULL,
                  ?, NULL,
                  ?, '2026-05-01T00:10:00.000Z')`)
      .run(`ht${i}`, `sr${i}`,
        `{"sensorsRun":[],"verdict":"${verdict}","untestedRegions":[],"residualRisk":[],"oracleAdequacy":{"sufficient":true,"gaps":[]}}`,
        `{"cost":null,"latency_ms":100,"model":null,"provider_id":null,"provider_version":null,"prompt_ref":null,"raw_output_ref":null,"rejected_alternatives":[],"human_interventions":[],"outcome":{"status":"${status}","failure_code":${fc}}}`);
  }
}

function deps() {
  const parsed = { proposedInstructions: "Generate a proposal, then validate it against the output schema.", predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], rationale: "r" };
  const broker: BrokerLike = { propose: vi.fn(async () => ({ status: "proposed", parsed })) };
  return { broker, actor: () => "owner" };
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); seed(db); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("learning routes", () => {
  it("analyze -> apply -> list lifecycle", async () => {
    const f = Fastify(); registerLearningRoutes(f, { db, ...deps() });

    const analyze = await f.inject({ method: "POST", url: "/v1/learning/templates/tpl/analyze?period=30d" });
    expect(analyze.statusCode).toBe(200);
    const proposals = (analyze.json() as { proposals: Array<{ id: string; stepTemplateId: string }> }).proposals;
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const id = proposals[0].id;

    const apply = await f.inject({ method: "POST", url: `/v1/learning/proposals/${id}/apply`, payload: {} });
    expect(apply.statusCode).toBe(200);
    expect((apply.json() as { proposal: { status: string } }).proposal.status).toBe("applied");

    const list = await f.inject({ method: "GET", url: "/v1/learning/templates/tpl/proposals" });
    expect((list.json() as { proposals: Array<{ status: string }> }).proposals.some((p) => p.status === "applied")).toBe(true);
  });

  it("400 on bad period, 404 on unknown template", async () => {
    const f = Fastify(); registerLearningRoutes(f, { db, ...deps() });
    expect((await f.inject({ method: "POST", url: "/v1/learning/templates/tpl/analyze?period=1y" })).statusCode).toBe(400);
    expect((await f.inject({ method: "POST", url: "/v1/learning/templates/nope/analyze?period=7d" })).statusCode).toBe(404);
  });

  it("409 applying an unknown/non-pending proposal", async () => {
    const f = Fastify(); registerLearningRoutes(f, { db, ...deps() });
    expect((await f.inject({ method: "POST", url: "/v1/learning/proposals/missing/apply", payload: {} })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/learning/routes.test.ts`
Expected: FAIL — `./routes.js` not found.

- [ ] **Step 3: Write usecases**

Create `apps/daemon/src/learning/usecases.ts`:

```typescript
import type Database from "better-sqlite3";
import type { MetricPeriod, TemplateInstructionProposal } from "@orca/contracts";
import { getTemplateMetricsDetail } from "../metrics/usecases.js";
import { windowStart } from "../metrics/aggregate.js";
import { listRevisionSignalsByTemplate } from "./fetch.js";
import { diagnoseTemplate } from "./diagnose.js";
import { proposeInstructionRevision, type BrokerLike } from "./propose.js";
import { enrichWithRegression } from "./canary.js";
import {
  insertProposal, listProposalsByTemplate, pendingProposalForStep,
} from "./store.js";

export interface AnalyzeDeps { broker: BrokerLike }

function nowOr(nowIso?: string): string { return nowIso ?? new Date().toISOString(); }

// B has no goal of its own; reuse the orchestrator model of the anchor run's goal.
function orchestratorModelForGoal(db: Database.Database, goalId: string): { providerId: string; modelId: string } | null {
  const row = db.prepare(`SELECT orchestrator_provider, orchestrator_model FROM goals WHERE id = ?`).get(goalId) as
    { orchestrator_provider: string | null; orchestrator_model: string | null } | undefined;
  if (!row?.orchestrator_provider || !row.orchestrator_model) return null;
  return { providerId: row.orchestrator_provider, modelId: row.orchestrator_model };
}

function stepInstructions(db: Database.Database, templateId: string): Map<string, string> {
  const row = db.prepare(`SELECT steps_json FROM workflow_templates WHERE id = ?`).get(templateId) as { steps_json: string } | undefined;
  const map = new Map<string, string>();
  if (!row) return map;
  const steps = JSON.parse(row.steps_json) as { id: string; instructions?: string }[];
  for (const s of steps) map.set(s.id, s.instructions ?? "");
  return map;
}

// Anchor the broker request to the most recent qualifying evidence transition.
function anchorForStep(db: Database.Database, templateId: string, stepTemplateId: string): { goalId: string; workflowRunId: string; stepRunId: string } | null {
  const row = db.prepare(
    `SELECT ht.goal_id AS goal_id, ht.workflow_run_id AS workflow_run_id, ht.workflow_step_run_id AS step_run_id
     FROM harness_transitions ht
     JOIN workflow_runs wr ON wr.id = ht.workflow_run_id
     JOIN workflow_step_runs wsr ON wsr.id = ht.workflow_step_run_id
     WHERE wr.template_id = ? AND wsr.step_template_id = ?
     ORDER BY ht.created_at DESC LIMIT 1`
  ).get(templateId, stepTemplateId) as { goal_id: string; workflow_run_id: string; step_run_id: string } | undefined;
  return row ? { goalId: row.goal_id, workflowRunId: row.workflow_run_id, stepRunId: row.step_run_id } : null;
}

function uuid(): string {
  // Reuse the daemon's id helper if one exists; crypto.randomUUID is available in Node 18+.
  return (globalThis.crypto as Crypto).randomUUID();
}

export async function analyzeTemplate(
  deps: AnalyzeDeps, db: Database.Database, templateId: string, period: MetricPeriod, nowIso?: string,
): Promise<TemplateInstructionProposal[]> {
  const now = nowOr(nowIso);
  const detail = getTemplateMetricsDetail(db, templateId, period, now);
  if (!detail) return []; // caller maps null template to 404 before this
  const since = windowStart(now, period);
  const signals = listRevisionSignalsByTemplate(db, templateId, since, now);
  const bundles = diagnoseTemplate({ detail, signals, stepInstructions: stepInstructions(db, templateId) });

  const created: TemplateInstructionProposal[] = [];
  for (const bundle of bundles) {
    // Dedupe: keep an existing pending proposal for the step.
    const existing = pendingProposalForStep(db, templateId, bundle.stepTemplateId);
    if (existing) { created.push(existing); continue; }
    const anchor = anchorForStep(db, templateId, bundle.stepTemplateId);
    if (!anchor) continue;
    const model = orchestratorModelForGoal(db, anchor.goalId);
    if (!model) continue; // can't propose without a provider/model
    const fill = await proposeInstructionRevision({ broker: deps.broker, ...model }, anchor, bundle);
    if (!fill) continue;
    const proposal: TemplateInstructionProposal = {
      id: uuid(), templateId, templateVersionAtProposal: detail.summary.latestVersion,
      stepTemplateId: bundle.stepTemplateId, component: "step_instructions",
      beforeInstructions: bundle.currentInstructions, afterInstructions: fill.proposedInstructions,
      targetedFailureMode: bundle.targetedFailureMode,
      predictedImprovement: fill.predictedImprovement, invariantsPreserved: fill.invariantsPreserved,
      falsifier: "version_comparison", rollbackPlan: "revert_to_before",
      evidence: { sampleTransitionIds: bundle.evidence.sampleTransitionIds, revisionSignalIds: bundle.evidence.revisionSignalIds, metricSnapshot: bundle.evidence.metricSnapshot },
      rationale: fill.rationale, humanEdited: false, status: "pending",
      createdAt: now, decidedAt: null, decidedBy: null, appliedAsVersion: null,
    };
    insertProposal(db, proposal);
    created.push(proposal);
  }
  return created;
}

export function listProposalsEnriched(db: Database.Database, templateId: string, period: MetricPeriod, nowIso?: string): TemplateInstructionProposal[] {
  const detail = getTemplateMetricsDetail(db, templateId, period, nowOr(nowIso));
  const proposals = listProposalsByTemplate(db, templateId);
  return detail ? enrichWithRegression(proposals, detail.summary) : proposals;
}
```

- [ ] **Step 4: Write routes**

Create `apps/daemon/src/learning/routes.ts`:

```typescript
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { MetricPeriod } from "@orca/contracts";
import { analyzeTemplate, listProposalsEnriched, type AnalyzeDeps } from "./usecases.js";
import { getProposal, updateProposalDecision } from "./store.js";
import {
  applyLearnedInstructionEdit, rollbackAppliedProposal, restoreTemplateDefault,
  StaleProposalError, ProposalNotPendingError, ProposalNotAppliedError, NoBaselineError, StepNotFoundError,
} from "./apply.js";

export interface LearningRouteDeps extends AnalyzeDeps {
  db: Database.Database;
  actor: () => string;   // resolves the acting owner id for decidedBy (single-owner today)
}

function templateExists(db: Database.Database, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM workflow_templates WHERE id = ?`).get(id);
}

export function registerLearningRoutes(server: FastifyInstance, deps: LearningRouteDeps): void {
  const { db } = deps;
  const now = () => new Date().toISOString();

  server.post("/v1/learning/templates/:id/analyze", async (req, reply) => {
    const period = MetricPeriod.safeParse((req.query as { period?: string }).period);
    if (!period.success) { reply.status(400); return { error: { code: "invalid_period" } }; }
    const { id } = req.params as { id: string };
    if (!templateExists(db, id)) { reply.status(404); return { error: { code: "template_not_found" } }; }
    const proposals = await analyzeTemplate(deps, db, id, period.data);
    return { proposals };
  });

  server.get("/v1/learning/templates/:id/proposals", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!templateExists(db, id)) { reply.status(404); return { error: { code: "template_not_found" } }; }
    const period = MetricPeriod.safeParse((req.query as { period?: string }).period ?? "7d");
    return { proposals: listProposalsEnriched(db, id, period.success ? period.data : "7d") };
  });

  server.post("/v1/learning/proposals/:id/apply", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { editedInstructions?: string };
    try {
      applyLearnedInstructionEdit(db, id, { editedInstructions: body.editedInstructions, decidedBy: deps.actor(), now: now() });
      return { proposal: getProposal(db, id) };
    } catch (e) {
      if (e instanceof StepNotFoundError) { reply.status(404); return { error: { code: "not_found" } }; }
      if (e instanceof StaleProposalError) { reply.status(409); return { error: { code: "stale_proposal" } }; }
      if (e instanceof ProposalNotPendingError) { reply.status(409); return { error: { code: "not_pending" } }; }
      throw e;
    }
  });

  server.post("/v1/learning/proposals/:id/dismiss", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProposal(db, id);
    if (!p) { reply.status(404); return { error: { code: "not_found" } }; }
    if (p.status !== "pending") { reply.status(409); return { error: { code: "not_pending" } }; }
    updateProposalDecision(db, id, { status: "dismissed", decidedAt: now(), decidedBy: deps.actor() });
    return { proposal: getProposal(db, id) };
  });

  server.post("/v1/learning/proposals/:id/rollback", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      rollbackAppliedProposal(db, id, { decidedBy: deps.actor(), now: now() });
      return { proposal: getProposal(db, id) };
    } catch (e) {
      if (e instanceof StepNotFoundError) { reply.status(404); return { error: { code: "not_found" } }; }
      if (e instanceof ProposalNotAppliedError) { reply.status(409); return { error: { code: "not_applied" } }; }
      throw e;
    }
  });

  server.post("/v1/learning/templates/:id/restore-default", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!templateExists(db, id)) { reply.status(404); return { error: { code: "template_not_found" } }; }
    try {
      const { newVersion } = restoreTemplateDefault(db, id, now());
      return { restored: true, newVersion };
    } catch (e) {
      if (e instanceof NoBaselineError) { reply.status(409); return { error: { code: "no_baseline" } }; }
      throw e;
    }
  });
}
```

- [ ] **Step 5: Register in server.ts**

In `apps/daemon/src/server.ts`, add an import beside `import { registerMetricsRoutes } from './metrics/routes.js';`:

```typescript
import { registerLearningRoutes } from './learning/routes.js';
```

And beside the `registerMetricsRoutes(server, { db });` call (server.ts:2202), add:

```typescript
  registerLearningRoutes(server, {
    db,
    broker: daemonContext.orchestrationTransportBroker,  // the broker the orchestrator uses
    actor: () => "owner",                                // single-owner today; tenancy replaces this
  });
```

Provider/model are resolved inside `analyzeTemplate` from the anchor run's goal (`orchestrator_provider`/`orchestrator_model`), so no model config is threaded through the route. The route module depends only on the `BrokerLike` shape, so any broker exposing `propose` works.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/learning/routes.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/learning/usecases.ts apps/daemon/src/learning/routes.ts apps/daemon/src/server.ts apps/daemon/src/learning/routes.test.ts
git commit -m "feat(daemon): /v1/learning endpoints (analyze, proposals, apply/dismiss/rollback/restore)"
```

---

### Task 9: Desktop API client

Add the six learning client fns mirroring the existing metrics client.

**Files:**
- Modify: `apps/desktop/src/api.ts`
- Test: `apps/desktop/src/api.learning.test.ts`

**Interfaces:**
- Consumes: `TemplateInstructionProposal`, `MetricPeriod` (`@orca/contracts`).
- Produces:
  - `analyzeTemplate(templateId: string, period: MetricPeriod): Promise<TemplateInstructionProposal[]>`
  - `listProposals(templateId: string, period: MetricPeriod): Promise<TemplateInstructionProposal[]>`
  - `applyProposal(id: string, editedInstructions?: string): Promise<TemplateInstructionProposal>`
  - `dismissProposal(id: string): Promise<TemplateInstructionProposal>`
  - `rollbackProposal(id: string): Promise<TemplateInstructionProposal>`
  - `restoreTemplateDefault(templateId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/api.learning.test.ts` (mirrors the proven `api.metrics.test.ts` setup — mock tauri core so `isTauri()` is false, reset modules + dynamic-import per test because `loadConfig` caches):

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));

type ApiModule = typeof import("./api");

const proposal = {
  id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1", component: "step_instructions",
  beforeInstructions: "old", afterInstructions: "new",
  targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
  predictedImprovement: "x", invariantsPreserved: ["safetyCompliance"], falsifier: "version_comparison", rollbackPlan: "revert_to_before",
  evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 60, verdictPassRate: 0.5, oracleSufficientRate: 0.8, versionDelta: null } },
  rationale: "r", humanEdited: false, status: "pending",
  createdAt: "2026-06-30T00:00:00.000Z", decidedAt: null, decidedBy: null, appliedAsVersion: null,
};

describe("learning api", () => {
  let api: ApiModule;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(async () => {
    vi.resetModules(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
    api = await import("./api");
  });

  it("analyzeTemplate POSTs with the period and returns proposals", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ proposals: [proposal] }), { status: 200, headers: { "content-type": "application/json" } }));
    const out = await api.analyzeTemplate("tpl", "7d");
    expect(out[0]!.id).toBe("p1");
    expect(fetchMock.mock.calls[0]![0]).toContain("/v1/learning/templates/tpl/analyze?period=7d");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("POST");
  });

  it("applyProposal POSTs editedInstructions and returns the proposal", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ proposal: { ...proposal, status: "applied" } }), { status: 200, headers: { "content-type": "application/json" } }));
    const out = await api.applyProposal("p1", "human text");
    expect(out.status).toBe("applied");
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ editedInstructions: "human text" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/api.learning.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Add the client fns**

In `apps/desktop/src/api.ts`, mirror the existing metrics client fns exactly — they use `loadConfig()` → `{ baseUrl, token }`, a raw `fetch` with `authHeaders(token)`, and `parseResponse(res, schema)`. `z` and the contract schemas are already imported in this file (the metrics fns import `TemplateMetricsSummary` etc.); add `TemplateInstructionProposal` to that import and append:

```typescript
// add TemplateInstructionProposal to the existing "@orca/contracts" import; z is already imported.
export async function analyzeTemplate(templateId: string, period: MetricPeriod): Promise<TemplateInstructionProposal[]> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/learning/templates/${encodeURIComponent(templateId)}/analyze?period=${period}`,
    { method: "POST", headers: authHeaders(token) });
  const body = await parseResponse(res, z.object({ proposals: z.array(TemplateInstructionProposal) }));
  return body.proposals;
}

export async function listProposals(templateId: string, period: MetricPeriod): Promise<TemplateInstructionProposal[]> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/learning/templates/${encodeURIComponent(templateId)}/proposals?period=${period}`,
    { headers: authHeaders(token) });
  const body = await parseResponse(res, z.object({ proposals: z.array(TemplateInstructionProposal) }));
  return body.proposals;
}

export async function applyProposal(id: string, editedInstructions?: string): Promise<TemplateInstructionProposal> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/learning/proposals/${encodeURIComponent(id)}/apply`, {
    method: "POST", headers: { ...authHeaders(token), "content-type": "application/json" },
    body: JSON.stringify(editedInstructions !== undefined ? { editedInstructions } : {}),
  });
  const body = await parseResponse(res, z.object({ proposal: TemplateInstructionProposal }));
  return body.proposal;
}

export async function dismissProposal(id: string): Promise<TemplateInstructionProposal> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/learning/proposals/${encodeURIComponent(id)}/dismiss`, { method: "POST", headers: authHeaders(token) });
  const body = await parseResponse(res, z.object({ proposal: TemplateInstructionProposal }));
  return body.proposal;
}

export async function rollbackProposal(id: string): Promise<TemplateInstructionProposal> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/learning/proposals/${encodeURIComponent(id)}/rollback`, { method: "POST", headers: authHeaders(token) });
  const body = await parseResponse(res, z.object({ proposal: TemplateInstructionProposal }));
  return body.proposal;
}

export async function restoreTemplateDefault(templateId: string): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/learning/templates/${encodeURIComponent(templateId)}/restore-default`, { method: "POST", headers: authHeaders(token) });
  await parseResponse(res, z.object({ restored: z.boolean(), newVersion: z.number() }));
}
```

(`loadConfig`, `authHeaders`, `parseResponse` are the existing private helpers in `api.ts` at lines 214/248/253 — the metrics fns use the same three.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/api.learning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/api.learning.test.ts
git commit -m "feat(desktop): learning-loop API client"
```

---

### Task 10: Desktop Self-Improvement rail

Replace the deferred placeholder with the full propose → confirm → watch → rollback/restore rail.

**Files:**
- Modify: `apps/desktop/src/metrics/SelfImprovement.tsx`, `apps/desktop/src/metrics/MetricsPage.tsx`
- Test: `apps/desktop/src/metrics/SelfImprovement.test.tsx`

**Interfaces:**
- Consumes: `TemplateInstructionProposal`, `TemplateMetricsDetail` (`@orca/contracts`); the Task 9 client fns.
- Produces: `SelfImprovementRail({ detail, workflowName, templateId, period, onMutated })` — `onMutated` lets `MetricsPage` refetch metrics after an apply/rollback/restore.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/metrics/SelfImprovement.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SelfImprovementRail } from "./SelfImprovement";
import * as api from "../api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const detail = { summary: { templateId: "tpl", name: "Brainstorm" } } as never;

const pending = {
  id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1", component: "step_instructions",
  beforeInstructions: "Generate.", afterInstructions: "Generate and validate against schema.",
  targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
  predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], falsifier: "version_comparison", rollbackPlan: "revert_to_before",
  evidence: { sampleTransitionIds: ["t1"], revisionSignalIds: [], metricSnapshot: { score: 60, verdictPassRate: 0.57, oracleSufficientRate: 0.8, versionDelta: -0.05 } },
  rationale: "because", humanEdited: false, status: "pending",
  createdAt: "2026-06-30T00:00:00.000Z", decidedAt: null, decidedBy: null, appliedAsVersion: null,
};

describe("SelfImprovementRail", () => {
  it("analyzes on click and renders a proposal card with the diff", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([]);
    vi.spyOn(api, "analyzeTemplate").mockResolvedValue([pending as never]);
    render(<SelfImprovementRail detail={detail} workflowName="Brainstorm" templateId="tpl" period="7d" onMutated={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /analyze this template/i }));
    expect(await screen.findByText(/Generate and validate against schema/i)).toBeTruthy();
    expect(screen.getByText(/invalid_output/i)).toBeTruthy();
  });

  it("applies a proposal and calls onMutated", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([pending as never]);
    const applySpy = vi.spyOn(api, "applyProposal").mockResolvedValue({ ...pending, status: "applied", appliedAsVersion: 2 } as never);
    const onMutated = vi.fn();
    render(<SelfImprovementRail detail={detail} workflowName="Brainstorm" templateId="tpl" period="7d" onMutated={onMutated} />);
    fireEvent.click(await screen.findByRole("button", { name: /^apply$/i }));
    await waitFor(() => expect(applySpy).toHaveBeenCalledWith("p1", undefined));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/metrics/SelfImprovement.test.tsx`
Expected: FAIL — the rail has no analyze button / new props.

- [ ] **Step 3: Rewrite the rail**

Replace `apps/desktop/src/metrics/SelfImprovement.tsx` with the lifecycle rail. Keep the existing `Panel`/`Sparkle` imports and visual tokens; add state + the client calls:

```tsx
import { useEffect, useState } from "react";
import type { TemplateInstructionProposal, TemplateMetricsDetail } from "@orca/contracts";
import { analyzeTemplate, applyProposal, dismissProposal, listProposals, restoreTemplateDefault, rollbackProposal } from "../api";
import { Panel } from "./metrics-charts";
import { statusForScore } from "./metrics-data";
import { Sparkle } from "./metrics-icons";

type Props = {
  detail: TemplateMetricsDetail | null;
  workflowName: string;
  templateId: string | null;
  period: "24h" | "7d" | "30d";
  onMutated: () => void;
};

export function SelfImprovementRail({ detail, workflowName, templateId, period, onMutated }: Props) {
  const [proposals, setProposals] = useState<TemplateInstructionProposal[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [editing, setEditing] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    if (templateId) listProposals(templateId, period).then((p) => { if (live) setProposals(p); }).catch(() => {});
    return () => { live = false; };
  }, [templateId, period]);

  const refresh = async () => { if (templateId) setProposals(await listProposals(templateId, period)); };

  const onAnalyze = async () => {
    if (!templateId) return;
    setAnalyzing(true);
    try { setProposals(await analyzeTemplate(templateId, period)); } finally { setAnalyzing(false); }
  };
  const onApply = async (p: TemplateInstructionProposal) => {
    await applyProposal(p.id, editing[p.id]); await refresh(); onMutated();
  };
  const onDismiss = async (p: TemplateInstructionProposal) => { await dismissProposal(p.id); await refresh(); };
  const onRollback = async (p: TemplateInstructionProposal) => { await rollbackProposal(p.id); await refresh(); onMutated(); };
  const onRestore = async () => { if (!templateId) return; await restoreTemplateDefault(templateId); await refresh(); onMutated(); };

  const pending = proposals.filter((p) => p.status === "pending");
  const applied = proposals.filter((p) => p.status === "applied");
  const history = proposals.filter((p) => ["dismissed", "rolled_back", "superseded"].includes(p.status));
  const steps = detail?.steps ?? [];
  const attention = steps.filter((s) => statusForScore(s.score) !== "healthy").length;

  return (
    <Panel title="Self-improvement" kicker="ORCA LEARNS" style={{ flex: 1, minHeight: 0 }}
      bodyStyle={{ padding: 12, display: "flex", flexDirection: "column", minHeight: 0, gap: 12, overflowY: "auto" }}>
      <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.55 }}>
        {attention > 0
          ? <>Orca sees <strong style={{ color: "var(--text)" }}>{attention} step{attention !== 1 ? "s" : ""} underperforming</strong> in {workflowName}.</>
          : <>Every step in {workflowName} is healthy.</>}
      </div>

      <button type="button" onClick={onAnalyze} disabled={analyzing || !templateId} style={{ alignSelf: "flex-start" }}>
        {analyzing ? "Reviewing runs…" : "Analyze this template"}
      </button>

      {!analyzing && pending.length === 0 && applied.length === 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", color: "var(--text-3)", gap: 8, padding: "16px 12px" }}>
          <Sparkle size={20} color="var(--text-4)" />
          <div style={{ fontSize: 12 }}>Nothing to propose — steps are healthy or below the sample threshold.</div>
        </div>
      )}

      {pending.map((p) => (
        <div key={p.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, fontSize: 12 }}>
          <div style={{ fontWeight: 600 }}>{p.stepTemplateId}</div>
          <div style={{ color: "var(--text-3)" }}>
            targets {p.targetedFailureMode.failureCode ?? p.targetedFailureMode.rule}
            {p.targetedFailureMode.clusterCount != null ? ` (${p.targetedFailureMode.clusterCount})` : ""}
            {p.targetedFailureMode.signalCount != null ? ` · ${p.targetedFailureMode.signalCount} re-steers` : ""}
          </div>
          <div style={{ marginTop: 6 }}>
            <div style={{ color: "var(--danger)", textDecoration: "line-through", whiteSpace: "pre-wrap" }}>{p.beforeInstructions}</div>
            <textarea defaultValue={p.afterInstructions} onChange={(e) => setEditing((s) => ({ ...s, [p.id]: e.target.value }))} style={{ width: "100%", marginTop: 4 }} />
          </div>
          <div style={{ marginTop: 6, color: "var(--text-2)" }}>Predicts: {p.predictedImprovement}</div>
          <div style={{ color: "var(--text-3)" }}>Preserves: {p.invariantsPreserved.join(", ") || "—"}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" onClick={() => onApply(p)}>Apply</button>
            <button type="button" onClick={() => onDismiss(p)}>Dismiss</button>
          </div>
        </div>
      ))}

      {applied.map((p) => (
        <div key={p.id} style={{ border: `1px solid ${p.regressionDetected ? "var(--danger)" : "var(--border)"}`, borderRadius: 8, padding: 10, fontSize: 12 }}>
          <div style={{ fontWeight: 600 }}>{p.stepTemplateId} · applied as v{p.appliedAsVersion}</div>
          <div style={{ color: "var(--text-3)" }}>
            {p.regressionDetected ? "Regression detected" : "Watching"}
            {p.watchedDeltas && Object.keys(p.watchedDeltas).length > 0
              ? " · " + Object.entries(p.watchedDeltas).map(([k, v]) => `${k} ${v == null ? "—" : v.toFixed(2)}`).join(", ")
              : " · awaiting runs"}
          </div>
          {p.regressionDetected && <button type="button" onClick={() => onRollback(p)} style={{ marginTop: 8 }}>Rollback</button>}
        </div>
      ))}

      {history.length > 0 && (
        <details>
          <summary style={{ fontSize: 11.5, color: "var(--text-3)", cursor: "pointer" }}>Activity log ({history.length})</summary>
          {history.map((p) => (
            <div key={p.id} style={{ fontSize: 11, color: "var(--text-3)", padding: "4px 0" }}>
              {p.stepTemplateId} — {p.status}{p.decidedBy ? ` by ${p.decidedBy}` : ""}{p.decidedAt ? ` · ${p.decidedAt.slice(0, 10)}` : ""}
            </div>
          ))}
        </details>
      )}

      <button type="button" onClick={onRestore} style={{ alignSelf: "flex-start", fontSize: 11, color: "var(--text-3)" }}>
        Restore default built-in
      </button>
    </Panel>
  );
}
```

- [ ] **Step 4: Pass the new props from MetricsPage**

In `apps/desktop/src/metrics/MetricsPage.tsx`, the rail is rendered at line 79 as `<SelfImprovementRail detail={detail} workflowName={wf.name} />`. The page already holds `wfId` (selected template id, line 17), `period` (line 14), and refetches metrics by bumping `reloadKey` (`setReloadKey((k) => k + 1)`, used by Refresh at line 57). Replace the render with:

```tsx
<SelfImprovementRail
  detail={detail}
  workflowName={wf.name}
  templateId={wfId}
  period={period}
  onMutated={() => setReloadKey((k) => k + 1)}
/>
```

The rail's `period` prop type is the same `"24h" | "7d" | "30d"` union as the page's `Period`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/metrics/SelfImprovement.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/metrics/SelfImprovement.tsx apps/desktop/src/metrics/MetricsPage.tsx apps/desktop/src/metrics/SelfImprovement.test.tsx
git commit -m "feat(desktop): learning-loop Self-Improvement rail (propose/apply/watch/rollback/restore)"
```

---

### Task 11: Docs

Reflect B in the three durable docs.

**Files:**
- Modify: `ORCA.md`, `FUTURE_WORK.md`, `FUTURE_ARCHITECTURE.md`

- [ ] **Step 1: ORCA.md — learning-loop entry**

Add an entry (near the Inspectable-axis / metrics surface text added by A) describing the per-template reflective optimizer: deterministic diagnosis + single gated LLM proposal, the privileged-write governance, forward version-comparison falsifier, restore-to-default. One short paragraph; match the doc's existing voice.

- [ ] **Step 2: FUTURE_WORK.md 5.2 — mark the propose/promote half landed**

Update the 5.2 bullet: the learning loop now proposes (never silently applies) per-template instruction edits, gated and opt-in. Record the **pre-promotion replay deferral** explicitly: counterfactual-judge (after sub-project C) and replay-re-run remain future work; B uses forward version-comparison + rollback.

- [ ] **Step 3: FUTURE_ARCHITECTURE.md — learning loop partially realized**

Note the learning loop is now partially realized and **control-plane-pure** (no execution-plane access; the falsifier is the forward version-comparison projection). Owner-scoping of proposals remains the additive tenancy step.

- [ ] **Step 4: Commit**

```bash
git add ORCA.md FUTURE_WORK.md FUTURE_ARCHITECTURE.md
git commit -m "docs: record the learning loop (Phase 5 sub-project B)"
```

---

## Verification (run after all tasks)

- [ ] `cd packages/contracts && pnpm vitest run` — contracts green.
- [ ] `cd apps/daemon && pnpm vitest run src/learning src/metrics src/harness-metrics` — learning + metrics + the A safety net green.
- [ ] `cd apps/desktop && pnpm vitest run src/metrics src/api.learning.test.ts` — desktop green.
- [ ] Type-check the whole workspace per the repo's standard command (e.g. `pnpm -r typecheck` or the equivalent in the root scripts).
- [ ] Manual smoke (browser proxy): `pnpm dev:browser`, open Metrics, pick a template with runs, click **Analyze this template**, confirm a proposal card renders with a diff, Apply, confirm the applied-watching state, then Restore default.
