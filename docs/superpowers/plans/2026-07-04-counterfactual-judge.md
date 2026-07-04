# Counterfactual LLM Judge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a human-triggered, pre-promotion `evaluate` stage to the 5.2 learning loop: an isolated adversarial shadow-LLM judges a proposed step-instruction edit against the step's persisted past outputs (bucketed by independently-verified ground truth) for regression risk on solved cases and improvement on the targeted failure mode, surfacing a calibrated verdict that **informs, never gates** the human promotion.

**Architecture:** A discrete route (`POST /v1/learning/proposals/:id/judge`) between propose and promote. Deterministic control-plane code builds a two-bucket corpus from `workflow_artifacts` (`step_output`) + `harness_transitions` facet verdicts; a pure `learning/judge.ts` module (mirroring 5.4's `refute-completion.ts`) runs one isolated `${templateId}::judge` shadow turn (spawn + teardown per call) and returns a tri-state calibrated proposal; the engine wraps it into a write-once `CounterfactualJudgment` persisted on the proposal ledger. The apply route is untouched.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), better-sqlite3, Zod (`@orca/contracts`), Vitest, pnpm monorepo (`@orca/daemon`, `@orca/contracts`, desktop `@orca/desktop`).

## Global Constraints

- Deterministic core owns lifecycle/routing/gating/persistence; the LLM only fills `{verdict, regressionRisk, addressesFailureMode, regressionCases, reason, inputsConsidered}` (FUTURE_ARCHITECTURE line 95).
- **Informs, never overrides:** the `apply` route (`learning/apply.ts`, `POST .../apply`) is NOT modified and never reads the judgment. The verdict is a surfaced signal only.
- **Write-once + idempotent:** a re-call returns the existing judgment; never clobber the audit record (append-only / auditable-rationale, FUTURE_ARCH line 98; paper §3.5.3).
- **Independence (paper p.37/p.46):** the judge runs in a context-isolated `${templateId}::judge` shadow session (spawn + teardown per call); the request EXCLUDES the orchestrator's self-reported scoring; bucket labels derive only from independent signals (`EvidenceFacet` sensors + 5.4 `RefuteFacet`).
- **Control-plane pure:** no execution-plane code; imagined execution over persisted outputs via the `ShadowAsk` seam. One additive contract module, one additive nullable column (`judge_json`), one additive route.
- Per-template only (not cross-goal). ESM `.js` specifiers; surgical changes.
- Commit on `main` (this session's approved convention). Every commit: `pnpm --filter @orca/contracts build` + `pnpm --filter @orca/daemon build` green + the touched vitest dirs pass.
- End commit bodies with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- `packages/contracts/src/learning/index.ts` — new judge schemas + `judgment` field (Task 1); `packages/contracts/src/workflows/index.ts` — export the existing size helper (Task 1).
- `apps/daemon/migrations/0053_learning_proposal_judgment.sql` + `apps/daemon/src/migrations.ts` — the `judge_json` column (Task 2).
- `apps/daemon/src/learning/store.ts` — hydrate `judgment`, add `setProposalJudgment` (Task 3).
- `apps/daemon/src/learning/corpus.ts` — deterministic two-bucket corpus builder (Task 4).
- `apps/daemon/src/learning/judge.ts` — pure shadow judge module, mirrors `refute-completion.ts` (Task 5).
- `apps/daemon/src/learning/usecases.ts` + `routes.ts` + `apps/daemon/src/server.ts` — `judgeProposal` usecase, judge route, shadow wiring (Task 6).
- `apps/desktop/src/...SelfImprovement...` + `api.ts` — "Evaluate this edit" action + judgment card (Task 7).
- `ORCA.md`, `FUTURE_WORK.md`, `FUTURE_ARCHITECTURE.md` (Task 8).

---

### Task 1: Contracts — judge schemas + `judgment` field

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts:18` (add `export` to `hasMaxSerializedBytes`)
- Modify: `packages/contracts/src/learning/index.ts` (add judge schemas after `EvidenceSnapshot` `:39`; add `judgment` field to `TemplateInstructionProposal` after `watchedDeltas` `:64`)
- Test: `packages/contracts/src/learning/index.test.ts`

**Interfaces:**
- Consumes: `z`, `TargetedFailureMode` (`learning/index.ts:12`), `ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES` + `hasMaxSerializedBytes` (`workflows/index.ts`).
- Produces: `JudgeVerdict`, `JudgeInstructionEditProposal`, `JudgeInstructionEditRequest`, `JudgeOutcome`, `CounterfactualJudgment`; optional `judgment` on `TemplateInstructionProposal`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/contracts/src/learning/index.test.ts`:
```ts
import {
  JudgeInstructionEditProposal, JudgeInstructionEditRequest, CounterfactualJudgment, TemplateInstructionProposal,
} from "./index.js";

describe("Counterfactual judge contracts", () => {
  it("round-trips a regression_risk proposal", () => {
    const p = { verdict: "regression_risk", regressionRisk: "likely", addressesFailureMode: "partial",
      regressionCases: ["case-1"], reason: "would drop the error-path check", inputsConsidered: ["solved:s1"] };
    expect(JudgeInstructionEditProposal.parse(p)).toEqual(p);
  });
  it("rejects an unknown verdict", () => {
    expect(JudgeInstructionEditProposal.safeParse({ verdict: "maybe", regressionRisk: "none",
      addressesFailureMode: "yes", regressionCases: [], reason: "x", inputsConsidered: [] }).success).toBe(false);
  });
  it("accepts a well-formed request with both buckets", () => {
    const r = { step: { name: "analyze", currentInstructions: "do X", proposedInstructions: "do X and Y" },
      targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 4, signalCount: null },
      solvedCases: [{ stepRunId: "s1", output: "{}" }], failureCases: [{ stepRunId: "s2", output: "{}" }] };
    expect(JudgeInstructionEditRequest.parse(r).solvedCases[0].stepRunId).toBe("s1");
  });
  it("rejects an oversized request", () => {
    const big = "x".repeat(70000);
    const r = { step: { name: "a", currentInstructions: "a", proposedInstructions: "a" },
      targetedFailureMode: { rule: "R1", failureCode: null, clusterCount: null, signalCount: null },
      solvedCases: [{ stepRunId: "s1", output: big }], failureCases: [] };
    expect(JudgeInstructionEditRequest.safeParse(r).success).toBe(false);
  });
  it("round-trips a persisted judgment and attaches to a proposal", () => {
    const j = { verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes", regressionCases: [],
      reason: "keeps solved cases", solvedCaseIds: ["s1"], failureCaseIds: ["s2"], solvedSampleSize: 1,
      failureSampleSize: 1, judgedAt: "2026-07-04T00:00:00.000Z", judgedAgainstVersion: 3 };
    expect(CounterfactualJudgment.parse(j)).toEqual(j);
    const base = { id: "p1", templateId: "t1", templateVersionAtProposal: 3, stepTemplateId: "st1",
      component: "step_instructions", beforeInstructions: "a", afterInstructions: "b",
      targetedFailureMode: { rule: "R1", failureCode: null, clusterCount: null, signalCount: null },
      predictedImprovement: "x", invariantsPreserved: [], falsifier: "version_comparison",
      rollbackPlan: "revert_to_before",
      evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } },
      rationale: "r", humanEdited: false, status: "pending", createdAt: "2026-07-04T00:00:00.000Z",
      decidedAt: null, decidedBy: null, appliedAsVersion: null, judgment: j };
    expect(TemplateInstructionProposal.parse(base).judgment?.verdict).toBe("pass");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/contracts exec vitest run src/learning/index.test.ts`
Expected: FAIL — `JudgeInstructionEditProposal` not exported.

- [ ] **Step 3: Export the size helper**

In `packages/contracts/src/workflows/index.ts:18`, change `function hasMaxSerializedBytes(` to `export function hasMaxSerializedBytes(`.

- [ ] **Step 4: Add the judge schemas**

In `packages/contracts/src/learning/index.ts`, add the import at the top (after `import { z } from "zod";`):
```ts
import { ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES, hasMaxSerializedBytes } from "../workflows/index.js";
```
Insert after `EvidenceSnapshot` (ends `:39`) and BEFORE `TemplateInstructionProposal`:
```ts
export const JudgeVerdict = z.enum(["pass", "regression_risk", "uncertain"]);
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

export const JudgeInstructionEditProposal = z.object({
  verdict: JudgeVerdict,
  regressionRisk: z.enum(["none", "possible", "likely"]),
  addressesFailureMode: z.enum(["yes", "partial", "no", "unclear"]),
  regressionCases: z.array(z.string().max(256)).max(50),
  reason: z.string().min(1).max(1024),
  inputsConsidered: z.array(z.string().max(256)).max(50),
}).strict();
export type JudgeInstructionEditProposal = z.infer<typeof JudgeInstructionEditProposal>;

const JudgeCase = z.object({ stepRunId: z.string(), output: z.string() }).strict();

export const JudgeInstructionEditRequest = z.object({
  step: z.object({
    name: z.string().max(200),
    currentInstructions: z.string().max(8192),
    proposedInstructions: z.string().max(8192),
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
  solvedCaseIds: z.array(z.string()),
  failureCaseIds: z.array(z.string()),
  solvedSampleSize: z.number().int(),
  failureSampleSize: z.number().int(),
  judgedAt: z.string(),
  judgedAgainstVersion: z.number().int(),
}).strict();
export type CounterfactualJudgment = z.infer<typeof CounterfactualJudgment>;
```
Then add to the `TemplateInstructionProposal` object, immediately after the `watchedDeltas` line (`:64`):
```ts
  judgment: CounterfactualJudgment.nullable().optional(),
```

- [ ] **Step 5: Run tests + build**

Run: `pnpm --filter @orca/contracts exec vitest run src/learning/index.test.ts && pnpm --filter @orca/contracts build`
Expected: PASS; contracts build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/learning/index.ts packages/contracts/src/learning/index.test.ts packages/contracts/src/workflows/index.ts
git commit -m "feat(contracts): counterfactual judge schemas + proposal judgment field

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Migration — `judge_json` column

**Files:**
- Create: `apps/daemon/migrations/0053_learning_proposal_judgment.sql`
- Modify: `apps/daemon/src/migrations.ts` (add to the `migrationFiles` array after `"0052_harness_transitions_refute.sql"`)
- Test: `apps/daemon/src/migrations.test.ts`

**Interfaces:**
- Consumes: the `migrationFiles` ordered array (`migrations.ts:16`).
- Produces: `template_instruction_proposals.judge_json TEXT` column.

- [ ] **Step 1: Write the migration**

`apps/daemon/migrations/0053_learning_proposal_judgment.sql`:
```sql
-- The pre-promotion counterfactual judgment, persisted on the proposal ledger (5.2 judge).
ALTER TABLE template_instruction_proposals ADD COLUMN judge_json TEXT;
```

- [ ] **Step 2: Register it**

In `apps/daemon/src/migrations.ts`, add `"0053_learning_proposal_judgment.sql",` to the `migrationFiles` array immediately after `"0052_harness_transitions_refute.sql",`.

- [ ] **Step 3: Write the failing test**

Add to `apps/daemon/src/migrations.test.ts` (the suite that opens a fresh DB and applies all migrations):
```ts
it("0053 adds template_instruction_proposals.judge_json", () => {
  const cols = db.prepare("PRAGMA table_info(template_instruction_proposals)").all() as { name: string }[];
  expect(cols.some((c) => c.name === "judge_json")).toBe(true);
});
```
(If the migrations test opens its DB differently, match the existing 0052 assertion's setup in that file.)

- [ ] **Step 4: Run + build**

Run: `pnpm --filter @orca/daemon exec vitest run src/migrations.test.ts && pnpm --filter @orca/daemon build`
Expected: PASS (column present); build clean.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/migrations/0053_learning_proposal_judgment.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts
git commit -m "feat(daemon): migration 0053 — template_instruction_proposals.judge_json

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Store — hydrate + persist the judgment

**Files:**
- Modify: `apps/daemon/src/learning/store.ts` (`Row` interface, `rowToProposal`, new `setProposalJudgment`)
- Test: `apps/daemon/src/learning/store.test.ts` (create if absent; otherwise extend)

**Interfaces:**
- Consumes: `CounterfactualJudgment`, `TemplateInstructionProposal` (`@orca/contracts`); the `template_instruction_proposals` table incl. `judge_json` (Task 2).
- Produces: `export function setProposalJudgment(db, proposalId: string, judgment: CounterfactualJudgment): void`; `rowToProposal` now hydrates `judgment` from `judge_json`.

- [ ] **Step 1: Write the failing test**

Create/extend `apps/daemon/src/learning/store.test.ts`:
```ts
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { applyMigrations } from "../migrations.js"; // match the helper the other daemon tests use to apply migrations
import { insertProposal, getProposal, setProposalJudgment } from "./store.js";
import type { TemplateInstructionProposal, CounterfactualJudgment } from "@orca/contracts";

function makeProposal(): TemplateInstructionProposal {
  return { id: "p1", templateId: "t1", templateVersionAtProposal: 2, stepTemplateId: "st1",
    component: "step_instructions", beforeInstructions: "a", afterInstructions: "b",
    targetedFailureMode: { rule: "R1", failureCode: null, clusterCount: null, signalCount: null },
    predictedImprovement: "x", invariantsPreserved: [], falsifier: "version_comparison",
    rollbackPlan: "revert_to_before",
    evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } },
    rationale: "r", humanEdited: false, status: "pending", createdAt: "2026-07-04T00:00:00.000Z",
    decidedAt: null, decidedBy: null, appliedAsVersion: null };
}

describe("proposal judgment persistence", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); insertProposal(db, makeProposal()); });

  it("hydrates null judgment before it is set", () => {
    expect(getProposal(db, "p1")?.judgment ?? null).toBeNull();
  });
  it("persists and hydrates a judgment", () => {
    const j: CounterfactualJudgment = { verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes",
      regressionCases: [], reason: "ok", solvedCaseIds: ["s1"], failureCaseIds: ["s2"], solvedSampleSize: 1,
      failureSampleSize: 1, judgedAt: "2026-07-04T00:00:00.000Z", judgedAgainstVersion: 2 };
    setProposalJudgment(db, "p1", j);
    expect(getProposal(db, "p1")?.judgment).toEqual(j);
  });
});
```
> Note: match the migration-apply helper the other daemon store tests use (grep `apps/daemon/src` for how `template_instruction_proposals` tests set up their DB — reuse that exact import rather than `applyMigrations` if the name differs).

- [ ] **Step 2: Run to verify red**

Run: `pnpm --filter @orca/daemon exec vitest run src/learning/store.test.ts`
Expected: FAIL — `setProposalJudgment` not exported / `judgment` undefined.

- [ ] **Step 3: Implement**

In `apps/daemon/src/learning/store.ts`:
1. Change the import to add the type: `import { TemplateInstructionProposal, type ProposalStatus, type CounterfactualJudgment } from "@orca/contracts";`
2. Add `judge_json: string | null;` to the `Row` interface.
3. In `rowToProposal`, add to the object passed to `TemplateInstructionProposal.parse`:
```ts
    judgment: r.judge_json ? (JSON.parse(r.judge_json) as CounterfactualJudgment) : null,
```
4. Add the writer at the end of the file:
```ts
export function setProposalJudgment(db: Database.Database, proposalId: string, judgment: CounterfactualJudgment): void {
  db.prepare(`UPDATE template_instruction_proposals SET judge_json = ? WHERE id = ?`)
    .run(JSON.stringify(judgment), proposalId);
}
```
(`insertProposal` is unchanged — new proposals have `judge_json` NULL by default.)

- [ ] **Step 4: Run green + build**

Run: `pnpm --filter @orca/daemon exec vitest run src/learning/store.test.ts && pnpm --filter @orca/daemon build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning/store.ts apps/daemon/src/learning/store.test.ts
git commit -m "feat(learning): persist + hydrate the proposal judgment

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Corpus builder — two-bucket past outputs

**Files:**
- Create: `apps/daemon/src/learning/corpus.ts`
- Test: `apps/daemon/src/learning/corpus.test.ts`

**Interfaces:**
- Consumes: a better-sqlite3 `Database`; `EvidenceFacet`, `RefuteFacet`, `TemplateInstructionProposal` (`@orca/contracts`); tables `workflow_artifacts` (`type='step_output'`, `body`, `step_run_id`, `created_at`), `workflow_step_runs` (`step_template_id`), `workflow_runs` (`template_id`), `harness_transitions` (`boundary='step_complete'`, `evidence_json`, `refute_json`), `step_revision_signals` (`step_run_id`).
- Produces:
  - `export const K_PER_BUCKET = 5;` `export const OUTPUT_BUDGET = 2000;`
  - `export interface JudgeCase { stepRunId: string; output: string }`
  - `export interface JudgeCorpus { solved: JudgeCase[]; failure: JudgeCase[] }`
  - `export function buildJudgeCorpus(db, proposal: TemplateInstructionProposal): JudgeCorpus`

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/learning/corpus.test.ts`:
```ts
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { buildJudgeCorpus } from "./corpus.js";
import type { TemplateInstructionProposal } from "@orca/contracts";

function schema(db: Database.Database) {
  db.exec(`
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, template_id TEXT);
    CREATE TABLE workflow_step_runs (id TEXT PRIMARY KEY, workflow_run_id TEXT, step_template_id TEXT);
    CREATE TABLE workflow_artifacts (id TEXT PRIMARY KEY, workflow_run_id TEXT, step_run_id TEXT, type TEXT, body TEXT, created_at TEXT);
    CREATE TABLE harness_transitions (id TEXT PRIMARY KEY, workflow_step_run_id TEXT, boundary TEXT, evidence_json TEXT, refute_json TEXT, created_at TEXT);
    CREATE TABLE step_revision_signals (id TEXT PRIMARY KEY, step_run_id TEXT);
  `);
}
function stepRun(db: Database.Database, runId: string, srId: string, tpl: string, stTpl: string) {
  db.prepare("INSERT OR IGNORE INTO workflow_runs (id, template_id) VALUES (?,?)").run(runId, tpl);
  db.prepare("INSERT INTO workflow_step_runs (id, workflow_run_id, step_template_id) VALUES (?,?,?)").run(srId, runId, stTpl);
}
function artifact(db: Database.Database, runId: string, srId: string, body: string, at: string) {
  db.prepare("INSERT INTO workflow_artifacts (id, workflow_run_id, step_run_id, type, body, created_at) VALUES (?,?,?,?,?,?)")
    .run(`a-${srId}-${at}`, runId, srId, "step_output", body, at);
}
function stepComplete(db: Database.Database, srId: string, evidence: unknown, refute: unknown) {
  db.prepare("INSERT INTO harness_transitions (id, workflow_step_run_id, boundary, evidence_json, refute_json, created_at) VALUES (?,?,?,?,?,?)")
    .run(`ht-${srId}`, srId, "step_complete", evidence ? JSON.stringify(evidence) : null, refute ? JSON.stringify(refute) : null, "2026-07-01T00:00:00.000Z");
}
const passedEvidence = { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } };
const upheldRefute = { verdict: "upheld", triggered_by: ["no_oracle"], risk_class: "low", reason: null, issue_refs: [] };
const refutedRefute = { verdict: "refuted", triggered_by: ["no_oracle"], risk_class: "low", reason: "bad", issue_refs: ["x"] };

function proposal(over: Partial<TemplateInstructionProposal> = {}): TemplateInstructionProposal {
  return { id: "p1", templateId: "t1", templateVersionAtProposal: 1, stepTemplateId: "st1",
    component: "step_instructions", beforeInstructions: "a", afterInstructions: "b",
    targetedFailureMode: { rule: "R1", failureCode: null, clusterCount: null, signalCount: null },
    predictedImprovement: "x", invariantsPreserved: [], falsifier: "version_comparison", rollbackPlan: "revert_to_before",
    evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } },
    rationale: "r", humanEdited: false, status: "pending", createdAt: "2026-07-01T00:00:00.000Z",
    decidedAt: null, decidedBy: null, appliedAsVersion: null, ...over };
}

describe("buildJudgeCorpus", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); schema(db); });

  it("buckets solved cases by refute-upheld primary / evidence-passed fallback", () => {
    stepRun(db, "r1", "sr-upheld", "t1", "st1"); artifact(db, "r1", "sr-upheld", "{\"ok\":1}", "2026-07-02T00:00:00.000Z"); stepComplete(db, "sr-upheld", null, upheldRefute);
    stepRun(db, "r2", "sr-passed", "t1", "st1"); artifact(db, "r2", "sr-passed", "{\"ok\":2}", "2026-07-02T00:00:00.000Z"); stepComplete(db, "sr-passed", passedEvidence, null);
    stepRun(db, "r3", "sr-refuted", "t1", "st1"); artifact(db, "r3", "sr-refuted", "{\"bad\":1}", "2026-07-02T00:00:00.000Z"); stepComplete(db, "sr-refuted", passedEvidence, refutedRefute);
    const c = buildJudgeCorpus(db, proposal());
    const ids = c.solved.map((s) => s.stepRunId).sort();
    expect(ids).toEqual(["sr-passed", "sr-upheld"]); // refuted excluded even though evidence passed (refute primary)
  });

  it("resolves failure bucket from the proposal's sampleTransitionIds (earliest attempt) and excludes them from solved", () => {
    stepRun(db, "r1", "sr-fail", "t1", "st1");
    artifact(db, "r1", "sr-fail", "{\"attempt\":1}", "2026-07-02T00:00:00.000Z"); // earliest = the failing one
    artifact(db, "r1", "sr-fail", "{\"attempt\":2}", "2026-07-03T00:00:00.000Z");
    stepComplete(db, "sr-fail", passedEvidence, null); // later succeeded, but it's the diagnosed failure case
    const c = buildJudgeCorpus(db, proposal({ evidence: { sampleTransitionIds: ["ht-sr-fail"], revisionSignalIds: [], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } } }));
    expect(c.failure).toEqual([{ stepRunId: "sr-fail", output: "{\"attempt\":1}" }]);
    expect(c.solved.some((s) => s.stepRunId === "sr-fail")).toBe(false);
  });

  it("resolves failure bucket from revisionSignalIds", () => {
    stepRun(db, "r1", "sr-rev", "t1", "st1"); artifact(db, "r1", "sr-rev", "{\"v\":1}", "2026-07-02T00:00:00.000Z");
    db.prepare("INSERT INTO step_revision_signals (id, step_run_id) VALUES (?,?)").run("sig1", "sr-rev");
    const c = buildJudgeCorpus(db, proposal({ evidence: { sampleTransitionIds: [], revisionSignalIds: ["sig1"], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } } }));
    expect(c.failure.map((f) => f.stepRunId)).toEqual(["sr-rev"]);
  });

  it("caps each bucket at K and clamps output length", () => {
    for (let i = 0; i < 7; i++) { stepRun(db, `r${i}`, `sr${i}`, "t1", "st1"); artifact(db, `r${i}`, `sr${i}`, "y".repeat(5000), `2026-07-0${i + 1}T00:00:00.000Z`); stepComplete(db, `sr${i}`, null, upheldRefute); }
    const c = buildJudgeCorpus(db, proposal());
    expect(c.solved.length).toBe(5);
    expect(c.solved[0].output.length).toBe(2000);
  });
});
```

- [ ] **Step 2: Run to verify red**

Run: `pnpm --filter @orca/daemon exec vitest run src/learning/corpus.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/daemon/src/learning/corpus.ts`:
```ts
import type Database from "better-sqlite3";
import { EvidenceFacet, RefuteFacet, type TemplateInstructionProposal } from "@orca/contracts";

export const K_PER_BUCKET = 5;
export const OUTPUT_BUDGET = 2000; // chars per compacted output

export interface JudgeCase { stepRunId: string; output: string }
export interface JudgeCorpus { solved: JudgeCase[]; failure: JudgeCase[] }

function compact(body: string): string {
  let text = body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { _completion: _omit, ...rest } = parsed as Record<string, unknown>;
      text = JSON.stringify(rest);
    }
  } catch { /* keep raw */ }
  return text.length > OUTPUT_BUDGET ? text.slice(0, OUTPUT_BUDGET) : text;
}

// Solved: latest step_output per step run whose step_complete verdict is solved
// (refute upheld primary; evidence passed fallback). Excludes the failure step runs.
function buildSolved(db: Database.Database, templateId: string, stepTemplateId: string, exclude: Set<string>): JudgeCase[] {
  const rows = db.prepare(
    `SELECT wa.step_run_id AS step_run_id, wa.body AS body,
            ht.evidence_json AS evidence_json, ht.refute_json AS refute_json
     FROM workflow_artifacts wa
     JOIN workflow_step_runs wsr ON wsr.id = wa.step_run_id
     JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
     JOIN harness_transitions ht ON ht.workflow_step_run_id = wa.step_run_id AND ht.boundary = 'step_complete'
     WHERE wr.template_id = ? AND wsr.step_template_id = ? AND wa.type = 'step_output'
     ORDER BY wa.created_at DESC, wa.rowid DESC`
  ).all(templateId, stepTemplateId) as { step_run_id: string; body: string; evidence_json: string | null; refute_json: string | null }[];
  const seen = new Set<string>();
  const out: JudgeCase[] = [];
  for (const r of rows) {
    if (seen.has(r.step_run_id)) continue;
    seen.add(r.step_run_id);
    if (exclude.has(r.step_run_id)) continue;
    const refute = r.refute_json ? RefuteFacet.safeParse(JSON.parse(r.refute_json)) : null;
    const evidence = r.evidence_json ? EvidenceFacet.safeParse(JSON.parse(r.evidence_json)) : null;
    let solved = false;
    if (refute && refute.success) solved = refute.data.verdict === "upheld";      // refute primary
    else if (evidence && evidence.success) solved = evidence.data.verdict === "passed"; // evidence fallback
    if (!solved) continue;
    out.push({ stepRunId: r.step_run_id, output: compact(r.body) });
    if (out.length >= K_PER_BUCKET) break;
  }
  return out;
}

// Failure: the proposal's own diagnosed cases (sampleTransitionIds + revisionSignalIds),
// each resolved to the EARLIEST step_output attempt (the pre-revision failing output).
function buildFailure(db: Database.Database, proposal: TemplateInstructionProposal): JudgeCase[] {
  const stepRunIds: string[] = [];
  const add = (id: string | null | undefined) => { if (id && !stepRunIds.includes(id)) stepRunIds.push(id); };
  for (const tid of proposal.evidence.sampleTransitionIds) {
    const r = db.prepare(`SELECT workflow_step_run_id AS s FROM harness_transitions WHERE id = ?`).get(tid) as { s: string | null } | undefined;
    add(r?.s);
  }
  for (const sid of proposal.evidence.revisionSignalIds) {
    const r = db.prepare(`SELECT step_run_id AS s FROM step_revision_signals WHERE id = ?`).get(sid) as { s: string } | undefined;
    add(r?.s);
  }
  const out: JudgeCase[] = [];
  for (const stepRunId of stepRunIds) {
    const r = db.prepare(
      `SELECT body FROM workflow_artifacts WHERE step_run_id = ? AND type = 'step_output' ORDER BY created_at ASC, rowid ASC LIMIT 1`
    ).get(stepRunId) as { body: string } | undefined;
    if (r) out.push({ stepRunId, output: compact(r.body) });
    if (out.length >= K_PER_BUCKET) break;
  }
  return out;
}

export function buildJudgeCorpus(db: Database.Database, proposal: TemplateInstructionProposal): JudgeCorpus {
  const failure = buildFailure(db, proposal);
  const failureIds = new Set(failure.map((c) => c.stepRunId));
  const solved = buildSolved(db, proposal.templateId, proposal.stepTemplateId, failureIds);
  return { solved, failure };
}
```

- [ ] **Step 4: Run green + build**

Run: `pnpm --filter @orca/daemon exec vitest run src/learning/corpus.test.ts && pnpm --filter @orca/daemon build`
Expected: PASS (4 tests); build clean.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning/corpus.ts apps/daemon/src/learning/corpus.test.ts
git commit -m "feat(learning): two-bucket past-output corpus for the counterfactual judge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Judge module (`learning/judge.ts`)

Pure module mirroring `refute-completion.ts`: compose an adversarial, spec-grounded prompt; ask an isolated shadow turn; parse the tri-state proposal; retry once; log + return `null`.

**Files:**
- Create: `apps/daemon/src/learning/judge.ts`
- Test: `apps/daemon/src/learning/judge.test.ts`

**Interfaces:**
- Consumes: `ShadowAsk` (`import type { ShadowAsk } from "../workflows/orchestrator/recover-step-scoring.js"`), `JudgeInstructionEditProposal`/`JudgeInstructionEditRequest` (`@orca/contracts`), `ShadowAdapterId` (`../orchestrator-llm/shadow-session.js`).
- Produces:
  - `export function composeJudgePrompt(request: JudgeInstructionEditRequest): { systemPrompt: string; userPrompt: string }`
  - `export async function judgeInstructionEdit(deps: ShadowAsk, input: { judgeSessionKey: string; adapterId: ShadowAdapterId; request: JudgeInstructionEditRequest; timeoutMs: number }): Promise<JudgeInstructionEditProposal | null>`

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/learning/judge.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { JudgeInstructionEditRequest } from "@orca/contracts";
import type { ShadowAsk } from "../workflows/orchestrator/recover-step-scoring.js";
import { judgeInstructionEdit, composeJudgePrompt } from "./judge.js";

const REQ: JudgeInstructionEditRequest = {
  step: { name: "analyze", currentInstructions: "Cover the error paths.", proposedInstructions: "Cover error paths and log them." },
  targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 4, signalCount: null },
  solvedCases: [{ stepRunId: "s1", output: "{\"ok\":1}" }],
  failureCases: [{ stepRunId: "s2", output: "{\"bad\":1}" }],
};
const ask = (text: string): ShadowAsk => ({ async ask() { return { text }; } });
const askThrows = (): ShadowAsk => ({ async ask() { throw new Error("shadow down"); } });

describe("judgeInstructionEdit", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it("parses a regression_risk verdict and preserves regressionCases", async () => {
    const p = { verdict: "regression_risk", regressionRisk: "likely", addressesFailureMode: "partial", regressionCases: ["s1"], reason: "would drop error check", inputsConsidered: ["s1", "s2"] };
    const r = await judgeInstructionEdit(ask(JSON.stringify(p)), { judgeSessionKey: "t1::judge", adapterId: "claude-code", request: REQ, timeoutMs: 1000 });
    expect(r).toEqual(p);
  });
  it("respects an uncertain verdict", async () => {
    const p = { verdict: "uncertain", regressionRisk: "possible", addressesFailureMode: "unclear", regressionCases: [], reason: "cannot tell", inputsConsidered: [] };
    const r = await judgeInstructionEdit(ask(JSON.stringify(p)), { judgeSessionKey: "t1::judge", adapterId: "claude-code", request: REQ, timeoutMs: 1000 });
    expect(r?.verdict).toBe("uncertain");
  });
  it("returns null + logs on throw / non-JSON / invalid", async () => {
    expect(await judgeInstructionEdit(askThrows(), { judgeSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
    expect(await judgeInstructionEdit(ask("not json"), { judgeSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
    expect(await judgeInstructionEdit(ask(JSON.stringify({ verdict: "nope" })), { judgeSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[judge]"));
  });
  it("asks the isolated ${templateId}::judge key", async () => {
    const seen: string[] = [];
    const spy: ShadowAsk = { async ask(key: string) { seen.push(key); return { text: JSON.stringify({ verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes", regressionCases: [], reason: "ok", inputsConsidered: [] }) }; } };
    await judgeInstructionEdit(spy, { judgeSessionKey: "t1::judge", adapterId: "claude-code", request: REQ, timeoutMs: 1000 });
    expect(seen).toEqual(["t1::judge"]);
  });
  it("prompt grounds on instructions + both buckets, forbids deferring to prior scoring", () => {
    const { systemPrompt, userPrompt } = composeJudgePrompt(REQ);
    expect(systemPrompt).toContain("orca:action");
    expect(systemPrompt).toContain("INSTRUCTIONS");
    expect(systemPrompt).toContain("regress");
    expect(userPrompt).toContain("proposedInstructions");
  });
});
```

- [ ] **Step 2: Run to verify red**

Run: `pnpm --filter @orca/daemon exec vitest run src/learning/judge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

`apps/daemon/src/learning/judge.ts`:
```ts
import { JudgeInstructionEditProposal, type JudgeInstructionEditRequest } from "@orca/contracts";
import type { ShadowAdapterId } from "../orchestrator-llm/shadow-session.js";
import type { ShadowAsk } from "../workflows/orchestrator/recover-step-scoring.js";

export function composeJudgePrompt(
  request: JudgeInstructionEditRequest
): { systemPrompt: string; userPrompt: string } {
  // Anti-circularity (p.37 AgentCoder Test-Designer / p.46 CANDOR): judge each output
  // against the step INSTRUCTIONS (the spec), NOT any prior scoring (none is given).
  // Criterion (p.33/§3.5.2): improve the targeted failure WITHOUT regressing solved cases.
  const systemPrompt = [
    "You are an INDEPENDENT reviewer evaluating a PROPOSED edit to one workflow step's instruction text.",
    "Judge each past output against the step INSTRUCTIONS (the spec). You are given NO prior scoring —",
    "ground your judgment in the outputs themselves; do not defer to the author.",
    "solvedCases PREVIOUSLY PASSED independent verification and MUST NOT regress under the proposed edit.",
    "failureCases exhibit the targeted failure mode and SHOULD improve under the proposed edit.",
    "For each solved case, would the PROPOSED instructions still yield an output that satisfies the instructions?",
    "Name any that would regress in regressionCases. For the failure cases, would the edit plausibly fix them?",
    "Return 'pass' ONLY if you find no concrete regression AND the edit addresses the failure mode;",
    "'regression_risk' if a previously-solved case would concretely break; 'uncertain' if plausible but you",
    "genuinely cannot tell — do NOT guess. List in inputsConsidered exactly which cases you used.",
    "Emit exactly one JudgeInstructionEditProposal JSON object in one fenced block, nothing after:",
    "```orca:action",
    '{ "verdict": "...", "regressionRisk": "...", "addressesFailureMode": "...", "regressionCases": [...], "reason": "...", "inputsConsidered": [...] }',
    "```",
  ].join("\n");
  return { systemPrompt, userPrompt: JSON.stringify(request) };
}

export async function judgeInstructionEdit(
  deps: ShadowAsk,
  input: { judgeSessionKey: string; adapterId: ShadowAdapterId; request: JudgeInstructionEditRequest; timeoutMs: number }
): Promise<JudgeInstructionEditProposal | null> {
  const { systemPrompt, userPrompt } = composeJudgePrompt(input.request);
  let lastFailure = "no attempts made";
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      ({ text } = await deps.ask(input.judgeSessionKey, {
        adapterId: input.adapterId, systemPrompt, userPrompt, timeoutMs: input.timeoutMs,
      }));
    } catch (err) {
      lastFailure = `shadow ask failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { lastFailure = "response was not JSON"; continue; }
    const parsed = JudgeInstructionEditProposal.safeParse(raw);
    if (parsed.success) return parsed.data;
    lastFailure = `invalid JudgeInstructionEditProposal: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 200)}`;
  }
  // Caller records "unavailable" on null; surface WHY for observability (p.33).
  console.warn(`[judge] instruction-edit judge failed for session ${input.judgeSessionKey}: ${lastFailure}`);
  return null;
}
```
> `"INSTRUCTIONS"` appears in the system prompt (test asserts it). Confirm `ShadowAdapterId` is exported from `../orchestrator-llm/shadow-session.js` (it is — `refute-completion.ts` imports it from the same module at a different depth).

- [ ] **Step 4: Run green + build**

Run: `pnpm --filter @orca/daemon exec vitest run src/learning/judge.test.ts && pnpm --filter @orca/daemon build`
Expected: PASS (5 tests); build clean.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning/judge.ts apps/daemon/src/learning/judge.test.ts
git commit -m "feat(learning): isolated adversarial counterfactual judge module

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Usecase + route + shadow wiring

The core wiring: `judgeProposal` builds the corpus, runs the isolated judge (spawn + teardown per call), wraps + persists a write-once judgment; the route exposes it idempotently; `server.ts` injects the shadow seam.

**Files:**
- Modify: `apps/daemon/src/learning/usecases.ts` (add `JudgeDeps`, `SOLVED_MIN`/`FAILURE_MIN`, `judgeProposal`)
- Modify: `apps/daemon/src/learning/routes.ts` (`LearningRouteDeps` gains `shadowAsk`/`terminateShadow`; add the judge route)
- Modify: `apps/daemon/src/server.ts:2231` (inject `shadowAsk` + `terminateShadow`)
- Test: `apps/daemon/src/learning/judge-usecase.test.ts`

**Interfaces:**
- Consumes: `buildJudgeCorpus` (Task 4); `judgeInstructionEdit` (Task 5); `getProposal`/`setProposalJudgment` (Task 3); `StepNotFoundError`/`ProposalNotPendingError` (`./apply.js`); `anchorForStep`/`orchestratorModelForGoal`/`nowOr` (existing in `usecases.ts`); `adapterIdForProvider` (`../orchestrator-llm/model-provider-llm-client.js`); `SHADOW_LLM_TIMEOUT_MS` (`../orchestrator-llm/shadow-llm-client.js`); `ShadowAsk` (`../workflows/orchestrator/recover-step-scoring.js`); `ShadowAdapterId` (`../orchestrator-llm/shadow-session.js`); `CounterfactualJudgment`/`JudgeInstructionEditRequest`/`ModelProviderId` (`@orca/contracts`).
- Produces: `export interface JudgeDeps { shadowAsk: ShadowAsk; terminateShadow: (key: string) => Promise<void> | void }`; `export async function judgeProposal(deps: JudgeDeps, db, proposalId: string, nowIso?: string): Promise<TemplateInstructionProposal>`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/learning/judge-usecase.test.ts` (reuse the corpus test's schema/seed helpers — copy the `schema`, `stepRun`, `artifact`, `stepComplete`, fact constants into this file, plus the `template_instruction_proposals` + `goals` tables):
```ts
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyMigrations } from "../migrations.js"; // match the daemon migration-apply helper
import { insertProposal, getProposal } from "./store.js";
import { judgeProposal, type JudgeDeps } from "./usecases.js";
import type { ShadowAsk } from "../workflows/orchestrator/recover-step-scoring.js";
import type { TemplateInstructionProposal } from "@orca/contracts";

// ...seed helpers: create workflow_runs/step_runs/artifacts/harness_transitions/goals rows so the
// corpus has >=1 solved and >=1 failure case, and goals has orchestrator_provider/model for the anchor.
// (Mirror corpus.test.ts's seeders; add a goals row and a harness_transition carrying goal_id/workflow_run_id.)

function fakeAsk(text: string, seen: string[] = []): ShadowAsk { return { async ask(key) { seen.push(key); return { text }; } }; }
const PASS = JSON.stringify({ verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes", regressionCases: [], reason: "ok", inputsConsidered: ["s1"] });

describe("judgeProposal", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); /* seed corpus + goal + proposal p1 (status pending, evidence pointing at the failure case) */ });

  it("persists a CounterfactualJudgment with engine-recorded case ids and returns the hydrated proposal", async () => {
    const terminated: string[] = [];
    const deps: JudgeDeps = { shadowAsk: fakeAsk(PASS), terminateShadow: (k) => { terminated.push(k); } };
    const p = await judgeProposal(deps, db, "p1");
    expect(p.judgment?.verdict).toBe("pass");
    expect(p.judgment?.solvedCaseIds.length).toBeGreaterThanOrEqual(1);
    expect(p.judgment?.failureCaseIds.length).toBeGreaterThanOrEqual(1);
    expect(p.judgment?.judgedAgainstVersion).toBe(p.templateVersionAtProposal);
    expect(terminated).toEqual(["t1::judge"]); // teardown per call
  });

  it("is idempotent — a second call makes no second shadow ask and returns the same judgment", async () => {
    const seen: string[] = [];
    const deps: JudgeDeps = { shadowAsk: fakeAsk(PASS, seen), terminateShadow: () => {} };
    await judgeProposal(deps, db, "p1");
    const before = getProposal(db, "p1")?.judgment;
    await judgeProposal(deps, db, "p1");
    expect(seen.length).toBe(1); // no second ask
    expect(getProposal(db, "p1")?.judgment).toEqual(before);
  });

  it("throws ProposalNotPendingError for a decided proposal (no shadow ask)", async () => {
    const seen: string[] = [];
    // ...mark p1 status 'applied' in the seed or via updateProposalDecision
    const deps: JudgeDeps = { shadowAsk: fakeAsk(PASS, seen), terminateShadow: () => {} };
    await expect(judgeProposal(deps, db, "p1")).rejects.toThrow();
    expect(seen.length).toBe(0);
  });

  it("short-circuits to insufficient_evidence when a bucket is empty (no shadow ask)", async () => {
    const seen: string[] = [];
    // ...seed a proposal p2 whose step has no solved cases
    const deps: JudgeDeps = { shadowAsk: fakeAsk(PASS, seen), terminateShadow: () => {} };
    const p = await judgeProposal(deps, db, "p2");
    expect(p.judgment?.verdict).toBe("insufficient_evidence");
    expect(seen.length).toBe(0);
  });

  it("records unavailable when the shadow returns null", async () => {
    const deps: JudgeDeps = { shadowAsk: { async ask() { throw new Error("down"); } }, terminateShadow: () => {} };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = await judgeProposal(deps, db, "p1");
    expect(p.judgment?.verdict).toBe("unavailable");
  });
});
```
> The seed is the fiddly part: create a `goals` row (`id`, `orchestrator_provider`, `orchestrator_model`), a `workflow_runs` row, `workflow_step_runs`, a solved `step_output` + `step_complete` transition, and a failure `step_output` + a `harness_transitions` row whose `id` is in the proposal's `evidence.sampleTransitionIds` and whose `goal_id`/`workflow_run_id`/`workflow_step_run_id` let `anchorForStep` resolve. Model the seed on `corpus.test.ts` + the existing `usecases`/`analyze` tests' goal seeding.

- [ ] **Step 2: Run to verify red**

Run: `pnpm --filter @orca/daemon exec vitest run src/learning/judge-usecase.test.ts`
Expected: FAIL — `judgeProposal` not exported.

- [ ] **Step 3: Implement `judgeProposal`**

In `apps/daemon/src/learning/usecases.ts`, add imports:
```ts
import type { CounterfactualJudgment, JudgeInstructionEditProposal, ModelProviderId } from "@orca/contracts";
import { JudgeInstructionEditRequest } from "@orca/contracts";
import type { ShadowAsk } from "../workflows/orchestrator/recover-step-scoring.js";
import type { ShadowAdapterId } from "../orchestrator-llm/shadow-session.js";
import { adapterIdForProvider } from "../orchestrator-llm/model-provider-llm-client.js";
import { SHADOW_LLM_TIMEOUT_MS } from "../orchestrator-llm/shadow-llm-client.js";
import { buildJudgeCorpus } from "./corpus.js";
import { judgeInstructionEdit } from "./judge.js";
import { getProposal, setProposalJudgment } from "./store.js";
import { StepNotFoundError, ProposalNotPendingError } from "./apply.js";
```
(Extend the existing `./store.js` import rather than duplicating it; `getProposal` may already be imported there.)

Add near the top:
```ts
export interface JudgeDeps {
  shadowAsk: ShadowAsk;
  terminateShadow: (key: string) => Promise<void> | void;
}
export const SOLVED_MIN = 1;
export const FAILURE_MIN = 1;
```

Add the usecase:
```ts
export async function judgeProposal(
  deps: JudgeDeps, db: Database.Database, proposalId: string, nowIso?: string,
): Promise<TemplateInstructionProposal> {
  const now = nowOr(nowIso);
  const p = getProposal(db, proposalId);
  if (!p) throw new StepNotFoundError(`proposal ${proposalId} not found`);
  if (p.status !== "pending") throw new ProposalNotPendingError(`proposal ${proposalId} is ${p.status}`);
  if (p.judgment) return p; // write-once + idempotent — never clobber the audit record

  const corpus = buildJudgeCorpus(db, p);
  const base = {
    regressionCases: [] as string[],
    solvedCaseIds: corpus.solved.map((c) => c.stepRunId),
    failureCaseIds: corpus.failure.map((c) => c.stepRunId),
    solvedSampleSize: corpus.solved.length,
    failureSampleSize: corpus.failure.length,
    judgedAt: now,
    judgedAgainstVersion: p.templateVersionAtProposal,
  };

  const persist = (j: CounterfactualJudgment): TemplateInstructionProposal => {
    setProposalJudgment(db, proposalId, j);
    return getProposal(db, proposalId)!;
  };

  if (corpus.solved.length < SOLVED_MIN || corpus.failure.length < FAILURE_MIN) {
    return persist({ verdict: "insufficient_evidence", regressionRisk: null, addressesFailureMode: null, reason: null, ...base });
  }

  // Resolve the shadow adapter from the anchor run's goal (per-template; no goal of our own).
  const anchor = anchorForStep(db, p.templateId, p.stepTemplateId);
  const model = anchor ? orchestratorModelForGoal(db, anchor.goalId) : null;
  const adapterId: ShadowAdapterId | null = model
    ? (adapterIdForProvider(model.providerId as ModelProviderId) as ShadowAdapterId)
    : null;

  let fill: JudgeInstructionEditProposal | null = null;
  if (adapterId) {
    const request = JudgeInstructionEditRequest.parse({
      step: {
        name: p.stepTemplateId,
        currentInstructions: p.beforeInstructions.slice(0, 8192),
        proposedInstructions: p.afterInstructions.slice(0, 8192),
      },
      targetedFailureMode: p.targetedFailureMode,
      solvedCases: corpus.solved,
      failureCases: corpus.failure,
    });
    const key = `${p.templateId}::judge`;
    try {
      fill = await judgeInstructionEdit(deps.shadowAsk, { judgeSessionKey: key, adapterId, request, timeoutMs: SHADOW_LLM_TIMEOUT_MS });
    } finally {
      await deps.terminateShadow(key); // spawn + teardown per judgment (maximal independence)
    }
  }

  return persist(fill
    ? { verdict: fill.verdict, regressionRisk: fill.regressionRisk, addressesFailureMode: fill.addressesFailureMode,
        regressionCases: fill.regressionCases, reason: fill.reason, solvedCaseIds: base.solvedCaseIds,
        failureCaseIds: base.failureCaseIds, solvedSampleSize: base.solvedSampleSize,
        failureSampleSize: base.failureSampleSize, judgedAt: now, judgedAgainstVersion: base.judgedAgainstVersion }
    : { verdict: "unavailable", regressionRisk: null, addressesFailureMode: null, reason: null, ...base });
}
```
> `nowOr`, `anchorForStep`, `orchestratorModelForGoal`, and the `TemplateInstructionProposal` import already exist in `usecases.ts`. `orchestratorModelForGoal` returns `{ providerId, modelId } | null`.

- [ ] **Step 4: Add the route**

In `apps/daemon/src/learning/routes.ts`:
1. Extend `LearningRouteDeps`:
```ts
import type { ShadowAsk } from "../workflows/orchestrator/recover-step-scoring.js";
// ...
export interface LearningRouteDeps extends AnalyzeDeps {
  db: Database.Database;
  actor: () => string;
  shadowAsk: ShadowAsk;
  terminateShadow: (key: string) => Promise<void> | void;
}
```
2. Import the usecase: add `judgeProposal` to the existing `./usecases.js` import.
3. Add the route (after the `dismiss` route):
```ts
server.post("/v1/learning/proposals/:id/judge", async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    const proposal = await judgeProposal({ shadowAsk: deps.shadowAsk, terminateShadow: deps.terminateShadow }, db, id);
    return { proposal };
  } catch (e) {
    if (e instanceof StepNotFoundError) { reply.status(404); return { error: { code: "not_found" } }; }
    if (e instanceof ProposalNotPendingError) { reply.status(409); return { error: { code: "not_pending" } }; }
    throw e;
  }
});
```
(`StepNotFoundError`/`ProposalNotPendingError` are already imported from `./apply.js` in this file.)

- [ ] **Step 5: Wire the shadow seam in `server.ts`**

In `apps/daemon/src/server.ts:2231`, extend the `registerLearningRoutes` deps:
```ts
  registerLearningRoutes(server, {
    db,
    broker: daemonContext.orchestrationTransportBroker,
    actor: () => "owner",
    shadowAsk: async (goalId, input) => {
      await shadowSessions.spawn(goalId, input.adapterId);
      return shadowSessions.ask(goalId, input);
    },
    terminateShadow: (key) => shadowSessions.terminate(key),
  });
```
(Same `shadowSessions` manager used by the orchestrator's `shadowAsk` at `:2156`; `terminate` returns a promise — the judge usecase awaits it.)

- [ ] **Step 6: Run green + build**

Run: `pnpm --filter @orca/daemon exec vitest run src/learning && pnpm --filter @orca/daemon build`
Expected: PASS (judge-usecase + existing learning tests); build clean.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/learning/usecases.ts apps/daemon/src/learning/routes.ts apps/daemon/src/server.ts apps/daemon/src/learning/judge-usecase.test.ts
git commit -m "feat(learning): judge usecase + route + isolated shadow wiring (evaluate stage)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Desktop — "Evaluate this edit" + judgment card

**Files:**
- Modify: the desktop learning API client (`apps/desktop/src/**/api.ts` — the file with `analyzeTemplate`/`applyProposal`) — add `judgeProposal`
- Modify: the Self-Improvement rail component (`apps/desktop/src/**/SelfImprovement*.tsx` — the proposal card) — add the action + judgment display
- Test: the component test beside `SelfImprovement` (mirror the existing proposal-card test)

**Interfaces:**
- Consumes: the `POST /v1/learning/proposals/:id/judge` route (Task 6); the `TemplateInstructionProposal.judgment` field (Task 1).
- Produces: `judgeProposal(proposalId: string): Promise<{ proposal: TemplateInstructionProposal }>` client fn; a judgment section on the card.

- [ ] **Step 1: Locate the existing client + card**

Run: `grep -rn "applyProposal\|analyzeTemplate\|listProposals" apps/desktop/src` and `grep -rln "SelfImprovement" apps/desktop/src`. Open the `api.ts` and the card component. Match their exact patterns (fetch wrapper, error handling, state hooks) — do not introduce a new style.

- [ ] **Step 2: Write the failing component test**

In the card's test file, add (adapt selectors/imports to the existing test's harness):
```tsx
it("shows the judge verdict and keeps Apply enabled (informs, never gates)", () => {
  const proposal = { /* ...a pending proposal fixture... */,
    judgment: { verdict: "regression_risk", regressionRisk: "likely", addressesFailureMode: "partial",
      regressionCases: ["s1"], reason: "would drop the error-path check", solvedCaseIds: ["s1"], failureCaseIds: ["s2"],
      solvedSampleSize: 1, failureSampleSize: 1, judgedAt: "2026-07-04T00:00:00.000Z", judgedAgainstVersion: 3 } };
  render(<ProposalCard proposal={proposal} /* ...existing props... */ />);
  expect(screen.getByText(/regression risk/i)).toBeInTheDocument();
  expect(screen.getByText(/would drop the error-path check/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /apply/i })).toBeEnabled(); // never gated
});
it("shows the Evaluate action when unjudged", () => {
  const proposal = { /* ...pending proposal, no judgment... */ };
  render(<ProposalCard proposal={proposal} /* ... */ />);
  expect(screen.getByRole("button", { name: /evaluate this edit/i })).toBeInTheDocument();
});
```

- [ ] **Step 3: Run to verify red**

Run: `pnpm --filter @orca/desktop exec vitest run <card test path>`
Expected: FAIL — no Evaluate button / verdict text.

- [ ] **Step 4: Implement the client fn + card**

In `api.ts` (match the existing fns' shape):
```ts
export async function judgeProposal(proposalId: string): Promise<{ proposal: TemplateInstructionProposal }> {
  return apiFetch(`/v1/learning/proposals/${proposalId}/judge`, { method: "POST" });
}
```
In the card: when `proposal.judgment` is absent, render an **"Evaluate this edit"** button calling `judgeProposal` (with a pending state during the request); when present, render the verdict chip (`pass ✓` / `regression_risk ⚠` / `uncertain ?` / `insufficient_evidence —` / `unavailable —`), `reason`, the `regressionCases` list, and `"judged {solvedSampleSize} solved · {failureSampleSize} failure cases"`. If the existing card already links transitions to provenance/replay, link `solvedCaseIds`/`failureCaseIds` the same way. Leave Apply / Edit&Apply / Dismiss exactly as they are — never disabled by the verdict. Thin-client: render computed values only; no arithmetic.

- [ ] **Step 5: Run green + build**

Run: `pnpm --filter @orca/desktop exec vitest run <card test path> && pnpm --filter @orca/desktop build`
Expected: PASS; build clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): Evaluate-this-edit action + counterfactual judgment card

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Docs

**Files:** `ORCA.md`, `FUTURE_WORK.md`, `FUTURE_ARCHITECTURE.md`

- [ ] **Step 1: ORCA.md**

In the learning-loop / Phase 5B section (the `apps/daemon/src/learning/` entry, ~`:315`), add a paragraph for the **evaluate stage**: a human-triggered, pre-promotion counterfactual judge (`POST /v1/learning/proposals/:id/judge`) that runs one isolated (`${templateId}::judge`, spawn+teardown) adversarial shadow turn over the step's persisted past outputs — bucketed by independent `RefuteFacet`/`EvidenceFacet` ground truth into solved (regression check) and targeted-failure (improvement check) — returning a calibrated `CounterfactualJudgment` (`pass`/`regression_risk`/`uncertain`/`insufficient_evidence`/`unavailable`) persisted write-once on the proposal ledger (`judge_json`). It **informs, never gates** the human promotion (apply is untouched); it is imagined execution over persisted outputs (real replay-re-run stays deferred), control-plane-pure via the `ShadowAsk` seam. (`apps/daemon/src/learning/{judge,corpus}.ts`, migration `0053`.)

- [ ] **Step 2: FUTURE_WORK.md**

Update the 5.2 status: the **counterfactual judge has landed** (2026-07-04) — the pre-promotion evaluate stage that 5.4 unblocked, consuming the `RefuteFacet` ground truth and reusing the refute independent-adversarial-shadow pattern. Update the "Status at a glance" 5.2 line from "half landed" to "propose/promote + counterfactual judge landed; **replay re-run remains the sole deferred path** (needs the execution-plane split)." Keep the replay-re-run deferral explicit.

- [ ] **Step 3: FUTURE_ARCHITECTURE.md**

In the "Experiential learning loop" bullet (`:83`), append: the learning loop's **evaluate stage is now realized** (2026-07-04) — a pre-promotion counterfactual judge over persisted past outputs, control-plane-pure via the `ShadowAsk` seam, informing (not gating) the governed promotion; real replay-re-run remains the deferred execution-plane step.

- [ ] **Step 4: Commit**

```bash
git add ORCA.md FUTURE_WORK.md FUTURE_ARCHITECTURE.md
git commit -m "docs: counterfactual judge landed — learning-loop evaluate stage (5.2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Evaluate stage / route between propose and promote → Task 6 (route + usecase), Task 1 (contracts).
- Two-bucket corpus, `RefuteFacet`-primary/`EvidenceFacet`-fallback, failure from proposal evidence, K-cap, compaction, superseded-attempt preference → Task 4.
- Isolated adversarial shadow, spawn+teardown, tri-state calibrated, retry-once, `[judge]` log, anti-contamination prompt → Task 5 + Task 6 (session key + teardown).
- Write-once + idempotent, no clobber → Task 6 (`if (p.judgment) return p`) + tests.
- Honest degradation (`insufficient_evidence` either bucket below MIN, no shadow call) + `unavailable` on null → Task 6.
- Persisted `CounterfactualJudgment` with engine-recorded case ids on the ledger → Task 1 (schema) + Task 3 (store) + Task 2 (column).
- Informs never overrides (apply untouched, buttons enabled) → Global Constraints + Task 6 (no apply edit) + Task 7 (enabled Apply test).
- Inspectable/drill-through → Task 1 (`solvedCaseIds`/`failureCaseIds`) + Task 7 (links).
- Docs / deferral honesty → Task 8.

**Placeholder scan:** the only non-literal spots are the desktop file paths (Task 7 — resolved by the named grep, matching how 5.4's plan handled desktop) and the test DB seed helper name (`applyMigrations` — Task 3/6 note says match the existing daemon helper). Both name the exact thing to confirm; neither is a vague "handle it."

**Type consistency:** `JudgeInstructionEditProposal` (LLM, 3-verdict) vs `JudgeOutcome`/`CounterfactualJudgment.verdict` (5-state engine) used consistently (Tasks 1/5/6); `JudgeCase {stepRunId, output}` identical in Task 4 ↔ Task 1 request; `judgeSessionKey`=`${templateId}::judge` identical Tasks 5/6; `JudgeDeps {shadowAsk, terminateShadow}` identical Tasks 6 route ↔ usecase ↔ server; `buildJudgeCorpus(db, proposal)` signature identical Task 4 ↔ Task 6; `setProposalJudgment(db, id, judgment)` identical Task 3 ↔ Task 6.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-04-counterfactual-judge.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, final whole-branch opus review.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
