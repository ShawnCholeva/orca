# Run-Version Pinning — Design

**Date:** 2026-06-15
**Status:** Approved (design)

## Problem

A workflow run executes against the **live** template: every run-execution path
loads it via `getTemplateById(db, run.templateId)` (~17 call sites). When a template
is edited — or a built-in is re-seeded with a bumped version — an in-flight run
silently adopts the new definition. This surfaced when the terminal-step work bumped
three built-ins v1→v2 and added a `Done` step: a run already in flight would, after
finishing its previously-terminal last step, resolve a new edge to `Done` and
dispatch it mid-run.

A run should execute against the template definition it **started with**, immune to
later edits or re-seeds.

## Decisions (confirmed)

- **Mechanism:** snapshot the resolved template into the run at start. No template
  version-history table (none exists today; `workflow_templates` overwrites in place).
- **Snapshot scope:** the **full** `WorkflowTemplate` definition, stored as one JSON
  column. Name/description/scope are frozen alongside steps/graph/guardrails.
- **Existing runs:** runs created before this migration have a null snapshot and
  **fall back to the live template** — today's behavior. No backfill.

## Changes

### 1. Migration — `0033_workflow_run_template_snapshot.sql`

```sql
ALTER TABLE workflow_runs ADD COLUMN template_snapshot_json TEXT;
```

Nullable; null means "pre-pinning run, fall back to live template." Register the
filename in `apps/daemon/src/migrations.ts` `migrationFiles` (after `0032`).

### 2. Write path — `startWorkflowRun` (`apps/daemon/src/workflows/runs/usecases.ts`)

`startWorkflowRun` already loads the live `template` (line ~105) before inserting the
run. Add the snapshot to the existing INSERT: write `JSON.stringify(template)` into
`template_snapshot_json` alongside the current columns. No other code path inserts
into `workflow_runs`.

### 3. Read path — new module `apps/daemon/src/workflows/runs/run-template.ts`

```ts
export function loadRunTemplate(db: Database.Database, run: WorkflowRunT): WorkflowTemplateT | null {
  const row = db
    .prepare("SELECT template_snapshot_json FROM workflow_runs WHERE id = ?")
    .get(run.id) as { template_snapshot_json: string | null } | undefined;
  if (row?.template_snapshot_json) {
    return WorkflowTemplate.parse(JSON.parse(row.template_snapshot_json));
  }
  return getTemplateById(db, run.templateId); // pre-migration runs keep today's behavior
}
```

Returns the same `WorkflowTemplateT | null` shape as `getTemplateById`, so call sites
need no downstream changes. Imports `getTemplateById` from `../templates/projection.js`
and `WorkflowTemplate` from `@orca/contracts`. A dedicated module avoids import cycles
between the run, step, and orchestrator layers.

### 4. Repoint run-execution call sites

Replace `getTemplateById(db, run.templateId)` with `loadRunTemplate(db, run)` at the
run-execution sites only:

- `apps/daemon/src/workflows/steps/usecases.ts` — 3 sites (lines ~255, ~334, ~500).
- `apps/daemon/src/workflows/orchestrator/service.ts` — ~13 sites.
- `apps/daemon/src/workflows/orchestration-transport/human-review.ts` — 1 site (~554).

Each site already has the `run` object in scope (it passes `run.templateId` today).

**Leave unchanged** (these operate on templates, not run execution):
`templates/routes.ts`, `templates/usecases.ts`, `templates/projection.ts`,
`recommendations/usecases.ts`, `server.ts`.

### 5. Behavior summary

- **New runs:** fully pinned. Template edits and built-in re-seeds (including the
  v1→v2 bumps) never alter an in-flight run's steps/graph/guardrails.
- **Existing in-flight runs:** null snapshot → live template (unchanged behavior).
- `template_version` on the run remains the human-readable label of the pinned version.

## Testing

- `run-template.test.ts`: `loadRunTemplate` returns the parsed snapshot when present;
  falls back to `getTemplateById` when the column is null.
- `runs/usecases` test: `startWorkflowRun` persists `template_snapshot_json` matching
  the template at start.
- Integration: start a run; mutate/upsert the template (change a step or graph);
  assert `loadRunTemplate` still returns the original definition and that next-step /
  terminal resolution follows the pinned graph, not the edited one.

## Out of scope

- Template version-history table / viewing arbitrary historical versions.
- Backfilling snapshots for runs created before the migration.
- Any change to template CRUD or the `getTemplateById` projection itself.
- A UI surface for "this run is pinned to version N" (the data exists; no view added).
