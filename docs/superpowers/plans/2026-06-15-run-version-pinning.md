# Run-Version Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workflow run executes against the template definition it started with, immune to later template edits or built-in re-seeds.

**Architecture:** Snapshot the full resolved `WorkflowTemplate` into the run at start (new nullable `workflow_runs.template_snapshot_json` column). A `loadRunTemplate(db, run)` helper returns the parsed snapshot, falling back to the live template when the column is null (pre-migration runs). Repoint the ~17 run-execution call sites from `getTemplateById(db, run.templateId)` to `loadRunTemplate(db, run)`.

**Tech Stack:** TypeScript, better-sqlite3 (SQL-file migrations in `apps/daemon/migrations/`), Zod (`@orca/contracts`), Vitest. Run with `pnpm`.

**Spec:** `docs/superpowers/specs/2026-06-15-run-version-pinning-design.md`

---

### Task 1: Snapshot column + write it at run start

**Files:**
- Create: `apps/daemon/migrations/0033_workflow_run_template_snapshot.sql`
- Modify: `apps/daemon/src/migrations.ts` (register the file in `migrationFiles`)
- Modify: `apps/daemon/src/workflows/runs/usecases.ts` (`startWorkflowRun` INSERT, ~line 120-124)
- Test: `apps/daemon/src/workflows/runs/usecases.test.ts`

- [ ] **Step 1: Write the failing test**

In `usecases.test.ts`, add inside `describe("workflow run usecases", ...)` (reuse the existing `setup`, `seedGoal`, `seedTemplate` helpers):

```ts
  it("snapshots the template definition into the run at start", () => {
    const { db, ctx } = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering", 7);

    const run = startWorkflowRun(ctx, { goalId: "goal-1", templateId: "orca/engineering" });

    const row = db
      .prepare("SELECT template_snapshot_json FROM workflow_runs WHERE id = ?")
      .get(run.id) as { template_snapshot_json: string | null };
    expect(row.template_snapshot_json).not.toBeNull();
    const snap = JSON.parse(row.template_snapshot_json!);
    expect(snap.id).toBe("orca/engineering");
    expect(snap.version).toBe(7);
    expect(snap.steps[0].id).toBe("intake");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- runs/usecases`
Expected: FAIL — `no such column: template_snapshot_json` (migration not yet added).

- [ ] **Step 3: Create the migration**

Create `apps/daemon/migrations/0033_workflow_run_template_snapshot.sql`:

```sql
ALTER TABLE workflow_runs ADD COLUMN template_snapshot_json TEXT;
```

- [ ] **Step 4: Register the migration**

In `apps/daemon/src/migrations.ts`, add the filename to the `migrationFiles` array immediately after `"0032_gate_decision_ledger_version.sql",`:

```ts
  "0033_workflow_run_template_snapshot.sql",
```

- [ ] **Step 5: Write the snapshot in `startWorkflowRun`**

In `apps/daemon/src/workflows/runs/usecases.ts`, replace the existing INSERT (the `INSERT INTO workflow_runs (... template_version, status ...)` statement and its `.run(...)`) with:

```ts
    ctx.db
      .prepare(
        "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, template_snapshot_json, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, ?, NULL)"
      )
      .run(runId, args.goalId, args.templateId, template.version, JSON.stringify(template), now);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- runs/usecases`
Expected: PASS (the new test and all existing run-usecase tests).

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/migrations/0033_workflow_run_template_snapshot.sql apps/daemon/src/migrations.ts apps/daemon/src/workflows/runs/usecases.ts apps/daemon/src/workflows/runs/usecases.test.ts
git commit -m "feat(workflows): snapshot template into run at start

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `loadRunTemplate` helper

**Files:**
- Create: `apps/daemon/src/workflows/runs/run-template.ts`
- Test: `apps/daemon/src/workflows/runs/run-template.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/runs/run-template.test.ts`. It mirrors the harness in `usecases.test.ts` (temp dir + real sqlite + migrations). Keep it self-contained:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { closeDatabase, openDatabase } from "../../db.js";
import type { Config } from "../../config.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetPreparedStatements as resetRunProjectionPreparedStatements, getWorkflowRunById } from "./projection.js";
import { loadRunTemplate } from "./run-template.js";

const tempDirs: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";

function createConfig(dataDir: string): Config {
  return {
    dataDir, port: 8787, logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024, sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, getAuthToken: () => "test-token",
  };
}

function seedTemplate(db: Database.Database, id: string, version: number, stepName: string): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)"
  ).run(
    id, "Engineering", "desc", version,
    JSON.stringify([{ id: "intake", ordinal: 0, name: stepName, instructions: "do", outputSchema: [{ key: "k", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] }]),
    JSON.stringify([]), NOW, NOW
  );
}

function insertRun(db: Database.Database, id: string, templateId: string, version: number, snapshotJson: string | null): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, 't', 'd', 'active', 1, ?, ?, NULL)"
  ).run(`goal-${id}`, NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, template_snapshot_json, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, ?, NULL)"
  ).run(id, `goal-${id}`, templateId, version, snapshotJson, NOW);
}

function setup(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-run-template-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

afterEach(() => {
  closeDatabase();
  resetRunProjectionPreparedStatements();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadRunTemplate", () => {
  it("returns the parsed snapshot when present, ignoring live template edits", () => {
    const db = setup();
    seedTemplate(db, "orca/engineering", 1, "Original");
    const snapshot = JSON.stringify({
      id: "orca/engineering", name: "Engineering", description: "desc", version: 1,
      isBuiltIn: true, isLocked: true,
      steps: [{ id: "intake", ordinal: 0, name: "Original", instructions: "do", outputSchema: [{ key: "k", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] }],
      guardrails: [], createdAt: NOW, updatedAt: NOW, scope: "global", scopeName: "", graph: null,
    });
    insertRun(db, "run-1", "orca/engineering", 1, snapshot);

    // Mutate the live template after the run was created.
    db.prepare("UPDATE workflow_templates SET steps_json = ? WHERE id = ?")
      .run(JSON.stringify([{ id: "intake", ordinal: 0, name: "EDITED", instructions: "do", outputSchema: [{ key: "k", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] }]), "orca/engineering");

    const run = getWorkflowRunById(db, "run-1")!;
    const tpl = loadRunTemplate(db, run)!;
    expect(tpl.steps[0].name).toBe("Original");
  });

  it("falls back to the live template when the snapshot is null", () => {
    const db = setup();
    seedTemplate(db, "orca/engineering", 1, "LiveName");
    insertRun(db, "run-2", "orca/engineering", 1, null);

    const run = getWorkflowRunById(db, "run-2")!;
    const tpl = loadRunTemplate(db, run)!;
    expect(tpl.steps[0].name).toBe("LiveName");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- run-template`
Expected: FAIL — `run-template.js` / `loadRunTemplate` does not exist yet.

- [ ] **Step 3: Implement the helper**

Create `apps/daemon/src/workflows/runs/run-template.ts`:

```ts
import type Database from "better-sqlite3";
import { WorkflowTemplate, type WorkflowTemplate as WorkflowTemplateT, type WorkflowRun as WorkflowRunT } from "@orca/contracts";
import { getTemplateById } from "../templates/projection.js";

/**
 * Returns the template a run executes against. Prefers the immutable snapshot
 * captured at run start; falls back to the live template for runs created before
 * the snapshot column existed.
 */
export function loadRunTemplate(
  db: Database.Database,
  run: WorkflowRunT
): WorkflowTemplateT | null {
  const row = db
    .prepare("SELECT template_snapshot_json FROM workflow_runs WHERE id = ?")
    .get(run.id) as { template_snapshot_json: string | null } | undefined;
  if (row?.template_snapshot_json) {
    return WorkflowTemplate.parse(JSON.parse(row.template_snapshot_json));
  }
  return getTemplateById(db, run.templateId);
}
```

(If `getTemplateById`'s declared return type differs from `WorkflowTemplateT | null`, match it exactly — both should be the contract `WorkflowTemplate`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- run-template`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/runs/run-template.ts apps/daemon/src/workflows/runs/run-template.test.ts
git commit -m "feat(workflows): add loadRunTemplate (pinned snapshot with live fallback)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Repoint run-execution call sites to the pinned template

**Files:**
- Modify: `apps/daemon/src/workflows/steps/usecases.ts` (3 sites: ~255, ~334, ~500)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (~13 sites)
- Modify: `apps/daemon/src/workflows/orchestration-transport/human-review.ts` (1 site: ~554)

These are mechanical swaps; each site already has the `run` object in scope and keeps its existing `if (!template) throw …` null-check.

- [ ] **Step 1: Repoint `steps/usecases.ts`**

Add the import (near the existing `getTemplateById` import):
```ts
import { loadRunTemplate } from "../runs/run-template.js";
```
Replace every occurrence of `getTemplateById(db, run.templateId)` with `loadRunTemplate(db, run)`. Then remove the now-unused `import { getTemplateById } from "../templates/projection.js";` line (verify with `grep -n "getTemplateById" apps/daemon/src/workflows/steps/usecases.ts` returning no matches after replacement).

- [ ] **Step 2: Repoint `orchestrator/service.ts`**

Add the import:
```ts
import { loadRunTemplate } from "../runs/run-template.js";
```
Replace every `getTemplateById(db, run.templateId)` with `loadRunTemplate(db, run)`. After replacement, `grep -n "getTemplateById" apps/daemon/src/workflows/orchestrator/service.ts` should return no matches — if so, remove the `getTemplateById` import; if any non-`run.templateId` use remains, keep the import.

- [ ] **Step 3: Repoint `orchestration-transport/human-review.ts`**

Add the import:
```ts
import { loadRunTemplate } from "../runs/run-template.js";
```
Replace `getTemplateById(deps.db, run.templateId)` with `loadRunTemplate(deps.db, run)`. Remove the `getTemplateById` import if `grep -n "getTemplateById" apps/daemon/src/workflows/orchestration-transport/human-review.ts` then returns no matches.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: no errors (catches any leftover unused import or type mismatch).

- [ ] **Step 5: Run the full daemon workflow suite**

Run: `pnpm --filter @orca/daemon test -- workflows`
Expected: PASS — the existing run/step/orchestrator tests now drive `loadRunTemplate`. Watch for any test that relied on a mid-run template swap (none expected).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/steps/usecases.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestration-transport/human-review.ts
git commit -m "feat(workflows): execute runs against their pinned template snapshot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Full verification

- [ ] **Step 1: Daemon test suite**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS (no regressions; new run-template + snapshot tests green).

- [ ] **Step 2: Typecheck the workspace**

Run: `pnpm -r typecheck`
Expected: clean across contracts, daemon, desktop.

- [ ] **Step 3: Knip (unused exports/imports), if configured**

Run: `pnpm knip` (repo root)
Expected: no NEW unused-import findings for the touched files. If `knip` reports pre-existing unrelated findings, ignore them; only fix ones introduced by this change (e.g. a leftover `getTemplateById` import).

- [ ] **Step 4: Commit any incidental cleanup**

If steps 1-3 surfaced a leftover import or fixture needing a tweak, fix minimally and commit:
```bash
git add -A
git commit -m "chore(workflows): cleanup after run-version pinning

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** §1 migration → Task 1. §2 write path → Task 1. §3 `loadRunTemplate` → Task 2. §4 repoint call sites → Task 3. §5 behavior → exercised by Task 2 tests (snapshot vs fallback) and Task 3 suite. Testing section → Tasks 1-2 unit tests + the "ignores live edits" integration assertion in Task 2.
- **Type consistency:** `loadRunTemplate(db, run): WorkflowTemplateT | null` matches `getTemplateById`'s return, so the 17 swapped call sites and their `if (!template)` guards are unchanged. `run: WorkflowRunT` is the contract `WorkflowRun` alias used in `runs/projection.ts`.
- **Watch point:** after repointing, confirm each file's `getTemplateById` import is actually unused before removing it — `orchestrator/service.ts` is the one to double-check, since it has the most call sites.
