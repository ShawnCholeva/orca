# Phase 4 — Stream 0 (provider rename) + Stream 1 (conversational surface) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OrcaChat conversational surface consume the harness activity facet *directly* — replacing the synthetic mark-done affordance, the synthetic orchestrator routing card, and unthrottled reasoning notes — and rename the now-misnamed `ShadowProvider` seam to `AgentProvider`.

**Architecture:** The daemon already owns a first-class, persisted `activities` table (one updating row per agent turn, projected to the `Activity` read-model and streamed to clients). Today three OrcaChat affordances bypass it: (1) "approve to complete the run" is computed in React from step state + a side `listRecommendations` fetch; (2) the splitter routing confirmation card is synthesized in the dispatch engine with `agentSessionId: null`; (3) reasoning notes append to the activity stream with no throttle, and the idle conversational `RoutingCard` is hardcoded JSX. This stream routes all three through the persisted activity facet so the client renders a projection and sends commands — no orchestration logic in the client. Stream 0 is a pure mechanical symbol rename done first so it doesn't collide with the edits to `service.ts`/`server.ts` in Stream 1.

**Tech Stack:** TypeScript; daemon = Node + better-sqlite3 + Fastify + Vitest; contracts = Zod + Vitest; desktop = Tauri + React + Vitest + @testing-library/react (happy-dom). No E2E/Tauri-integration coverage exists — Tauri-native behavior is manual-only.

## Global Constraints

- **One seam per commit.** Each task ends with a commit. Commit messages: `feat(phase-4): …` / `refactor(phase-4): …` / `test(phase-4): …`.
- **TDD.** Write the failing test first, run it, watch it fail, then implement. Daemon/contract logic always gets a red→green test. Desktop component behavior gets an RTL test; Tauri-native bits (file open) are manual-only and called out.
- **Append-only event spine + projections.** Clients render projections and send commands; never add orchestration logic to the desktop app.
- **Surgical changes.** Touch only what each task requires. Do not reformat or "improve" adjacent code. Match existing style.
- **Done-marker legend** (for FUTURE_WORK.md updates): ✅ done · 🟡 deferred-by-decision · 🔴 blocked · ⚪ non-change. **There is no 🟢.**
- **Daemon test harness pattern** (copy verbatim where a test needs a DB):
  ```ts
  import Database from "better-sqlite3";
  import { defaultMigrationsDir, runMigrations } from "../migrations.js";
  // in beforeEach:
  db = new Database(":memory:");
  runMigrations(db, defaultMigrationsDir());
  ```
- **Commands** (run from repo root):
  - daemon test (one file): `pnpm --filter @orca/daemon test -- <relative/path.test.ts>`
  - contracts test (one file): `pnpm --filter @orca/contracts test -- <relative/path.test.ts>`
  - desktop test (one file): `pnpm --filter @orca/desktop test -- <relative/path.test.tsx>`
  - typecheck: `pnpm --filter @orca/<pkg> typecheck` (`@orca/daemon` / `@orca/contracts` / `@orca/desktop`)
- **Known flakes** (ignore if they fail only under parallel load, pass in isolation): `http-surface.test.ts`, `human-review.test.ts`.

---

## Task R1: Rename `ShadowProvider` → `AgentProvider` (Stream 0)

Pure mechanical symbol rename. Verified scope: 17 files, all under `apps/daemon/src`, zero contract/DB/wire impact (the adapter id string type `ShadowAdapterId` and the literal ids `"claude-code"`/`"codex"`/`"antigravity"` are **separate** and do **not** change). Do this first so it doesn't conflict with Stream 1's edits to `service.ts`/`server.ts`.

**Files (all under `apps/daemon/src`, modify):**
- `orchestrator-llm/providers/types.ts` (interface definition at `:81`; doc-comment "future: rename to AgentProvider" at `:92-93`)
- `orchestrator-llm/providers/registry.ts` (`resolveShadowProvider` at `:12`)
- `orchestrator-llm/providers/{antigravity,claude,codex,hook-contract}.ts`
- `orchestrator-llm/shadow-session.ts`
- `server.ts`, `workflows/orchestrator/service.ts`
- tests: `orchestrator-llm/providers/{worker-hook-config,permission-rule,registry,antigravity,hook-contract.conformance,hook-contract-declarations,telemetry-env}.test.ts`, `workflows/orchestrator/worker-session.test.ts`

**Interfaces:**
- Produces: `AgentProvider` (was `ShadowProvider`), `resolveAgentProvider` (was `resolveShadowProvider`), and the concrete class names `ClaudeAgentProvider` / `CodexAgentProvider` / `AntigravityAgentProvider` (were `*ShadowProvider`). Stream 1 does not consume these, so no cross-task coupling.

- [ ] **Step 1: Confirm the exact symbol set before renaming**

Run: `grep -rn "ShadowProvider\|resolveShadowProvider\|ClaudeShadowProvider\|CodexShadowProvider\|AntigravityShadowProvider" apps/daemon/src | wc -l`
Expected: a non-zero count (the symbols to rename). Note the number; you will re-run after to confirm it reaches 0.

- [ ] **Step 2: Verify the test baseline is green first**

Run: `pnpm --filter @orca/daemon test -- orchestrator-llm/providers/registry.test.ts`
Expected: PASS (establishes the pre-rename baseline so a post-rename failure is attributable to the rename).

- [ ] **Step 3: Rename the interface and the resolver, then the concrete classes**

Mechanical rename across the 17 files. `ShadowProvider` → `AgentProvider`; `resolveShadowProvider` → `resolveAgentProvider`; `ClaudeShadowProvider` → `ClaudeAgentProvider`; `CodexShadowProvider` → `CodexAgentProvider`; `AntigravityShadowProvider` → `AntigravityAgentProvider`. Do **not** touch `ShadowAdapterId`, `ShadowSession*`, `shadow-session.ts`'s `ShadowSession` class, `shadow-hooks`, or any string literal — only the five symbols above.

Use a guarded sed (word-boundary, scoped to src), longest names first to avoid partial overlaps:
```bash
cd /Users/shawncholeva/projects/orca
for sym in ClaudeShadowProvider CodexShadowProvider AntigravityShadowProvider resolveShadowProvider ShadowProvider; do
  new=${sym/Shadow/Agent}
  grep -rl "\b$sym\b" apps/daemon/src | while read -r f; do
    perl -pi -e "s/\\b$sym\\b/$new/g" "$f"
  done
done
```
Update the doc-comment at `types.ts:92-93` so it no longer says "future: rename to AgentProvider" (the rename is now done) — change it to describe the seam as the generalized agent-provider contract.

- [ ] **Step 4: Confirm zero stragglers and that the adapter-id type is untouched**

Run: `grep -rn "ShadowProvider\|resolveShadowProvider" apps/daemon/src | wc -l`
Expected: `0`.
Run: `grep -rn "ShadowAdapterId" apps/daemon/src | wc -l`
Expected: unchanged non-zero (proves the id type was not swept).

- [ ] **Step 5: Typecheck + full provider test suite**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: PASS (no unresolved symbols).
Run: `pnpm --filter @orca/daemon test -- orchestrator-llm/providers`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src
git commit -m "refactor(phase-4): rename ShadowProvider seam to AgentProvider (item 5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task M1: Mark-done facet — contract `sourceKind` + `recommendationId` (item 1)

Add the activity vocabulary the persisted mark-done card needs: a new `ActivitySourceKind` value and a `recommendationId` field on `Activity` so the card carries the `complete_workflow_run` recommendation id (eliminating the client's side `listRecommendations` fetch).

**Files:**
- Modify: `packages/contracts/src/index.ts` (`ActivitySourceKind` enum at `:1194-1208`; `Activity` object at `:1279-1303`)
- Test: `packages/contracts/src/__tests__/activity-contracts.test.ts`

**Interfaces:**
- Produces: `ActivitySourceKind` now includes `"mark_done_pending"`; `Activity` now has optional `recommendationId?: string`.
- Consumed by: Task M2 (store), M3 (dispatch), M4 (desktop).

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/__tests__/activity-contracts.test.ts`:
```ts
import { Activity, ActivitySourceKind } from "../index.js";

it("accepts the mark_done_pending source kind", () => {
  expect(ActivitySourceKind.parse("mark_done_pending")).toBe("mark_done_pending");
});

it("carries an optional recommendationId for the mark-done card", () => {
  const a = Activity.parse({
    id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1",
    agentSessionId: null, turnOrdinal: 0, status: "paused_for_input",
    currentText: "Approve to complete the run.", finalSummary: null,
    sourceKind: "mark_done_pending", workCategory: null, confidence: null,
    recommendationId: "rec-1",
    createdAt: "t", updatedAt: "t", completedAt: null, steps: [],
  });
  expect(a.recommendationId).toBe("rec-1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test -- __tests__/activity-contracts.test.ts`
Expected: FAIL — `ActivitySourceKind.parse("mark_done_pending")` throws (invalid enum value) and `Activity.parse` rejects the unknown `recommendationId` key (the object is `.strict()`).

- [ ] **Step 3: Implement — extend the enum and the object**

In `packages/contracts/src/index.ts`, add to the `ActivitySourceKind` enum (after `"gate_decision"` at `:1207`):
```ts
  // A workflow run whose final step produced output and is awaiting the
  // human's approve-to-complete decision (live, persisted so it survives a
  // daemon restart and the chat rebuilds the affordance from activities alone).
  "mark_done_pending",
```
In the `Activity` object (alongside `pendingQuestion`/`stepName` optional fields, ~`:1294`):
```ts
    recommendationId: z.string().optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test -- __tests__/activity-contracts.test.ts`
Expected: PASS.
Run: `pnpm --filter @orca/contracts typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src
git commit -m "feat(phase-4): add mark_done_pending source kind + activity recommendationId (item 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task M2: Mark-done facet — DB column + store helpers (item 1)

Add the `recommendation_id` column and two store helpers that mirror the existing gate-decision precedent (`pauseForGateDecision`/`resolveGateDecisionActivity` at `store.ts:385-440`): `pauseForMarkDone` creates a persisted `mark_done_pending` row carrying the rec id; `resolveMarkDoneActivity` completes it on approval. Also project the new column.

**Files:**
- Create: `apps/daemon/migrations/0043_activity_recommendation_id.sql`
- Modify: `apps/daemon/src/activities/store.ts` (add helpers; add `recommendation_id` to the `ActivityRow` type and to `openOrUpdateLive`'s INSERT/UPDATE is **not** needed — only the two new helpers write/read it)
- Modify: `apps/daemon/src/activities/projection.ts` (`rowToActivity` at `:59-84`; `ActivityRow` type)
- Test: `apps/daemon/src/activities/store.test.ts`, `apps/daemon/src/activities/projection.test.ts`

**Interfaces:**
- Consumes: `ActivitySourceKind` `"mark_done_pending"` + `Activity.recommendationId` (Task M1).
- Produces:
  - `pauseForMarkDone(ctx: ActivityStoreCtx, input: { goalId: string; workflowRunId: string; stepRunId: string; recommendationId: string }): ActivityT`
  - `resolveMarkDoneActivity(ctx: ActivityStoreCtx, input: { stepRunId: string }): ActivityT | undefined`
  - projection now sets `recommendationId` on activities whose `recommendation_id` column is non-null.

- [ ] **Step 1: Write the migration**

Create `apps/daemon/migrations/0043_activity_recommendation_id.sql`:
```sql
-- 0043_activity_recommendation_id.sql
-- The mark-done activity (sourceKind mark_done_pending) carries the
-- complete_workflow_run recommendation id so the chat can render and accept the
-- approve-to-complete affordance straight from the activities projection — no
-- separate recommendations fetch. Nullable; only mark_done_pending rows set it.
ALTER TABLE activities ADD COLUMN recommendation_id TEXT;
```

- [ ] **Step 2: Write the failing store test**

Append to `apps/daemon/src/activities/store.test.ts` (it already has `ctxFor`/`seedGoal`/in-memory-db setup):
```ts
import { pauseForMarkDone, resolveMarkDoneActivity, getLiveForStepRun } from "./store.js";

it("pauseForMarkDone persists a mark_done_pending row carrying the rec id", () => {
  const { ctx } = ctxFor(db);
  const a = pauseForMarkDone(ctx, {
    goalId: "g1", workflowRunId: "r1", stepRunId: "s1", recommendationId: "rec-9",
  });
  expect(a.sourceKind).toBe("mark_done_pending");
  expect(a.status).toBe("paused_for_input");
  expect(a.recommendationId).toBe("rec-9");
  // idempotent re-park returns the same row
  const again = pauseForMarkDone(ctx, {
    goalId: "g1", workflowRunId: "r1", stepRunId: "s1", recommendationId: "rec-9",
  });
  expect(again.id).toBe(a.id);
});

it("resolveMarkDoneActivity completes the parked mark-done row", () => {
  const { ctx } = ctxFor(db);
  pauseForMarkDone(ctx, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", recommendationId: "rec-9" });
  const done = resolveMarkDoneActivity(ctx, { stepRunId: "s1" });
  expect(done?.status).toBe("completed");
  expect(getLiveForStepRun(db, "s1")).toBeUndefined();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- activities/store.test.ts`
Expected: FAIL — `pauseForMarkDone`/`resolveMarkDoneActivity` are not exported.

- [ ] **Step 4: Implement the two helpers**

In `apps/daemon/src/activities/store.ts`, add after `resolveGateDecisionActivity` (mirror `pauseForGateDecision` at `:389-418` and `resolveGateDecisionActivity` at `:422-440`, but write/keep the rec id and use sourceKind `mark_done_pending`):
```ts
// Open (or reuse) a persisted mark-done activity awaiting the human's
// approve-to-complete decision. Its own row (sourceKind mark_done_pending,
// status paused_for_input) carries the complete_workflow_run recommendation id
// so the chat rebuilds the affordance from the activities list alone.
export function pauseForMarkDone(
  ctx: ActivityStoreCtx,
  input: { goalId: string; workflowRunId: string; stepRunId: string; recommendationId: string }
): ActivityT {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const now = currentTime(ctx);
    const existing = getLiveForStepRun(ctx.db, input.stepRunId);
    if (existing?.sourceKind === "mark_done_pending") return existing; // idempotent re-park
    const id = nextActivityId(ctx);
    const turnOrdinal = nextTurnOrdinal(ctx.db, input.stepRunId);
    const text = "Final step output produced — approve to complete the run.";
    ctx.db
      .prepare(
        `INSERT INTO activities (
           id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
           status, current_text, final_summary, source_kind, work_category, confidence,
           pending_question, recommendation_id, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, NULL, ?, 'paused_for_input', ?, NULL, 'mark_done_pending', NULL, NULL, NULL, ?, ?, ?, NULL)`
      )
      .run(id, input.goalId, input.workflowRunId, input.stepRunId, turnOrdinal, text, input.recommendationId, now, now);
    const inserted = getActivityById(ctx.db, id);
    if (inserted === undefined) throw new Error(`Activity insert failed: ${id}`);
    event = insertActivityChangedEvent(ctx.db, inserted, now);
    return inserted;
  })();
  publishActivityChanged(ctx, event);
  return activity;
}

// Resolve the parked mark-done activity into a completed record once the user
// approves run completion, so it stays in the thread.
export function resolveMarkDoneActivity(
  ctx: ActivityStoreCtx,
  input: { stepRunId: string }
): ActivityT | undefined {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const live = getLiveForStepRun(ctx.db, input.stepRunId);
    if (live === undefined || live.sourceKind !== "mark_done_pending") return undefined;
    const now = currentTime(ctx);
    const summary = "Approved — completing the run.";
    ctx.db
      .prepare(
        `UPDATE activities
         SET status = 'completed', current_text = ?, final_summary = ?,
             completed_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(summary, summary, now, now, live.id);
    const resolved = getActivityById(ctx.db, live.id);
    if (resolved === undefined) throw new Error(`Activity disappeared: ${live.id}`);
    event = insertActivityChangedEvent(ctx.db, resolved, now);
    return resolved;
  })();
  publishActivityChanged(ctx, event);
  return activity;
}
```
> Note: the existing `INSERT` statements in this file do not list `recommendation_id`; SQLite leaves it NULL for them, which is correct. Only `pauseForMarkDone` sets it.

- [ ] **Step 5: Project the new column**

In `apps/daemon/src/activities/projection.ts`: add `recommendation_id: string | null;` to the `ActivityRow` type, add `sr.recommendation_id`-style selection is **not** needed (the activities SELECT is `SELECT *`-equivalent — confirm the row query already selects all columns; if it lists columns explicitly, add `recommendation_id`). Then in `rowToActivity` (`:65-83`), add alongside the `pendingQuestion` conditional spread:
```ts
      ...(row.recommendation_id !== null ? { recommendationId: row.recommendation_id } : {}),
```

- [ ] **Step 6: Write + run the projection test**

Append to `apps/daemon/src/activities/projection.test.ts` a case that inserts a `mark_done_pending` row via `pauseForMarkDone` and asserts the projected `Activity.recommendationId` round-trips:
```ts
it("projects recommendationId for mark_done_pending activities", () => {
  const { ctx } = ctxFor(db); // use this file's existing ctx/seed helpers
  pauseForMarkDone(ctx, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", recommendationId: "rec-7" });
  const list = listActivitiesForGoal(db, "g1"); // use this file's existing projection entry point
  const mark = list.find((a) => a.sourceKind === "mark_done_pending");
  expect(mark?.recommendationId).toBe("rec-7");
});
```
> Adapt the import names (`ctxFor`, the projection list function) to those already used in `projection.test.ts`.

Run: `pnpm --filter @orca/daemon test -- activities/store.test.ts activities/projection.test.ts`
Expected: PASS.
Run: `pnpm --filter @orca/daemon typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/migrations apps/daemon/src/activities
git commit -m "feat(phase-4): persist mark-done activity carrying the rec id (item 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task M3: Mark-done facet — dispatch wiring + resolve-on-accept (item 1)

Write the `mark_done_pending` activity when the terminal step produces the `complete_workflow_run` recommendation, and resolve it when the recommendation is accepted.

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts` (after the rec is created + staged events published, ~`:1088-1099`)
- Modify: `apps/daemon/src/recommendations/usecases.ts` (the accept-of-`complete_workflow_run` block at `:554-572`)
- Test: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts` (or the dispatch/recommendations test that already drives a run to its terminal step — pick the one that exercises `complete_workflow_run`)

**Interfaces:**
- Consumes: `pauseForMarkDone`, `resolveMarkDoneActivity` (Task M2); the IIFE result `{ decision, recommendationIds }` already returned at `dispatch-engine.ts:1088`.

- [ ] **Step 1: Write the failing test**

In the test that drives a run to completion (where a `complete_workflow_run` recommendation is asserted today), add assertions that a `mark_done_pending` activity exists carrying that rec id, and that accepting the recommendation flips it to `completed`. Sketch (bind to the file's existing run-driving helpers):
```ts
it("persists a mark_done_pending activity with the rec id, resolved on accept", async () => {
  // ... drive run to terminal step so complete_workflow_run rec is produced ...
  const acts = listActivitiesForGoal(db, goalId);
  const pending = acts.find((a) => a.sourceKind === "mark_done_pending");
  expect(pending).toBeDefined();
  expect(pending?.recommendationId).toBe(recId);

  // ... accept the recommendation (the usecase under test) ...
  const after = listActivitiesForGoal(db, goalId).find((a) => a.sourceKind === "mark_done_pending");
  expect(after?.status).toBe("completed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- workflows/orchestrator/service.agent-step.test.ts`
Expected: FAIL — no `mark_done_pending` activity is produced today.

- [ ] **Step 3: Implement — write the activity in dispatch-engine**

In `dispatch-engine.ts`, immediately after `publishStaged(options.bus, stagedEvents);` (`:1090`) for the terminal-completion branch, add (the IIFE at `:1043-1089` returns `{ decision, recommendationIds }`; capture it if it is not already assigned — e.g. `const completion = db.transaction(() => { … })();`):
```ts
    const markDoneRecId = completion.recommendationIds[0];
    if (markDoneRecId !== undefined) {
      pauseForMarkDone(
        { db, bus: options.bus ?? new EventBus() },
        { goalId: goal.id, workflowRunId: run.id, stepRunId: stepRun.id, recommendationId: markDoneRecId }
      );
    }
```
Add `pauseForMarkDone` to the existing import from `../../activities/store.js` at `:57`.

- [ ] **Step 4: Implement — resolve on accept**

In `apps/daemon/src/recommendations/usecases.ts`, inside the `if (action === "accept" && rec.proposedAction.kind === "complete_workflow_run")` block (`:554`), after the `emitMarkDone(...)` call (`:565-568`) and still inside the `try`, add:
```ts
        resolveMarkDoneActivity(
          { db, bus, now: () => now, idFactory: idFn },
          { stepRunId: rec.proposedAction.workflowStepRunId }
        );
```
Add `resolveMarkDoneActivity` to the imports from the activities store. (`rec.proposedAction.workflowStepRunId` is the terminal step run id set at `dispatch-engine.ts:1081`.)

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @orca/daemon test -- workflows/orchestrator/service.agent-step.test.ts`
Expected: PASS.
Run: `pnpm --filter @orca/daemon typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/dispatch-engine.ts apps/daemon/src/recommendations/usecases.ts apps/daemon/src/workflows
git commit -m "feat(phase-4): emit + resolve the mark-done activity around run completion (item 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task M4: Mark-done facet — desktop derives from the activity stream (item 1)

Replace the synthetic `awaitingApproval` computation and the side `listRecommendations` fetch with derivation from the `mark_done_pending` activity already in the activities list. The approve action (`acceptRecommendation(completionRecId, {})` → tracker `onApprove`) is unchanged — only the *source* of `awaitingApproval` + `completionRecId` changes.

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx` — remove `completionRecId` `useState` (`:126`), the synthetic `awaitingApproval` (`:587-590`), and the `listRecommendations` effect (`:593-625`); derive both from the activities array that already feeds `timeline`.
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

**Interfaces:**
- Consumes: `Activity.sourceKind === "mark_done_pending"` + `Activity.recommendationId` (Tasks M1–M3).

- [ ] **Step 1: Write the failing test**

Add to `OrcaChat.test.tsx` (using the existing `listActivitiesMock` + `acceptRecommendationMock` from the top-of-file mock block). The activities fixture includes a `mark_done_pending` row; assert the approve affordance appears and that accepting calls `acceptRecommendation` with the activity's `recommendationId` — and that **`listRecommendations` is never called** for completion:
```ts
it("derives the approve-to-complete affordance from the mark_done_pending activity", async () => {
  listActivitiesMock.mockResolvedValue({ items: [{
    id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1",
    agentSessionId: null, turnOrdinal: 0, status: "paused_for_input",
    currentText: "Approve to complete the run.", finalSummary: null,
    sourceKind: "mark_done_pending", workCategory: null, confidence: null,
    recommendationId: "rec-42", createdAt: "t", updatedAt: "t", completedAt: null, steps: [],
  }] });
  // ... render OrcaChat with the same prop/mocks scaffold the other tests use ...
  const approve = await screen.findByRole("button", { name: /approve/i });
  fireEvent.click(approve);
  await waitFor(() => expect(acceptRecommendationMock).toHaveBeenCalledWith("rec-42", {}));
  expect(listRecommendationsMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- orchestrator/OrcaChat.test.tsx`
Expected: FAIL — today `completionRecId` comes from `listRecommendations`, so either the assertion that `listRecommendations` is not called fails, or the rec id is not derived from the activity.

- [ ] **Step 3: Implement — derive from activities, delete the fetch**

In `OrcaChat.tsx`:
1. Delete the `const [completionRecId, setCompletionRecId] = useState<string | null>(null);` line (`:126`).
2. Delete the synthetic `awaitingApproval` block (`:587-590`).
3. Delete the entire `listRecommendations` effect (`:593-625`).
4. Where those values are needed (above the tracker render that uses `completionRecId`/`awaitingApproval`), derive them from the activities array that builds `timeline` (the same list mapped at `:956`):
```tsx
  const markDonePending = activities.find(
    (a) => a.sourceKind === "mark_done_pending" && a.status === "paused_for_input",
  );
  const awaitingApproval = markDonePending != null;
  const completionRecId = markDonePending?.recommendationId ?? null;
```
> Bind `activities` to the actual state variable the component already holds (the array `timeline`/`entry.activity` is derived from). Remove the now-unused `listRecommendations` import from `../api` (`:30`) only if no other call site remains — confirm with `grep -n listRecommendations OrcaChat.tsx`.

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @orca/desktop test -- orchestrator/OrcaChat.test.tsx`
Expected: PASS.
Run: `pnpm --filter @orca/desktop typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(phase-4): derive approve-to-complete from the mark-done activity (item 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task T1: Throttle reasoning notes (item 3 — the "fix once" core)

`tool_use` signals are throttled per `(step, category)` via `ACTIVITY_THROTTLE_MS` (`updater.ts:42-63`), but `reasoning_note` appends unconditionally (`updater.ts:108-121`), so a burst of assistant text blocks floods `activity_steps`. Gate `reasoning_note` with the same per-step time window. This is the single fix point the orchestrator-reasoning wiring (Task O1) also routes through.

**Files:**
- Modify: `apps/daemon/src/activities/updater.ts` (the `reasoning_note` case at `:108-121`; reuse the `perStep` `StepState.lastUpdateMs`)
- Test: `apps/daemon/src/activities/updater.test.ts`

**Interfaces:**
- Consumes: `ACTIVITY_THROTTLE_MS` (already imported), the existing `perStep` map + `StepState`.
- Produces: reasoning notes within `ACTIVITY_THROTTLE_MS` of the prior activity for that step are dropped.

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/activities/updater.test.ts` (use its existing in-memory-db + `ActivityUpdater` setup; the updater takes an injectable `nowMs`):
```ts
it("throttles reasoning notes within ACTIVITY_THROTTLE_MS for a step", () => {
  let t = 0;
  const updater = new ActivityUpdater(() => t);
  // open a live step so notes have a row to attach to
  updater.apply(ctx, { kind: "step_started", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: "sess", stepName: "S" });
  updater.apply(ctx, { kind: "reasoning_note", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: "sess", text: "first thought" });
  t = 1000; // < ACTIVITY_THROTTLE_MS (3000)
  updater.apply(ctx, { kind: "reasoning_note", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: "sess", text: "second thought (throttled)" });
  t = 4000; // > ACTIVITY_THROTTLE_MS since the first note
  updater.apply(ctx, { kind: "reasoning_note", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: "sess", text: "third thought" });
  const live = getLiveForStepRun(db, "s1");
  const steps = loadStepsForActivity(db, live!.id); // use this file's existing step-loading helper
  const noteTexts = steps.map((s) => s.text);
  expect(noteTexts).toContain("first thought");
  expect(noteTexts).not.toContain("second thought (throttled)");
  expect(noteTexts).toContain("third thought");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- activities/updater.test.ts`
Expected: FAIL — "second thought (throttled)" is present (no throttle today).

- [ ] **Step 3: Implement the throttle**

Replace the `reasoning_note` case body in `apps/daemon/src/activities/updater.ts` (`:108-121`) with a per-step time gate that reuses `perStep.lastUpdateMs`:
```ts
      case "reasoning_note": {
        const text = signal.text.trim();
        if (text.length === 0) return;
        const now = this.nowMs();
        const state = this.perStep.get(signal.stepRunId);
        if (state !== undefined && now - state.lastUpdateMs < ACTIVITY_THROTTLE_MS) {
          return;
        }
        appendActivityStep(ctx, {
          goalId: signal.goalId,
          workflowRunId: signal.workflowRunId,
          stepRunId: signal.stepRunId,
          agentSessionId: signal.agentSessionId,
          text,
          category: "other",
          diff: null,
        });
        this.perStep.set(signal.stepRunId, { lastUpdateMs: now, lastCategory: state?.lastCategory ?? null });
        return;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- activities/updater.test.ts`
Expected: PASS.
Run: `pnpm --filter @orca/daemon typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/activities/updater.ts apps/daemon/src/activities/updater.test.ts
git commit -m "feat(phase-4): throttle reasoning notes per step (item 3, fix once)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task C1: Validate the provider-neutral activity contract for non-Claude adapters (item 4, offline part)

The `ActivitySignal`/`ActivityUpdater` contract is already provider-neutral; only reasoning-note *extraction* (`transcript.ts`) is Claude-JSONL-specific, gated on `payload.transcriptPath` (Codex carries no transcript path). The offline deliverable is a regression test that pins the provider-neutral contract: a session that produces **no** transcript yields a coherent activity thread (step_started → tool_use → turn_completed) with **zero** reasoning notes — i.e. the thread degrades to a silent no-op for non-Claude providers, exactly as intended. (Live Codex reasoning-path validation stays PARKED — see "Parked items" at the end.)

**Files:**
- Test (create): `apps/daemon/src/activities/provider-neutral.test.ts`

**Interfaces:**
- Consumes: `ActivityUpdater`, `ActivitySignal` (no new production code).

- [ ] **Step 1: Write the test**

Create `apps/daemon/src/activities/provider-neutral.test.ts` (copy the db/ctx setup from `updater.test.ts`):
```ts
it("produces a coherent thread with zero reasoning notes when no transcript exists", () => {
  const updater = new ActivityUpdater(() => 0);
  updater.apply(ctx, { kind: "step_started", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: "codex-sess", stepName: "S" });
  updater.apply(ctx, { kind: "tool_use", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: "codex-sess", category: "running", detail: "ran build", diff: null });
  updater.apply(ctx, { kind: "turn_completed", stepRunId: "s1", summary: "done", confidence: null });
  const acts = listActivitiesForGoal(db, "g1"); // existing projection entry point
  const a = acts.find((x) => x.stepRunId === "s1");
  expect(a?.status).toBe("completed");
  // no reasoning_note signals were applied → no "other"-category steps from reasoning
  expect(a?.steps.every((s) => s.text !== "")).toBe(true);
  expect(a?.steps.some((s) => s.category === "running")).toBe(true);
});
```

- [ ] **Step 2: Run test (it should pass immediately — this is a pinning/regression test)**

Run: `pnpm --filter @orca/daemon test -- activities/provider-neutral.test.ts`
Expected: PASS. (If it fails, the contract is *not* provider-neutral — stop and investigate before proceeding; that would be a real finding.)

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/activities/provider-neutral.test.ts
git commit -m "test(phase-4): pin provider-neutral activity contract (no-transcript no-op) (item 4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task U1: Auto-collapse completed activity cards (item 13)

Completed activity cards render their full done-step list forever (`AgentActivity.tsx:14-16`). Collapse a completed card to its summary line by default, expandable on click. Pairs with the activity-stream work above.

**Files:**
- Modify: `apps/desktop/src/orchestrator/AgentActivity.tsx` (`AgentActivity` at `:3-31`)
- Test: `apps/desktop/src/orchestrator/AgentActivity.test.tsx` (create if absent; otherwise extend)

**Interfaces:**
- Consumes: `Activity` (`status`, `steps`, `finalSummary`).

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentActivity } from "./AgentActivity";

const completed = {
  id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null,
  turnOrdinal: 0, status: "completed", currentText: "", finalSummary: "Did the thing",
  sourceKind: "turn_completed", workCategory: null, confidence: null,
  createdAt: "t", updatedAt: "t", completedAt: "t",
  steps: [
    { id: "st1", text: "edited a.ts", category: "editing", status: "done", createdAt: "t" },
    { id: "st2", text: "ran tests", category: "running", status: "done", createdAt: "t" },
  ],
} as const;

it("collapses a completed card to the summary, expands on click", () => {
  render(<AgentActivity activity={completed as any} />);
  expect(screen.getByText("Did the thing")).toBeInTheDocument();
  expect(screen.queryByText("edited a.ts")).not.toBeInTheDocument(); // collapsed by default
  fireEvent.click(screen.getByTestId("agent-activity-toggle"));
  expect(screen.getByText("edited a.ts")).toBeInTheDocument(); // expanded
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- orchestrator/AgentActivity.test.tsx`
Expected: FAIL — all done steps render; there is no toggle.

- [ ] **Step 3: Implement collapse-by-default with a toggle**

In `AgentActivity.tsx`, add `const [expanded, setExpanded] = useState(false);` (import `useState`), and when `finished && !expanded`, render only the summary plus a toggle control (`data-testid="agent-activity-toggle"`) instead of the done-step list. When not finished, behavior is unchanged (live steps always show). Keep the existing `data-testid="agent-activity"` and `data-status`.

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @orca/desktop test -- orchestrator/AgentActivity.test.tsx`
Expected: PASS.
Run: `pnpm --filter @orca/desktop typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/AgentActivity.tsx apps/desktop/src/orchestrator/AgentActivity.test.tsx
git commit -m "feat(phase-4): auto-collapse completed activity cards (item 13)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task U2: `(Recommended)` badge detection (item 14)

Best-effort render-time heuristic: when a worker question option label ends with Claude's `(Recommended)` convention, render a badge and strip the suffix from the visible label. Pure render-time; no contract change.

**Files:**
- Modify: the component that renders worker `AskUserQuestion` option labels (find it: `grep -rn "Recommended\|option.label\|pendingQuestion" apps/desktop/src/orchestrator` — likely the worker-question card rendered from `Activity.pendingQuestion` / a chat message).
- Test: that component's `.test.tsx`.

**Interfaces:**
- Consumes: the option label string already rendered today.

- [ ] **Step 1: Locate the render site**

Run: `grep -rn "Recommended\|\.label\b" apps/desktop/src/orchestrator | grep -i option`
Identify the JSX that maps option labels to clickable choices. Note the file:line.

- [ ] **Step 2: Write the failing test**

In that component's test, render an option whose label is `"Use Postgres (Recommended)"` and assert: the visible label text is `"Use Postgres"` and a badge with `data-testid="recommended-badge"` is present; a plain label `"Use SQLite"` shows no badge.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- <that-component>.test.tsx`
Expected: FAIL — the literal `"(Recommended)"` is shown and no badge exists.

- [ ] **Step 4: Implement the heuristic**

Add a small pure helper next to the component:
```ts
export function splitRecommended(label: string): { text: string; recommended: boolean } {
  const m = /\s*\(Recommended\)\s*$/i.exec(label);
  return m ? { text: label.slice(0, m.index).trimEnd(), recommended: true } : { text: label, recommended: false };
}
```
Use it at the render site: show `text`, and when `recommended`, render `<span data-testid="recommended-badge">Recommended</span>`.

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter @orca/desktop test -- <that-component>.test.tsx`
Expected: PASS.
Run: `pnpm --filter @orca/desktop typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/orchestrator
git commit -m "feat(phase-4): detect and badge (Recommended) option labels (item 14)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task U3: Open the result-card artifact (item 21)

The brainstorm result card renders the primary artifact as text only — `description: reference` with the path in a `title` attribute (`ActivityThread.tsx:220-224`). Make it an affordance that opens the artifact in the OS editor/filesystem via Tauri.

**Files:**
- Modify: `apps/desktop/src/orchestrator/ActivityThread.tsx` (`StepResultCard`, `:220-224`)
- Possibly add: an `openPath` wrapper in `apps/desktop/src/api.ts` (or wherever Tauri `invoke`/`opener` calls live — `grep -rn "openPath\|shell.open\|opener\|revealItemInDir" apps/desktop/src`)
- Test: `apps/desktop/src/orchestrator/ActivityThread.test.tsx`

**Interfaces:**
- Consumes: `WorkflowStepResult.primaryArtifact` (`{ reference, description }`).

- [ ] **Step 1: Decide the open mechanism**

Run: `grep -rn "openPath\|@tauri-apps/plugin-opener\|@tauri-apps/api/shell\|revealItemInDir\|invoke(" apps/desktop/src | head`
Use the existing Tauri open/reveal mechanism if one is present; otherwise add a thin `openArtifact(reference: string): Promise<void>` wrapper that calls the Tauri opener plugin. Keep it mockable (export from `../api` so tests can `vi.fn()` it like the other api mocks).

- [ ] **Step 2: Write the failing test**

In `ActivityThread.test.tsx`, render a `StepResultCard` whose `stepResult.primaryArtifact = { reference: ".orca/specs/x.md", description: "design spec" }`. Assert the artifact is a button/link (role), and clicking it calls the mocked `openArtifact` with `".orca/specs/x.md"`.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- orchestrator/ActivityThread.test.tsx`
Expected: FAIL — today the artifact is a non-interactive `<div>` with a `title` attribute only.

- [ ] **Step 4: Implement the open affordance**

Replace the artifact `<div>` (`ActivityThread.tsx:220-224`) with a button that keeps the `description: reference` text and the `data-testid="step-result-artifact"`, calling `openArtifact(r.primaryArtifact.reference)` on click. (Tauri-native open is manual-only to verify end-to-end; the RTL test covers the wiring.)

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter @orca/desktop test -- orchestrator/ActivityThread.test.tsx`
Expected: PASS.
Run: `pnpm --filter @orca/desktop typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/orchestrator apps/desktop/src/api.ts
git commit -m "feat(phase-4): open the result-card artifact in the editor (item 21)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task O1: Orchestrator reasoning → first-class persisted activity (item 2, scoped-full)

**Design decision (approved): scoped-full.** Persist *every* orchestrator turn as a first-class auditable activity (the durable, runner-split-surviving contract half), via a **deliberately thin, provisional** in-process tap. Do **not** build a general producer abstraction — the orchestrator emits only a `Stop` hook with a single `last_assistant_message` blob (no `transcript_path`, no incremental notes), and the in-process wiring here moves to the Runner Protocol network boundary at the control/execution-plane split. Mark that wiring as provisional in comments.

**Verified constraints (from the orchestrator-path investigation):**
- Orchestrator shadow session emits only `Stop`/`StopFailure` (`shadow-hook-settings.ts:15-34`); no PreToolUse/transcript.
- The full orchestrator turn text is available exactly once, transiently, in `ShadowSessionManager.resolvePending` (`shadow-session.ts:267`) as `result.text`, **before** `parseAction` (`:277`) strips it to the `orca:action` block.
- Sessions are keyed by `goalId`; stable id `shadowSessionId(goalId) = \`orchsess-${goalId}\`` (`shadow-session.ts:341`).
- `activities.step_run_id` is NOT NULL — every activity attaches to a step run. The orchestrator always reasons in the context of a step, so attaching to the goal's current step run mirrors the existing routing card.

**Files:**
- Modify: `packages/contracts/src/index.ts` (`ActivitySourceKind` enum — add `"orchestrator_reasoning"`)
- Create: `apps/daemon/src/orchestrator-llm/reasoning-extract.ts` (pure helper) + `…/reasoning-extract.test.ts`
- Modify: `apps/daemon/src/activities/store.ts` (add `recordOrchestratorReasoning`)
- Modify: `apps/daemon/src/orchestrator-llm/shadow-session.ts` (add provisional `onOrchestratorTurn` deps callback; call it in `resolvePending` before `parseAction`)
- Modify: `apps/daemon/src/server.ts` (wire `onOrchestratorTurn` to a producer that resolves the goal's current step run and records the reasoning; fix the routing-card attribution)
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts` (`:1412` — attribute the routing card to `orchsess-${goal.id}` instead of `null`)
- Test: `apps/daemon/src/activities/store.test.ts`, `apps/daemon/src/orchestrator-llm/shadow-session.test.ts` (extend if present; else create)

**Interfaces:**
- Consumes: `shadowSessionId` (`shadow-session.ts:341`), `ActivityStoreCtx`.
- Produces:
  - `extractOrchestratorReasoning(fullText: string): string` — the prose with the `orca:action` block removed, trimmed (empty string if nothing remains).
  - `recordOrchestratorReasoning(ctx: ActivityStoreCtx, input: { goalId: string; workflowRunId: string; stepRunId: string; text: string }): ActivityT | undefined` — inserts a **completed** `orchestrator_reasoning` activity row attributed to `orchsess-${goalId}`; returns `undefined` for empty text.
  - `ShadowSessionManager` gains an optional `onOrchestratorTurn?(goalId: string, fullText: string): void` dep (provisional).

- [ ] **Step 1: Contract — add the source kind (red → green)**

Add to `packages/contracts/src/__tests__/activity-contracts.test.ts`:
```ts
it("accepts the orchestrator_reasoning source kind", () => {
  expect(ActivitySourceKind.parse("orchestrator_reasoning")).toBe("orchestrator_reasoning");
});
```
Run: `pnpm --filter @orca/contracts test -- __tests__/activity-contracts.test.ts` → FAIL.
Add `"orchestrator_reasoning",` to the `ActivitySourceKind` enum (after `"mark_done_pending"`), with a comment: a point-in-time record of an orchestrator LLM turn (auditable trajectory; provisional in-process capture, moves to the Runner Protocol at the plane split).
Run again → PASS. Then `pnpm --filter @orca/contracts typecheck` → PASS. Commit:
```bash
git add packages/contracts/src
git commit -m "feat(phase-4): add orchestrator_reasoning activity source kind (item 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 2: Pure reasoning-extract helper (red → green)**

Create `apps/daemon/src/orchestrator-llm/reasoning-extract.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { extractOrchestratorReasoning } from "./reasoning-extract.js";

describe("extractOrchestratorReasoning", () => {
  it("returns prose with the orca:action block stripped", () => {
    const turn = "I'll route to the feature branch because the goal has a spec.\n\n```orca:action\n{\"kind\":\"route\"}\n```";
    expect(extractOrchestratorReasoning(turn)).toBe("I'll route to the feature branch because the goal has a spec.");
  });
  it("returns empty string when only the action block is present", () => {
    expect(extractOrchestratorReasoning("```orca:action\n{}\n```")).toBe("");
  });
});
```
Run: `pnpm --filter @orca/daemon test -- orchestrator-llm/reasoning-extract.test.ts` → FAIL.
Create `apps/daemon/src/orchestrator-llm/reasoning-extract.ts`:
```ts
/** Strip the orca:action fenced block from an orchestrator turn, leaving the
 *  reasoning prose. Provisional: the orchestrator currently yields one final
 *  blob per turn (no incremental transcript). Trims; returns "" if nothing left. */
export function extractOrchestratorReasoning(fullText: string): string {
  return fullText.replace(/```orca:action[\s\S]*?```/g, "").trim();
}
```
> If the orchestrator action delimiter differs, align the regex with `extractActionBlock` (`orchestrator-llm/providers/claude.ts`) — check it before finalizing.
Run again → PASS.

- [ ] **Step 3: Store helper `recordOrchestratorReasoning` (red → green)**

Append to `apps/daemon/src/activities/store.test.ts`:
```ts
import { recordOrchestratorReasoning } from "./store.js";

it("records a completed orchestrator_reasoning activity attributed to the orch session", () => {
  const { ctx } = ctxFor(db);
  const a = recordOrchestratorReasoning(ctx, {
    goalId: "g1", workflowRunId: "r1", stepRunId: "s1", text: "routing because the spec exists",
  });
  expect(a?.sourceKind).toBe("orchestrator_reasoning");
  expect(a?.status).toBe("completed");
  expect(a?.agentSessionId).toBe("orchsess-g1");
  expect(a?.finalSummary).toBe("routing because the spec exists");
});

it("skips empty orchestrator reasoning", () => {
  const { ctx } = ctxFor(db);
  expect(recordOrchestratorReasoning(ctx, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", text: "  " })).toBeUndefined();
});
```
Run → FAIL. Implement in `store.ts` (insert a completed row; mirror the column list used by `pauseForGateDecision`; import `shadowSessionId` from `../orchestrator-llm/shadow-session.js`):
```ts
// Point-in-time record of one orchestrator LLM turn (auditable trajectory).
// A completed row (not the one-live-per-step bubble) so it never conflicts with
// the live worker activity for the same step.
export function recordOrchestratorReasoning(
  ctx: ActivityStoreCtx,
  input: { goalId: string; workflowRunId: string; stepRunId: string; text: string }
): ActivityT | undefined {
  const text = input.text.trim();
  if (text.length === 0) return undefined;
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const now = currentTime(ctx);
    const id = nextActivityId(ctx);
    const turnOrdinal = nextTurnOrdinal(ctx.db, input.stepRunId);
    ctx.db
      .prepare(
        `INSERT INTO activities (
           id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
           status, current_text, final_summary, source_kind, work_category, confidence,
           pending_question, recommendation_id, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, 'orchestrator_reasoning', NULL, NULL, NULL, NULL, ?, ?, ?)`
      )
      .run(id, input.goalId, input.workflowRunId, input.stepRunId, shadowSessionId(input.goalId), turnOrdinal, text, text, now, now, now);
    const inserted = getActivityById(ctx.db, id);
    if (inserted === undefined) throw new Error(`Activity insert failed: ${id}`);
    event = insertActivityChangedEvent(ctx.db, inserted, now);
    return inserted;
  })();
  publishActivityChanged(ctx, event);
  return activity;
}
```
Run → PASS. `pnpm --filter @orca/daemon typecheck` → PASS.

- [ ] **Step 4: Provisional tap in `resolvePending` (red → green)**

In `apps/daemon/src/orchestrator-llm/shadow-session.ts`, add an optional dep `onOrchestratorTurn?: (goalId: string, fullText: string) => void` to the manager's deps/options type, and call it in `resolvePending` (`:267`) **before** `parseAction` (`:277`), guarded so it can never break the orchestrator loop:
```ts
    // PROVISIONAL: capture the orchestrator's full turn text for the auditable
    // activity trajectory before parseAction strips it to the action block. This
    // in-process tap moves to the Runner Protocol boundary at the plane split.
    try { this.deps.onOrchestratorTurn?.(goalId, result.text ?? ""); } catch { /* never break the loop */ }
```
Add/extend `shadow-session.test.ts` to assert the callback fires with the raw text on a successful resolve (construct a manager with a spy dep, stub a pending, call `resolvePending(goalId, { text: "reasoning\n\n```orca:action\n{}\n```" })`, expect the spy called with the raw string). Run the test red → implement → green.

- [ ] **Step 5: Wire the producer in server.ts + fix routing-card attribution**

In `apps/daemon/src/server.ts`, where `ShadowSessionManager` is constructed (`~:571`), pass `onOrchestratorTurn`:
```ts
  onOrchestratorTurn: (goalId, fullText) => {
    try {
      const ctx = resolveStepContextFromGoal(db, goalId); // active run + current step run
      if (!ctx) return;
      const reasoning = extractOrchestratorReasoning(fullText);
      recordOrchestratorReasoning(
        { db, bus },
        { goalId, workflowRunId: ctx.workflowRunId, stepRunId: ctx.stepRunId, text: reasoning }
      );
    } catch { /* auditable-trajectory capture must never break orchestration */ }
  },
```
Add `resolveStepContextFromGoal(db, goalId)` if no equivalent exists: read `goals.active_workflow_run_id`, then the most recent `workflow_step_runs` row for that run, returning `{ workflowRunId, stepRunId }` (or `null`). Reuse an existing query helper if one already resolves the active run's current step. Import `extractOrchestratorReasoning` and `recordOrchestratorReasoning`.

Then in `dispatch-engine.ts:1412`, change the routing card's `agentSessionId: null` to `agentSessionId: shadowSessionId(goal.id)` (honest attribution — the orchestrator produced this routing decision). Import `shadowSessionId` from `../../orchestrator-llm/shadow-session.js`.

- [ ] **Step 6: Run the affected suites + typecheck**

Run: `pnpm --filter @orca/daemon test -- activities/store.test.ts orchestrator-llm/reasoning-extract.test.ts orchestrator-llm/shadow-session.test.ts`
Expected: PASS.
Run: `pnpm --filter @orca/daemon typecheck`
Expected: PASS.
Run (regression on the dispatch/splitter path): `pnpm --filter @orca/daemon test -- workflows/orchestrator`
Expected: PASS (the routing card now carries a non-null session id — update any assertion that pinned `agentSessionId: null` for that card to `orchsess-<goalId>`).

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src
git commit -m "feat(phase-4): persist orchestrator reasoning as first-class activity (item 2)

Scoped-full: durable orchestrator_reasoning activity + thin provisional in-process
tap (moves to the Runner Protocol at the plane split). Routing card now attributed
to the orchestrator session instead of null.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> Desktop note: with orchestrator reasoning now persisted, the hardcoded idle `RoutingCard` (`OrcaChat.tsx:1408-1433`, rendered at `:1037-1041`) can later be replaced by rendering the latest `orchestrator_reasoning` activity. That UI swap is **optional polish** — leave the `RoutingCard` as the pre-first-activity placeholder unless it churns; do not block this task on it.

---

## Parked items (do NOT run a live daemon/agy/Codex without explicit go-ahead)

The running daemon in the `daemon-terminal` tmux session is on **older code**, and spawning real agents spends the subscription. The following stay parked; surface and confirm before any rebuild/restart:
- **Item 4 (live half)** — Codex reasoning-note path validation needs a live Codex run.
- **Items 22–24** — antigravity native allow-list writer (needs live `agy`), Codex reasoning live-validation, client re-adopt/respawn.
- Carry-forward smokes: Phase-2 belief-divergence, Phase-3 OTEL two-provider (also gates 2.7b cost roll-up).

## FUTURE_WORK.md updates (do as the final commit of this stream)

When the stream's tasks are done, update `FUTURE_WORK.md` Phase 4 markers: item 5 ✅, item 1 ✅, item 3 ✅, item 4 ✅ (offline) with the live half noted 🔴/parked, item 13 ✅, item 14 ✅, item 21 ✅, item 2 ✅ (after Task O1). Use the legend exactly (no 🟢).
