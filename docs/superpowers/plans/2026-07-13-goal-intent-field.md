# Goal Intent Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the optional goal `description` field with a required `intent` field — a pure rename (same downstream role) that is now mandatory (non-empty) at goal creation.

**Architecture:** This is one atomic, cross-cutting rename spanning three packages that compile in dependency order: `@orca/contracts` → `apps/daemon` → `apps/desktop`. Because the spec forbids a compatibility alias, the repo does **not** fully typecheck between Task 1 and Task 3 — this is inherent to an atomic rename. Each task ends green for its **own package's** scoped test command; full-repo `typecheck` + `test` green is the Task 4 gate. The DB column is renamed in place (`ALTER TABLE goals RENAME COLUMN description TO intent`), preserving all existing goals; no backfill of legacy empty values.

**Tech Stack:** TypeScript (ESM), Zod contracts, better-sqlite3 (bundled SQLite ≥3.25, `RENAME COLUMN` supported), Fastify daemon, React desktop, Vitest.

## Global Constraints

- Field name is exactly `intent` everywhere (contract fields, DB column, event payloads, internal orchestrator `goal.intent`, desktop state).
- Create-time validation: `z.string().min(1).max(4000)` (non-empty, ≤4000) on `CreateGoalRequest` and `CreateGoalAndStartWorkflowRequest`.
- Refinement/update paths keep permissive length only: `z.string().max(4000).default("")` for the two refine inputs; `z.string().max(4000).optional()` for `UpdateGoalRequest` (the requirement is enforced only at goal **creation**, per spec — do NOT add `.min(1)` to update/refine).
- No `description` compatibility alias on any goal type. No backfill of existing rows.
- New migration file: `apps/daemon/migrations/0059_goal_intent_rename.sql`, registered as the last entry in `migrationFiles` (after `"0058_goal_documents.sql"`).
- Desktop create-flow placeholder copy (exact): `What do you want to achieve and why? Describe the outcome, not the steps.`
- Per-package test commands: contracts `pnpm --filter @orca/contracts test`; daemon `pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/daemon test`; desktop `pnpm --filter @orca/desktop typecheck && pnpm --filter @orca/desktop test`.

---

## Task 1: Contracts rename

**Files:**
- Modify: `packages/contracts/src/index.ts` (lines 42, 56–58, 62–65, 102–104, 117–119, 147–154, 416–420)
- Test: `packages/contracts/src/index.test.ts`

**Interfaces:**
- Produces (consumed by all later tasks):
  - `Goal.intent: string` (required)
  - `CreateGoalRequest.intent: string` (min 1, max 4000; **no default**)
  - `CreateGoalAndStartWorkflowRequest.intent: string` (min 1, max 4000; no default)
  - `GuidedRefinementInput.intent: string` (max 4000, default "")
  - `GuidedRefinementOutput.intent: string` (max 4000, required)
  - `UpdateGoalRequest.intent?: string` (max 4000, optional)
  - `RefineGoalRequest.intent: string` (max 4000, default "")

- [ ] **Step 1: Write the failing contract tests**

In `packages/contracts/src/index.test.ts`, first update the existing round-trip fixtures that use `description` for goal schemas to `intent`. The known spots (from grep) are around lines 119, 131, 148, 269, 279, 283, 292, 458 — change the `description:` keys that belong to `Goal`, `CreateGoalRequest`, `GuidedRefinementInput/Output`, `RefineGoalRequest` payloads to `intent:`. (Leave `description` keys that belong to unrelated schemas like question `options` untouched — e.g. line 198 `options: [{ label: "A", description: "x" }]`.)

Then add these new assertions (put them in the goal-contract describe block):

```ts
it("CreateGoalRequest requires a non-empty intent", () => {
  expect(() => CreateGoalRequest.parse({ title: "T" })).toThrow(); // intent missing
  expect(() => CreateGoalRequest.parse({ title: "T", intent: "" })).toThrow(); // empty
  const ok = CreateGoalRequest.parse({ title: "T", intent: "Ship the feature" });
  expect(ok.intent).toBe("Ship the feature");
});

it("CreateGoalAndStartWorkflowRequest requires a non-empty intent", () => {
  expect(() =>
    CreateGoalAndStartWorkflowRequest.parse({ title: "T", workflowTemplateId: "wf" }),
  ).toThrow();
  expect(() =>
    CreateGoalAndStartWorkflowRequest.parse({ title: "T", intent: "", workflowTemplateId: "wf" }),
  ).toThrow();
  const ok = CreateGoalAndStartWorkflowRequest.parse({
    title: "T",
    intent: "Do the thing",
    workflowTemplateId: "wf",
  });
  expect(ok.intent).toBe("Do the thing");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/contracts test`
Expected: FAIL — `intent` is not yet a field; `.parse({ intent })` strips it / assertions on `ok.intent` are undefined, and the renamed round-trip fixtures fail.

- [ ] **Step 3: Apply the contract rename**

In `packages/contracts/src/index.ts` make these exact edits:

```ts
// Goal (line ~42)
  intent: z.string(),

// GuidedRefinementInput (line ~57-58)
export const GuidedRefinementInput = z.object({
  title: z.string().min(1).max(200),
  intent: z.string().max(4000).default("")
});

// GuidedRefinementOutput (line ~65)
  intent: z.string().max(4000),

// CreateGoalRequest (line ~104)
  intent: z.string().min(1).max(4000),

// CreateGoalAndStartWorkflowRequest (line ~119)
  intent: z.string().min(1).max(4000),

// UpdateGoalRequest (lines ~147-154)
export const UpdateGoalRequest = z
  .object({
    title: z.string().min(1).max(200).optional(),
    intent: z.string().max(4000).optional()
  })
  .refine((data) => data.title !== undefined || data.intent !== undefined, {
    message: "at least one of title or intent must be provided"
  });

// RefineGoalRequest (lines ~416-420)
export const RefineGoalRequest = z
  .object({
    title: z.string().min(1).max(200),
    intent: z.string().max(4000).default("")
  })
  .strict();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/contracts test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): required goal intent field replacing optional description"
```

---

## Task 2: Daemon — migration, persistence, and orchestrator plumbing

This is the atomic daemon rename: the DB column, the persistence layer (`goals.ts` + skills + route), and the internal orchestrator `goal.description` field must all move together so the daemon typechecks and every daemon test (which runs the migration) stays green.

**Files:**
- Create: `apps/daemon/migrations/0059_goal_intent_rename.sql`
- Modify: `apps/daemon/src/migrations.ts` (register file)
- Modify: `apps/daemon/src/goals.ts`
- Modify: `apps/daemon/src/skills/quick-goal.ts`
- Modify: `apps/daemon/src/skills/guided-goal-refinement.ts`
- Modify: `apps/daemon/src/goals/bootstrap-route.ts`
- Modify: `apps/daemon/src/server.ts` (refine route hand-off)
- Modify: `apps/daemon/src/workflows/orchestrator/db-rows.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/step-input.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/agent-objective.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (≈146, 360, 1538)
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts` (≈425, 584, 1807, 2078)
- Modify: `apps/daemon/src/workflows/orchestrator/provider-recovery-controller.ts` (≈332)
- Modify: `apps/daemon/src/workflows/orchestrator/step-result-builder.ts` (≈194)
- Modify: `apps/daemon/src/orchestrator-llm/context.ts` (≈23)
- Modify: `apps/daemon/src/orchestrator-llm/build-context.ts` (≈137, 177, 199)
- Modify: `apps/daemon/src/orchestrator-llm/prompts.ts` (≈6, 54, 72)
- Modify: `apps/daemon/src/orchestrator-chat/usecases.ts` (≈133, 163)
- Modify: `apps/daemon/src/recommendations/input.ts` (≈405)
- Test: `apps/daemon/src/migrations.test.ts`, `apps/daemon/src/goals.test.ts`, and the orchestrator test fixtures listed in Step 11.

**Interfaces:**
- Consumes: contract types from Task 1 (`Goal.intent`, `CreateGoalRequest.intent`, etc.).
- Produces: `goals` table column `intent`; `CreateGoalInput.intent`; internal `goal.intent` on all orchestrator context objects; `composeAgentInitialPrompt` input field `goalIntent`.

### Migration

- [ ] **Step 1: Write the failing migration test**

In `apps/daemon/src/migrations.test.ts` add:

```ts
it("0059 renames goals.description to intent and preserves values", () => {
  const db = freshDb();
  applyMigrationsUpTo(db, "0059_goal_intent_rename.sql");
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, worker_permission_mode, operating_mode, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, 'ask', 'human_review', ?, ?)",
  ).run("g1", "T", "keep me", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

  const sql = readFileSync(path.join(defaultMigrationsDir(), "0059_goal_intent_rename.sql"), "utf-8");
  db.exec(sql);

  const cols = (db.prepare("PRAGMA table_info(goals)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("intent");
  expect(cols).not.toContain("description");
  const row = db.prepare("SELECT intent FROM goals WHERE id = 'g1'").get() as { intent: string };
  expect(row.intent).toBe("keep me");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orca/daemon test -- migrations.test`
Expected: FAIL — `0059_goal_intent_rename.sql` does not exist (readFileSync throws / file not registered).

- [ ] **Step 3: Create the migration file**

Create `apps/daemon/migrations/0059_goal_intent_rename.sql`:

```sql
-- Rename the goal prose column: optional description -> required intent.
-- The NOT-NULL requirement is enforced at creation time in application code;
-- existing rows keep their (possibly empty) values.
ALTER TABLE goals RENAME COLUMN description TO intent;
```

- [ ] **Step 4: Register the migration**

In `apps/daemon/src/migrations.ts`, add to the end of the `migrationFiles` array (immediately after `"0058_goal_documents.sql",`):

```ts
  "0059_goal_intent_rename.sql",
```

- [ ] **Step 5: Fix the full-list migration assertions**

Run: `pnpm --filter @orca/daemon test -- migrations.test`
This will now fail the two `expect(result.applied).toEqual([...])` assertions (the "applies all migrations on a fresh database" and the upgrade test) because they list migrations through `"0058_goal_documents.sql"`. Append `"0059_goal_intent_rename.sql"` as the final element of each such array. Re-run:

Run: `pnpm --filter @orca/daemon test -- migrations.test`
Expected: PASS (including the new 0059 test).

### Persistence layer (goals.ts, skills, routes)

- [ ] **Step 6: Rename in `goals.ts`**

Apply these exact edits in `apps/daemon/src/goals.ts`:

```ts
// GoalRow (line ~69)
  intent: string;

// rowToGoal (line ~86)
    intent: row.intent,

// insertGoal SQL (line ~120) — column list description -> intent
      "INSERT INTO goals (id, title, intent, status, autonomy_level, orchestrator_provider, orchestrator_model, worker_permission_mode, operating_mode, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?, 'ask', ?, ?, ?)"

// updateGoal SQL (line ~127)
      "UPDATE goals SET title = COALESCE(?, title), intent = COALESCE(?, intent), updated_at = ? WHERE id = ?"

// CreateGoalInput (line ~142)
  intent?: string;

// GoalOrigin (line ~151)
  intent: string;
```

In `resolveGoalOrigin` (lines ~162–186), rename both returned `description` fields to `intent`, and change the `normalized` cast type and its read:

```ts
  if (validatedRefined) {
    return {
      title: validatedRefined.title,
      intent: validatedRefined.intent,
      skillId: "guided-goal-refinement",
      extensionPoint: "goal.refine",
      durationMs: 0,
    };
  }
  ...
  const normalized = skill.invoke(input, { now: () => new Date().toISOString() }) as {
    title: string;
    intent: string;
  };
  return {
    title: normalized.title,
    intent: normalized.intent,
    skillId: skill.id,
    extensionPoint: skill.extensionPoint,
    durationMs: Math.round(performance.now() - startedAt),
  };
```

In `createGoal`:

```ts
// destructure (line ~250)
  const { title, intent, skillId, extensionPoint, durationMs } = resolveGoalOrigin(
    input,
    ctx,
    validatedRefined,
  );

// goal.created event (line ~274)
    toPublish.push(emitEvent("goal.created", { title, intent }));

// insertGoal.run (line ~275-284) — pass `intent` in the 3rd position
    stmts.insertGoal.run(
      goalId,
      title,
      intent,
      validatedOrchestratorModel?.providerId ?? null,
      validatedOrchestratorModel?.modelId ?? null,
      operatingMode,
      now,
      now
    );

// return object (line ~360)
    intent,
```

In `updateGoal` (line ~400), change the second `stmts.updateGoal.run` argument:

```ts
    stmts.updateGoal.run(
      patch.title ?? null,
      patch.intent ?? null,
      now,
      id
    );
```

- [ ] **Step 7: Rename in `quick-goal.ts` and enforce non-empty**

Replace the body of `apps/daemon/src/skills/quick-goal.ts` I/O to use `intent`, and reject empty-after-trim:

```ts
export const quickGoalSkill: SkillDescriptor<
  { title: string; intent?: string },
  { title: string; intent: string }
> = {
  id: "quick-goal",
  pluginId: "orca.default-skills",
  extensionPoint: "goal.create",
  version: "0.1.0",
  category: "public",
  invocation: "http",
  title: "Quick Goal",
  description: "Deterministic normalization of Goal creation input. No AI.",

  invoke(input, _ctx) {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof (input as Record<string, unknown>).title !== "string"
    ) {
      throw new ValidationError([{ path: ["title"], message: "title must be a string" }]);
    }

    const raw = input as { title: string; intent?: string };
    const title = raw.title.trim();
    const intent = (raw.intent ?? "").trim();

    if (title.length < 1 || title.length > 200) {
      throw new ValidationError([
        { path: ["title"], message: "title must be 1..200 chars after trim" },
      ]);
    }

    if (intent.length < 1 || intent.length > 4000) {
      throw new ValidationError([
        { path: ["intent"], message: "intent must be 1..4000 chars after trim" },
      ]);
    }

    return { title, intent };
  },
};
```

Note: `skill.description` on the descriptor (line 15) is the skill's own metadata field — leave it.

- [ ] **Step 8: Rename in `guided-goal-refinement.ts`**

The skill parses a prose blob into a description + structured sections. Rename only the **output field** and the local var that feeds it (keep the internal `parseDescription` helper name — it parses a description-formatted blob, and renaming it is cosmetic churn outside this change's scope):

```ts
// parseDescription return type + return object: rename `description` key -> `intent`
function parseDescription(raw: string): {
  intent: string;
  successCriteria: string[];
  constraints: string[];
  assumptions: string[];
} {
  ...
  const intent = descLines.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd();
  return {
    intent,
    successCriteria: processItems(collected.successCriteria),
    constraints: processItems(collected.constraints),
    assumptions: processItems(collected.assumptions),
  };
}

// invoke(): read parsed.intent, emit intent
  invoke(input, _ctx): GuidedRefinementOutput {
    const parsed = GuidedRefinementInput.parse(input);
    const { intent, successCriteria, constraints, assumptions } = parseDescription(parsed.intent);
    return GuidedRefinementOutput.parse({
      skillId: SKILL_ID,
      title: parsed.title.trim(),
      intent,
      successCriteria,
      constraints,
      assumptions,
    });
  },
```

- [ ] **Step 9: Rename in `bootstrap-route.ts` and the refine route**

In `apps/daemon/src/goals/bootstrap-route.ts`:

```ts
// createGoalFn input type (line ~13)
  createGoalFn: (input: {
    title: string;
    intent: string;
    workspaces?: { inputPath: string; name?: string }[];
    documents?: { kind: "file" | "url"; ref: string; name?: string }[];
    orchestratorModel?: OrchestratorModelChoice;
  }) => Promise<Goal>;

// route handler (line ~41)
    const { title, intent, workspaces, documents, orchestratorModel, workflowTemplateId } = parsed.data;

// createGoalFn call (line ~46)
      goal = await deps.createGoalFn({ title, intent, workspaces, documents, orchestratorModel });
```

In `apps/daemon/src/server.ts`, the `/v1/goals/refine` handler (around line 536) passes the parsed request into the refine skill. Confirm it forwards the field by name; if it destructures or references `description`, rename to `intent`. (The skill now reads `GuidedRefinementInput.intent`, so as long as the route passes `parsed.data` straight through, no change is needed there — verify by reading lines 536–552.)

### Orchestrator internal plumbing

- [ ] **Step 10: Rename `goal.description` → `goal.intent` across orchestrator internals**

Apply these exact edits:

```ts
// db-rows.ts — GoalRow (line ~8)
  intent: string;
// db-rows.ts — readGoal SELECT (line ~62)
      "SELECT id, title, intent, orchestrator_provider, orchestrator_model FROM goals WHERE id = ?",

// step-input.ts — both goal inline types (lines ~6 and ~19)
  goal: { id: string; intent: string };

// agent-objective.ts (lines ~7 and ~9)
  ctx: { goal: { intent: string }; stepRun: { id: string } }
  const header = `Workflow step: ${step.name}\nGoal: ${ctx.goal.intent}\n\n`;

// orchestrator-llm/context.ts — OrchestratorContextInput.goal (line ~23)
  goal: { id: string; title: string; intent: string; attachedWorkspaces: WorkspaceRef[]; attachedDocuments: DocumentRef[] };

// orchestrator-llm/build-context.ts — SELECT + cast (lines ~137-138)
    .prepare("SELECT id, title, intent FROM goals WHERE id = ?")
    .get(args.goalId) as { id: string; title: string; intent: string } | undefined;
// build-context.ts — both context objects (lines ~177 and ~199)
        goal: { id: goal.id, title: goal.title, intent: goal.intent, attachedWorkspaces, attachedDocuments },
    goal: { id: goal.id, title: goal.title, intent: goal.intent, attachedWorkspaces: [], attachedDocuments: [] },

// orchestrator-llm/prompts.ts — AgentInitialPromptInput (line ~6)
  goalIntent: string;
// prompts.ts — compose (line ~54)
  const goalIntent = input.goalIntent.trim();
// prompts.ts — body (line ~72) — replace the goalDescription spread
    ...(goalIntent ? ["", goalIntent] : []),

// workflows/orchestrator/service.ts (line ~146)
        intent: input.goal.intent,
// service.ts (lines ~360 and ~1538)
      goal: { id: goal.id, intent: goal.intent },

// workflows/orchestrator/dispatch-engine.ts (line ~425)
      goalIntent: ctx.goal.intent,
// dispatch-engine.ts (lines ~584, ~1807, ~2078)
      goal: { id: goal.id, intent: goal.intent },

// workflows/orchestrator/provider-recovery-controller.ts (line ~333)
          goalIntent: goal.intent,

// workflows/orchestrator/step-result-builder.ts (line ~194)
        goal: { id: ctx.goal.id, intent: ctx.goal.intent },

// orchestrator-chat/usecases.ts (lines ~133 and ~163)
    const usr = JSON.stringify({ goal: { id: goal.id, title: goal.title, intent: goal.intent }, userMessage: parsed.body });
      goal: { id: goal.id, title: goal.title, intent: goal.intent },

// recommendations/input.ts (line ~405)
    objective: goalRow.intent.trim(),
```

For `provider-recovery-controller.ts` and `dispatch-engine.ts`, the `goalIntent`/`goalDescription` key is whatever `composeAgentInitialPrompt` expects — after renaming its input field to `goalIntent` (prompts.ts), every call site must pass `goalIntent:`. Also update any local interface in `provider-recovery-controller.ts` that declared `goalDescription` for the recovery prompt.

For `orchestrator-chat/usecases.ts` line ~43, if there is a local `goal` type with a `description: string` field, rename it to `intent`.

- [ ] **Step 11: Update daemon test fixtures**

Run: `pnpm --filter @orca/daemon typecheck`
Fix every `goalDescription`/`goal.description`/`{ id, description }`-on-goal type error the compiler reports. The known fixture spots (rename `description` → `intent` where the object is a **goal**): `gate-evaluation.test.ts:8`, `refute-completion.test.ts:8`, `step-result-scoring.test.ts:10`, `step-input.test.ts:9,25`. Also update `goals.test.ts` (≈21 references) and any `build-context`/`prompts`/`context` tests that build a goal with `description` or call `composeAgentInitialPrompt({ goalDescription })`.

Do NOT touch `description` on non-goal objects (question `options`, task inputs, artifact `{ reference, description }`, skill descriptors).

- [ ] **Step 12: Run the full daemon suite**

Run: `pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/daemon test`
Expected: PASS (clean typecheck, all tests green).

- [ ] **Step 13: Commit**

```bash
git add apps/daemon
git commit -m "feat(daemon): rename goal description to required intent (migration 0059)"
```

---

## Task 3: Desktop — create flow, goal edit, and detail view

**Files:**
- Modify: `apps/desktop/src/create-goal-flow/state.ts`
- Modify: `apps/desktop/src/create-goal-flow/steps/RoughGoalStep.tsx`
- Modify: `apps/desktop/src/create-goal-flow/CreateGoalFlow.tsx` (lines ~73, ~92)
- Modify: `apps/desktop/src/goal-detail/GoalDetailView.tsx` (lines ~312–313)
- Modify: `apps/desktop/src/App.tsx` (goal-card edit form, lines ~509, 514–516, 520, 530, 532, 578)
- Test: `apps/desktop/src/create-goal-flow/state.test.ts`, `apps/desktop/src/goal-detail/GoalDetailView.test.tsx`, and any `CoordinateStep`/`App` tests the typecheck flags.

**Interfaces:**
- Consumes: `Goal.intent`, `CreateGoalAndStartWorkflowRequest.intent`, `UpdateGoalRequest.intent` from Task 1.
- Produces: flow state field `intent`, action `setIntent`.

Note: `apps/desktop/src/api.ts` needs **no change** — `createGoalAndStartWorkflow`/`updateGoal` call `Schema.parse(input)`, so the rename flows through the contract types; only the objects the callers build change.

- [ ] **Step 1: Write the failing state/gating test**

In `apps/desktop/src/create-goal-flow/state.test.ts`, rename existing `description`/`setDescription` references to `intent`/`setIntent`, and add:

```ts
it("setIntent updates intent in the rough phase", () => {
  const s = reducer(initialState, { type: "setIntent", intent: "Ship it" });
  expect(s.phase).toBe("rough");
  expect((s as Extract<FlowState, { phase: "rough" }>).intent).toBe("Ship it");
});
```

If there is a `RoughGoalStep` test that asserts Proceed gating, add a case that Next is disabled when `intent` is empty and enabled when both title and intent are non-empty. (If no such test exists, rely on the reducer test above plus the browser drive in Task 4.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orca/desktop test -- state.test`
Expected: FAIL — `setIntent` is not a known action; `initialState`/state have no `intent`.

- [ ] **Step 3: Rename in `state.ts`**

In `apps/desktop/src/create-goal-flow/state.ts`, rename `description` → `intent` on every phase state (`RoughState` L25, `CoordinateState` L32, `SubmittingState` L44, `WorkflowFailedState` L61), in `initialState` (L84), the action (L89 `setDescription`→`setIntent`, field `description`→`intent`), the reducer case (L115–119, `case "setDescription"` → `case "setIntent"`, `action.description`→`action.intent`, `description:`→`intent:`), and every phase-transition object that threads `description: state.description` (L126, 140, 230, 249/251, 268, 282 — replace with `intent: state.intent`).

- [ ] **Step 4: Rename in `RoughGoalStep.tsx`**

```tsx
export function RoughGoalStep({ state, dispatch }: Props) {
  const canProceed = state.title.trim().length > 0 && state.intent.trim().length > 0;

  return (
    <div className="flow-step">
      <div className="form-field">
        <label htmlFor="rough-title">Title</label>
        <input
          id="rough-title"
          type="text"
          value={state.title}
          onChange={(e) => dispatch({ type: "setTitle", title: e.target.value })}
          maxLength={200}
          required
          placeholder="What are you trying to achieve?"
          autoFocus
        />
      </div>

      <div className="form-field">
        <label htmlFor="rough-intent">Intent</label>
        <textarea
          id="rough-intent"
          value={state.intent}
          onChange={(e) => dispatch({ type: "setIntent", intent: e.target.value })}
          maxLength={4000}
          required
          placeholder={"What do you want to achieve and why? Describe the outcome, not the steps.\n\nOptionally include sections like:\nGoals:\n  - ...\nConstraints:\n  - ...\nAssumptions:\n  - ..."}
          rows={7}
        />
      </div>

      {state.error && <div className="form-error">{state.error}</div>}

      <div className="flow-step-actions">
        <button
          type="button"
          className="submit-button"
          onClick={() => dispatch({ type: "proceedToCoordinate" })}
          disabled={!canProceed}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Rename in `CreateGoalFlow.tsx`**

```tsx
// destructure (line ~73)
    const {
      title,
      intent,
      pendingWorkspaces,
      pendingDocuments,
      orchestratorModel,
      workflowTemplateId,
    } = state;

// createGoalAndStartWorkflow call (line ~92)
        const result = await createGoalAndStartWorkflow({
          title,
          intent,
          ...
```

- [ ] **Step 6: Rename in `GoalDetailView.tsx`**

```tsx
// lines ~312-313
        {goal.intent && (
          <p className="goal-detail-description">{goal.intent}</p>
        )}
```

(Keep the `goal-detail-description` CSS class name — it's an unrelated style hook, and renaming CSS is out of scope.)

- [ ] **Step 7: Rename in `App.tsx` goal-card edit form**

```tsx
// state (line ~509)
  const [editIntent, setEditIntent] = useState(goal.intent);

// truncated (lines ~514-516)
  const truncated =
    goal.intent.length > MAX_DESC
      ? goal.intent.slice(0, MAX_DESC) + "…"
      : goal.intent;

// startEdit (line ~520)
    setEditIntent(goal.intent);

// saveEdit patch (lines ~530-532)
      const patch: { title?: string; intent?: string } = {};
      if (editTitle !== goal.title) patch.title = editTitle;
      if (editIntent !== goal.intent) patch.intent = editIntent;
      if (patch.title === undefined && patch.intent === undefined) {

// label + textarea (lines ~578-586)
          <label htmlFor={`gc-intent-${goal.id}`}>Intent</label>
          <textarea
            id={`gc-intent-${goal.id}`}
            value={editIntent}
            onChange={(e) => setEditIntent(e.target.value)}
            maxLength={4000}
            rows={3}
            disabled={busy}
          />
```

- [ ] **Step 8: Run desktop typecheck + tests**

Run: `pnpm --filter @orca/desktop typecheck && pnpm --filter @orca/desktop test`
Fix any remaining `goal.description`/`description`-on-goal references the compiler flags (e.g. `GoalDetailView.test.tsx` fixtures building a `Goal` with `description`).
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): required Intent field in goal create/edit flows"
```

---

## Task 4: Full-repo verification

**Files:** none (verification only).

- [ ] **Step 1: Sweep for any missed goal-`description` references**

Run:
```bash
grep -rn "goalDescription\|goal\.description\|goal: { id[^}]*description" apps packages --include=*.ts --include=*.tsx | grep -v node_modules
```
Expected: no matches. Any hit is a missed rename — fix it (verify it refers to a **goal**, not a task/workspace/skill/option `description`).

- [ ] **Step 2: Full typecheck + test**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: PASS across contracts, daemon, and desktop.

- [ ] **Step 3: Drive the create-goal flow in a browser**

Start the browser proxy: `pnpm dev:browser` and open the printed Local URL. Using the app:
1. Open the create-goal flow. Confirm the second field is labeled **Intent** with the new placeholder, and **Next →** is disabled until both Title and Intent are non-empty.
2. Enter a title + intent, proceed, pick a workspace/template, and submit. Confirm the goal is created and a workflow starts (no validation error).
3. Open the created goal's detail view and confirm the intent prose renders.
4. From the goals list, edit a goal; confirm the edit form shows **Intent**, and saving a changed intent persists (round-trips via `updateGoal`).

Expected: all four behave correctly. If the daemon rejects creation, check that the desktop is sending `intent` (network tab) and the daemon migration `0059` has been applied to the live DB (a running daemon auto-applies pending migrations on restart).

- [ ] **Step 4: Final commit (if the sweep or browser drive required fixes)**

```bash
git add -A
git commit -m "fix: resolve residual goal description references after intent rename"
```
