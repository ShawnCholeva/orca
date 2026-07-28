# Goal Success Criteria Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user type required success criteria when creating a Goal, persist them on the goal, and thread them into the two workflow parties that judge/produce work — the gate (verify) and the step agent (do).

**Architecture:** A new `success_criteria` JSON-array column on the `goals` table (separate from the AI-generated `goal_refinements.success_criteria`). The desktop create flow captures a structured list (≥1 required). On the daemon workflow path, `readGoal` surfaces the raw column; a shared parse helper feeds the gate evaluation request and the step-agent objective / step-execution input. Every prompt insertion is empty-string when a goal has no criteria, so existing goals render byte-identically.

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), better-sqlite3, Fastify (daemon), React + useReducer (desktop), Vitest.

## Global Constraints

- **No editing after create.** Criteria are set only at goal creation; no `UpdateGoalRequest` changes.
- **Required ≥1 on create.** `CreateGoalRequest` / `CreateGoalAndStartWorkflowRequest` require `successCriteria` with `.min(1)`. The `Goal` read schema uses `.default([])` so pre-existing rows / null columns still parse.
- **Item bounds (verbatim, reused from existing model):** `z.array(z.string().min(1).max(200)).max(20)`.
- **Empty-list parity is load-bearing.** Every prompt/payload insertion (gate prompt, worker prompt, agent objective, step-execution input) MUST be a no-op (empty string / omitted key) when a goal has no criteria. Tests assert byte-identical output for the empty case.
- **Do not touch the AI refinement path** (`goal.refine`, `goal_refinements`, `guided-goal-refinement`). The two `successCriteria` concepts coexist independently.
- **Migration is additive & nullable** (`success_criteria TEXT`), so existing rows backfill as `[]`.
- Tests run with `pnpm --filter <pkg> test` (vitest) — `@orca/contracts`, `@orca/daemon`, `@orca/desktop`.

---

## File Structure

**Contracts** (`packages/contracts/src/`)
- `index.ts` — add `successCriteria` to `Goal`, `CreateGoalRequest`, `CreateGoalAndStartWorkflowRequest`.
- `workflows/index.ts` — add optional `successCriteria` to `GateEvaluationRequest.goal`.
- `index.test.ts` — schema tests.

**Daemon** (`apps/daemon/`)
- `migrations/0063_goal_success_criteria.sql` — new column.
- `src/goals.ts` — `GoalRow`, `rowToGoal`, `CreateGoalInput`, insert SQL, `createGoal` persist.
- `src/goals/bootstrap-route.ts` — thread `successCriteria` through the injected `createGoalFn`.
- `src/server.ts` — no code change (createGoalFn already forwards `input`); verified in Task 3.
- `src/workflows/orchestrator/db-rows.ts` — `GoalRow.success_criteria`, `readGoal` SELECT, new `goalSuccessCriteria()` helper.
- `src/workflows/orchestrator/success-criteria-prompt.ts` — NEW shared pure helpers (`successCriteriaBlock`, `successCriteriaHint`).
- `src/workflows/orchestrator/gate-evaluation.ts` / `gate-worker.ts` — conditional hint; builder populates request.
- `src/workflows/orchestrator/dispatch-engine.ts` — `buildGateEvaluationRequest`, `buildAgentObjective` call site, `buildStepExecutionInput` call site.
- `src/workflows/orchestrator/service.ts` — `buildStepExecutionInput` call site.
- `src/workflows/orchestrator/agent-objective.ts` — render objective block.
- `src/workflows/orchestrator/step-input.ts` — `StepExecutionInput.goal` + `buildStepExecutionInput` thread.

**Desktop** (`apps/desktop/src/create-goal-flow/`)
- `state.ts` — `RoughState.successCriteria`, thread through phases, reducer actions.
- `steps/RoughGoalStep.tsx` — list UI + `canProceed`.
- `CreateGoalFlow.tsx` — pass trimmed non-empty criteria to submit.

---

## Task 1: Contracts — schema fields

**Files:**
- Modify: `packages/contracts/src/index.ts:39-53` (Goal), `:102-109` (CreateGoalRequest), `:117-124` (CreateGoalAndStartWorkflowRequest)
- Modify: `packages/contracts/src/workflows/index.ts:916` (GateEvaluationRequest.goal)
- Test: `packages/contracts/src/index.test.ts`

**Interfaces:**
- Produces: `Goal.successCriteria: string[]` (default `[]`); `CreateGoalRequest.successCriteria: string[]` (required, 1–20 items); `CreateGoalAndStartWorkflowRequest.successCriteria: string[]` (required, 1–20 items); `GateEvaluationRequest.goal.successCriteria?: string[]` (optional, absent when empty).

- [ ] **Step 1: Write failing tests**

Add to `packages/contracts/src/index.test.ts`:

```ts
import { Goal, CreateGoalRequest, CreateGoalAndStartWorkflowRequest } from "./index.js";

describe("Goal successCriteria", () => {
  it("defaults to [] when absent (back-compat for existing rows)", () => {
    const g = Goal.parse({
      id: "g1", title: "T", intent: "I", status: "active",
      createdAt: "2026-07-27T00:00:00.000Z", updatedAt: "2026-07-27T00:00:00.000Z",
      archivedAt: null,
    });
    expect(g.successCriteria).toEqual([]);
  });

  it("CreateGoalRequest requires at least one criterion", () => {
    const base = { title: "T", intent: "I" };
    expect(CreateGoalRequest.safeParse({ ...base, successCriteria: [] }).success).toBe(false);
    expect(CreateGoalRequest.safeParse({ ...base, successCriteria: ["all tests pass"] }).success).toBe(true);
  });

  it("CreateGoalRequest rejects >20 or >200-char criteria", () => {
    const base = { title: "T", intent: "I" };
    expect(CreateGoalRequest.safeParse({ ...base, successCriteria: Array(21).fill("x") }).success).toBe(false);
    expect(CreateGoalRequest.safeParse({ ...base, successCriteria: ["x".repeat(201)] }).success).toBe(false);
  });

  it("CreateGoalAndStartWorkflowRequest requires ≥1 criterion", () => {
    const base = { title: "T", intent: "I", workflowTemplateId: "wf1" };
    expect(CreateGoalAndStartWorkflowRequest.safeParse({ ...base, successCriteria: [] }).success).toBe(false);
    expect(CreateGoalAndStartWorkflowRequest.safeParse({ ...base, successCriteria: ["done"] }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @orca/contracts test -- index.test.ts`
Expected: FAIL — `successCriteria` undefined / accepts empty array.

- [ ] **Step 3: Implement**

In `packages/contracts/src/index.ts`, `Goal` object (after `archivedAt`, before the closing `})` at line 52) add:

```ts
  successCriteria: z.array(z.string().min(1).max(200)).max(20).default([]),
```

In `CreateGoalRequest` (add after `intent`):

```ts
  successCriteria: z.array(z.string().min(1).max(200)).min(1).max(20),
```

In `CreateGoalAndStartWorkflowRequest` (add after `intent`):

```ts
  successCriteria: z.array(z.string().min(1).max(200)).min(1).max(20),
```

In `packages/contracts/src/workflows/index.ts:916`, change the `goal` shape:

```ts
    goal: z.object({ id: Id, intent: z.string().max(4000), successCriteria: z.array(z.string().min(1).max(200)).max(20).optional() }).strict(),
```

(Optional, no default → absent from the parsed object when omitted, so it does not appear in `JSON.stringify(request)` for existing goals. The existing `.superRefine` payload-size guard already covers the added bytes.)

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @orca/contracts test -- index.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck contracts**

Run: `pnpm --filter @orca/contracts build` (or `tsc -p packages/contracts`)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/workflows/index.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): goal successCriteria (create required, gate-request optional)"
```

---

## Task 2: Migration + goals.ts persistence (CRUD/read path)

**Files:**
- Create: `apps/daemon/migrations/0063_goal_success_criteria.sql`
- Modify: `apps/daemon/src/goals.ts` — `GoalRow:66-80`, `rowToGoal:82-98`, `_stmts.insertGoal:119-121`, `CreateGoalInput:140-147`, `createGoal` insert `:275-284`
- Test: `apps/daemon/src/goals.test.ts`

**Interfaces:**
- Consumes: `Goal.successCriteria` (Task 1).
- Produces: `createGoal({ ..., successCriteria })` persists a JSON array; `getGoalById(...).successCriteria: string[]` round-trips; null column → `[]`.

- [ ] **Step 1: Write the migration**

Create `apps/daemon/migrations/0063_goal_success_criteria.sql`:

```sql
-- User-authored definition of done, captured at goal creation (structured list,
-- ≥1 required by the API). Stored as a JSON array of strings. Distinct from the
-- AI-generated goal_refinements.success_criteria. Nullable so existing rows read
-- as [] (rowToGoal defaults null → []).
ALTER TABLE goals ADD COLUMN success_criteria TEXT;
```

- [ ] **Step 2: Write failing test**

Add to `apps/daemon/src/goals.test.ts` (reuse the existing `createGoal` / `getGoalById` harness in that file):

```ts
it("persists and round-trips successCriteria", async () => {
  const goal = await createGoal(
    { title: "T", intent: "do the thing", successCriteria: ["  all tests pass  ", "", "docs updated"] },
    ctx, // the CreateGoalCtx built by this file's beforeEach/helper
  );
  // blanks filtered, entries trimmed
  expect(goal.successCriteria).toEqual(["all tests pass", "docs updated"]);
  const fetched = getGoalById(ctx.db, goal.id);
  expect(fetched?.successCriteria).toEqual(["all tests pass", "docs updated"]);
});

it("defaults successCriteria to [] for a goal created without it (legacy path)", async () => {
  const goal = await createGoal({ title: "T", intent: "x" }, ctx);
  expect(goal.successCriteria).toEqual([]);
});
```

> Note: match the exact `ctx` / helper names already used by neighboring tests in `goals.test.ts` (it constructs `CreateGoalCtx` with `db`, `bus`, `skills`, `modelProviderRegistry`, `inspectWorkspace`). Copy that setup — do not invent new fixture names.

- [ ] **Step 3: Run — expect FAIL**

Run: `pnpm --filter @orca/daemon test -- goals.test.ts`
Expected: FAIL — `successCriteria` undefined; column does not exist.

- [ ] **Step 4: Implement `goals.ts`**

`GoalRow` interface (add field):

```ts
  operating_mode: string;
  success_criteria: string | null;
```

`rowToGoal` — parse (null/invalid → `[]`):

```ts
function parseSuccessCriteria(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
```

In `rowToGoal`'s `Goal.parse({...})` add:

```ts
    operatingMode: row.operating_mode,
    successCriteria: parseSuccessCriteria(row.success_criteria),
```

`insertGoal` statement — add column + placeholder:

```ts
      insertGoal: db.prepare(
        "INSERT INTO goals (id, title, intent, success_criteria, status, autonomy_level, orchestrator_provider, orchestrator_model, worker_permission_mode, operating_mode, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, 'ask', ?, ?, ?)"
      ),
```

`CreateGoalInput` type — add:

```ts
  orchestratorModel?: OrchestratorModelChoice;
  successCriteria?: string[];
```

In `createGoal`, compute the sanitized list near the top of the function body (after `const { refined, workspaces, documents } = input;`):

```ts
  const successCriteria = (input.successCriteria ?? [])
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
```

Update the `stmts.insertGoal.run(...)` call (add `JSON.stringify(successCriteria)` in the new position, right after `intent`):

```ts
    stmts.insertGoal.run(
      goalId,
      title,
      intent,
      JSON.stringify(successCriteria),
      validatedOrchestratorModel?.providerId ?? null,
      validatedOrchestratorModel?.modelId ?? null,
      operatingMode,
      now,
      now
    );
```

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm --filter @orca/daemon test -- goals.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/migrations/0063_goal_success_criteria.sql apps/daemon/src/goals.ts apps/daemon/src/goals.test.ts
git commit -m "feat(daemon): persist goal.successCriteria (migration + CRUD round-trip)"
```

---

## Task 3: Bootstrap route — thread successCriteria to createGoal

**Files:**
- Modify: `apps/daemon/src/goals/bootstrap-route.ts:9-20` (dep type), `:41` (destructure), `:46` (call)
- Verify (no change expected): `apps/daemon/src/server.ts:1140-1147`
- Test: create/extend a bootstrap-route unit test

**Interfaces:**
- Consumes: `CreateGoalAndStartWorkflowRequest.successCriteria` (Task 1), `createGoal({ ..., successCriteria })` (Task 2).
- Produces: the create-and-start-workflow endpoint forwards `successCriteria` to `createGoalFn`.

- [ ] **Step 1: Write failing test**

Find the existing bootstrap-route test (`grep -rn "registerGoalBootstrapRoute" apps/daemon --include=*.test.ts`). If one exists, add a case; otherwise create `apps/daemon/src/goals/bootstrap-route.test.ts` with a Fastify instance and a spy `createGoalFn`. Assert forwarding:

```ts
it("forwards successCriteria to createGoalFn", async () => {
  const createGoalFn = vi.fn(async (input) => ({ id: "g1", /* ...minimal Goal... */ } as any));
  const server = Fastify();
  registerGoalBootstrapRoute(server, {
    createGoalFn,
    startWorkflowRunFn: () => ({ id: "r1" } as any),
    spawnOrchestratorSessionFn: async () => "s1",
    startWorkflowFirstStepFn: async () => {},
  });
  await server.inject({
    method: "POST", url: "/v1/goals/create-and-start-workflow",
    payload: { title: "T", intent: "I", successCriteria: ["done"], workflowTemplateId: "wf1" },
  });
  expect(createGoalFn).toHaveBeenCalledWith(expect.objectContaining({ successCriteria: ["done"] }));
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @orca/daemon test -- bootstrap-route`
Expected: FAIL — `successCriteria` not forwarded (and the request would 400 before Task 1; ensure contracts built).

- [ ] **Step 3: Implement**

In `GoalBootstrapRouteDeps.createGoalFn` input type (`:10-16`) add:

```ts
    orchestratorModel?: OrchestratorModelChoice;
    successCriteria?: string[];
```

Update the destructure at `:41`:

```ts
    const { title, intent, successCriteria, workspaces, documents, orchestratorModel, workflowTemplateId } = parsed.data;
```

Update the call at `:46`:

```ts
      goal = await deps.createGoalFn({ title, intent, successCriteria, workspaces, documents, orchestratorModel });
```

- [ ] **Step 4: Verify server.ts wiring (read-only)**

Confirm `apps/daemon/src/server.ts:1140` reads `createGoalFn: (input) => createGoal(input, {...})` — it forwards the whole `input`, so `successCriteria` flows automatically once the dep type allows it. **No edit needed.** If it destructures specific fields instead, add `successCriteria`.

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm --filter @orca/daemon test -- bootstrap-route`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/goals/bootstrap-route.ts apps/daemon/src/goals/bootstrap-route.test.ts
git commit -m "feat(daemon): forward successCriteria through create-and-start-workflow"
```

---

## Task 4: Dispatch read path + shared prompt helpers

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/db-rows.ts:5-11` (GoalRow), `:61-69` (readGoal), add `goalSuccessCriteria`
- Create: `apps/daemon/src/workflows/orchestrator/success-criteria-prompt.ts`
- Test: `apps/daemon/src/workflows/orchestrator/db-rows.test.ts` (create if absent) and `success-criteria-prompt.test.ts`

**Interfaces:**
- Produces:
  - `GoalRow.success_criteria: string | null` (raw column).
  - `goalSuccessCriteria(row: Pick<GoalRow, "success_criteria">): string[]` — parses (null/invalid → `[]`).
  - `successCriteriaBlock(criteria: string[] | undefined): string` — plain-text numbered block ending in `\n\n`, or `""` when empty. (For the objective — the only non-JSON surface.)
  - `successCriteriaHint(criteria: string[] | undefined): string` — one-line pointer ending in `\n\n`, or `""` when empty. (For gate/skill JSON surfaces where criteria already ride in the payload.)

- [ ] **Step 1: Write failing tests**

Create `apps/daemon/src/workflows/orchestrator/success-criteria-prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { successCriteriaBlock, successCriteriaHint } from "./success-criteria-prompt.js";

describe("successCriteriaBlock", () => {
  it("returns '' for empty/undefined (parity)", () => {
    expect(successCriteriaBlock([])).toBe("");
    expect(successCriteriaBlock(undefined)).toBe("");
  });
  it("renders a numbered block ending in a blank line", () => {
    expect(successCriteriaBlock(["a", "b"])).toBe(
      "Success Criteria (the goal is met only if ALL are satisfied):\n1. a\n2. b\n\n",
    );
  });
});

describe("successCriteriaHint", () => {
  it("returns '' for empty/undefined (parity)", () => {
    expect(successCriteriaHint([])).toBe("");
    expect(successCriteriaHint(undefined)).toBe("");
  });
  it("returns a one-line pointer when present", () => {
    expect(successCriteriaHint(["a"])).toMatch(/successCriteria/);
    expect(successCriteriaHint(["a"]).endsWith("\n\n")).toBe(true);
  });
});
```

Create `apps/daemon/src/workflows/orchestrator/db-rows.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { goalSuccessCriteria } from "./db-rows.js";

describe("goalSuccessCriteria", () => {
  it("parses a JSON array", () => {
    expect(goalSuccessCriteria({ success_criteria: '["a","b"]' })).toEqual(["a", "b"]);
  });
  it("returns [] for null / invalid", () => {
    expect(goalSuccessCriteria({ success_criteria: null })).toEqual([]);
    expect(goalSuccessCriteria({ success_criteria: "not json" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @orca/daemon test -- success-criteria-prompt db-rows`
Expected: FAIL — modules/exports missing.

- [ ] **Step 3: Implement helpers**

Create `apps/daemon/src/workflows/orchestrator/success-criteria-prompt.ts`:

```ts
// Shared, pure renderers for user-authored goal success criteria. Both return ""
// for an empty/undefined list so callers that splice them in are byte-identical
// for goals without criteria (empty-list parity — see the plan's Global Constraints).

export function successCriteriaBlock(criteria: string[] | undefined): string {
  if (!criteria || criteria.length === 0) return "";
  const lines = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return `Success Criteria (the goal is met only if ALL are satisfied):\n${lines}\n\n`;
}

export function successCriteriaHint(criteria: string[] | undefined): string {
  if (!criteria || criteria.length === 0) return "";
  return (
    "The goal's successCriteria define the definition of done — the output must " +
    "satisfy EVERY criterion; treat any unmet criterion as grounds to reject.\n\n"
  );
}
```

- [ ] **Step 4: Implement db-rows**

`GoalRow` — add:

```ts
  orchestrator_model: string | null;
  success_criteria: string | null;
```

`readGoal` SELECT — add the column:

```ts
    .prepare(
      "SELECT id, title, intent, orchestrator_provider, orchestrator_model, success_criteria FROM goals WHERE id = ?",
    )
```

Append helper to `db-rows.ts`:

```ts
export function goalSuccessCriteria(row: Pick<GoalRow, "success_criteria">): string[] {
  if (!row.success_criteria) return [];
  try {
    const v = JSON.parse(row.success_criteria);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm --filter @orca/daemon test -- success-criteria-prompt db-rows`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/db-rows.ts apps/daemon/src/workflows/orchestrator/db-rows.test.ts apps/daemon/src/workflows/orchestrator/success-criteria-prompt.ts apps/daemon/src/workflows/orchestrator/success-criteria-prompt.test.ts
git commit -m "feat(daemon): surface goal.success_criteria on dispatch read path + prompt helpers"
```

---

## Task 5: Gate — criteria in the evaluation request + conditional hint

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts:2093-2100` (`buildGateEvaluationRequest`)
- Modify: `apps/daemon/src/workflows/orchestrator/gate-evaluation.ts:14-43` (`composeGateEvaluationPrompt`)
- Modify: `apps/daemon/src/workflows/orchestrator/gate-worker.ts:3-32` (`composeGateWorkerPrompt`)
- Test: `apps/daemon/src/workflows/orchestrator/gate-evaluation.test.ts`, `gate-worker.test.ts`

**Interfaces:**
- Consumes: `goalSuccessCriteria` + `successCriteriaHint` (Task 4); `GateEvaluationRequest.goal.successCriteria?` (Task 1).
- Produces: gate request carries `goal.successCriteria` only when non-empty; both gate prompts prepend the hint only when non-empty.

- [ ] **Step 1: Write failing tests**

In `gate-evaluation.test.ts`:

```ts
import { composeGateEvaluationPrompt } from "./gate-evaluation.js";

const baseReq = {
  gate: { nodeId: "n1", name: "Gate", instructions: "check" },
  goal: { id: "g1", intent: "ship it" },
  sourceStepOutput: null, priorGateDecisions: [], availableOutcomes: ["approved", "rejected"], committedLedger: [],
} as any;

it("prompt is byte-identical when no successCriteria (parity)", () => {
  const withKey = composeGateEvaluationPrompt({ ...baseReq, goal: { ...baseReq.goal } });
  const withEmpty = composeGateEvaluationPrompt({ ...baseReq, goal: { ...baseReq.goal, successCriteria: [] } });
  expect(withEmpty.systemPrompt).toBe(withKey.systemPrompt);
  expect(withEmpty.userPrompt).toBe(withKey.userPrompt);
});

it("prepends the criteria hint when present; systemPrompt unchanged", () => {
  const bare = composeGateEvaluationPrompt(baseReq);
  const withSc = composeGateEvaluationPrompt({ ...baseReq, goal: { ...baseReq.goal, successCriteria: ["all tests pass"] } });
  expect(withSc.systemPrompt).toBe(bare.systemPrompt);
  expect(withSc.userPrompt.startsWith("The goal's successCriteria")).toBe(true);
  expect(withSc.userPrompt).toContain(JSON.stringify({ ...baseReq, goal: { ...baseReq.goal, successCriteria: ["all tests pass"] } }));
});
```

In `gate-worker.test.ts`:

```ts
import { composeGateWorkerPrompt } from "./gate-worker.js";

const req = {
  gate: { nodeId: "n1", name: "G", instructions: "verify" },
  goal: { id: "g1", intent: "x" },
  sourceStepOutput: null, priorGateDecisions: [], availableOutcomes: ["approved"], committedLedger: [],
} as any;

it("worker prompt byte-identical when no criteria (parity)", () => {
  expect(composeGateWorkerPrompt({ ...req, goal: { ...req.goal, successCriteria: [] } }))
    .toBe(composeGateWorkerPrompt(req));
});

it("prepends hint when criteria present", () => {
  const withSc = composeGateWorkerPrompt({ ...req, goal: { ...req.goal, successCriteria: ["done"] } });
  expect(withSc.startsWith("The goal's successCriteria")).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @orca/daemon test -- gate-evaluation gate-worker`
Expected: FAIL — no hint prepended.

- [ ] **Step 3: Implement composers**

`gate-evaluation.ts` — import and prepend to userPrompt only:

```ts
import { successCriteriaHint } from "./success-criteria-prompt.js";
```

Change the return of `composeGateEvaluationPrompt` (leave `systemPrompt` untouched):

```ts
  return {
    systemPrompt,
    userPrompt: successCriteriaHint(request.goal.successCriteria) + JSON.stringify(request),
  };
```

`gate-worker.ts` — import and prepend to the joined string:

```ts
import { successCriteriaHint } from "./success-criteria-prompt.js";

export function composeGateWorkerPrompt(request: GateEvaluationRequest): string {
  return successCriteriaHint(request.goal.successCriteria) + [
    request.gate.instructions,
    // ...unchanged array...
  ].join("\n");
}
```

- [ ] **Step 4: Implement the builder**

`dispatch-engine.ts` — import `goalSuccessCriteria` (from `./db-rows.js`, extend the existing import). In `buildGateEvaluationRequest`, before the `return`:

```ts
    const successCriteria = goalSuccessCriteria(goal);
```

Change the `goal` field of the parsed request (omit the key when empty, for parity):

```ts
      goal: successCriteria.length
        ? { id: goal.id, intent: goal.intent, successCriteria }
        : { id: goal.id, intent: goal.intent },
```

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm --filter @orca/daemon test -- gate-evaluation gate-worker`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/gate-evaluation.ts apps/daemon/src/workflows/orchestrator/gate-worker.ts apps/daemon/src/workflows/orchestrator/dispatch-engine.ts apps/daemon/src/workflows/orchestrator/gate-evaluation.test.ts apps/daemon/src/workflows/orchestrator/gate-worker.test.ts
git commit -m "feat(daemon): gate evaluation judges against user success criteria"
```

---

## Task 6: Step agent (the doer) — objective + step-execution input

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/agent-objective.ts` (whole file)
- Modify: `apps/daemon/src/workflows/orchestrator/step-input.ts:5-12` (type), `:18-32,48-55` (thread goal)
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts:823` (objective call), `:587-588` (step-input call)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts:371` (step-input call)
- Test: `apps/daemon/src/workflows/orchestrator/agent-objective.test.ts` (create), extend `step-input`-covering test if present

**Interfaces:**
- Consumes: `goalSuccessCriteria` + `successCriteriaBlock` (Task 4).
- Produces: `buildAgentObjective(step, { goal: { intent, successCriteria? }, stepRun })` renders the block; `StepExecutionInput.goal.successCriteria?: string[]` carried into the run-step-skill / synthesis payload.

- [ ] **Step 1: Write failing test**

Create `apps/daemon/src/workflows/orchestrator/agent-objective.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildAgentObjective } from "./agent-objective.js";

const step = { name: "Implement", instructions: "do X" } as any;

describe("buildAgentObjective", () => {
  it("is byte-identical when no criteria (parity)", () => {
    const none = buildAgentObjective(step, { goal: { intent: "ship" }, stepRun: { id: "s1" } });
    const empty = buildAgentObjective(step, { goal: { intent: "ship", successCriteria: [] }, stepRun: { id: "s1" } });
    expect(empty).toBe(none);
  });
  it("renders the success-criteria block after the Goal line", () => {
    const out = buildAgentObjective(step, { goal: { intent: "ship", successCriteria: ["tests pass"] }, stepRun: { id: "s1" } });
    expect(out).toContain("Goal: ship");
    expect(out).toContain("Success Criteria (the goal is met only if ALL are satisfied):\n1. tests pass");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @orca/daemon test -- agent-objective`
Expected: FAIL — block not rendered; `successCriteria` not accepted on ctx type.

- [ ] **Step 3: Implement `agent-objective.ts`**

```ts
import type { WorkflowStepTemplate } from "@orca/contracts";

import { augmentInstructionsWithOutputConvention } from "./orca-output.js";
import { successCriteriaBlock } from "./success-criteria-prompt.js";

export function buildAgentObjective(
  step: WorkflowStepTemplate,
  ctx: { goal: { intent: string; successCriteria?: string[] }; stepRun: { id: string } }
): string {
  const header =
    `Workflow step: ${step.name}\nGoal: ${ctx.goal.intent}\n\n` +
    successCriteriaBlock(ctx.goal.successCriteria);
  return augmentInstructionsWithOutputConvention(`${header}${step.instructions}`);
}
```

(When `successCriteria` is empty/absent, `successCriteriaBlock` returns `""`, so `header` is byte-identical to today.)

- [ ] **Step 4: Implement `step-input.ts`**

Widen the `goal` shape on both `StepExecutionInput` and `buildStepExecutionInput`'s `args`:

```ts
export interface StepExecutionInput {
  goal: { id: string; intent: string; successCriteria?: string[] };
```

```ts
export function buildStepExecutionInput(args: {
  goal: { id: string; intent: string; successCriteria?: string[] };
```

No change to the function body needed — it already returns `goal` as-is (`return { goal, ... }`). The field flows through.

- [ ] **Step 5: Implement call sites**

`dispatch-engine.ts:823` (objective):

```ts
    const objective = buildAgentObjective(stepTpl, {
      goal: { intent: goal.intent, successCriteria: goalSuccessCriteria(goal) },
      stepRun,
    });
```

`dispatch-engine.ts:587-588` (step-input) — set `goal` conditionally for payload parity:

```ts
    const stepSuccessCriteria = goalSuccessCriteria(goal);
    const input = buildStepExecutionInput({
      goal: stepSuccessCriteria.length
        ? { id: goal.id, intent: goal.intent, successCriteria: stepSuccessCriteria }
        : { id: goal.id, intent: goal.intent },
      steps: template.steps,
      // ...unchanged...
```

`service.ts:371` — same treatment (here too `goal` is a `GoalRow`; import `goalSuccessCriteria` from `./db-rows.js`):

```ts
    const svcSuccessCriteria = goalSuccessCriteria(goal);
    const stepInput = buildStepExecutionInput({
      goal: svcSuccessCriteria.length
        ? { id: goal.id, intent: goal.intent, successCriteria: svcSuccessCriteria }
        : { id: goal.id, intent: goal.intent },
      steps: template.steps,
      // ...unchanged...
```

- [ ] **Step 6: Run — expect PASS + typecheck**

Run: `pnpm --filter @orca/daemon test -- agent-objective`
Run: `pnpm --filter @orca/daemon build` (typecheck the call sites)
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/agent-objective.ts apps/daemon/src/workflows/orchestrator/agent-objective.test.ts apps/daemon/src/workflows/orchestrator/step-input.ts apps/daemon/src/workflows/orchestrator/dispatch-engine.ts apps/daemon/src/workflows/orchestrator/service.ts
git commit -m "feat(daemon): step agent sees goal success criteria (objective + step input)"
```

---

## Task 7: Desktop — required success-criteria list in the create flow

**Files:**
- Modify: `apps/desktop/src/create-goal-flow/state.ts` — `RoughState`, phase threading, actions, reducer
- Modify: `apps/desktop/src/create-goal-flow/steps/RoughGoalStep.tsx` — list UI + `canProceed`
- Modify: `apps/desktop/src/create-goal-flow/CreateGoalFlow.tsx:71-104` — pass criteria to submit
- Test: `apps/desktop/src/create-goal-flow/state.test.ts`

**Interfaces:**
- Consumes: `CreateGoalAndStartWorkflowRequest.successCriteria` (Task 1).
- Produces: `RoughState.successCriteria: string[]`; the submit path sends trimmed, non-empty criteria.

- [ ] **Step 1: Write failing tests**

Add to `apps/desktop/src/create-goal-flow/state.test.ts` (match existing import of `reducer`, `initialState`):

```ts
it("starts with one empty criterion row", () => {
  expect(initialState).toMatchObject({ phase: "rough", successCriteria: [""] });
});

it("adds, edits, and removes criteria", () => {
  let s = reducer(initialState, { type: "editSuccessCriterion", index: 0, value: "a" });
  s = reducer(s, { type: "addSuccessCriterion" });
  s = reducer(s, { type: "editSuccessCriterion", index: 1, value: "b" });
  expect((s as any).successCriteria).toEqual(["a", "b"]);
  s = reducer(s, { type: "removeSuccessCriterion", index: 0 });
  expect((s as any).successCriteria).toEqual(["b"]);
});

it("carries successCriteria into the coordinate phase and back", () => {
  let s = reducer({ ...initialState, title: "T", intent: "I", successCriteria: ["a"] } as any, { type: "proceedToCoordinate" });
  expect((s as any).successCriteria).toEqual(["a"]);
  s = reducer(s, { type: "backToDescribe" });
  expect((s as any).successCriteria).toEqual(["a"]);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @orca/desktop test -- state.test.ts`
Expected: FAIL — actions/fields missing.

- [ ] **Step 3: Implement `state.ts`**

Add `successCriteria: string[]` to `RoughState`, `CoordinateState`, `SubmittingState`, and `WorkflowFailedState` (every phase that already carries `title`/`intent`).

`initialState`:

```ts
export const initialState: FlowState = {
  phase: "rough",
  title: "",
  intent: "",
  successCriteria: [""],
};
```

Add actions to `FlowAction`:

```ts
  | { type: "addSuccessCriterion" }
  | { type: "editSuccessCriterion"; index: number; value: string }
  | { type: "removeSuccessCriterion"; index: number }
```

Add reducer cases (rough phase only), mirroring the existing `setIntent` guard style:

```ts
    case "addSuccessCriterion":
      if (state.phase === "rough") {
        return { ...state, successCriteria: [...state.successCriteria, ""] };
      }
      return state;

    case "editSuccessCriterion":
      if (state.phase === "rough") {
        return {
          ...state,
          successCriteria: state.successCriteria.map((c, i) => (i === action.index ? action.value : c)),
        };
      }
      return state;

    case "removeSuccessCriterion":
      if (state.phase === "rough") {
        // keep at least one row so the UI always shows an input
        const next = state.successCriteria.filter((_, i) => i !== action.index);
        return { ...state, successCriteria: next.length > 0 ? next : [""] };
      }
      return state;
```

Thread `successCriteria` through every phase transition that copies `title`/`intent`: `proceedToCoordinate`, `backToDescribe`, `submitRequested`, `submitFailed`, `workflowBootstrapFailed`, `retryWorkflowStart` (add `successCriteria: state.successCriteria,` to each returned object).

- [ ] **Step 4: Implement `RoughGoalStep.tsx`**

Require ≥1 non-empty criterion in `canProceed`, and render the list:

```tsx
  const trimmedCriteria = state.successCriteria.map((c) => c.trim()).filter((c) => c.length > 0);
  const canProceed =
    state.title.trim().length > 0 &&
    state.intent.trim().length > 0 &&
    trimmedCriteria.length > 0;
```

Add this block after the intent `form-field` and before `{state.error && ...}`:

```tsx
      <div className="form-field">
        <label>Success Criteria</label>
        <p className="form-hint">
          What makes this goal complete? The workflow gates judge success against these.
        </p>
        {state.successCriteria.map((criterion, i) => (
          <div key={i} className="criterion-row">
            <input
              type="text"
              value={criterion}
              onChange={(e) => dispatch({ type: "editSuccessCriterion", index: i, value: e.target.value })}
              maxLength={200}
              placeholder="e.g. All tests pass in CI"
            />
            {state.successCriteria.length > 1 && (
              <button
                type="button"
                className="criterion-remove"
                aria-label="Remove criterion"
                onClick={() => dispatch({ type: "removeSuccessCriterion", index: i })}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="criterion-add"
          onClick={() => dispatch({ type: "addSuccessCriterion" })}
        >
          + Add criterion
        </button>
      </div>
```

(Styling: reuse existing `.form-field` / `.form-hint`; `.criterion-row/.criterion-add/.criterion-remove` are minor additions — match the app's existing button/input classes rather than inventing heavy new CSS. Keep it consistent with `CoordinateStep`'s pending-row styling if present.)

- [ ] **Step 5: Implement `CreateGoalFlow.tsx` submit**

Destructure `successCriteria` in the submitting effect (`:71-78`) and pass the trimmed, non-empty list to `createGoalAndStartWorkflow` (`:90`):

```ts
    const {
      title,
      intent,
      successCriteria,
      pendingWorkspaces,
      pendingDocuments,
      orchestratorModel,
      workflowTemplateId,
    } = state;
```

```ts
        const result = await createGoalAndStartWorkflow({
          title,
          intent,
          successCriteria: successCriteria.map((c) => c.trim()).filter((c) => c.length > 0),
          workspaces: pendingWorkspaces.map((ws) => ({ inputPath: ws.inputPath, name: ws.name })),
          // ...unchanged...
        });
```

- [ ] **Step 6: Run — expect PASS + typecheck**

Run: `pnpm --filter @orca/desktop test -- state.test.ts`
Run: `pnpm --filter @orca/desktop build` (typechecks the new request field + reducer)
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/create-goal-flow/state.ts apps/desktop/src/create-goal-flow/state.test.ts apps/desktop/src/create-goal-flow/steps/RoughGoalStep.tsx apps/desktop/src/create-goal-flow/CreateGoalFlow.tsx
git commit -m "feat(desktop): capture required success criteria in create-goal flow"
```

---

## Task 8: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suites**

Run: `pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test`
Expected: all PASS.

- [ ] **Step 2: Typecheck the workspace**

Run: `pnpm -r build` (or the repo's typecheck script)
Expected: no errors.

- [ ] **Step 3: Manual smoke (browser-driven, optional but recommended)**

Per CLAUDE.md "Driving the app in a browser": `pnpm dev:browser`, create a goal, confirm the Success Criteria list requires ≥1 entry before "Next →" enables, complete creation, and verify (daemon logs / DB) that `goals.success_criteria` is populated and a gate evaluation request for that goal carries `goal.successCriteria`.

- [ ] **Step 4: Update the progress ledger / mark spec delivered.**

---

## Self-Review

**Spec coverage:**
- Data model / new column → Task 2 (migration + goals.ts) & Task 4 (dispatch read path). ✓
- Contract fields (Goal default `[]`, create required `min(1)`, gate optional) → Task 1. ✓
- Structured-list UI, ≥1 required, create-only → Task 7. ✓
- Reach = gate + step agent → Task 5 (gate) & Task 6 (objective + step input). ✓
- Empty-list parity (byte-identical) → helpers return `""`, asserted in Tasks 4/5/6. ✓
- API forwarding through create-and-start-workflow → Task 3. ✓
- Non-goals (no refinement changes, no edit-after-create, no context-assembly/tasks/memory/recommendations threading) → respected; none of those files are touched. ✓

**Placeholder scan:** No TBD/TODO; all code steps show concrete code and exact commands. ✓

**Type consistency:** `goalSuccessCriteria` (db-rows) used identically in Tasks 5 & 6; `successCriteriaBlock` (objective) vs `successCriteriaHint` (gate/skill JSON) are distinct by design and used consistently; `RoughState.successCriteria: string[]` matches the reducer actions `add/edit/removeSuccessCriterion`. ✓

**Known ordering note:** Tasks 5–7 depend on Task 1 (contracts) being built; Tasks 4–6 depend on Task 2's column existing at runtime (tests in 5/6 use in-memory prompt composers so they don't need the migration, but the full suite in Task 8 does). Execute in order.
