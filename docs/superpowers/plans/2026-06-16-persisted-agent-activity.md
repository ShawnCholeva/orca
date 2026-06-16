# Persisted Agent Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flickering, self-overwriting live activity bubble with one persisted `AgentActivity` card per agent turn that accumulates a checklist of specific, hook-derived steps (with inline code diffs) and settles with a summary.

**Architecture:** Each agent `tool_use` hook now *appends* a persisted step (in a new `activity_steps` table) instead of overwriting the activity's `current_text`. Step text is derived from the tool's input at the hook boundary (`narrateToolDetail`), and edit tools carry a reconstructed unified diff. The desktop merges the old live-bubble and terminal-card into a single `AgentActivity` component that renders the checklist + diffs and persists in the chat timeline.

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), better-sqlite3 (daemon), React + Vite (desktop), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-16-persisted-agent-activity-design.md`

**Conventions:**
- Run a single daemon test file: `pnpm --filter @orca/daemon exec vitest run <path>`
- Run a single contracts test file: `pnpm --filter @orca/contracts exec vitest run <path>`
- Run a single desktop test file: `pnpm --filter @orca/desktop exec vitest run <path>`
- Full package test: `pnpm --filter @orca/<pkg> test`
- This plan runs on branch `feat/persisted-agent-activity` (already created).

---

## Task 1: Contract types — `ActivityStep` / `ActivityDiff`, add `steps` to `Activity`

**Files:**
- Modify: `packages/contracts/src/index.ts` (near the `Activity` definition, ~line 1124-1160)
- Test: `packages/contracts/src/__tests__/activity-contracts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/__tests__/activity-contracts.test.ts`:

```ts
import { Activity, ActivityStep, ActivityDiff } from "../index.js";

test("Activity defaults steps to an empty array (back-compat)", () => {
  const parsed = Activity.parse({
    id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1",
    agentSessionId: null, turnOrdinal: 0, status: "active",
    currentText: "Reading…", finalSummary: null, sourceKind: "tool_use",
    workCategory: "reading", confidence: null,
    createdAt: "2026-06-16T00:00:00.000Z", updatedAt: "2026-06-16T00:00:00.000Z",
    completedAt: null,
  });
  expect(parsed.steps).toEqual([]);
});

test("ActivityStep accepts an optional diff", () => {
  const diff = ActivityDiff.parse({
    filePath: "verifier.ts", additions: 2, deletions: 1,
    hunks: [{ oldStart: 42, newStart: 42, lines: [
      { kind: "remove", text: "old()" },
      { kind: "add", text: "new()" },
    ] }],
  });
  const step = ActivityStep.parse({
    id: "st1", text: "Edited verifier.ts", category: "editing",
    status: "done", diff, createdAt: "2026-06-16T00:00:00.000Z",
  });
  expect(step.diff?.additions).toBe(2);
  expect(step.status).toBe("done");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts exec vitest run src/__tests__/activity-contracts.test.ts`
Expected: FAIL — `ActivityStep`/`ActivityDiff` not exported; `parsed.steps` is undefined.

- [ ] **Step 3: Add the schemas**

In `packages/contracts/src/index.ts`, immediately BEFORE `export const Activity = z` (~line 1137), insert:

```ts
export const ActivityDiffLine = z
  .object({
    kind: z.enum(["context", "add", "remove"]),
    text: z.string().max(2000),
  })
  .strict();
export type ActivityDiffLine = z.infer<typeof ActivityDiffLine>;

export const ActivityDiffHunk = z
  .object({
    oldStart: z.number().int().positive().nullable(),
    newStart: z.number().int().positive().nullable(),
    lines: z.array(ActivityDiffLine).max(400),
  })
  .strict();
export type ActivityDiffHunk = z.infer<typeof ActivityDiffHunk>;

export const ActivityDiff = z
  .object({
    filePath: z.string().max(1024),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    hunks: z.array(ActivityDiffHunk).max(20),
  })
  .strict();
export type ActivityDiff = z.infer<typeof ActivityDiff>;

export const ActivityStep = z
  .object({
    id: z.string(),
    text: z.string().max(2000),
    category: ActivityWorkCategory.nullable(),
    status: z.enum(["active", "done"]),
    diff: ActivityDiff.optional(),
    createdAt: z.string(),
  })
  .strict();
export type ActivityStep = z.infer<typeof ActivityStep>;
```

Then, inside the `Activity` object (after the `completedAt` line, before the closing `})`), add:

```ts
    steps: z.array(ActivityStep).default([]),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts exec vitest run src/__tests__/activity-contracts.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @orca/contracts typecheck`
Expected: no errors.

```bash
git add packages/contracts/src/index.ts packages/contracts/src/__tests__/activity-contracts.test.ts
git commit -m "feat(contracts): add ActivityStep/ActivityDiff and Activity.steps"
```

---

## Task 2: Migration `0034_activity_steps.sql`

**Files:**
- Create: `apps/daemon/migrations/0034_activity_steps.sql`
- Modify: `apps/daemon/src/migrations.test.ts` (the ordered expected-filenames list)

- [ ] **Step 1: Add the new migration to the expected list (failing test)**

In `apps/daemon/src/migrations.test.ts`, find the array entry `"0033_workflow_run_template_snapshot.sql",` and add immediately after it:

```ts
      "0034_activity_steps.sql",
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/migrations.test.ts`
Expected: FAIL — the migrations dir has no `0034_activity_steps.sql` yet (count/order mismatch).

- [ ] **Step 3: Create the migration**

Create `apps/daemon/migrations/0034_activity_steps.sql`:

```sql
-- 0034_activity_steps.sql
-- Persist each agent tool step as its own row so the chat can render an
-- accumulating checklist instead of overwriting a single live line. Nothing
-- FK-references activity_steps, so this runs in the normal transaction.
CREATE TABLE activity_steps (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  text        TEXT NOT NULL,
  category    TEXT,
  status      TEXT NOT NULL CHECK (status IN ('active', 'done')),
  diff        TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_activity_steps_activity ON activity_steps(activity_id, ordinal);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/migrations.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/migrations/0034_activity_steps.sql apps/daemon/src/migrations.test.ts
git commit -m "feat(daemon): add activity_steps table (migration 0034)"
```

---

## Task 3: `narrateToolDetail` — specific step text

**Files:**
- Modify: `apps/daemon/src/activities/claude-adapter.ts`
- Test: `apps/daemon/src/activities/claude-adapter.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/append `apps/daemon/src/activities/claude-adapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { narrateToolDetail } from "./claude-adapter.js";

describe("narrateToolDetail", () => {
  it("names the file read", () => {
    expect(narrateToolDetail("Read", { file_path: "/repo/billing/verifier.ts" }))
      .toBe("Read verifier.ts");
  });
  it("names the file edited", () => {
    expect(narrateToolDetail("Edit", { file_path: "/repo/store.ts" }))
      .toBe("Edited store.ts");
    expect(narrateToolDetail("Write", { file_path: "/repo/new.ts" }))
      .toBe("Edited new.ts");
  });
  it("shows the search pattern", () => {
    expect(narrateToolDetail("Grep", { pattern: "retryCharge(" }))
      .toBe('Searched "retryCharge("');
  });
  it("shows the command, marking tests", () => {
    expect(narrateToolDetail("Bash", { command: "pnpm test billing" }))
      .toBe("Ran tests: pnpm test billing");
    expect(narrateToolDetail("Bash", { command: "ls -la" }))
      .toBe("Ran ls -la");
  });
  it("falls back to category narration on unknown/garbage input", () => {
    expect(narrateToolDetail("WebFetch", null))
      .toBe("Working on the step...");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/activities/claude-adapter.test.ts`
Expected: FAIL — `narrateToolDetail` not exported.

- [ ] **Step 3: Implement `narrateToolDetail`**

Append to `apps/daemon/src/activities/claude-adapter.ts`:

```ts
const TEST_CMD = /\b(test|vitest|jest|pytest)\b/i;

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function truncate(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Human one-liner for a tool call, derived from its input. Falls back to the
 *  generic category narration for unknown tools or malformed input. */
export function narrateToolDetail(toolName: string, toolInput: unknown): string {
  try {
    const input = (toolInput ?? {}) as Record<string, unknown>;
    const file = typeof input.file_path === "string" ? basename(input.file_path) : null;
    switch (toolName) {
      case "Read":
        return file ? `Read ${file}` : narrateCategory("reading");
      case "Edit":
      case "Write":
      case "MultiEdit":
      case "NotebookEdit":
        return file ? `Edited ${file}` : narrateCategory("editing");
      case "Grep":
      case "Glob": {
        const pattern = typeof input.pattern === "string" ? input.pattern
          : typeof input.glob === "string" ? input.glob : null;
        return pattern ? `Searched "${truncate(pattern, 60)}"` : narrateCategory("searching");
      }
      case "Bash": {
        const cmd = typeof input.command === "string" ? input.command : null;
        if (!cmd) return narrateCategory("running");
        return TEST_CMD.test(cmd) ? `Ran tests: ${truncate(cmd)}` : `Ran ${truncate(cmd)}`;
      }
      default:
        return narrateCategory(categorizeClaudeTool(toolName, toolInput));
    }
  } catch {
    return narrateCategory("other");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/activities/claude-adapter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/activities/claude-adapter.ts apps/daemon/src/activities/claude-adapter.test.ts
git commit -m "feat(daemon): narrateToolDetail for specific step text"
```

---

## Task 4: Diff reconstruction from hook payload

**Files:**
- Create: `apps/daemon/src/activities/diff.ts`
- Test: `apps/daemon/src/activities/diff.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/activities/diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { reconstructEditDiff } from "./diff.js";

const FILE = [
  "export class Verifier {",          // line 1
  "  verify(evt) {",                  // line 2
  "    if (flags.billingV3Shadow)",   // line 3
  "      return this.dualVerify(evt);",// line 4
  "    return this.v1(evt);",         // line 5
  "  }",                              // line 6
  "}",                               // line 7
].join("\n");

describe("reconstructEditDiff", () => {
  it("builds an Edit diff with line numbers and context", () => {
    const diff = reconstructEditDiff(
      "Edit",
      {
        file_path: "/repo/billing/verifier.ts",
        old_string: "  verify(evt) { return this.v1(evt); }",
        new_string: "  verify(evt) {\n    if (flags.billingV3Shadow)\n      return this.dualVerify(evt);\n    return this.v1(evt);\n  }",
      },
      () => FILE,
    )!;
    expect(diff.filePath).toBe("verifier.ts");
    expect(diff.additions).toBe(5);
    expect(diff.deletions).toBe(1);
    expect(diff.hunks[0].newStart).toBe(2);
    expect(diff.hunks[0].lines.filter((l) => l.kind === "add")).toHaveLength(5);
    expect(diff.hunks[0].lines.some((l) => l.kind === "context")).toBe(true);
  });

  it("treats Write as an all-addition diff", () => {
    const diff = reconstructEditDiff("Write", { file_path: "/r/new.ts", content: "a\nb\n" }, () => "")!;
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
    expect(diff.hunks[0].lines.every((l) => l.kind === "add")).toBe(true);
  });

  it("returns null line numbers when the snippet can't be located", () => {
    const diff = reconstructEditDiff(
      "Edit",
      { file_path: "/r/x.ts", old_string: "gone", new_string: "absent" },
      () => "totally different file",
    )!;
    expect(diff.hunks[0].newStart).toBeNull();
    expect(diff.deletions).toBe(1);
  });

  it("returns null for non-edit tools and on read failure", () => {
    expect(reconstructEditDiff("Read", { file_path: "/r/x.ts" }, () => "")).toBeNull();
    expect(reconstructEditDiff("Edit", { file_path: "/r/x.ts", old_string: "a", new_string: "b" },
      () => { throw new Error("ENOENT"); })!.hunks[0].newStart).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/activities/diff.test.ts`
Expected: FAIL — `./diff.js` does not exist.

- [ ] **Step 3: Implement `diff.ts`**

Create `apps/daemon/src/activities/diff.ts`:

```ts
import { readFileSync } from "node:fs";
import type { ActivityDiff, ActivityDiffLine } from "@orca/contracts";

const MAX_HUNK_LINES = 200;
const CONTEXT_LINES = 2;

type Reader = (filePath: string) => string;

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function buildEditHunk(
  filePath: string,
  oldStr: string,
  newStr: string,
  read: Reader,
): ActivityDiff {
  const removed = splitLines(oldStr);
  const added = splitLines(newStr);
  let oldStart: number | null = null;
  let newStart: number | null = null;
  let before: ActivityDiffLine[] = [];
  let after: ActivityDiffLine[] = [];

  try {
    const file = read(filePath);
    const first = file.indexOf(newStr);
    const unique = first >= 0 && newStr.length > 0 && file.indexOf(newStr, first + 1) === -1;
    if (unique) {
      newStart = file.slice(0, first).split("\n").length; // 1-based
      oldStart = newStart;
      const fileLines = file.split("\n");
      const startIdx = newStart - 1;
      before = fileLines
        .slice(Math.max(0, startIdx - CONTEXT_LINES), startIdx)
        .map((text) => ({ kind: "context", text }));
      const endIdx = startIdx + added.length;
      after = fileLines
        .slice(endIdx, endIdx + CONTEXT_LINES)
        .map((text) => ({ kind: "context", text }));
    }
  } catch {
    // leave line numbers null, no context
  }

  const lines: ActivityDiffLine[] = [
    ...before,
    ...removed.map((text): ActivityDiffLine => ({ kind: "remove", text })),
    ...added.map((text): ActivityDiffLine => ({ kind: "add", text })),
    ...after,
  ].slice(0, MAX_HUNK_LINES);

  return {
    filePath: basename(filePath),
    additions: added.length,
    deletions: removed.length,
    hunks: [{ oldStart, newStart, lines }],
  };
}

/** Reconstruct a unified diff for an edit tool from its hook payload. Returns
 *  null for non-edit tools or when no file path is present. Never throws. */
export function reconstructEditDiff(
  toolName: string,
  toolInput: unknown,
  read: Reader = (p) => readFileSync(p, "utf8"),
): ActivityDiff | null {
  try {
    const input = (toolInput ?? {}) as Record<string, unknown>;
    const filePath = typeof input.file_path === "string" ? input.file_path : null;
    if (!filePath) return null;

    if (toolName === "Write") {
      const content = typeof input.content === "string" ? input.content : "";
      const added = splitLines(content);
      const lines: ActivityDiffLine[] = added
        .slice(0, MAX_HUNK_LINES)
        .map((text) => ({ kind: "add", text }));
      return {
        filePath: basename(filePath),
        additions: added.length,
        deletions: 0,
        hunks: [{ oldStart: 1, newStart: 1, lines }],
      };
    }

    if (toolName === "Edit") {
      const oldStr = typeof input.old_string === "string" ? input.old_string : "";
      const newStr = typeof input.new_string === "string" ? input.new_string : "";
      return buildEditHunk(filePath, oldStr, newStr, read);
    }

    if (toolName === "MultiEdit") {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const hunks = [];
      let additions = 0;
      let deletions = 0;
      for (const raw of edits) {
        const e = (raw ?? {}) as Record<string, unknown>;
        const oldStr = typeof e.old_string === "string" ? e.old_string : "";
        const newStr = typeof e.new_string === "string" ? e.new_string : "";
        const d = buildEditHunk(filePath, oldStr, newStr, read);
        hunks.push(...d.hunks);
        additions += d.additions;
        deletions += d.deletions;
      }
      if (hunks.length === 0) return null;
      return { filePath: basename(filePath), additions, deletions, hunks: hunks.slice(0, 20) };
    }

    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/activities/diff.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/activities/diff.ts apps/daemon/src/activities/diff.test.ts
git commit -m "feat(daemon): reconstruct edit diffs from hook payload"
```

---

## Task 5: Extend the `tool_use` signal with `detail` + `diff`

**Files:**
- Modify: `apps/daemon/src/activities/signals.ts`

- [ ] **Step 1: Add fields to the signal**

In `apps/daemon/src/activities/signals.ts`, in the `tool_use` member, add two fields after `category`:

```ts
  | {
      kind: "tool_use";
      goalId: string;
      workflowRunId: string;
      stepRunId: string;
      agentSessionId: string | null;
      category: ActivityWorkCategory;
      detail: string;
      diff: ActivityDiff | null;
    }
```

And add the import at the top:

```ts
import type {
  ActivityConfidence,
  ActivityDiff,
  ActivityWorkCategory,
  PendingQuestion
} from "@orca/contracts";
```

- [ ] **Step 2: Typecheck (expected to fail at call sites)**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: FAIL — `server.ts` and `updater.ts` build/consume `tool_use` without `detail`/`diff`. These are fixed in Tasks 6–7. (No commit yet; this task is folded into the next two. Proceed to Task 6.)

---

## Task 6: Store — persist & read steps; append on tool_use

**Files:**
- Modify: `apps/daemon/src/activities/store.ts`
- Modify: `apps/daemon/src/activities/projection.ts`
- Test: `apps/daemon/src/activities/store.steps.test.ts` (create)

This task introduces `appendActivityStep`, makes `completeLive` close the active step, and makes both row readers load steps. `openOrUpdateLive` keeps its overwrite behavior for the non-step signals (`step_started`, `permission_pending`, `weak_signal`) — it just no longer carries the substance; the substance comes from steps.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/activities/store.steps.test.ts`:

```ts
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { appendActivityStep, completeLive, getLiveForStepRun } from "./store.js";

function ctx() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT, goal_id TEXT, payload TEXT, created_at TEXT);
    CREATE TABLE activities (
      id TEXT PRIMARY KEY, goal_id TEXT, workflow_run_id TEXT, step_run_id TEXT,
      agent_session_id TEXT, turn_ordinal INTEGER, status TEXT, current_text TEXT,
      final_summary TEXT, source_kind TEXT, work_category TEXT, confidence TEXT,
      pending_question TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT);
    CREATE TABLE activity_steps (
      id TEXT PRIMARY KEY, activity_id TEXT, ordinal INTEGER, text TEXT,
      category TEXT, status TEXT, diff TEXT, created_at TEXT);
  `);
  let n = 0;
  return { db, bus: { publish() {} }, now: () => "2026-06-16T00:00:00.000Z", idFactory: () => `id-${n++}` };
}

const base = { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null };

describe("activity steps", () => {
  let c: ReturnType<typeof ctx>;
  beforeEach(() => { c = ctx(); });

  it("appends steps, flipping the prior active step to done", () => {
    appendActivityStep(c, { ...base, text: "Read verifier.ts", category: "reading", diff: null });
    appendActivityStep(c, { ...base, text: "Edited verifier.ts", category: "editing", diff: null });
    const live = getLiveForStepRun(c.db, "s1")!;
    expect(live.steps.map((s) => s.status)).toEqual(["done", "active"]);
    expect(live.steps.map((s) => s.text)).toEqual(["Read verifier.ts", "Edited verifier.ts"]);
  });

  it("stores the diff JSON on the step", () => {
    appendActivityStep(c, {
      ...base, text: "Edited verifier.ts", category: "editing",
      diff: { filePath: "verifier.ts", additions: 1, deletions: 0,
        hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "add", text: "x" }] }] },
    });
    expect(getLiveForStepRun(c.db, "s1")!.steps[0].diff?.additions).toBe(1);
  });

  it("completeLive marks the active step done and sets the summary", () => {
    appendActivityStep(c, { ...base, text: "Read verifier.ts", category: "reading", diff: null });
    completeLive(c, { stepRunId: "s1", finalSummary: "Found the bug.", confidence: null });
    const row = c.db.prepare("SELECT status, final_summary FROM activities WHERE step_run_id='s1'").get() as any;
    expect(row.status).toBe("completed");
    expect(row.final_summary).toBe("Found the bug.");
    const stepStatus = c.db.prepare("SELECT status FROM activity_steps").get() as any;
    expect(stepStatus.status).toBe("done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/activities/store.steps.test.ts`
Expected: FAIL — `appendActivityStep` not exported; `live.steps` undefined.

- [ ] **Step 3: Implement steps in `store.ts`**

In `apps/daemon/src/activities/store.ts`:

(a) Add imports at the top:

```ts
import {
  Activity,
  ActivityStep,
  PendingQuestion,
  type Activity as ActivityT,
  type ActivityConfidence,
  type ActivityDiff,
  type ActivitySourceKind,
  type ActivityStep as ActivityStepT,
  type ActivityWorkCategory,
  type DomainEvent,
  type PendingQuestion as PendingQuestionT
} from "@orca/contracts";
```

(b) Add a step loader and include steps in `rowToActivity`. Add this function above `rowToActivity`:

```ts
function loadSteps(db: Database.Database, activityId: string): ActivityStepT[] {
  const rows = db
    .prepare(
      `SELECT id, text, category, status, diff, created_at
       FROM activity_steps WHERE activity_id = ? ORDER BY ordinal ASC`
    )
    .all(activityId) as Array<{
      id: string; text: string; category: string | null;
      status: string; diff: string | null; created_at: string;
    }>;
  return rows.map((r) =>
    ActivityStep.parse({
      id: r.id,
      text: r.text,
      category: r.category,
      status: r.status,
      ...(r.diff ? { diff: JSON.parse(r.diff) } : {}),
      createdAt: r.created_at,
    })
  );
}
```

In `rowToActivity`, change the signature to accept the db and pass steps into the parse:

```ts
function rowToActivity(db: Database.Database, row: ActivityRow): ActivityT {
  // ...existing pendingQuestion block unchanged...
  return Activity.parse({
    // ...existing fields unchanged...
    steps: loadSteps(db, row.id),
  });
}
```

Update the three internal callers of `rowToActivity(row)` in this file to `rowToActivity(ctx?.db ?? db, row)` — specifically: `getActivityById` (pass its `db`), `getLiveForStepRun` (pass `db`), `getPausedForGoal` (pass `db`), and the `expireLive` local `rowToActivity(row)` (pass `ctx.db`). Each already has a `db`/`ctx.db` in scope.

(c) Add the `appendActivityStep` function (place after `openOrUpdateLive`):

```ts
export interface AppendStepInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  agentSessionId: string | null;
  text: string;
  category: ActivityWorkCategory | null;
  diff: ActivityDiff | null;
}

export function appendActivityStep(ctx: ActivityStoreCtx, input: AppendStepInput): ActivityT {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const now = currentTime(ctx);
    let live = getLiveForStepRun(ctx.db, input.stepRunId);

    // Create the activity lazily if no live one exists (defensive — normally
    // step_started already opened it).
    if (live === undefined) {
      const id = nextActivityId(ctx);
      const turnOrdinal = nextTurnOrdinal(ctx.db, input.stepRunId);
      ctx.db
        .prepare(
          `INSERT INTO activities (
             id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
             status, current_text, final_summary, source_kind, work_category, confidence,
             pending_question, created_at, updated_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', '', NULL, 'tool_use', ?, NULL, NULL, ?, ?, NULL)`
        )
        .run(id, input.goalId, input.workflowRunId, input.stepRunId, input.agentSessionId,
          turnOrdinal, input.category, now, now);
      live = getActivityById(ctx.db, id);
      if (live === undefined) throw new Error(`Activity insert failed: ${id}`);
    }

    // Close the current active step.
    ctx.db
      .prepare("UPDATE activity_steps SET status = 'done' WHERE activity_id = ? AND status = 'active'")
      .run(live.id);

    // Insert the new active step.
    const ord = (ctx.db
      .prepare("SELECT MAX(ordinal) AS m FROM activity_steps WHERE activity_id = ?")
      .get(live.id) as { m: number | null }).m;
    ctx.db
      .prepare(
        `INSERT INTO activity_steps (id, activity_id, ordinal, text, category, status, diff, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(nextActivityId(ctx), live.id, (ord ?? -1) + 1, input.text, input.category,
        input.diff ? JSON.stringify(input.diff) : null, now);

    // Mirror latest text + source onto the activity row (back-compat).
    ctx.db
      .prepare("UPDATE activities SET current_text = ?, source_kind = 'tool_use', work_category = ?, updated_at = ? WHERE id = ?")
      .run(input.text, input.category, now, live.id);

    const updated = getActivityById(ctx.db, live.id);
    if (updated === undefined) throw new Error(`Activity disappeared: ${live.id}`);
    event = insertActivityChangedEvent(ctx.db, updated, now);
    return updated;
  })();

  publishActivityChanged(ctx, event);
  return activity;
}
```

(d) In `completeLive`, close the active step. Inside its transaction, after the `UPDATE activities … status = 'completed' …` statement, add:

```ts
    ctx.db
      .prepare("UPDATE activity_steps SET status = 'done' WHERE activity_id = ? AND status = 'active'")
      .run(live.id);
```

- [ ] **Step 4: Mirror the step loader into `projection.ts`**

In `apps/daemon/src/activities/projection.ts`, add the same `loadSteps` helper (copy the function from Step 3b), import `ActivityStep` from `@orca/contracts`, and in `rowToActivity` add `steps: loadSteps(db, row.id),` to the `Activity.parse({...})`. Change `rowToActivity(row)` to `rowToActivity(db, row)` and update its single caller in `listActivitiesByGoal` (`.map((r) => rowToActivity(db, r))`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/activities/store.steps.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/activities/store.ts apps/daemon/src/activities/projection.ts apps/daemon/src/activities/store.steps.test.ts
git commit -m "feat(daemon): persist and load activity steps; append on tool_use"
```

---

## Task 7: Updater — route tool_use through appendActivityStep

**Files:**
- Modify: `apps/daemon/src/activities/updater.ts`
- Test: `apps/daemon/src/activities/updater.test.ts` (add cases; create file if absent)

- [ ] **Step 1: Write the failing test**

Create/append `apps/daemon/src/activities/updater.test.ts`:

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ActivityUpdater } from "./updater.js";
import { getLiveForStepRun } from "./store.js";

function ctx() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT, goal_id TEXT, payload TEXT, created_at TEXT);
    CREATE TABLE activities (
      id TEXT PRIMARY KEY, goal_id TEXT, workflow_run_id TEXT, step_run_id TEXT,
      agent_session_id TEXT, turn_ordinal INTEGER, status TEXT, current_text TEXT,
      final_summary TEXT, source_kind TEXT, work_category TEXT, confidence TEXT,
      pending_question TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT);
    CREATE TABLE activity_steps (
      id TEXT PRIMARY KEY, activity_id TEXT, ordinal INTEGER, text TEXT,
      category TEXT, status TEXT, diff TEXT, created_at TEXT);
  `);
  let n = 0;
  return { db, bus: { publish() {} }, now: () => "2026-06-16T00:00:00.000Z", idFactory: () => `id-${n++}` };
}
const sig = { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null };

describe("ActivityUpdater steps", () => {
  it("step_started opens an activity with no persisted steps", () => {
    const c = ctx();
    new ActivityUpdater().apply(c, { kind: "step_started", ...sig, stepName: "Root Cause" });
    expect(getLiveForStepRun(c.db, "s1")!.steps).toEqual([]);
  });

  it("tool_use appends a persisted step with detail + diff", () => {
    const c = ctx();
    const u = new ActivityUpdater();
    u.apply(c, { kind: "step_started", ...sig, stepName: "Root Cause" });
    u.apply(c, { kind: "tool_use", ...sig, category: "reading", detail: "Read verifier.ts", diff: null });
    const live = getLiveForStepRun(c.db, "s1")!;
    expect(live.steps.map((s) => s.text)).toEqual(["Read verifier.ts"]);
    expect(live.steps[0].status).toBe("active");
  });

  it("weak_signal appends no step", () => {
    const c = ctx();
    const u = new ActivityUpdater();
    u.apply(c, { kind: "step_started", ...sig, stepName: "Root Cause" });
    u.apply(c, { kind: "weak_signal_tick", ...sig });
    expect(getLiveForStepRun(c.db, "s1")!.steps).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/activities/updater.test.ts`
Expected: FAIL — `tool_use` currently overwrites `current_text` (no `steps` row), and the signal type lacks `detail`/`diff` so the test object is rejected by TS until Task 5 lands (Task 5 + 7 are committed together).

- [ ] **Step 3: Update the updater**

In `apps/daemon/src/activities/updater.ts`:

(a) Add the import:

```ts
import { appendActivityStep, /* existing: */ completeLive, expireLive, getLiveForStepRun, openOrUpdateLive, pauseForInput, type ActivityStoreCtx } from "./store.js";
```

(b) Replace the body of the `tool_use` case with an append, keeping the existing throttle:

```ts
      case "tool_use": {
        const now = this.nowMs();
        const state = this.perStep.get(signal.stepRunId);
        if (
          state?.lastCategory === signal.category &&
          now - state.lastUpdateMs < ACTIVITY_THROTTLE_MS
        ) {
          return;
        }

        appendActivityStep(ctx, {
          goalId: signal.goalId,
          workflowRunId: signal.workflowRunId,
          stepRunId: signal.stepRunId,
          agentSessionId: signal.agentSessionId,
          text: signal.detail,
          category: signal.category,
          diff: signal.diff,
        });
        this.perStep.set(signal.stepRunId, { lastUpdateMs: now, lastCategory: signal.category });
        return;
      }
```

(`step_started`, `weak_signal_tick`, `permission_pending`, `question_pending`, `turn_completed` cases are unchanged — `step_started` still opens the activity via `openOrUpdateLive`, which now simply sets `current_text` with no persisted step.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/activities/updater.test.ts`
Expected: PASS

- [ ] **Step 5: Commit (Tasks 5 + 7 together)**

```bash
git add apps/daemon/src/activities/signals.ts apps/daemon/src/activities/updater.ts apps/daemon/src/activities/updater.test.ts
git commit -m "feat(daemon): route tool_use through appendActivityStep with detail+diff"
```

---

## Task 8: Wire the hook — thread detail + diff at `onToolUse`

**Files:**
- Modify: `apps/daemon/src/server.ts` (~line 1385-1392, and the imports near line 184)

- [ ] **Step 1: Update imports**

In `apps/daemon/src/server.ts`, change the activities import (line ~184) to also bring in the new helpers:

```ts
import { categorizeClaudeTool, narrateToolDetail } from './activities/claude-adapter.js';
import { reconstructEditDiff } from './activities/diff.js';
```

- [ ] **Step 2: Update the `onToolUse` signal construction**

Replace the `applyActivitySafely("agent.tool_use", {...})` call (~line 1388) with:

```ts
      applyActivitySafely("agent.tool_use", {
        kind: "tool_use",
        ...stepContext,
        category: categorizeClaudeTool(payload.toolName, payload.toolInput),
        detail: narrateToolDetail(payload.toolName, payload.toolInput),
        diff: reconstructEditDiff(payload.toolName, payload.toolInput),
      });
```

- [ ] **Step 3: Typecheck the daemon**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: PASS (all `tool_use` producers/consumers now agree).

- [ ] **Step 4: Run the full daemon test suite**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS. If any existing activity test asserted on the old overwrite behaviour (e.g. expected a `weak_signal`/`step_started` `current_text` to be the live "line"), update that assertion to read `steps` instead — these are legitimate behaviour changes, not regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/server.ts
git commit -m "feat(daemon): attach tool detail + diff to activity tool_use signal"
```

---

## Task 9: Desktop — `AgentActivity` component (checklist + diff)

**Files:**
- Create: `apps/desktop/src/orchestrator/AgentActivity.tsx`
- Create: `apps/desktop/src/orchestrator/AgentActivity.test.tsx`
- Modify: `apps/desktop/src/orchestrator/orca-chat.css` (append styles)

The component renders one card: header (`stepName`), the step checklist (done = check + muted; active = pulsing dots), expandable diffs, and the final summary. It supersedes `ActivityThread`'s `LiveActivity`/`ActivityCard` for non-`step_result` activities.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/orchestrator/AgentActivity.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Activity } from "@orca/contracts";
import { AgentActivity } from "./AgentActivity";

const baseActivity = (over: Partial<Activity>): Activity => ({
  id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null,
  turnOrdinal: 0, status: "active", currentText: "", finalSummary: null,
  sourceKind: "tool_use", workCategory: null, confidence: null, stepName: "Root Cause",
  steps: [], createdAt: "2026-06-16T00:00:00.000Z", updatedAt: "2026-06-16T00:00:00.000Z",
  completedAt: null, ...over,
});

describe("AgentActivity", () => {
  it("renders done steps with a check and the active step as a pulse", () => {
    render(<AgentActivity activity={baseActivity({
      steps: [
        { id: "1", text: "Read verifier.ts", category: "reading", status: "done", createdAt: "t" },
        { id: "2", text: "Ran tests: pnpm test", category: "testing", status: "active", createdAt: "t" },
      ],
    })} />);
    expect(screen.getByText("Read verifier.ts")).toBeTruthy();
    expect(screen.getByTestId("agent-activity-active").textContent).toContain("Ran tests: pnpm test");
  });

  it("shows the closing summary when completed", () => {
    render(<AgentActivity activity={baseActivity({
      status: "completed", finalSummary: "Found the double-charge bug.",
      steps: [{ id: "1", text: "Read verifier.ts", category: "reading", status: "done", createdAt: "t" }],
    })} />);
    expect(screen.getByText("Found the double-charge bug.")).toBeTruthy();
  });

  it("expands an edit step into its diff", () => {
    render(<AgentActivity activity={baseActivity({
      steps: [{ id: "1", text: "Edited verifier.ts", category: "editing", status: "done", createdAt: "t",
        diff: { filePath: "verifier.ts", additions: 1, deletions: 1, hunks: [{ oldStart: 42, newStart: 42,
          lines: [{ kind: "remove", text: "old()" }, { kind: "add", text: "new()" }] }] } }],
    })} />);
    expect(screen.queryByText("old()")).toBeNull();        // collapsed by default
    fireEvent.click(screen.getByTestId("agent-activity-diff-toggle"));
    expect(screen.getByText("old()")).toBeTruthy();
    expect(screen.getByText("new()")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/AgentActivity.test.tsx`
Expected: FAIL — `./AgentActivity` does not exist.

- [ ] **Step 3: Implement `AgentActivity.tsx`**

Create `apps/desktop/src/orchestrator/AgentActivity.tsx`:

```tsx
import { useState } from "react";
import type { Activity, ActivityDiff, ActivityStep } from "@orca/contracts";

export function AgentActivity({ activity }: { activity: Activity }) {
  const completed = activity.status === "completed";
  // The active line is the last step still marked active; if there is none yet
  // (step opened, no tool call run), fall back to a single pulse.
  const activeStep = [...activity.steps].reverse().find((s) => s.status === "active") ?? null;
  const doneSteps = activity.steps.filter((s) => s.status === "done");
  const showInitialPulse = !completed && activeStep === null && activity.steps.length === 0;

  return (
    <div className="agent-activity" data-testid="agent-activity" data-status={activity.status}>
      {activity.stepName ? <div className="agent-activity-head">{activity.stepName}</div> : null}
      <div className="agent-activity-steps">
        {doneSteps.map((step) => (
          <StepRow key={step.id} step={step} done />
        ))}
        {activeStep ? <StepRow key={activeStep.id} step={activeStep} done={false} /> : null}
        {showInitialPulse ? (
          <div className="agent-activity-step" data-testid="agent-activity-active">
            <Pulse />
            <span className="agent-activity-step-text">{activity.stepName ?? "Working…"}</span>
          </div>
        ) : null}
      </div>
      {completed && activity.finalSummary ? (
        <div className="agent-activity-summary">{activity.finalSummary}</div>
      ) : null}
    </div>
  );
}

function StepRow({ step, done }: { step: ActivityStep; done: boolean }) {
  return (
    <div
      className="agent-activity-step"
      data-testid={done ? "agent-activity-done" : "agent-activity-active"}
    >
      {done ? <Check /> : <Pulse />}
      <span className={`agent-activity-step-text${done ? " is-done" : ""}`}>{step.text}</span>
      {step.diff ? <DiffBlock diff={step.diff} /> : null}
    </div>
  );
}

function DiffBlock({ diff }: { diff: ActivityDiff }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="agent-activity-diff">
      <button
        type="button"
        className="agent-activity-diff-toggle"
        data-testid="agent-activity-diff-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="agent-activity-diff-chevron">{open ? "▾" : "▸"}</span>
        <span className="agent-activity-diff-file">{diff.filePath}</span>
        <span className="agent-activity-diff-stat">
          <span className="diff-add">+{diff.additions}</span>{" "}
          <span className="diff-del">−{diff.deletions}</span>
        </span>
      </button>
      {open ? (
        <pre className="agent-activity-diff-body">
          {diff.hunks.flatMap((hunk, hi) =>
            hunk.lines.map((line, li) => {
              const oldNo = hunk.oldStart;
              const newNo = hunk.newStart;
              return (
                <div key={`${hi}-${li}`} className={`diff-line diff-line--${line.kind}`}>
                  <span className="diff-gutter">
                    {newNo === null ? "" : line.kind === "remove" ? "-" : "+"}
                  </span>
                  <span className="diff-text">{line.text}</span>
                </div>
              );
            })
          )}
        </pre>
      ) : null}
    </div>
  );
}

function Check() {
  return (
    <svg className="agent-activity-check" width="13" height="13" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function Pulse() {
  return (
    <span className="thinking-dots agent-activity-pulse" aria-hidden>
      <span style={{ animationDelay: "0s" }} />
      <span style={{ animationDelay: "0.18s" }} />
      <span style={{ animationDelay: "0.36s" }} />
    </span>
  );
}
```

- [ ] **Step 4: Add styles**

Append to `apps/desktop/src/orchestrator/orca-chat.css`:

```css
.agent-activity { border: 1px solid var(--border, rgba(255,255,255,0.10)); border-radius: 10px; padding: 10px 12px; margin: 6px 0; }
.agent-activity-head { font-weight: 600; margin-bottom: 6px; }
.agent-activity-steps { display: flex; flex-direction: column; gap: 4px; }
.agent-activity-step { display: flex; align-items: flex-start; gap: 8px; }
.agent-activity-step-text.is-done { opacity: 0.6; }
.agent-activity-check { color: #3fb950; flex: 0 0 auto; margin-top: 2px; }
.agent-activity-pulse { margin-top: 6px; }
.agent-activity-summary { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); }
.agent-activity-diff { width: 100%; margin-top: 4px; }
.agent-activity-diff-toggle { display: inline-flex; align-items: center; gap: 6px; background: none; border: none; color: inherit; cursor: pointer; font: inherit; padding: 0; }
.agent-activity-diff-file { font-family: var(--mono, monospace); opacity: 0.85; }
.diff-add { color: #3fb950; }
.diff-del { color: #f85149; }
.agent-activity-diff-body { margin: 4px 0 0; overflow-x: auto; font-family: var(--mono, monospace); font-size: 12px; }
.diff-line { display: flex; gap: 8px; white-space: pre; }
.diff-line--add { background: rgba(63,185,80,0.12); }
.diff-line--remove { background: rgba(248,81,73,0.12); }
.diff-gutter { width: 1ch; opacity: 0.7; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/AgentActivity.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/orchestrator/AgentActivity.tsx apps/desktop/src/orchestrator/AgentActivity.test.tsx apps/desktop/src/orchestrator/orca-chat.css
git commit -m "feat(desktop): AgentActivity card with step checklist and inline diffs"
```

---

## Task 10: Desktop — render persisted activity cards in the timeline

**Files:**
- Modify: `apps/desktop/src/orchestrator/ActivityThread.tsx`
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx` (add a case)

The timeline must now include every agent activity that has steps (active/paused/completed), each as one persisted `AgentActivity` card, and stop rendering the separate ephemeral tail bubble for them. `step_result` cards stay as they are.

- [ ] **Step 1: Broaden `isTimelineCard` (failing via the OrcaChat test below)**

In `apps/desktop/src/orchestrator/ActivityThread.tsx`, update `isTimelineCard` and add a helper that recognises step-bearing activities:

```ts
// A turn-level agent activity that owns a persisted card (it has accumulated
// steps or a meaningful summary). step_result keeps its dedicated card.
export function isAgentActivityCard(activity: Activity): boolean {
  return (
    activity.sourceKind !== "step_result" &&
    activity.sourceKind !== "step_confirmation_pending" &&
    activity.sourceKind !== "provider_recovery_pending" &&
    (activity.steps.length > 0 || isMeaningfulCompleted(activity))
  );
}

export function isTimelineCard(activity: Activity): boolean {
  return activity.sourceKind === "step_result" || isAgentActivityCard(activity);
}
```

Keep `pickLiveActivity` for the confirmation/recovery/question pause cases only — change it to ignore activities that are rendered as cards:

```ts
export function pickLiveActivity(activities: Activity[]): Activity | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (
      activity?.status === "paused_for_input" &&
      (activity.sourceKind === "step_confirmation_pending" ||
        activity.sourceKind === "provider_recovery_pending" ||
        activity.pendingQuestion != null)
    ) {
      return activity;
    }
  }
  return null;
}
```

- [ ] **Step 2: Render `AgentActivity` for card entries in `OrcaChat`**

In `apps/desktop/src/orchestrator/OrcaChat.tsx`:

(a) Add the import:

```ts
import { AgentActivity } from "./AgentActivity";
```

(b) In the timeline map (the `entry.kind === "card"` branch, ~line 690), render `AgentActivity` for agent-activity cards and keep `ActivityCard` for `step_result`:

```tsx
            {timeline.map((entry) =>
              entry.kind === "message" ? (
                <ChatMessageRow
                  key={entry.key}
                  message={entry.message}
                  goalId={selectedGoalId ?? ""}
                />
              ) : entry.activity.sourceKind === "step_result" ? (
                <ActivityCard key={entry.key} activity={entry.activity} />
              ) : (
                <AgentActivity key={entry.key} activity={entry.activity} />
              )
            )}
```

(c) The `liveActivity` tail block stays — but it now only fires for the confirmation/recovery/question pauses (`pickLiveActivity` was narrowed in Step 1), so the flickering tool bubble is gone while pause interactions still render their forms.

- [ ] **Step 3: Add an OrcaChat timeline test**

Add to `apps/desktop/src/orchestrator/OrcaChat.test.tsx` a case asserting that an activity with steps renders an `agent-activity` card in the timeline and persists after completion. Follow the existing harness in that file for mounting `OrcaChat` with mocked `listActivities`/`listOrchestratorMessages`; assert:

```ts
expect(await screen.findByTestId("agent-activity")).toBeTruthy();
```

(Use the file's established mock setup — match the existing tests' import of the api module and their goal/connection props.)

- [ ] **Step 4: Run desktop tests**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/OrcaChat.test.tsx src/orchestrator/AgentActivity.test.tsx`
Expected: PASS. If an existing OrcaChat/ActivityThread test asserted on the old `activity-bubble` tail behaviour for tool activity, update it to assert on the `agent-activity` card — this is the intended change.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @orca/desktop typecheck`

```bash
git add apps/desktop/src/orchestrator/ActivityThread.tsx apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): render persisted AgentActivity cards in the chat timeline"
```

---

## Task 11: Desktop — transient orchestrator routing card

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx` (the `ThinkingRow` tail used while awaiting a reply)

Evolve the existing `awaitingReply`/`sendingMessage` thinking-dots into a small synthetic phase checklist that collapses when the reply lands. No persistence, no backend.

- [ ] **Step 1: Add a `RoutingCard` component**

In `apps/desktop/src/orchestrator/OrcaChat.tsx`, add near `ThinkingRow`:

```tsx
function RoutingCard() {
  return (
    <div className="msg msg--orca">
      <OrcaMark />
      <div className="agent-activity" data-testid="routing-card">
        <div className="agent-activity-steps">
          <div className="agent-activity-step">
            <svg className="agent-activity-check" width="13" height="13" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span className="agent-activity-step-text is-done">Reading your message</span>
          </div>
          <div className="agent-activity-step">
            <span className="thinking-dots agent-activity-pulse" aria-hidden>
              <span style={{ animationDelay: "0s" }} />
              <span style={{ animationDelay: "0.18s" }} />
              <span style={{ animationDelay: "0.36s" }} />
            </span>
            <span className="agent-activity-step-text">Working out a response</span>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Swap the awaiting-reply indicator to use it**

Replace the `(sendingMessage || awaitingReply)` block (~line 731) with:

```tsx
            {(sendingMessage || awaitingReply) && (
              <div data-testid="awaiting-reply">
                <RoutingCard />
              </div>
            )}
```

(The `showStarting` first-turn step indicator keeps using `ThinkingRow` — leave it unchanged.)

- [ ] **Step 3: Run desktop tests**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/OrcaChat.test.tsx`
Expected: PASS. If a test asserted the old thinking-dots `label="orchestrator"` text while awaiting a reply, update it to assert `getByTestId("routing-card")`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx
git commit -m "feat(desktop): transient orchestrator routing card while awaiting reply"
```

---

## Task 12: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole workspace**

Run: `pnpm typecheck`
Expected: PASS for `@orca/contracts`, `@orca/daemon`, `@orca/desktop`.

- [ ] **Step 2: Run all tests**

Run: `pnpm test`
Expected: PASS. Triage any failures: behaviour-change assertions (old overwrite/tail-bubble expectations) should be updated to the new step/card model; genuine regressions must be fixed.

- [ ] **Step 3: Manual smoke (daemon already running in `daemon-terminal` tmux)**

Start a workflow on a goal, send a chat message, and confirm in the desktop app:
- a routing card appears, then collapses into the persisted reply;
- the step agent's card accumulates specific steps ("Read X", "Ran tests: …") with checks;
- an edit step expands into a diff with line numbers + context;
- after the turn, the card persists with all checks + a summary, and survives a goal re-select / reload.

- [ ] **Step 4: Final commit (if any triage edits were made)**

```bash
git add -A
git commit -m "test: update activity assertions to the persisted step/card model"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** Task 1 (contract `steps`/`diff`), Task 2 (`activity_steps` table), Task 3 (`narrateToolDetail`), Task 4 (hook-reconstructed diffs), Tasks 5–8 (append-on-tool_use, drop weak-signal step, no "Watching" step, hook wiring), Tasks 9–10 (one persisted `AgentActivity` card, timeline consolidation, remove tail bubble), Task 11 (transient routing card). Auto-collapse is intentionally out of scope (spec §"Out of scope").
- **No "Watching…" step:** enforced by leaving `step_started` on `openOrUpdateLive` (no `activity_steps` insert); the first persisted step is the first `tool_use`.
- **Back-compat:** `Activity.steps` defaults to `[]`; pre-migration activities render via the initial-pulse / summary fallbacks.
- **Type consistency check:** `appendActivityStep` (store) ↔ `appendActivityStep` call (updater); `reconstructEditDiff` signature ↔ server call; `ActivityStep`/`ActivityDiff` field names identical across contracts, store JSON (de)serialization, and the React component.
