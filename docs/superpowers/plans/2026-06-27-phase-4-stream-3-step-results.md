# Phase 4 — Stream 3 (step results / scoring / telemetry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two real correctness gaps in the step-result surfaces — the confirmation `lead` that diverges between the live card and the history card, and the output-schema shorthand that silently drops object-level descriptions (plus a one-line validity-gate gap) — and doc-close the three items verification showed are deferred or already-done.

**Architecture:** Two small, independent fixes. Item 10 (daemon): the confirmation `lead` is currently *rebuilt* at read time from different sources on the live card (`scoring.reason ‖ proposal`) vs the post-confirm history card (`resultSummary ?? outcome.reason`), so they diverge; the fix snapshots the confirmed lead into a new `workflow_step_runs.confirmed_lead` column at confirm-pause time and reads it with a fallback. Item 12 (desktop): the output-schema serializer's object/array-of-object branches return before emitting the `# description`, so a round-trip drops it; the parser already accepts it — fix the serializer; and gate the "Create workflow" button on `schemaInvalid` (already wired everywhere except that button).

**Tech Stack:** TypeScript; daemon = Node + better-sqlite3 + Fastify + Vitest; desktop = React + Vitest + @testing-library/react.

## Global Constraints

- **One seam per commit** (`feat(phase-4):` / `fix(phase-4):` / `docs(phase-4):`). **TDD** red→green for all three code tasks.
- **Append-only event spine + projections**; no orchestration logic in the desktop app; surgical changes; match existing style.
- **Done-marker legend** (FUTURE_WORK.md): ✅ done · 🟡 deferred-by-decision · 🔴 blocked · ⚪ non-change. **No 🟢.**
- **Clean-state DB** (already reset this branch): item 10's `confirmed_lead` column is **nullable** (no default, no backfill); the read side falls back to the current rebuild when it is NULL, so it is robust without backfill.
- **Migration-list update (mandatory):** adding migration `0045` WILL break the migration-enumeration tests — append `"0045_step_run_confirmed_lead.sql"` to `migrationFiles` in `apps/daemon/src/migrations.ts` AND to each hardcoded applied/`toEqual([...])` list in `apps/daemon/src/migrations.test.ts`, `apps/daemon/test/migrations-0006.test.ts`, `apps/daemon/src/migrations/suggested-orchestration.test.ts`.
- **Contracts dist** is gitignored + built: if a `@orca/contracts` change is made, `pnpm --filter @orca/contracts build` before daemon/desktop tests. (Stream 3 has no contract change unless a test needs one — none expected.)
- **Pre-existing:** desktop package-wide `tsc` is red on `main` (unrelated `operatingMode` fixture gaps) — for desktop tasks verify "no NEW type error in changed files," not package-wide green.
- **Commands:** daemon `pnpm --filter @orca/daemon test -- <path>` / `… typecheck`; desktop `pnpm --filter @orca/desktop test -- <path>`.
- **Known flakes:** `http-surface.test.ts`, `human-review.test.ts` (parallel-load only).

---

## Task T1: Snapshot the confirmation lead (item 10)

The confirmation `lead` diverges: the live `step_confirmation_pending` card builds it from `scoring?.reason?.trim() || proposal?.trim() || "Step complete."` (`confirmation-summary.ts:45`), but the post-confirm `step_result` history card rebuilds it from `stepResult.resultSummary ?? stepResult.outcome.reason` (`projection.ts:125`) — different text. Snapshot the confirmed lead at confirm-pause time and read it back so both show the same thing.

**Files:**
- Create: `apps/daemon/migrations/0045_step_run_confirmed_lead.sql`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (the confirm-pause stash write, ~`:1202-1206`)
- Modify: `apps/daemon/src/workflows/ledger/projection.ts` (or wherever `rebuildConfirmedFrame` + its `workflow_step_runs` SELECT live — confirm path; the agent reported `projection.ts:92-127,133-145`)
- Modify: `apps/daemon/src/migrations.ts` + the 3 migration-enumeration test files (migration-list update)
- Test: the projection/confirmation test that exercises `rebuildConfirmedFrame` (find it: `grep -rl "rebuildConfirmedFrame\|confirmationSummary\|step_result" apps/daemon/src/**/*.test.ts`)

**Interfaces:**
- Produces: `workflow_step_runs.confirmed_lead` (nullable TEXT), populated at confirm-pause, read by the history-card projection with fallback.

- [ ] **Step 1: Write the migration**

Create `apps/daemon/migrations/0045_step_run_confirmed_lead.sql`:
```sql
-- 0045_step_run_confirmed_lead.sql
-- Snapshot the confirmation card's lead at confirm-pause time so the post-confirm
-- history card shows the SAME lead the user saw, instead of rebuilding it from a
-- different source (resultSummary ?? outcome.reason). Nullable; read side falls
-- back to the rebuild when NULL.
ALTER TABLE workflow_step_runs ADD COLUMN confirmed_lead TEXT;
```

- [ ] **Step 2: Write the failing test**

In the test that drives a step to a confirmation and reads the history-card `confirmationSummary.lead`, add a case asserting the history-card lead equals the lead computed from `scoring.reason`/`proposal` at confirm time (NOT `resultSummary`/`outcome.reason`). Bind to the file's existing harness; the assertion is that the live-card lead and the post-confirm history-card lead are identical when `scoring.reason` differs from `resultSummary`.
Run it → FAIL (today they differ).

- [ ] **Step 3: Compute + store the lead at confirm-pause**

In `service.ts` at the stash write (`:1202-1206`), compute the lead with the SAME formula the live card uses and persist it to the new column. Reuse/extract the existing lead formula from `confirmation-summary.ts:45` (`scoring?.reason?.trim() || proposal?.trim() || "Step complete."`) — import/share it rather than duplicating the literal, so the two sites cannot drift again:
```ts
const confirmedLead = scoring?.reason?.trim() || proposal?.trim() || "Step complete.";
db.prepare(
  "UPDATE workflow_step_runs SET pending_completion_json = ?, confirmed_lead = ? WHERE id = ?"
).run(
  JSON.stringify({ block: block ?? {}, scoring: scoring ?? null, finishedAt, proposal }),
  confirmedLead,
  ctx.stepRun.id
);
```
> If `confirmation-summary.ts` doesn't already export the lead helper, extract it to a small shared function `confirmationLead(scoringReason, proposal)` and use it in BOTH `buildConfirmationSummary` and here.

- [ ] **Step 4: Read the snapshot in the history-card projection (with fallback)**

In `rebuildConfirmedFrame` (`projection.ts:~125`), add `sr.confirmed_lead` to the `workflow_step_runs` SELECT it already runs (`:133-145`), and use it as the lead, falling back to the current behavior when NULL:
```ts
const leadText = row.confirmed_lead ?? (stepResult.resultSummary ?? stepResult.outcome.reason);
return buildConfirmationSummary(schemaParse.data, block, null, leadText);
```

- [ ] **Step 5: Migration-list update + run**

Append `"0045_step_run_confirmed_lead.sql"` to `migrationFiles` (`migrations.ts`) and to each hardcoded list in `migrations.test.ts`, `migrations-0006.test.ts`, `suggested-orchestration.test.ts`.
Run: `pnpm --filter @orca/daemon test -- <the projection/confirmation test> migrations.test.ts migrations-0006.test.ts suggested-orchestration.test.ts daemon.integration.test.ts`
Expected: PASS.
Run: `pnpm --filter @orca/daemon typecheck`.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/migrations apps/daemon/src
git commit -m "fix(phase-4): snapshot the confirmation lead so the history card matches (item 10)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task T2: Round-trip object-level descriptions in the output-schema shorthand (item 12a)

The serializer drops `description` on `object` and `array`-of-`object` fields (it returns before the `# desc` line); the parser already accepts `myObj { … } # description`. Fix the serializer so the round-trip preserves object-level descriptions.

**Files:**
- Modify: `apps/desktop/src/workflows/output-schema-text.ts` (the object branch `:12-13` and the array-of-object branch `:15-16`)
- Test: `apps/desktop/src/workflows/output-schema-text.test.ts`

**Interfaces:**
- Consumes/produces: the existing `serializeOutputSchema` / `parseOutputSchemaText` round-trip.

- [ ] **Step 1: Write the failing round-trip test**

In `output-schema-text.test.ts`, add a schema with a `description` on (a) an `object` field and (b) an `array`-of-`object` field, serialize then parse, and assert the descriptions survive:
```ts
const schema = [
  { key: "meta", type: "object", description: "the metadata block", fields: [{ key: "id", type: "string", required: true }] },
  { key: "items", type: "array", itemType: "object", description: "list of results", fields: [{ key: "name", type: "string", required: true }] },
];
const round = parseOutputSchemaText(serializeOutputSchema(schema as any));
expect(round.find((f) => f.key === "meta")?.description).toBe("the metadata block");
expect(round.find((f) => f.key === "items")?.description).toBe("list of results");
```
Run → FAIL (descriptions dropped by the serializer).

- [ ] **Step 2: Emit the description on the multi-line branches**

In `output-schema-text.ts`, append the `# description` to the object and array-of-object branches (placed after the closing `}`, matching where the parser reads it at `:179-181`). For the object branch (`:12-13`):
```ts
if (f.type === "object" && f.fields) {
  const desc = f.description ? `  # ${f.description}` : "";
  return `${pad(depth)}${f.key}${opt} {\n${renderFields(f.fields, depth + 1)}\n${pad(depth)}}${desc}`;
}
```
Apply the analogous change to the array-of-object branch (`:15-16`), keeping the `[] {` form. Use the same `# ${f.description}` idiom the leaf branch uses (`:26-27`).

- [ ] **Step 3: Run the test + verify no new type error**

Run: `pnpm --filter @orca/desktop test -- workflows/output-schema-text.test.ts`
Expected: PASS (round-trip preserves object descriptions; existing tests still green).
Run: `pnpm --filter @orca/desktop exec tsc --noEmit 2>&1 | grep -i output-schema-text` — expected: empty.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/workflows/output-schema-text.ts apps/desktop/src/workflows/output-schema-text.test.ts
git commit -m "fix(phase-4): round-trip object-level descriptions in output-schema shorthand (item 12)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task T3: Gate the "Create workflow" button on schema validity (item 12b)

`schemaInvalid` already gates the "Save Changes" button (`TemplateDetail.tsx:506`) and is wired from both editor paths, but the "Create workflow" button (`:528`) omits it — a new workflow with an invalid output schema can be submitted.

**Files:**
- Modify: `apps/desktop/src/workflows/TemplateDetail.tsx:528`
- Test: `apps/desktop/src/workflows/TemplateDetail.test.tsx` (if present; else add a focused case)

**Interfaces:** consumes the existing in-scope `schemaInvalid` state.

- [ ] **Step 1: Write the failing test**

In `TemplateDetail.test.tsx`, render the create flow, drive a step's output-schema editor to an invalid state (so `onOutputSchemaValidityChange(false)` fires), and assert the "Create workflow" button is disabled. (If a focused RTL path to invalidate the schema is impractical, assert at minimum that the button's `disabled` includes `schemaInvalid` by simulating the validity callback.)
Run → FAIL (button enabled despite invalid schema).

- [ ] **Step 2: Add the gate**

In `TemplateDetail.tsx:528`, change `disabled={saving || duplicating}` to `disabled={saving || duplicating || schemaInvalid}`.

- [ ] **Step 3: Run the test + verify no new type error**

Run: `pnpm --filter @orca/desktop test -- workflows/TemplateDetail.test.tsx`
Expected: PASS.
Run: `pnpm --filter @orca/desktop exec tsc --noEmit 2>&1 | grep -i templatedetail` — expected: empty.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/workflows/TemplateDetail.tsx apps/desktop/src/workflows/TemplateDetail.test.tsx
git commit -m "fix(phase-4): gate Create workflow on output-schema validity (item 12)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task T4: Doc-close the deferred / already-done items (items 8, 9, 11)

Doc-only FUTURE_WORK marker updates. No code.

**Files:** Modify `FUTURE_WORK.md`.

- [ ] **Step 1: Update the three bullets**

- Item 8 (telemetry counters) → keep 🟡, annotate deferred-by-decision: fields stay optional/unpopulated; no reliable per-step turn/tool source exists (only dirty over-counting approximations from `activities`/`activity_steps`); revisit when the OTLP receiver provides per-step attribution.
- Item 9 (scoring fill-rate eval gate) → keep 🟡, annotate deferred-to-live-session: a ~sub-project blocked on a recorded-session fixture corpus + live model calls AND an unresolved design question (the `0.0` prompt example makes a real low score indistinguishable from a copy-paste, so "filled" can't be defined yet). Not reopened here.
- Item 11 (run-pinning UI) → ✅ for the display the item asked for (the "pinned to vN" label already renders in `WorkflowRunPanel.tsx:203` via `templateVersion`); note the deeper "view the pinned definition" / historical-version store are separate larger asks (the per-run `template_snapshot_json` exists server-side but is intentionally not surfaced; no `workflow_template_versions` store) — left out of scope.

- [ ] **Step 2: Commit**

```bash
git add FUTURE_WORK.md
git commit -m "docs(phase-4): close stream-3 items — telemetry 🟡, fill-rate 🟡, run-pin label ✅ (items 8,9,11)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Deferred / not built in this stream

- **Item 8** 🟡 — no reliable per-step turn/tool source; stays optional.
- **Item 9** 🟡 — scoring fill-rate eval gate: sub-project, unresolved "filled" definition, needs live model calls. Deferred to a live-session effort (same posture as item 19).

## FUTURE_WORK.md marker summary

item 8 🟡 (T4) · item 9 🟡 (T4) · item 10 ✅ (T1) · item 11 ✅ display / store out-of-scope (T4) · item 12 ✅ (T2+T3). Fold item-10/12 marker updates into a final doc commit or T4. Legend exactly (no 🟢).
