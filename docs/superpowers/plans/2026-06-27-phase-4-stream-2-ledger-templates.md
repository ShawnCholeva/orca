# Phase 4 — Stream 2 (ledger / Inspectable surfaces & templates) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch two more surfaces up to the substrate — render the committed harness ledger directly in the desktop (Inspectable), and make a template's `category` a first-class persisted attribute so the Workflows-tab filter reads it directly instead of reconstructing it via a catalog-join shim — plus a small stale-reference cleanup and doc-close of confirmed-as-is decisions.

**Architecture:** Items grouped by surface. The daemon already exposes `GET …/ledger` (committed records + version list) but no desktop UI consumes it; item 15 promotes the ledger read shape into `@orca/contracts` and adds a stacked `<LedgerPanel>`. Template `category` exists today only on the catalog *display* read-model + a desktop shim that joins persisted templates against the catalog by id (leaving user templates `Uncategorized`); item 20 (Depth B) persists `category` on the `WorkflowTemplate` contract + DB column and deletes the shim. Item 19 (template-ledger authoring) is **deferred** — its only real payoff (templates emitting ledger records) is unverifiable without a live daemon (parked).

**Tech Stack:** TypeScript; daemon = Node + better-sqlite3 + Fastify + Vitest; contracts = Zod + Vitest; desktop = Tauri + React + Vitest + @testing-library/react (happy-dom).

## Global Constraints

- **One seam per commit.** Each task ends with a commit (`feat(phase-4):` / `refactor(phase-4):` / `docs(phase-4):` / `test(phase-4):`).
- **TDD** for daemon/contract/UI logic (red→green); doc-only tasks have no test.
- **Append-only event spine + projections.** Clients render projections + send commands; no orchestration logic in the desktop app.
- **Surgical changes.** Touch only what each task requires; match existing style; don't reformat adjacent code.
- **Done-marker legend** (FUTURE_WORK.md): ✅ done · 🟡 deferred-by-decision · 🔴 blocked · ⚪ non-change. **No 🟢.**
- **Future-shape-only (item 20) — clean-state, NO compat, NO backfill:** `WorkflowTemplate.category` is **strictly required** — `z.string().min(1).max(64)` (NO `.default()`). The dev database is **reset to a clean state** before/with this work, so there is no pre-existing data to migrate. The migration only *defines* the column for fresh DBs; there is **no data backfill** (no rows, no snapshots to patch). **Explicit consequence:** this migration will fail to load runs from any DB that is NOT reset — old `template_snapshot_json` blobs lack `category` and would throw on `WorkflowTemplate.parse(...)`. The DB column is `category TEXT NOT NULL DEFAULT 'Engineering'` (the `DEFAULT` is required by SQLite for an `ADD COLUMN NOT NULL` and supplies the value for newly-created custom templates — a DB default for the single existing category, not a compat affordance). **Operational prerequisite (surfaced separately): the dev DB reset is a destructive action tied to the daemon restart and is confirmed with the user before execution.**
- **Contracts dist is gitignored + built:** after any `@orca/contracts` change, run `pnpm --filter @orca/contracts build` before daemon/desktop tests, or they fail on a stale dist.
- **Commands:** daemon `pnpm --filter @orca/daemon test -- <path>` / `… typecheck`; contracts `pnpm --filter @orca/contracts test -- <path>` / `… build` / `… typecheck`; desktop `pnpm --filter @orca/desktop test -- <path>` / `… typecheck`.
- **Pre-existing (not this stream):** desktop package-wide `tsc --noEmit` is already red on `main` (App.test.tsx/GoalDetailView.test.tsx fixtures miss `operatingMode`). For desktop tasks verify "no NEW type error in changed files," not package-wide green. Desktop vitest is green.
- **Known flakes:** `http-surface.test.ts`, `human-review.test.ts` (fail only under parallel load; pass in isolation).

---

## Task S1: Remove stale `orca/engineering` references (item 6)

Two actionable dead references to the removed `orca/engineering` template seed (verified: the only actionable ones; ~140 other hits are intentional test fixtures).

**Files:**
- Modify: `apps/desktop/src/goal-detail/workflow/WorkflowRunPanel.tsx:408` (dead branch)
- Modify: `ORCA.md:101` (doc line referencing the deleted `seed-engineering.ts`)
- Test: `apps/desktop/src/goal-detail/workflow/WorkflowRunPanel.test.tsx` (if the line is covered; otherwise no test — it's dead-branch removal)

**Interfaces:** none consumed/produced downstream.

- [ ] **Step 1: Inspect the dead branch**

Read `WorkflowRunPanel.tsx:408`: `return templateId === "orca/engineering" ? "Engineering workflow" : templateId;`. The `orca/engineering` template is no longer in the catalog, so the branch never matches. Confirm what the function is (a template-id→label helper) and whether any other built-in id should map to a label. If the surrounding helper only special-cased the removed id, the correct surgical change is to drop the dead ternary and return the fallback directly.

- [ ] **Step 2: Remove the dead branch**

Replace the dead ternary at `:408` with the fallback it already falls through to (e.g. `return templateId;` or whatever the `: templateId` arm returns). Do not add new label logic — just remove the unreachable `orca/engineering` special-case.

- [ ] **Step 3: Fix the ORCA.md doc line**

`ORCA.md:101` references `seed-engineering.ts` (deleted) and `the orca/engineering template`. Update the sentence so it no longer points to the deleted file/seed — describe the current catalog model (built-ins live in `catalog.ts`'s `BUILTIN_TEMPLATE_CATALOG`) without the stale filename. Keep the edit minimal and in the existing prose style.

- [ ] **Step 4: Verify nothing else broke**

Run: `pnpm --filter @orca/desktop test -- goal-detail/workflow/WorkflowRunPanel.test.tsx`
Expected: PASS (no behavior change — the branch was dead).
Run: `grep -rn "orca/engineering" apps/desktop/src ORCA.md` — expected: 0 hits in those two locations (test fixtures elsewhere are intentional and out of scope).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/goal-detail/workflow/WorkflowRunPanel.tsx ORCA.md
git commit -m "refactor(phase-4): drop dead orca/engineering references (item 6)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task S2: Doc-close confirmed-as-is decisions (item 7)

Record (doc-only) the Phase-2/3 decisions that verification confirmed are correct as-is, so they stop reading as open. No code.

**Files:**
- Modify: `FUTURE_WORK.md` (the four bullets: ledger open decisions `:159`; terminal-event payload `:142`; INITIATIVE_GRAPH + reconcile `:165`)

**Interfaces:** none.

- [ ] **Step 1: Update the ledger open-decisions bullet (`:159`)**

Change its 🟡 marker to ✅ with a confirmed-as-is note: atomic txn wraps `step_output` + ledger version only, async review runs *before* the txn and cursor advance *after* (`ledger-commit.ts:42,72`); empty ledger versions are **always** committed (`ledger/usecases.ts:53`); orchestrator review is the **deterministic normalizer only**, broker pass descoped (`ledger/review.ts:1-19`). All three confirmed correct as-is — no code change needed.

- [ ] **Step 2: Update the terminal-event payload bullet (`:142`)**

Keep 🟡 but mark it deferred-by-decision with rationale: terminal events carry identifiers only by design (4 KiB cap + content-free `FORBIDDEN_KEYS`); no consumer needs the full `stepResult` (desktop refetches on event type; projection/replay read the DB). Keeping identifiers-only is the correct, exit-criterion-aligned choice.

- [ ] **Step 3: Update the INITIATIVE_GRAPH + reconcile bullet (`:165`)**

Change to ⚪ non-change with note: `INITIATIVE_GRAPH` does not exist in code (subsumed into `orca/adaptive-delivery`); the catalog reconcile test's `goals` INSERT has no schema drift (omitted columns all carry defaults); stale `orca/engineering` actionable refs handled in Task S1, `orca/feature-development` has zero code hits.

- [ ] **Step 4: Commit**

```bash
git add FUTURE_WORK.md
git commit -m "docs(phase-4): close confirmed-as-is ledger/payload/template decisions (item 7)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task S3: Promote the ledger read shape into contracts (item 15a)

The daemon route `GET /v1/goals/:goalId/workflow-runs/:id/ledger` returns `{ committed, versions }` as a raw untyped object; `CommittedLedger` lives only in `apps/daemon/src/workflows/ledger/projection.ts:4`. Promote a typed response into `@orca/contracts` and parse it at the route boundary, so the desktop can consume a contract type (consistent with every other endpoint).

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts` (near `LedgerRecord` at `:1879`)
- Modify: `apps/daemon/src/workflows/runs/routes.ts:205-218` (parse the response)
- Test: `packages/contracts/src/__tests__/*` (a focused contract test) + the existing runs route test if it covers `/ledger`

**Interfaces:**
- Produces:
  - `CommittedLedger = z.object({ version: z.number().int().nonnegative(), records: z.array(LedgerRecord) }).strict()`
  - `LedgerVersionEntry = z.object({ version: z.number().int().nonnegative(), sourceStepRunId: z.string().nullable(), traversalSeq: z.number().int().nonnegative(), createdAt: z.string() }).strict()`
  - `WorkflowRunLedgerResponse = z.object({ committed: CommittedLedger, versions: z.array(LedgerVersionEntry) }).strict()`
- Consumed by: Task S4 (desktop).

- [ ] **Step 1: Write the failing contract test**

In a new/auxiliary contract test file, parse a representative ledger response (one committed record + two version entries) through `WorkflowRunLedgerResponse` and assert it round-trips; assert `.strict()` rejects an unknown key.
Run: `pnpm --filter @orca/contracts test -- <that file>` → FAIL (types not defined).

- [ ] **Step 2: Define the contract types**

In `packages/contracts/src/workflows/index.ts` after `LedgerRecord` (`:1879`), add `CommittedLedger`, `LedgerVersionEntry`, `WorkflowRunLedgerResponse` (shapes above) + their `z.infer` type exports, matching the file's existing style. Mirror the field names the daemon already returns (`version`, `records`, `sourceStepRunId`, `traversalSeq`, `createdAt`).
Run the contract test → PASS. Then `pnpm --filter @orca/contracts build` + `pnpm --filter @orca/contracts typecheck`.

- [ ] **Step 3: Parse at the daemon route boundary**

In `apps/daemon/src/workflows/runs/routes.ts:205-218`, wrap the returned object in `WorkflowRunLedgerResponse.parse({ committed: latestCommittedLedger(deps.db, id), versions: listLedgerVersionsForRun(deps.db, id) })` (import the type from `@orca/contracts`). This makes the HTTP boundary typed like the sibling routes (`WorkflowRunResponse.parse`). If `latestCommittedLedger`'s return type already matches `CommittedLedger`, no projection change is needed; if a field name differs, align the parse input (do NOT change the projection's internal type).

- [ ] **Step 4: Run the daemon route test + typecheck**

Run: `pnpm --filter @orca/daemon test -- workflows/runs` (the runs route test; if it doesn't cover `/ledger`, add a focused case asserting the route returns a `WorkflowRunLedgerResponse`-shaped object).
Expected: PASS. Then `pnpm --filter @orca/daemon typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src apps/daemon/src/workflows/runs/routes.ts apps/daemon/src/workflows
git commit -m "feat(phase-4): type the workflow-run ledger read response in contracts (item 15)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task S4: Desktop ledger panel (item 15b)

Add a `<LedgerPanel>` that renders the committed ledger records (and version count) inside `WorkflowRunPanel`, fed by a new `api.ts` fetch wrapper. Inspectable surface consuming the ledger facet directly.

**Files:**
- Modify: `apps/desktop/src/api.ts` (add `getWorkflowRunLedger`)
- Create: `apps/desktop/src/goal-detail/workflow/LedgerPanel.tsx`
- Modify: `apps/desktop/src/goal-detail/workflow/WorkflowRunPanel.tsx` (state + fetch + render the panel as a peer of `ArtifactsList`/`DecisionTraceTimeline`)
- Test: `apps/desktop/src/goal-detail/workflow/LedgerPanel.test.tsx` (create)

**Interfaces:**
- Consumes: `WorkflowRunLedgerResponse`, `CommittedLedger`, `LedgerRecord` (Task S3).
- Produces: `getWorkflowRunLedger(goalId: string, runId: string): Promise<WorkflowRunLedgerResponse>`.

- [ ] **Step 1: Add the api.ts wrapper**

In `apps/desktop/src/api.ts`, mirror `listWorkflowRunArtifacts` (`:1252-1263`):
```ts
export async function getWorkflowRunLedger(
  goalId: string,
  runId: string,
): Promise<WorkflowRunLedgerResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workflow-runs/${encodeURIComponent(runId)}/ledger`,
    { headers: authHeaders(token) },
    WorkflowRunLedgerResponse,
    "Get workflow run ledger failed",
  );
}
```
Add `WorkflowRunLedgerResponse` to the `@orca/contracts` import.

- [ ] **Step 2: Write the failing LedgerPanel test**

Create `LedgerPanel.test.tsx`: render `<LedgerPanel committed={{ version: 3, records: [{ id: "deliv-abc", recordType: "deliverable", status: "done", note: "Shipped X", evidenceRefs: ["a.ts"], relatedRecordIds: [], firstVersion: 1, lastVersion: 3, updatedAt: "t" }] }} versionCount={3} />` and assert it shows the record's note, recordType, status, and the version count; assert an empty ledger (`records: []`) renders an empty-state line (not a crash).
Run: `pnpm --filter @orca/desktop test -- goal-detail/workflow/LedgerPanel.test.tsx` → FAIL (component absent).

- [ ] **Step 3: Implement LedgerPanel**

Create `LedgerPanel.tsx` — a presentational component taking `{ committed: CommittedLedger; versionCount: number }`, rendering a header (e.g. `Ledger · v{versionCount}`), an empty-state when `records.length === 0`, else a list of records showing `recordType`, `status`, `note`, and `evidenceRefs`. Match the styling/markup conventions of the sibling panels (`ArtifactsList.tsx` / `DecisionTraceTimeline.tsx`) — read one for the className/structure idiom. Keep it read-only (no actions).
Run the test → PASS.

- [ ] **Step 4: Wire into WorkflowRunPanel**

In `WorkflowRunPanel.tsx`: add `ledger` to `WorkflowPanelState` (`{ committed: CommittedLedger; versions: LedgerVersionEntry[] } | null`); add `getWorkflowRunLedger(goalId, runId)` to the `load()` `Promise.all` block (`:91-108`) with the same error tolerance as siblings; render `<LedgerPanel committed={state.ledger.committed} versionCount={state.ledger.versions.length} />` inside `workflow-run-panel-body` as a peer after `ArtifactsList` (guarded on `state.ledger != null`). Match the existing sub-panel wiring pattern exactly.

- [ ] **Step 5: Run tests + verify no new type error**

Run: `pnpm --filter @orca/desktop test -- goal-detail/workflow/LedgerPanel.test.tsx goal-detail/workflow/WorkflowRunPanel.test.tsx`
Expected: PASS.
Run: `pnpm --filter @orca/desktop exec tsc --noEmit 2>&1 | grep -iE "LedgerPanel|WorkflowRunPanel|api.ts"` — expected: empty (no NEW type errors in changed files).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/goal-detail/workflow/LedgerPanel.tsx apps/desktop/src/goal-detail/workflow/LedgerPanel.test.tsx apps/desktop/src/goal-detail/workflow/WorkflowRunPanel.tsx
git commit -m "feat(phase-4): render the committed ledger in the workflow run panel (item 15)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task S5: Persist template `category` on the substrate (item 20a)

Make `category` a first-class persisted attribute of `WorkflowTemplate` (Depth B) so post-install surfaces read it directly. `BuiltInTemplateDefinition.category` already exists in the catalog but is never written to the DB.

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts` (`WorkflowTemplate` at `:344-363`)
- Create: `apps/daemon/migrations/0044_workflow_template_category.sql`
- Modify: `apps/daemon/src/workflows/templates/projection.ts` (`WorkflowTemplateRow` `:4-18`, `ensureStmts` SELECTs `:30-35`, `rowToTemplate` `:46-62`)
- Modify: `apps/daemon/src/workflows/templates/usecases.ts` (`upsertBuiltInTemplate` INSERT/UPDATE `:178-206`; `duplicateTemplate` INSERT `:139-153` to inherit `source.category`; `createCustomTemplate` `:57-71` relies on the column default)
- Modify: `apps/daemon/src/workflows/templates/catalog.test.ts:30-36` (relax the hardcoded assertion)
- Test: `apps/daemon/src/workflows/templates/*.test.ts` (projection/usecases round-trip)

**Interfaces:**
- Produces: `WorkflowTemplate.category` (persisted, `z.string().min(1).max(64).default("Engineering")`).
- Consumed by: Task S6 (desktop).

- [ ] **Step 1: Write the failing migration + contract test**

Add a contract test: `WorkflowTemplate.parse({...full template WITHOUT category...})` **THROWS** (category is required, no default); and a template WITH `category: "Product"` round-trips.
Add a daemon test: on a fresh in-memory DB (`runMigrations` from scratch), install a built-in via `upsertBuiltInTemplate`, then `getTemplateById` and assert `.category === "Engineering"`; `duplicateTemplate` of it yields a template whose `category` equals the source's. (No snapshot-backfill test — clean-state means no pre-existing snapshots; the test harness always builds the schema from scratch.)
Run all → FAIL.

- [ ] **Step 2: Add the contract field (required, no default)**

In `WorkflowTemplate` (`:344-363`), add (after `scopeName`, before `graph` to match field grouping):
```ts
    category: z.string().min(1).max(64),
```
**No `.default()`** — the future shape is the only shape; existing data is migrated to carry the field (Step 3), so nothing relies on a fallback (see Global Constraints).
Run: `pnpm --filter @orca/contracts test -- <contract test>` → the without-category case THROWS as asserted. Then `pnpm --filter @orca/contracts build`.

- [ ] **Step 3: Write the migration (column + data backfill, incl. snapshots)**

Create `apps/daemon/migrations/0044_workflow_template_category.sql`:
```sql
-- 0044_workflow_template_category.sql
-- Promote template category from catalog-display-only to a first-class persisted
-- attribute so post-install surfaces (Workflows tab filter) read it directly
-- instead of reconstructing it by joining against the catalog by id.
-- Clean-state / future-shape-only: the contract requires `category` (no default).
-- The dev DB is reset, so there is no pre-existing data to migrate — this only
-- defines the column for fresh DBs. The DEFAULT is required by SQLite for an
-- ADD COLUMN NOT NULL and supplies the value for newly-created custom templates.
ALTER TABLE workflow_templates ADD COLUMN category TEXT NOT NULL DEFAULT 'Engineering';
```

- [ ] **Step 4: Thread `category` through the projection**

In `projection.ts`: add `category: string;` to `WorkflowTemplateRow` (`:4-18`); add `category` to both SELECT column lists in `ensureStmts` (`:30-35`); add `category: row.category,` to the `WorkflowTemplate.parse({...})` in `rowToTemplate` (`:46-62`).

- [ ] **Step 5: Thread `category` through writes**

In `usecases.ts`:
- `upsertBuiltInTemplate` (`:178-206`): add `category` to the INSERT column list + value (`def.category`), and to the UPDATE `SET` clause (`category = ?`, `def.category`). Both branches.
- `duplicateTemplate` (`:139-153`): add `category` to the INSERT and pass `source.category` (a duplicate inherits the source's category).
- `createCustomTemplate` (`:57-71`): leave the INSERT column list as-is — the DB column default `'Engineering'` applies (custom templates default to Engineering; no request field exists). *(If `CreateWorkflowTemplateRequest` is later given a category, thread it here.)*

- [ ] **Step 6: Relax the hardcoded catalog test**

In `catalog.test.ts:30-36`, change `expect(d.category).toBe("Engineering")` to assert membership in a known set so adding a future category doesn't break it:
```ts
    expect(["Engineering"]).toContain(d.category); // extend this set as categories are added
```
(Keep the `bestFor` assertions unchanged.)

- [ ] **Step 7: Run daemon tests + typecheck**

Run: `pnpm --filter @orca/daemon test -- workflows/templates`
Expected: PASS (projection round-trip, upsert/duplicate category, relaxed catalog test).
Run the FULL daemon migration tests since a migration was added: `pnpm --filter @orca/daemon test -- migrations.test.ts migrations-0006.test.ts suggested-orchestration.test.ts daemon.integration.test.ts` — these enumerate the migration list; **append `0044_workflow_template_category.sql`** to `migrationFiles` in `src/migrations.ts` and to each hardcoded `applied` list (same pattern as the 0043 fix), then re-run.
Run: `pnpm --filter @orca/daemon typecheck`.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src apps/daemon/migrations apps/daemon/src/workflows/templates apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts apps/daemon/test apps/daemon/src/migrations
git commit -m "feat(phase-4): persist template category as a first-class attribute (item 20)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task S6: Desktop reads `category` directly, delete the catalog-join shim (item 20b)

With `category` now on every persisted template, the Workflows-tab filter reads `t.category` directly; the `categoryById` catalog-join shim (and its `Uncategorized` fallback for user templates) is removed.

**Files:**
- Modify: `apps/desktop/src/workflows/WorkflowsPage.tsx` (delete `categoryById` `:55`, the catalog-fetch effect `:82-100`, simplify `categoryOf` `:132-136`; remove the now-unused `listTemplateCatalog` import if no other use)
- Modify: `apps/desktop/src/onboarding/OnboardingView.tsx:224` (the "Product, Design … on the way" copy — light touch, see Step 4)
- Test: `apps/desktop/src/workflows/WorkflowsPage.test.tsx`

**Interfaces:**
- Consumes: `WorkflowTemplate.category` (Task S5).

- [ ] **Step 1: Update the failing test**

In `WorkflowsPage.test.tsx`, set up `listWorkflowTemplates` to return templates that each carry a real `category` (e.g. one `"Engineering"`), and assert the category filter options + filtering work **without** `listTemplateCatalog` being called for category derivation (assert the catalog mock is not used for that, or is not called at all if it has no other purpose here).
Run: `pnpm --filter @orca/desktop test -- workflows/WorkflowsPage.test.tsx` → FAIL (today category comes from the catalog join).

- [ ] **Step 2: Read `category` directly, delete the shim**

In `WorkflowsPage.tsx`:
- Delete `const [categoryById, setCategoryById] = useState…` (`:55`).
- Delete the entire catalog-fetch `useEffect` (`:82-100`).
- Replace `categoryOf` (`:132-136`) with `const categoryOf = (t: WorkflowTemplate) => t.category;` (category is a required contract field, so every template carries it — no `Uncategorized` fallback is needed). Keep `categoryOptions` computed from `categoryOf`.
- Remove the `UNCATEGORIZED` const (`:11`) and the `listTemplateCatalog` import **iff** nothing else in the file uses them (grep first).

- [ ] **Step 3: Run test + verify no new type error**

Run: `pnpm --filter @orca/desktop test -- workflows/WorkflowsPage.test.tsx`
Expected: PASS.
Run: `pnpm --filter @orca/desktop exec tsc --noEmit 2>&1 | grep -i workflowspage` — expected: empty.

- [ ] **Step 4: Update onboarding copy (light)**

`OnboardingView.tsx:224` says categories "Product, Design … are on the way." This is still accurate (only Engineering ships), so leave the meaning intact — only adjust if Step 2's changes made it stale (they don't). **If unchanged, skip this step and note it.** Do NOT invent new-category UI.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/workflows/WorkflowsPage.tsx apps/desktop/src/workflows/WorkflowsPage.test.tsx
git commit -m "feat(phase-4): Workflows-tab category reads the substrate, drop catalog-join shim (item 20)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Deferred / not in this stream

- **Item 19 (template platform-managed ledger):** 🟡 deferred to a live-daemon session — the engine machinery is complete; the only remaining work is making templates *emit* ledger records, whose payoff is unverifiable without a live daemon (parked). The broker correction pass stays descoped (deterministic normalizer suffices); not reopened.

## FUTURE_WORK.md marker updates (fold into the relevant task's commit or a final doc commit)

- item 6 ✅ (S1) · item 7 ✅/🟡/⚪ as recorded (S2) · item 15 ✅ (S4) · item 19 🟡 deferred-to-live · item 20 ✅ Depth B (S6). Use the legend exactly (no 🟢).
