# Refute-Completion (5.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a risk/oracle-gated, independent adversarial *refute* of `approve_step_complete` that runs after the deterministic gates and before commit: in L5 it gates the auto-approve (refuted→revise, uncertain→human pause, upheld→commit); in L4 it rides the human confirmation card as an advisory; every run is recorded as an inspectable `RefuteFacet`.

**Architecture:** Mirrors 5.3's ShadowAsk-backed evaluator. A pure `refute-completion.ts` module produces a tri-state `RefuteCompletionProposal` from an isolated (`${goalId}::refute`) shadow turn; a deterministic gate (`shouldRefute` = tool-risk≥high OR no/weak oracle) and the deterministic core (`service.ts`) own every branch. The refute is an additive harness facet + one additive migration; no execution-plane code.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), better-sqlite3, Zod (`@orca/contracts`), Vitest, pnpm monorepo (`@orca/daemon`, `@orca/contracts`, desktop `@orca/desktop`).

## Global Constraints

- Deterministic core owns lifecycle/routing/branching/termination; the LLM only fills the verdict + issue list — it never advances the flow (FUTURE_ARCHITECTURE line 95).
- L4 human-authoritative completion is unchanged: the refute only *informs* the human card; the human still confirms.
- The refute composes with, never duplicates, the existing deterministic gates (sensors/2.8-claim/state-conflict). It runs only *after* they pass.
- Independence (paper p.37): the refute runs in a session **isolated from the approving orchestrator** — key `${goalId}::refute`, never the bare `goalId`.
- Calibrated tri-state (paper p.31): `refuted`→revise; `uncertain`/`unavailable`→human pause; `upheld`→commit. Never auto-approve a gated step the refute could not clear.
- Gate = refute *unless already adequately verified*: `tool-risk ≥ high` OR `evidence == null` OR `evidence.oracleAdequacy.gaps.length > 0` (paper p.47/p.62).
- Contracts additions are additive; exactly one additive migration (`refute_json`); ESM `.js` specifiers; surgical changes.
- Commit on `main` (this session's approved convention). Every commit: `pnpm --filter @orca/daemon build` green + touched vitest dirs pass.
- End commit bodies with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Contracts — refute request/proposal + RefuteFacet + failure code

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts` (add `RefuteVerdict`, `RefuteCompletionProposal`, `RefuteCompletionRequest` beside `GateEvaluationRequest` ~`:843`)
- Modify: `packages/contracts/src/harness/index.ts` (add `RefuteOutcome`, `RefuteFacet`; add `"refute_veto"` to `FailureCode` `:96`; add `"refute"` to `FacetSpec.key` `:193`; `defineFacet` after composition `:226`; add `refute` field to `HarnessTransition` `:243`)
- Test: `packages/contracts/src/workflows/index.test.ts` (or the existing workflows contract test) and `packages/contracts/src/harness/index.test.ts`

**Interfaces:**
- Consumes (existing in `workflows/index.ts`): `Id`, `BoundedString`, `WORKFLOW_STEP_MAX_INSTRUCTIONS_BYTES`, `ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES`, `hasMaxSerializedBytes`. In `harness/index.ts`: `RiskClass`, `FailureCode`, `defineFacet`, `FacetSpec`, `HarnessTransition`.
- Produces: `RefuteVerdict` (`"upheld"|"refuted"|"uncertain"`), `RefuteCompletionProposal { verdict, reason, issueRefs[], inputsConsidered[] }`, `RefuteCompletionRequest {...}`, `RefuteOutcome` (`RefuteVerdict | "unavailable"`), `RefuteFacet {...}`.

- [ ] **Step 1: Write the failing contract tests**

Add to the workflows contract test file:
```ts
import { RefuteCompletionProposal, RefuteCompletionRequest } from "./index.js";
describe("Refute contracts", () => {
  it("round-trips a refuted proposal", () => {
    const p = { verdict: "refuted", reason: "output ignores the acceptance criteria", issueRefs: ["missing-error-path"], inputsConsidered: ["stepOutput"] };
    expect(RefuteCompletionProposal.parse(p)).toEqual(p);
  });
  it("rejects an unknown verdict", () => {
    expect(RefuteCompletionProposal.safeParse({ verdict: "maybe", reason: "x", issueRefs: [], inputsConsidered: [] }).success).toBe(false);
  });
  it("accepts a well-formed request with oracle scope", () => {
    const r = { step: { name: "Analyze", instructions: "do X" }, goal: { id: "goal-1", description: "ship" },
      stepOutput: { summary: "done" }, selfReportedScoring: { successScore: 0.9 },
      oracle: { ran: true, verdict: "passed", sensorsRun: [{ kind: "test", summary: "12 passed" }], gaps: ["integration"] } };
    expect(RefuteCompletionRequest.parse(r).oracle.gaps).toEqual(["integration"]);
  });
});
```
Add to the harness contract test file:
```ts
import { RefuteFacet, FailureCode, HARNESS_FACETS } from "./index.js";
it("RefuteFacet round-trips and is registered", () => {
  const f = { verdict: "refuted", triggered_by: ["no_oracle"], risk_class: "high", reason: "bad", issue_refs: ["x"] };
  expect(RefuteFacet.parse(f)).toEqual(f);
  expect(HARNESS_FACETS.some((s) => s.key === "refute" && s.column === "refute_json")).toBe(true);
});
it("FailureCode includes refute_veto", () => { expect(FailureCode.parse("refute_veto")).toBe("refute_veto"); });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/contracts exec vitest run src/workflows/index.test.ts src/harness/index.test.ts`
Expected: FAIL — `RefuteCompletionProposal`/`RefuteFacet` not exported.

- [ ] **Step 3: Add the workflow schemas**

In `packages/contracts/src/workflows/index.ts`, after `GateEvaluationRequest` (~`:861`):
```ts
export const RefuteVerdict = z.enum(["upheld", "refuted", "uncertain"]);
export type RefuteVerdict = z.infer<typeof RefuteVerdict>;

export const RefuteCompletionProposal = z
  .object({
    verdict: RefuteVerdict,
    reason: z.string().min(1).max(1024),
    issueRefs: z.array(z.string().min(1).max(128)).max(50),
    inputsConsidered: z.array(z.string().min(1).max(128)).max(50),
  })
  .strict();
export type RefuteCompletionProposal = z.infer<typeof RefuteCompletionProposal>;

export const RefuteCompletionRequest = z
  .object({
    step: z
      .object({
        name: z.string().max(100),
        instructions: BoundedString(WORKFLOW_STEP_MAX_INSTRUCTIONS_BYTES, "instructions"),
      })
      .strict(),
    goal: z.object({ id: Id, description: z.string().max(4000) }).strict(),
    stepOutput: z.record(z.string(), z.unknown()).nullable(),
    selfReportedScoring: z.record(z.string(), z.unknown()).nullable(),
    oracle: z
      .object({
        ran: z.boolean(),
        verdict: z.enum(["passed", "partial", "failed"]).nullable().default(null),
        sensorsRun: z
          .array(z.object({ kind: z.string().max(64), summary: z.string().max(600) }).strict())
          .max(50)
          .default([]),
        gaps: z.array(z.string().max(200)).max(50).default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!hasMaxSerializedBytes(value, ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RefuteCompletionRequest too large" });
    }
  });
export type RefuteCompletionRequest = z.infer<typeof RefuteCompletionRequest>;
```

- [ ] **Step 4: Add the harness facet + failure code**

In `packages/contracts/src/harness/index.ts`:
1. Add `"refute_veto"` to the `FailureCode` enum (`:96-100`), e.g. after `"evidence_veto"`.
2. Add `"refute"` to the `FacetSpec.key` union (`:193`): `key: "risk" | "evidence" | "stateDeps" | "telemetry" | "composition" | "refute";`
3. After the composition `defineFacet` (`:226`), add:
```ts
export const RefuteOutcome = z.enum(["upheld", "refuted", "uncertain", "unavailable"]);
export type RefuteOutcome = z.infer<typeof RefuteOutcome>;

export const RefuteFacet = z
  .object({
    verdict: RefuteOutcome,
    triggered_by: z.array(z.enum(["high_risk", "no_oracle", "weak_oracle"])).max(3),
    risk_class: RiskClass,
    reason: z.string().max(1024).nullable(),
    issue_refs: z.array(z.string().max(128)).max(50),
  })
  .strict();
export type RefuteFacet = z.infer<typeof RefuteFacet>;

defineFacet({ key: "refute", column: "refute_json", schema: RefuteFacet });
```
4. Add to `HarnessTransition` (`:243`, after `composition`): `refute: RefuteFacet.nullable().optional(),`

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @orca/contracts exec vitest run src/workflows/index.test.ts src/harness/index.test.ts && pnpm --filter @orca/contracts build`
Expected: PASS; contracts build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/harness/index.ts packages/contracts/src/workflows/index.test.ts packages/contracts/src/harness/index.test.ts
git commit -m "feat(contracts): refute request/proposal + RefuteFacet + refute_veto failure code

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Migration — `refute_json` column

**Files:**
- Create: `apps/daemon/migrations/0052_harness_transitions_refute.sql`
- Modify: `apps/daemon/src/migrations.ts` (register the new file in the ordered list, after `0051_workflow_template_inputs`)
- Test: reuse the existing migrations/store test that applies all migrations (mirror how 0050/0051 are asserted)

**Interfaces:**
- Consumes: the migration runner in `apps/daemon/src/migrations.ts` (ordered `migrationFiles` list).
- Produces: `harness_transitions.refute_json TEXT` column.

- [ ] **Step 1: Write the migration**

`apps/daemon/migrations/0052_harness_transitions_refute.sql`:
```sql
-- Add the refute facet column to the harness transition spine (5.4).
ALTER TABLE harness_transitions ADD COLUMN refute_json TEXT;
```

- [ ] **Step 2: Register it**

In `apps/daemon/src/migrations.ts`, add `"0052_harness_transitions_refute.sql"` to the ordered migration list immediately after `"0051_workflow_template_inputs.sql"` (match the existing registration style — read the file to see whether it's an array of filenames or imported SQL strings, and follow it exactly).

- [ ] **Step 3: Write/extend the failing test**

Add to the daemon migrations test (the suite that opens a fresh DB and applies all migrations):
```ts
it("0052 adds harness_transitions.refute_json", () => {
  const cols = db.prepare("PRAGMA table_info(harness_transitions)").all() as { name: string }[];
  expect(cols.some((c) => c.name === "refute_json")).toBe(true);
});
```

- [ ] **Step 4: Run + build**

Run: `pnpm --filter @orca/daemon exec vitest run src/migrations.test.ts && pnpm --filter @orca/daemon build`
Expected: PASS (column present); build clean.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/migrations/0052_harness_transitions_refute.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts
git commit -m "feat(daemon): migration 0052 — harness_transitions.refute_json

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Refute module (`refute-completion.ts`)

Pure module mirroring `gate-evaluation.ts`: compose an adversarial, oracle-scoped prompt; ask an isolated shadow turn; parse the tri-state proposal; retry once; log + return `null` on failure.

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/refute-completion.ts`
- Test: `apps/daemon/src/workflows/orchestrator/refute-completion.test.ts`

**Interfaces:**
- Consumes: `ShadowAsk` (`import type { ShadowAsk } from "./recover-step-scoring.js"`), `RefuteCompletionProposal`/`RefuteCompletionRequest` (`@orca/contracts`), `ShadowAdapterId` (`../../orchestrator-llm/shadow-session.js`).
- Produces:
  - `export function composeRefutePrompt(request: RefuteCompletionRequest): { systemPrompt: string; userPrompt: string }`
  - `export async function refuteStepCompletion(deps: ShadowAsk, input: { refuteSessionKey: string; adapterId: ShadowAdapterId; request: RefuteCompletionRequest; timeoutMs: number }): Promise<RefuteCompletionProposal | null>`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { RefuteCompletionRequest } from "@orca/contracts";
import type { ShadowAsk } from "./recover-step-scoring.js";
import { refuteStepCompletion, composeRefutePrompt } from "./refute-completion.js";

const REQ: RefuteCompletionRequest = {
  step: { name: "Analyze", instructions: "Cover the error paths." },
  goal: { id: "goal-1", description: "Ship the feature." },
  stepOutput: { summary: "done" }, selfReportedScoring: { successScore: 0.9 },
  oracle: { ran: false, verdict: null, sensorsRun: [], gaps: [] },
};
const ask = (text: string): ShadowAsk => ({ async ask() { return { text }; } });
const askThrows = (): ShadowAsk => ({ async ask() { throw new Error("shadow down"); } });

describe("refuteStepCompletion", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it("parses each tri-state verdict and preserves issueRefs", async () => {
    const p = { verdict: "refuted", reason: "misses error paths", issueRefs: ["no-error-path"], inputsConsidered: ["stepOutput"] };
    const r = await refuteStepCompletion(ask(JSON.stringify(p)), { refuteSessionKey: "goal-1::refute", adapterId: "claude-code", request: REQ, timeoutMs: 1000 });
    expect(r).toEqual(p);
  });
  it("respects an uncertain verdict (not coerced to refuted)", async () => {
    const p = { verdict: "uncertain", reason: "cannot tell", issueRefs: [], inputsConsidered: [] };
    const r = await refuteStepCompletion(ask(JSON.stringify(p)), { refuteSessionKey: "goal-1::refute", adapterId: "claude-code", request: REQ, timeoutMs: 1000 });
    expect(r?.verdict).toBe("uncertain");
  });
  it("returns null + logs on throw / non-JSON / invalid", async () => {
    expect(await refuteStepCompletion(askThrows(), { refuteSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
    expect(await refuteStepCompletion(ask("not json"), { refuteSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
    expect(await refuteStepCompletion(ask(JSON.stringify({ verdict: "no" })), { refuteSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[refute]"));
  });
  it("uses the isolated refute session key (not the bare goalId)", async () => {
    const seen: string[] = [];
    const spy: ShadowAsk = { async ask(key: string) { seen.push(key); return { text: JSON.stringify({ verdict: "upheld", reason: "ok", issueRefs: [], inputsConsidered: [] }) }; } };
    await refuteStepCompletion(spy, { refuteSessionKey: "goal-1::refute", adapterId: "claude-code", request: REQ, timeoutMs: 1000 });
    expect(seen).toEqual(["goal-1::refute"]);
  });
  it("scopes the prompt by oracle coverage", () => {
    const { systemPrompt, userPrompt } = composeRefutePrompt({ ...REQ, oracle: { ran: true, verdict: "passed", sensorsRun: [{ kind: "test", summary: "ok" }], gaps: ["integration"] } });
    expect(systemPrompt).toContain("orca:action");
    expect(systemPrompt).toContain("refute");
    expect(userPrompt).toContain("integration");
  });
});
```

- [ ] **Step 2: Run to verify red**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/refute-completion.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
import { RefuteCompletionProposal, type RefuteCompletionRequest } from "@orca/contracts";
import type { ShadowAdapterId } from "../../orchestrator-llm/shadow-session.js";
import type { ShadowAsk } from "./recover-step-scoring.js";

export function composeRefutePrompt(
  request: RefuteCompletionRequest
): { systemPrompt: string; userPrompt: string } {
  // p.37 anti-circularity + p.47 integrate-both: the refute is an INDEPENDENT
  // adversarial check that targets only the scope the deterministic oracle did
  // NOT cover. Default to "uncertain" over a guessed "refuted" (p.31 calibrated).
  const oracleLine = request.oracle.ran
    ? [
        `Deterministic sensors ALREADY verified this step (verdict: ${request.oracle.verdict ?? "n/a"}).`,
        `They did NOT cover: ${request.oracle.gaps.length ? request.oracle.gaps.join(", ") : "(no declared gaps)"}.`,
        "Do NOT re-litigate what the sensors verified — judge only the unverified scope:",
        "semantic correctness, instruction adherence, and downstream readiness.",
      ].join("\n")
    : "No deterministic verification ran for this step — you are the only check on its correctness.";
  const systemPrompt = [
    "You are an INDEPENDENT reviewer. Adversarially try to REFUTE that the step output",
    "satisfies the step's instructions toward the goal. Actively look for a concrete,",
    "evidence-grounded reason it does NOT — do not re-affirm the author's own scoring.",
    oracleLine,
    "Return one of three verdicts: 'refuted' (you found a concrete failure), 'upheld'",
    "(no concrete reason to refute), or 'uncertain' (plausible but you genuinely cannot",
    "tell — do NOT guess 'refuted'). On 'refuted', issueRefs is a short enumerated list of",
    "the specific, addressable failures ('fix only these'); on 'upheld'/'uncertain' it is [].",
    "List in inputsConsidered exactly which evidence you used.",
    "Emit exactly one RefuteCompletionProposal JSON object in one fenced block, nothing after:",
    "```orca:action",
    '{ "verdict": "...", "reason": "...", "issueRefs": [...], "inputsConsidered": [...] }',
    "```",
  ].join("\n");
  return { systemPrompt, userPrompt: JSON.stringify(request) };
}

export async function refuteStepCompletion(
  deps: ShadowAsk,
  input: { refuteSessionKey: string; adapterId: ShadowAdapterId; request: RefuteCompletionRequest; timeoutMs: number }
): Promise<RefuteCompletionProposal | null> {
  const { systemPrompt, userPrompt } = composeRefutePrompt(input.request);
  let lastFailure = "no attempts made";
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      ({ text } = await deps.ask(input.refuteSessionKey, {
        adapterId: input.adapterId, systemPrompt, userPrompt, timeoutMs: input.timeoutMs,
      }));
    } catch (err) {
      lastFailure = `shadow ask failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { lastFailure = "response was not JSON"; continue; }
    const parsed = RefuteCompletionProposal.safeParse(raw);
    if (parsed.success) return parsed.data;
    lastFailure = `invalid RefuteCompletionProposal: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 200)}`;
  }
  // Caller escalates to a human on null; surface WHY for observability (p.33).
  console.warn(`[refute] step-completion refute failed for session ${input.refuteSessionKey}: ${lastFailure}`);
  return null;
}
```

- [ ] **Step 4: Run to verify green + build**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/refute-completion.test.ts && pnpm --filter @orca/daemon build`
Expected: PASS (5 tests); build clean.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/refute-completion.ts apps/daemon/src/workflows/orchestrator/refute-completion.test.ts
git commit -m "feat(refute): independent adversarial step-completion refute module

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Risk/oracle gate helper

**Files:**
- Create: `apps/daemon/src/harness-risk/rank.ts` (`RiskClass` ordinal + `riskClassAtLeast`)
- Create: `apps/daemon/src/workflows/orchestrator/refute-gate.ts` (`stepToolRiskClass`, `shouldRefute`, `RefuteTrigger`)
- Test: `apps/daemon/src/workflows/orchestrator/refute-gate.test.ts`

**Interfaces:**
- Consumes: `RiskClass` (`@orca/contracts`), a better-sqlite3 `Database`, the `harness_transitions` table (`type`, `workflow_step_run_id`, `risk_json`), the sensor evidence shape (`{ oracleAdequacy: { gaps: string[] } } | null`).
- Produces:
  - `export const RISK_RANK: Record<RiskClass, number>` and `export function riskClassAtLeast(a: RiskClass, b: RiskClass): boolean` (rank.ts)
  - `export function stepToolRiskClass(db, workflowStepRunId: string): RiskClass`
  - `export type RefuteTrigger = "high_risk" | "no_oracle" | "weak_oracle"`
  - `export function shouldRefute(riskClass: RiskClass, evidence: { oracleAdequacy: { gaps: string[] } } | null): { refute: boolean; triggers: RefuteTrigger[] }`

- [ ] **Step 1: Write the failing tests**

```ts
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { riskClassAtLeast } from "../../harness-risk/rank.js";
import { stepToolRiskClass, shouldRefute } from "./refute-gate.js";

function seedTx(db: Database.Database, stepRunId: string, riskClass: string) {
  db.prepare("INSERT INTO harness_transitions (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, risk_json, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(`t-${Math.random()}`, "g", "r", stepRunId, "tool_gate", JSON.stringify({ risk_class: riskClass, permission_tier: "sandbox_edit", classification_reasons: [], gate_decision: "allow", hard_constraint_violations: [] }), "2026-07-03T00:00:00.000Z");
}

describe("riskClassAtLeast", () => {
  it("orders low<medium<high<critical", () => {
    expect(riskClassAtLeast("high", "high")).toBe(true);
    expect(riskClassAtLeast("critical", "high")).toBe(true);
    expect(riskClassAtLeast("medium", "high")).toBe(false);
  });
});

describe("stepToolRiskClass", () => {
  it("returns the max risk over the step's tool_gate rows; low when none", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE harness_transitions (id TEXT PRIMARY KEY, goal_id TEXT, workflow_run_id TEXT, workflow_step_run_id TEXT, boundary TEXT, risk_json TEXT, created_at TEXT)");
    expect(stepToolRiskClass(db, "s1")).toBe("low");
    seedTx(db, "s1", "medium"); seedTx(db, "s1", "high"); seedTx(db, "s2", "critical");
    expect(stepToolRiskClass(db, "s1")).toBe("high");
    expect(stepToolRiskClass(db, "s2")).toBe("critical");
  });
});

describe("shouldRefute", () => {
  it("fires on high tool-risk, on null evidence, and on oracle gaps; skips a well-verified low-risk step", () => {
    expect(shouldRefute("high", { oracleAdequacy: { gaps: [] } })).toEqual({ refute: true, triggers: ["high_risk"] });
    expect(shouldRefute("low", null)).toEqual({ refute: true, triggers: ["no_oracle"] });
    expect(shouldRefute("low", { oracleAdequacy: { gaps: ["integration"] } })).toEqual({ refute: true, triggers: ["weak_oracle"] });
    expect(shouldRefute("low", { oracleAdequacy: { gaps: [] } })).toEqual({ refute: false, triggers: [] });
  });
});
```

- [ ] **Step 2: Run to verify red**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/refute-gate.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/daemon/src/harness-risk/rank.ts`:
```ts
import type { RiskClass } from "@orca/contracts";
export const RISK_RANK: Record<RiskClass, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export function riskClassAtLeast(a: RiskClass, b: RiskClass): boolean {
  return RISK_RANK[a] >= RISK_RANK[b];
}
```
`apps/daemon/src/workflows/orchestrator/refute-gate.ts`:
```ts
import type Database from "better-sqlite3";
import type { RiskClass } from "@orca/contracts";
import { RISK_RANK, riskClassAtLeast } from "../../harness-risk/rank.js";

export type RefuteTrigger = "high_risk" | "no_oracle" | "weak_oracle";

/** Max deterministic tool-gate risk class recorded for the step run (low when none). */
export function stepToolRiskClass(db: Database.Database, workflowStepRunId: string): RiskClass {
  const rows = db
    .prepare("SELECT risk_json FROM harness_transitions WHERE workflow_step_run_id = ? AND boundary = 'tool_gate' AND risk_json IS NOT NULL")
    .all(workflowStepRunId) as { risk_json: string }[];
  let max: RiskClass = "low";
  for (const r of rows) {
    try {
      const rc = JSON.parse(r.risk_json).risk_class as RiskClass;
      if (rc && RISK_RANK[rc] !== undefined && RISK_RANK[rc] > RISK_RANK[max]) max = rc;
    } catch { /* ignore malformed */ }
  }
  return max;
}

/** Refute unless the step was already adequately verified by a deterministic oracle
 *  and is not high-risk (paper p.47 integrate-both / p.62 oracle adequacy). */
export function shouldRefute(
  riskClass: RiskClass,
  evidence: { oracleAdequacy: { gaps: string[] } } | null
): { refute: boolean; triggers: RefuteTrigger[] } {
  const triggers: RefuteTrigger[] = [];
  if (riskClassAtLeast(riskClass, "high")) triggers.push("high_risk");
  if (evidence === null) triggers.push("no_oracle");
  else if (evidence.oracleAdequacy.gaps.length > 0) triggers.push("weak_oracle");
  return { refute: triggers.length > 0, triggers };
}
```
> Note: `boundary` is the `harness_transitions` column name for the transition kind (see migration `0040_harness_transitions.sql`); `tool_gate` transitions are emitted by `emitToolGate` (`emit.ts`). Confirm the exact column name (`boundary` vs `type`) against `0040_harness_transitions.sql` and match it.

- [ ] **Step 4: Run green + build**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/refute-gate.test.ts && pnpm --filter @orca/daemon build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-risk/rank.ts apps/daemon/src/workflows/orchestrator/refute-gate.ts apps/daemon/src/workflows/orchestrator/refute-gate.test.ts
git commit -m "feat(refute): deterministic risk/oracle gate (refute unless adequately verified)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Thread the refute facet through `emitStepComplete`

**Files:**
- Modify: `apps/daemon/src/harness-transitions/emit.ts:35` (add `"refute"` to the `step_complete` boundary facet tuple)
- Test: update the emit/registry snapshot tests that assert `HARNESS_BOUNDARIES`/facet lists (the same tests Phase 5E's composition facet touched)

**Interfaces:**
- Consumes: `defineBoundary` (`emit.ts:23`), the `"refute"` FacetKey (Task 1).
- Produces: `emitStepComplete` now type-accepts an optional `refute` facet.

- [ ] **Step 1: Update the boundary + run the snapshot tests to see them fail**

Change `emit.ts:35` to:
```ts
export const emitStepComplete = defineBoundary("step_complete", ["evidence", "stateDeps", "telemetry", "refute"] as const);
```
Run: `pnpm --filter @orca/daemon exec vitest run src/harness-transitions`
Expected: FAIL on the `HARNESS_BOUNDARIES` snapshot/conformance test (step_complete now lists `refute`).

- [ ] **Step 2: Update the snapshot/conformance expectations**

Update the failing test(s) so `step_complete`'s expected facet list includes `"refute"` (a stricter `.toEqual`, matching how composition was added). Do NOT loosen any assertion — only add `refute` where the other facets are listed.

- [ ] **Step 3: Run green + build**

Run: `pnpm --filter @orca/daemon exec vitest run src/harness-transitions && pnpm --filter @orca/daemon build`
Expected: PASS; build clean (the facet-registry ↔ `HarnessTransition` conformance guard stays green because Task 1 added `refute` to both).

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/harness-transitions/emit.ts apps/daemon/src/harness-transitions/emit.test.ts
git commit -m "feat(harness): step_complete carries the refute facet

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Service integration — L5 gate + facet emit + session teardown

The core wiring: run the gated, isolated refute after the deterministic evidence gate; branch the automated path on the tri-state; record the `RefuteFacet`.

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (approve handler `:1041-1363`: hoist `evidence`; add `maybeRefute` + `formatRefuteFeedback`; wire the L5 branch; thread `refute` into the `step_complete` emits)
- Modify: `apps/daemon/src/server.ts` (tear down the `${goalId}::refute` shadow session alongside `shadowSessions.terminate(goalId)`)
- Test: `apps/daemon/src/workflows/orchestrator/service.refute.test.ts` (new; mirror `service.gate-routing.test.ts` harness — fake `ShadowAsk`, `operating_mode`, seeded `tool_gate` transitions)

**Interfaces:**
- Consumes: `refuteStepCompletion` (Task 3), `composeRefutePrompt`; `stepToolRiskClass`/`shouldRefute`/`RefuteTrigger` (Task 4); `RefuteCompletionRequest`/`RefuteFacet`/`RefuteOutcome` (Task 1); existing `reviseStep`, `resolveShadowAdapterId`, `readGoal`, `this.shadowAsk`, `emitStepComplete`, `SHADOW_LLM_TIMEOUT_MS`, the `block`/`sessionId`/`ctx`/`options`/`evidence` locals in the handler.
- Produces: a private `maybeRefute(...)` returning `{ ran: false } | { ran: true; outcome: RefuteOutcome; facet: RefuteFacet; proposal: RefuteCompletionProposal | null }`; a `formatRefuteFeedback(proposal)` helper.

- [ ] **Step 1: Write the failing service tests**

Create `service.refute.test.ts` mirroring `service.gate-routing.test.ts`'s setup (in-memory DB, `makeEngine`/`makeService` with a fake `ShadowAsk`, a goal + run + step at the point of an `approve_step_complete`). Cover:
```ts
// helpers: fakeRefuteAsk(verdict, {reason, issueRefs}) -> ShadowAsk keyed check;
//          seedToolGate(db, stepRunId, riskClass); driveApprove(service, action) reaching applyOrchestratorAction.

it("L5 high-risk refuted -> reviseStep, not committed; RefuteFacet has failure_code refute_veto", async () => { /* operating_mode automated; seedToolGate high; fakeRefuteAsk('refuted', {issueRefs:['x']}); assert step NOT advanced, revise_attempts bumped, a step_complete transition exists with refute_json.verdict='refuted' */ });
it("L5 upheld -> commits; RefuteFacet verdict upheld, no veto", async () => { /* seedToolGate high; fakeRefuteAsk('upheld'); assert advanced + refute_json.verdict='upheld' */ });
it("L5 uncertain -> human confirmation pause (not committed, not revised)", async () => { /* fakeRefuteAsk('uncertain'); assert pending_completion set + pauseForConfirmation, no advance, no revise */ });
it("L5 refute unavailable (ask throws) -> human pause (fail-safe)", async () => { /* ask throws; assert pause, not committed */ });
it("gate: adequately-verified low-risk exec step -> refute NOT called", async () => { /* execReq step, sensors passed, gaps empty, tool-risk low; assert fake ask received 0 calls; step commits */ });
it("gate: no-oracle step -> refute called", async () => { /* non-exec step; assert ask called with '<goalId>::refute' key */ });
it("independence: refute asks the '<goalId>::refute' session, never the bare goalId", async () => { /* assert the key */ });
it("a step already vetoed by the evidence gate never reaches the refute", async () => { /* exec step, sensors FAIL -> reviseStep at evidence gate; assert refute ask 0 calls */ });
```

- [ ] **Step 2: Run to verify red**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/service.refute.test.ts`
Expected: FAIL — `maybeRefute` not implemented / refute never runs.

- [ ] **Step 3: Hoist `evidence` to handler scope**

In `service.ts`, the evidence gate declares `let evidence ... = null` **inside** the `if (execReq)` block (`:1196`). Move that declaration to just above `const execReq = ...` (`:1193`) so it is in scope after the block:
```ts
let evidence: Awaited<ReturnType<typeof runSensors>> | null = null;
const execReq = stepRequiresExecution(ctx.template.guardrails, ctx.stepTpl.id);
if (execReq) {
  // ... existing body, but assign (not re-declare) evidence:  evidence = await runSensors(...)
}
```
(Change the inner `let evidence ... = null;` to use the hoisted variable; keep every other line of the gate unchanged, including the `emitStepComplete` at `:1227` — Task 6 Step 5 threads `refute` onto it.)

- [ ] **Step 4: Add `maybeRefute` + `formatRefuteFeedback`**

Add as private methods on `OrchestratorService` (near `reviseStep`):
```ts
private async maybeRefute(
  db: Database.Database,
  ctx: { run: WorkflowRunT; stepRun: StepRunRow; stepTpl: WorkflowStepTemplate },
  block: unknown,
  scoring: unknown,
  evidence: Awaited<ReturnType<typeof runSensors>> | null,
): Promise<{ ran: false } | { ran: true; outcome: RefuteOutcome; facet: RefuteFacet; proposal: RefuteCompletionProposal | null }> {
  if (!this.shadowAsk) return { ran: false };
  const riskClass = stepToolRiskClass(db, ctx.stepRun.id);
  const gate = shouldRefute(riskClass, evidence ? { oracleAdequacy: evidence.oracleAdequacy } : null);
  if (!gate.refute) return { ran: false };
  const goal = readGoal(db, ctx.run.goalId);
  let adapterId: ShadowAdapterId | null = null;
  try { adapterId = resolveShadowAdapterId(goal); } catch { adapterId = null; }
  if (!adapterId) return { ran: false };  // no shadow adapter -> cannot refute; deterministic gates already ran

  const request = RefuteCompletionRequest.parse({
    step: { name: ctx.stepTpl.name, instructions: ctx.stepTpl.instructions ?? "" },
    goal: { id: goal.id, description: goal.description },
    stepOutput: isRecord(block) ? block : null,
    selfReportedScoring: isRecord(scoring) ? scoring : null,
    oracle: evidence
      ? { ran: true, verdict: evidence.verdict, sensorsRun: evidence.sensorsRun.map((s) => ({ kind: s.kind, summary: s.summary.slice(0, 600) })).slice(0, 50), gaps: evidence.oracleAdequacy.gaps.slice(0, 50) }
      : { ran: false, verdict: null, sensorsRun: [], gaps: [] },
  });
  const proposal = await refuteStepCompletion(this.shadowAsk, {
    refuteSessionKey: `${goal.id}::refute`, adapterId, request, timeoutMs: SHADOW_LLM_TIMEOUT_MS,
  });
  const outcome: RefuteOutcome = proposal ? proposal.verdict : "unavailable";
  const facet: RefuteFacet = {
    verdict: outcome, triggered_by: gate.triggers, risk_class: riskClass,
    reason: proposal?.reason ?? null, issue_refs: proposal?.issueRefs ?? [],
  };
  return { ran: true, outcome, facet, proposal };
}

private formatRefuteFeedback(proposal: RefuteCompletionProposal): string {
  const issues = proposal.issueRefs.length ? `\nFix only these:\n- ${proposal.issueRefs.join("\n- ")}` : "";
  return `An independent review refuted this completion: ${proposal.reason}${issues}\nAddress these and re-emit completion.`;
}
```
(`isRecord` = a local `(v): v is Record<string,unknown> => typeof v === "object" && v !== null && !Array.isArray(v)`; add if not already present. Import `RefuteCompletionRequest`, `RefuteCompletionProposal`, `RefuteOutcome`, `RefuteFacet` from `@orca/contracts`; `refuteStepCompletion` from `./refute-completion.js`; `stepToolRiskClass`, `shouldRefute` from `./refute-gate.js`.)

- [ ] **Step 5: Wire the L5 branch + facet emit into the approve handler**

Between the evidence gate (ends `:1284`) and `const finishedAt = now()` compute the refute once; carry `refuteFacet` so every `step_complete` emit threads it.
```ts
const refute = await this.maybeRefute(db, ctx, block, action.scoring, evidence);
const refuteFacet = refute.ran ? refute.facet : undefined;   // thread onto emitStepComplete calls
```
- In the evidence-gate `emitStepComplete` (`:1227`) and the state-pause `emitStepComplete` (`:1307`), add `refute: refuteFacet` to the input object, and set the transition's `failure_code` to `"refute_veto"` when `refute.ran && refute.outcome === "refuted"` (compose with the existing `vetoed`/`evidence_veto` logic — refute_veto only when evidence did NOT already veto).
- After `const finishedAt = now();` (`:1286`), before the pause branch (`:1288`), add the L5 gate:
```ts
const pausing = conflictPause || goalRequiresHumanReview(db, ctx.run.goalId) || ctx.stepTpl.completionPolicy === "handoff";
let escalateForRefute = false;
if (!pausing && refute.ran) {
  if (refute.outcome === "refuted" && refute.proposal) {
    // record the refute_veto step_complete transition for a non-exec step (no evidence gate emitted one)
    if (!execReq) emitStepComplete({ db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory }, { goalId: ctx.run.goalId, workflowRunId: ctx.run.id, workflowStepRunId: ctx.stepRun.id, stateDeps: options.stateDepsByStepRunId?.[ctx.stepRun.id], refute: refute.facet });
    return this.reviseStep(db, now, ctx, sessionId, this.formatRefuteFeedback(refute.proposal), options);
  }
  if (refute.outcome === "uncertain" || refute.outcome === "unavailable") escalateForRefute = true;
  // "upheld" -> fall through to commit
}
```
- Change the pause-branch condition from `if (conflictPause || goalRequiresHumanReview(...) || handoff)` to `if (pausing || escalateForRefute)` (reuse `pausing`). Inside that branch, add `refute: refute.ran ? { verdict: refute.outcome, reason: refute.facet.reason, issueRefs: refute.facet.issue_refs } : null` to the `pending_completion_json` payload (Task 7 renders it), and add `refute: refuteFacet` to that branch's `emitStepComplete` (`:1307`).
> Emit discipline: exactly one `step_complete` per step. Exec steps emit at the evidence gate (`:1227`) — thread the facet there. Non-exec automated-commit steps have no evidence-gate emit; the refuted branch emits above, and the non-refuted automated commit records its transition at the downstream advance-site (`dispatch-engine.ts` advance emit) — thread `refuteFacet` through `advanceToNextStep`'s options if a facet must ride it, OR (simpler, chosen) accept that an *upheld* non-exec refute is captured on the state-pause/advance transition only when one is emitted; the plan's reviewer should confirm exactly one transition carries the facet and none double-emits. Pin this in implementation; if threading through `advanceToNextStep` is heavy, emit the upheld non-exec refute transition inline here (mirroring the refuted branch) and suppress the downstream one, matching how the conflict-pause path already emits inline for non-gated steps (`:1305`).

- [ ] **Step 6: Session teardown**

In `apps/daemon/src/server.ts`, everywhere `shadowSessions.terminate(goalId)` is called on goal end (`:932`, `:1315`), also fire `void shadowSessions.terminate(\`${goalId}::refute\`).catch(() => {});` so the isolated refute session is reclaimed with the goal.

- [ ] **Step 7: Run green + build**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/service.refute.test.ts src/workflows/orchestrator/service.gate-routing.test.ts && pnpm --filter @orca/daemon build`
Expected: PASS (new refute tests + existing gate tests unregressed); build clean.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/server.ts apps/daemon/src/workflows/orchestrator/service.refute.test.ts
git commit -m "feat(refute): L5 gate + RefuteFacet telemetry + isolated refute session

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: L4 advisory surfacing + desktop + docs

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/confirmation-summary.ts` and/or `scoring-summary.ts` (prepend a refute advisory lead)
- Modify: the desktop completion/confirmation card component (renders the advisory)
- Modify: `ORCA.md`, `FUTURE_WORK.md`, `FUTURE_ARCHITECTURE.md`
- Test: daemon confirmation-summary test (advisory lead) + desktop card test

**Interfaces:**
- Consumes: the `refute` field on `pending_completion_json` (Task 6 Step 5) → surfaced through the confirmation card contract; the `RefuteOutcome`.
- Produces: an advisory lead string when `verdict !== "upheld"`; a desktop advisory chip.

- [ ] **Step 1: Write the failing daemon test**

In the confirmation-summary test, assert the advisory:
```ts
it("prepends a refute advisory when the verdict is not upheld", () => {
  const lead = confirmationLead("Looks good", null, { verdict: "refuted", reason: "misses error paths", issueRefs: ["x"] });
  expect(lead).toContain("Independent review");
  expect(lead).toContain("misses error paths");
});
```

- [ ] **Step 2: Implement the advisory lead**

Extend `confirmationLead` (`confirmation-summary.ts:87`) with an optional third arg `refute?: { verdict: string; reason: string | null; issueRefs: string[] } | null`; when `refute && refute.verdict !== "upheld"`, prepend `⚠️ Independent review ${refute.verdict === "refuted" ? "disputes" : "is uncertain about"} this completion: ${refute.reason}\n`. Thread the `refute` field from `pending_completion_json` at the call site (`service.ts:1292` — `confirmationLead(scoring?.reason, proposal)` gains the refute arg from the stash payload).

- [ ] **Step 3: Desktop card advisory**

In the completion/confirmation card component (the one reading the confirmation activity payload — locate via `grep -rn "confirmed_lead\|pending_completion\|confirmationLead\|completion card" apps/desktop/src`), render a warning chip + reason + issue list when the payload carries a non-`upheld` refute verdict. Add a component test asserting the chip renders for `refuted`/`uncertain` and is absent for `upheld`. Thin-client: the verdict/reason arrive computed; no arithmetic.

- [ ] **Step 4: Docs**

- **ORCA.md:** in the step-completion / harness section, document the refute (Verify) lane — risk+oracle gate, isolated adversarial second pass, tri-state (uncertain→HITL), the `RefuteFacet` telemetry, L4 advisory vs L5 gate.
- **FUTURE_WORK.md:** mark **5.4 ✅ LANDED (2026-07-03)**; update the "Status at a glance" line; and update **5.2**'s note — its deferred **counterfactual judge is now unblocked** (the refute module + `RefuteFacet` are the adversarial-refute plumbing 5.2 waited for), so 5.2 moves from "half landed" toward its remaining pre-promotion-evaluation piece.
- **FUTURE_ARCHITECTURE.md:** the Inspectable axis gains the refute telemetry channel; note it stays control-plane-pure.

- [ ] **Step 5: Run green + build + full sweep**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator && pnpm --filter @orca/daemon build && pnpm --filter @orca/desktop exec vitest run <card test dir>`
Expected: PASS; builds clean.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/confirmation-summary.ts apps/daemon/src/workflows/orchestrator/service.ts apps/desktop ORCA.md FUTURE_WORK.md FUTURE_ARCHITECTURE.md
git commit -m "feat(refute): L4 advisory on the confirmation card + docs (5.4 landed)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Independent adversarial refute after deterministic gates, before commit → Task 3 (module) + Task 6 (placement after evidence gate `:1284`).
- Gate = high-risk OR no/weak oracle → Task 4 (`shouldRefute`) + Task 6 (`maybeRefute`).
- Isolation (`${goalId}::refute`) → Task 3 (key param) + Task 6 (call + `server.ts` teardown) + independence tests.
- Tri-state calibrated verdict; uncertain/unavailable→HITL → Task 6 Step 5.
- L4 advisory, human authoritative → Task 6 (stash) + Task 7 (lead + desktop).
- Inspectable `RefuteFacet` (+ `refute_veto`) → Task 1 (facet/failure code) + Task 5 (emit tuple) + Task 6 (emit threading).
- Additive migration → Task 2.
- Composes with, not duplicates, existing gates; a pre-vetoed step never reaches refute → Task 6 (ordering + test).
- Unblocks 5.2 → Task 7 docs + the `RefuteFacet` substrate.

**Placeholder scan:** the two genuinely under-determined spots are called out as *implementation-pin* items with the exact anchor + the fallback chosen: (a) the single-`step_complete`-emit threading across exec/non-exec/commit paths (Task 6 Step 5 — fallback: emit inline like the existing non-gated conflict-pause path, suppress the downstream one); (b) the exact `harness_transitions` kind column name `boundary` vs `type` (Task 4 — verify against `0040_harness_transitions.sql`). Both name the file to check; neither is a vague "handle it."

**Type consistency:** `RefuteVerdict` (3-state, LLM) vs `RefuteOutcome` (4-state, engine incl. `unavailable`) used consistently (Tasks 1/3/6); `RefuteFacet` fields (`verdict/triggered_by/risk_class/reason/issue_refs`) match Task 1 ↔ Task 6; `refuteSessionKey`/`${goalId}::refute` identical across Tasks 3/6; `shouldRefute` return shape (`{refute, triggers}`) matches Task 4 ↔ Task 6.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-03-refute-completion.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
