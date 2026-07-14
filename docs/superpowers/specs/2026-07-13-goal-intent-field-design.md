# Design: Replace optional goal `description` with required `intent`

**Date:** 2026-07-13
**Status:** Approved (pending spec review)

## Summary

Goal creation today has an optional free-text `description` field. This field is
not merely a label — it is the goal's prose substance that flows downstream as:

- the agent's stated objective (`agent-objective.ts`: `Goal: ${ctx.goal.description}`),
- the orchestrator LLM prompt body (`composeAgentInitialPrompt`),
- the context-assembly objective section, and
- the recommendations `objective`.

This change **renames** `description` to `intent` everywhere and makes it
**required** (non-empty). Semantically it plays the exact same role — the goal's
prose, relabeled "Intent" in the UI and now mandatory. This is a wide but
mechanical rename; the risk is a missed reference, not conceptual complexity.

### Decisions locked in

- **Rename, not alias.** The internal `Goal` domain field becomes `intent`. No
  `description` compatibility alias is kept — this is an internal, local-first app.
- **No backfill.** Existing goals with empty `description` values keep them. The
  non-empty requirement is enforced at creation going forward, not retroactively.
- **DB rename, not add+drop.** A single `ALTER TABLE goals RENAME COLUMN`
  preserves all existing goal data. Verified: no view/index/trigger/FTS references
  `goals.description`, and better-sqlite3 bundles SQLite 3.25+ (RENAME COLUMN
  supported).

## Contract changes — `packages/contracts/src/index.ts`

| Schema | Before | After |
|---|---|---|
| `Goal` | `description: z.string()` | `intent: z.string()` (still required) |
| `CreateGoalRequest` | `description: z.string().max(4000).default("")` | `intent: z.string().min(1).max(4000)` |
| `CreateGoalAndStartWorkflowRequest` | `description: z.string().max(4000).default("")` | `intent: z.string().min(1).max(4000)` |
| `GuidedRefinementInput` | `description: z.string().max(4000).default("")` | `intent: z.string().max(4000).default("")` |
| `GuidedRefinementOutput` | `description: z.string().max(4000)` | `intent: z.string().max(4000)` |
| `UpdateGoalRequest` | `description: z.string().max(4000).optional()` | `intent: z.string().max(4000).optional()` |

Notes:
- Dropping `.default("")` and adding `.min(1)` on the create requests is what makes
  intent server-side-required (empty string now fails validation).
- `UpdateGoalRequest` keeps `intent` optional; its existing `.refine(...)` "at least
  one of" check now references `title`/`intent`.
- `GuidedRefinementInput` keeps `.default("")` — refinement is a pre-goal path where
  the user may not yet have prose; the required floor is enforced at goal creation.

## DB migration — new `apps/daemon/migrations/0059_goal_intent_rename.sql`

```sql
ALTER TABLE goals RENAME COLUMN description TO intent;
```

- Preserves all existing rows and their values.
- Legacy empty-string values are left as-is (see "No backfill").

## Daemon changes — `apps/daemon/src/`

- **`goals.ts`**: rename in `GoalRow`, `rowToGoal`, INSERT and UPDATE SQL, the
  `CreateGoalInput` type, `GoalOrigin` type, `resolveGoalOrigin`, `createGoal`,
  `updateGoal`, and the `goal.created` / `goal.updated` event payload fields.
- **`skills/quick-goal.ts`**: read/normalize `intent`; throw `ValidationError` on
  empty-after-trim (new non-empty enforcement) in addition to the existing 4000 cap.
- **`skills/guided-goal-refinement.ts`**: rename field references.
- **`goals/bootstrap-route.ts`**: rename `createGoalFn` input field + destructuring.

## Downstream consumers — mechanical `.description` → `.intent`

- **`orchestrator-llm/prompts.ts`**: `composeAgentInitialPrompt` param
  `goalDescription` → `goalIntent`.
- **`orchestrator-llm/build-context.ts`**: `SELECT id, title, description` →
  `... intent`; assembled context field `description` → `intent`.
- **`workflows/orchestrator/`**: `dispatch-engine.ts`, `agent-objective.ts`,
  `service.ts`, `step-result-builder.ts`, `provider-recovery-controller.ts` —
  all `goal.description` reads and `goalDescription` args.
- **`orchestrator-chat/usecases.ts`**: `goal: { id, title, description }` payload.
- **`recommendations/input.ts`**: `objective: goalRow.description.trim()` →
  `goalRow.intent.trim()`.
- **Unaffected:** the `objective`-string pathway in `context/{usecases,
  deterministic-assembler}.ts` — it never named the field; the caller-supplied
  `objective` string is what changes at its source (the goal's `intent`).

## Desktop changes — `apps/desktop/src/`

- **`create-goal-flow/state.ts`**: rename `description` → `intent` across all phase
  states (`RoughState`, `CoordinateState`, `SubmittingState`, `WorkflowFailedState`),
  `initialState`, the `setDescription` → `setIntent` action + reducer case, and all
  phase-transition threading.
- **`create-goal-flow/steps/RoughGoalStep.tsx`**: label "Intent", `required`,
  and guiding placeholder:
  > *"What do you want to achieve and why? Describe the outcome, not the steps."*

  Keep the existing Goals/Constraints/Assumptions structured hints as secondary
  help text. Wire `canProceed` to also gate on `intent.trim().length > 0`.
- **`create-goal-flow/CreateGoalFlow.tsx`** + **`api.ts`**: submit `intent`.

## Testing

Update existing suites referencing the field: `goals.test.ts`, `prompts.test.ts`,
`build-context.test.ts`, `migrations.test.ts`, `context.test.ts`,
`create-goal-flow/state.test.ts`, `steps/CoordinateStep.test.tsx`,
`packages/contracts/src/index.test.ts`, and any others surfaced by a full-repo sweep.

New tests:
1. **Contract**: `CreateGoalRequest` / `CreateGoalAndStartWorkflowRequest` reject
   empty and missing `intent`; accept a valid non-empty value.
2. **Migration**: `0059` renames the column and preserves an existing row's value
   (insert with `description`, run migration, read back as `intent`).
3. **Desktop**: Proceed is gated (disabled) until `intent` is non-empty, in the
   `state` reducer / `RoughGoalStep` test.

## Verification

- `description` sweep: `grep -rn "description" apps packages | grep -i goal` returns
  no goal-related hits after the change (only unrelated tables: agents, workflows,
  tasks, workspaces, suggested_orchestration).
- Typecheck + full test suite green.
- Drive the create-goal flow in the browser (`pnpm dev:browser`): intent required,
  Proceed gated, goal creates and starts a workflow with the intent as objective.
