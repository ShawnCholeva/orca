# Workspaces First-Class Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote workspaces from per-goal repo attachments to first-class entities (workspace == repo) with a `goal_workspaces` junction, a workspaces registry + CRUD endpoints, and a `completed` goal status — then back the desktop Workspaces tab with real data instead of seeds.

**Architecture:** A canonical `workspaces` entity table (`id, path, name, description, created_at, updated_at`) plus a `goal_workspaces` junction make workspaces many-to-many with goals. The daemon exposes `GET /v1/workspaces` (aggregate list), `GET /v1/workspaces/:id` (entity + its goals with progress), `POST /v1/workspaces` (standalone create), and `PATCH /v1/workspaces/:id` (rename/describe). Goal completion is set when the goal's single workflow run completes. The desktop tab consumes these endpoints; git probing stays transient (inspect only).

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), Fastify + better-sqlite3 (daemon), React 18 + Vitest + Testing Library (desktop), Tauri dialog plugin.

## Global Constraints

- `workspace == repo`: one canonical workspace per canonical filesystem `path` (UNIQUE).
- Goal ↔ workspace is many-to-many via `goal_workspaces`.
- `GoalStatus = active | completed | archived`. `completed` is set only by workflow-run completion; `archived` stays the existing manual action.
- Git fields (`workspaceType`, `branch`, `isDirty`, `gitProbe`) are NEVER persisted on the entity — they remain transient on `InspectWorkspacePreview` only.
- No delete-workspace, no live-session indicators in v1.
- Follow existing patterns: prepared-statement projections, `db.transaction(() => …)` then `bus.publish` after commit, Zod-validated request/response, TDD with frequent commits.
- Spec: `docs/superpowers/specs/2026-06-19-workspaces-first-class-design.md`.

---

## File Structure

**Contracts** — `packages/contracts/src/index.ts` (+ `index.test.ts`): `GoalStatus`, `Workspace` reshape, standalone `InspectWorkspacePreview`, new workspace request/response schemas, event types.

**Daemon**
- `apps/daemon/src/migrations/0036_workspaces_first_class.sql` (new) + `migrations.ts` (register + FK-off special-case).
- `apps/daemon/src/workspaces/projection.ts` (rewrite: entity + junction + aggregates).
- `apps/daemon/src/workspaces/usecases.ts` (rewrite: create/update/attach/detach).
- `apps/daemon/src/server.ts` (new routes + reshape goal-detail workspaces).
- `apps/daemon/src/workflows/runs/usecases.ts` (`completeWorkflowRun` sets `status='completed'`).

**Desktop**
- `apps/desktop/src/api.ts` (new workspace functions).
- `apps/desktop/src/workspaces/data.ts` (remove seeds; 3-state meta; keep `slugify`).
- `apps/desktop/src/workspaces/WorkspacesPage.tsx` (consume real API).
- `apps/desktop/src/goal-detail/WorkspaceListPanel.tsx` (drop persisted git chips).
- `apps/desktop/src/create-goal-flow/*` + `App.tsx` (pre-seed workspace into New Goal).
- `apps/desktop/src/workspaces/WorkspacesPage.test.tsx` (rewrite for real API mocks).

---

## PHASE 1 — Contracts

### Task 1: Reshape contracts for first-class workspaces

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/index.test.ts`

**Interfaces:**
- Produces:
  - `GoalStatus = z.enum(["active","completed","archived"])`
  - `Workspace = { id, path, name, description, createdAt, updatedAt }`
  - `InspectWorkspacePreview = { path, name, workspaceType, branch, isDirty, gitProbe }` (standalone)
  - `WorkspaceSummary = Workspace & { goalCounts: { active:number, completed:number, archived:number } }`
  - `WorkspaceGoalView = { id, title, description, status: GoalStatus, createdAt, progress: number | null }`
  - `ListWorkspacesResponse = { workspaces: WorkspaceSummary[] }`
  - `GetWorkspaceResponse = { workspace: Workspace, goals: WorkspaceGoalView[] }`
  - `CreateWorkspaceRequest = { inputPath: string, name?: string, description?: string }`
  - `CreateWorkspaceResponse = { workspace: Workspace }`
  - `UpdateWorkspaceRequest = { name?: string, description?: string }`
  - `UpdateWorkspaceResponse = { workspace: Workspace }`
  - `DomainEventType` adds `"workspace.created"`, `"workspace.updated"`

- [ ] **Step 1: Write failing tests**

Add to `packages/contracts/src/index.test.ts`:

```ts
import {
  GoalStatus, Workspace, InspectWorkspacePreview, WorkspaceSummary,
  ListWorkspacesResponse, GetWorkspaceResponse,
  CreateWorkspaceRequest, UpdateWorkspaceRequest, DomainEventType,
} from "./index";

describe("first-class workspace contracts", () => {
  it("GoalStatus includes completed", () => {
    expect(GoalStatus.parse("completed")).toBe("completed");
    expect(() => GoalStatus.parse("paused")).toThrow();
  });

  it("Workspace is the lean entity (no goalId/git fields)", () => {
    const ws = Workspace.parse({
      id: "w1", path: "/repo/a", name: "a", description: "",
      createdAt: "2026-06-19T00:00:00.000Z", updatedAt: "2026-06-19T00:00:00.000Z",
    });
    expect(ws.path).toBe("/repo/a");
    expect(() => Workspace.parse({ id: "w1", goalId: "g1" } as unknown)).toThrow();
  });

  it("InspectWorkspacePreview keeps transient git fields", () => {
    const p = InspectWorkspacePreview.parse({
      path: "/repo/a", name: "a", workspaceType: "repo",
      branch: "main", isDirty: false, gitProbe: "ok",
    });
    expect(p.gitProbe).toBe("ok");
  });

  it("WorkspaceSummary carries goalCounts", () => {
    const s = WorkspaceSummary.parse({
      id: "w1", path: "/repo/a", name: "a", description: "",
      createdAt: "2026-06-19T00:00:00.000Z", updatedAt: "2026-06-19T00:00:00.000Z",
      goalCounts: { active: 2, completed: 1, archived: 0 },
    });
    expect(s.goalCounts.active).toBe(2);
  });

  it("GetWorkspaceResponse carries goals with nullable progress", () => {
    const r = GetWorkspaceResponse.parse({
      workspace: { id: "w1", path: "/r", name: "a", description: "",
        createdAt: "2026-06-19T00:00:00.000Z", updatedAt: "2026-06-19T00:00:00.000Z" },
      goals: [{ id: "g1", title: "T", description: "D", status: "active",
        createdAt: "2026-06-19T00:00:00.000Z", progress: 0.5 },
        { id: "g2", title: "T2", description: "", status: "completed",
        createdAt: "2026-06-19T00:00:00.000Z", progress: null }],
    });
    expect(r.goals[1]!.progress).toBeNull();
  });

  it("Create/Update requests validate", () => {
    expect(CreateWorkspaceRequest.parse({ inputPath: "/r" }).inputPath).toBe("/r");
    expect(() => CreateWorkspaceRequest.parse({ inputPath: "" })).toThrow();
    expect(UpdateWorkspaceRequest.parse({ name: "x" }).name).toBe("x");
  });

  it("new workspace event types parse", () => {
    expect(DomainEventType.parse("workspace.created")).toBe("workspace.created");
    expect(DomainEventType.parse("workspace.updated")).toBe("workspace.updated");
  });

  it("ListWorkspacesResponse parses", () => {
    expect(ListWorkspacesResponse.parse({ workspaces: [] }).workspaces).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --filter @orca/contracts test -- index.test.ts`
Expected: FAIL (e.g. `completed` rejected, `Workspace` still requires `goalId`).

- [ ] **Step 3: Edit `index.ts`**

Change `GoalStatus` (line ~25):
```ts
export const GoalStatus = z.enum(["active", "completed", "archived"]);
```

Replace the `Workspace` block (currently lines ~283–294) with the lean entity, and make `InspectWorkspacePreview` standalone:
```ts
export const Workspace = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  description: z.string().default(""),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type Workspace = z.infer<typeof Workspace>;

export const InspectWorkspacePreview = z.object({
  path: z.string(),
  name: z.string(),
  workspaceType: WorkspaceType,
  branch: z.string().nullable(),
  isDirty: z.boolean().nullable(),
  gitProbe: GitProbe
});
export type InspectWorkspacePreview = z.infer<typeof InspectWorkspacePreview>;
```
(Keep `WorkspaceType` and `GitProbe` enums — still used by the preview. Remove the old `Workspace.omit(...)` definition of `InspectWorkspacePreview`.)

Add new schemas (near the other workspace schemas):
```ts
export const WorkspaceSummary = Workspace.extend({
  goalCounts: z.object({
    active: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative()
  })
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const WorkspaceGoalView = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: GoalStatus,
  createdAt: z.string().datetime(),
  progress: z.number().min(0).max(1).nullable()
});
export type WorkspaceGoalView = z.infer<typeof WorkspaceGoalView>;

export const ListWorkspacesResponse = z.object({ workspaces: z.array(WorkspaceSummary) });
export type ListWorkspacesResponse = z.infer<typeof ListWorkspacesResponse>;

export const GetWorkspaceResponse = z.object({
  workspace: Workspace,
  goals: z.array(WorkspaceGoalView)
});
export type GetWorkspaceResponse = z.infer<typeof GetWorkspaceResponse>;

export const CreateWorkspaceRequest = z.object({
  inputPath: z.string().min(1).max(1024),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional()
}).strict();
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

export const CreateWorkspaceResponse = z.object({ workspace: Workspace });
export type CreateWorkspaceResponse = z.infer<typeof CreateWorkspaceResponse>;

export const UpdateWorkspaceRequest = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional()
}).strict();
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequest>;

export const UpdateWorkspaceResponse = z.object({ workspace: Workspace });
export type UpdateWorkspaceResponse = z.infer<typeof UpdateWorkspaceResponse>;
```

In `DomainEventType = z.enum([...])` (line ~149), add after `"workspace.removed"`:
```ts
  "workspace.created",
  "workspace.updated",
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @orca/contracts test`
Expected: PASS. Then `pnpm --filter @orca/contracts typecheck` — this will surface daemon/desktop type breaks handled in later tasks; contracts package itself must compile.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): first-class workspace + completed goal status schemas"
```

---

## PHASE 2 — Daemon

### Task 2: Migration — split workspaces into entity + junction, remap tasks

**Files:**
- Create: `apps/daemon/src/migrations/0036_workspaces_first_class.sql`
- Modify: `apps/daemon/src/migrations.ts` (register file + FK-off special-case)
- Test: `apps/daemon/src/migrations.test.ts`

**Interfaces:**
- Produces tables: `workspaces (id, path UNIQUE, name, description, created_at, updated_at)`, `goal_workspaces (goal_id, workspace_id, attached_at, PK(goal_id, workspace_id))`. `tasks.workspace_id` repointed to new entity ids.

- [ ] **Step 1: Write failing test**

Add to `apps/daemon/src/migrations.test.ts` (follow the file's existing harness for opening an in-memory db and running migrations up to a point — mirror an existing test's setup):

```ts
it("0036 migrates per-goal workspaces into entity + junction and remaps tasks", () => {
  const db = new Database(":memory:");
  // apply everything BEFORE 0036
  applyMigrationsUpTo(db, "0035_orchestrator_message_pending_revision.sql");
  const now = "2026-06-19T00:00:00.000Z";
  db.exec(`INSERT INTO goals (id,title,description,status,created_at,updated_at) VALUES
    ('g1','G1','','active','${now}','${now}'),('g2','G2','','active','${now}','${now}')`);
  // same path attached to two goals -> one entity, two links
  db.exec(`INSERT INTO workspaces (id,goal_id,path,name,workspace_type,branch,is_dirty,git_probe,attached_at) VALUES
    ('ws1','g1','/repo/a','a','repo','main',0,'ok','${now}'),
    ('ws2','g2','/repo/a','a','repo','main',0,'ok','${now}'),
    ('ws3','g1','/repo/b','b','repo',NULL,NULL,'not_a_repo','${now}')`);
  db.exec(`INSERT INTO tasks (id,goal_id,parent_task_id,workspace_id,role,status,title,description,created_at,updated_at)
    VALUES ('t1','g1',NULL,'ws3','engineer','pending','T','','${now}','${now}')`);

  applyMigration(db, "0036_workspaces_first_class.sql");

  const entities = db.prepare("SELECT path FROM workspaces ORDER BY path").all() as { path: string }[];
  expect(entities.map((e) => e.path)).toEqual(["/repo/a", "/repo/b"]);
  const links = db.prepare("SELECT count(*) AS c FROM goal_workspaces").get() as { c: number };
  expect(links.c).toBe(3);
  // tasks.workspace_id now points at the /repo/b entity
  const taskWs = db.prepare(
    "SELECT w.path FROM tasks t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id='t1'"
  ).get() as { path: string };
  expect(taskWs.path).toBe("/repo/b");
  // entity has no git columns
  const cols = db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[];
  expect(cols.map((c) => c.name)).toEqual(
    ["id","path","name","description","created_at","updated_at"]);
});
```

> If `migrations.test.ts` lacks `applyMigrationsUpTo` / `applyMigration` helpers, add small local helpers that read each SQL file from `migrations/` and `db.exec` it in `migrationFiles` order, replicating the FK-off handling from `runMigrations` for `0011` and `0036`. Reuse the file's existing `Database` import.

- [ ] **Step 2: Run test, verify fail**

Run: `pnpm --filter @orca/daemon test -- migrations.test.ts`
Expected: FAIL (table `goal_workspaces` does not exist).

- [ ] **Step 3: Write the migration SQL**

Create `apps/daemon/src/migrations/0036_workspaces_first_class.sql`:

```sql
-- Promote workspaces to first-class entities (workspace == repo) and make
-- goal<->workspace many-to-many. Runs with foreign_keys OFF (see migrations.ts).

CREATE TABLE workspaces_new (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE goal_workspaces (
  goal_id      TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  attached_at  TEXT NOT NULL,
  PRIMARY KEY (goal_id, workspace_id),
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces_new(id) ON DELETE CASCADE
);

-- distinct path -> one new entity id (name/created_at from earliest attachment)
CREATE TEMP TABLE ws_map AS
SELECT
  path,
  lower(hex(randomblob(16))) AS new_id,
  (SELECT w2.name FROM workspaces w2
     WHERE w2.path = w.path ORDER BY w2.attached_at ASC, w2.id ASC LIMIT 1) AS name,
  MIN(attached_at) AS created_at
FROM workspaces w
GROUP BY path;

INSERT INTO workspaces_new (id, path, name, description, created_at, updated_at)
SELECT new_id, path, name, '', created_at, created_at FROM ws_map;

-- old workspace id -> new entity id, for the tasks remap
CREATE TEMP TABLE ws_idmap AS
SELECT w.id AS old_id, m.new_id AS new_id
FROM workspaces w JOIN ws_map m ON m.path = w.path;

INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at)
SELECT w.goal_id, m.new_id, w.attached_at
FROM workspaces w JOIN ws_map m ON m.path = w.path;

UPDATE tasks
SET workspace_id = (SELECT new_id FROM ws_idmap WHERE old_id = tasks.workspace_id)
WHERE workspace_id IS NOT NULL;

DROP TABLE workspaces;
ALTER TABLE workspaces_new RENAME TO workspaces;

CREATE INDEX idx_goal_workspaces_workspace ON goal_workspaces(workspace_id);

DROP TABLE ws_map;
DROP TABLE ws_idmap;
```

- [ ] **Step 4: Register in `migrations.ts`**

Add the filename to `migrationFiles` (after `0035_orchestrator_message_pending_revision.sql`):
```ts
  "0036_workspaces_first_class.sql",
```
Add a constant near the other migration constants (top of file):
```ts
const WORKSPACES_FIRST_CLASS_MIGRATION = "0036_workspaces_first_class.sql";
```
In `runMigrations`, add a special-case branch mirroring `WORKFLOW_RECOMMENDATION_TYPES_MIGRATION` (FK off outside the transaction). Place it alongside that branch:
```ts
    if (file === WORKSPACES_FIRST_CLASS_MIGRATION) {
      const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
      db.pragma("foreign_keys = OFF");
      try {
        db.transaction(() => {
          db.exec(sql);
          insertMigration.run(file, now);
        })();
      } finally {
        db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
      }
      applied.push(file);
      continue;
    }
```

- [ ] **Step 5: Run test, verify pass**

Run: `pnpm --filter @orca/daemon test -- migrations.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/migrations/0036_workspaces_first_class.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts
git commit -m "feat(daemon): migration splitting workspaces into entity + junction"
```

---

### Task 3: Rewrite the workspaces projection (entity + junction + aggregates)

**Files:**
- Modify: `apps/daemon/src/workspaces/projection.ts`
- Test: `apps/daemon/src/workspaces/projection.test.ts`

**Interfaces:**
- Produces:
  - `findWorkspaceById(db, id): Workspace | null`
  - `findWorkspaceByPath(db, path): Workspace | null`  *(global, no goalId)*
  - `insertWorkspaceEntity(db, ws: Workspace): void`
  - `updateWorkspaceEntity(db, id, patch: { name?, description? }, updatedAt): Workspace | null`
  - `linkGoalWorkspace(db, goalId, workspaceId, attachedAt): void`
  - `unlinkGoalWorkspace(db, goalId, workspaceId): boolean`
  - `listWorkspaceSummaries(db): WorkspaceSummary[]`
  - `listWorkspacesByGoal(db, goalId): Workspace[]`  *(via junction — keeps goal-detail working)*
  - `listGoalViewsForWorkspace(db, workspaceId): WorkspaceGoalView[]`
  - `DuplicateWorkspaceError(path)` (now path-only)
- Consumes: `Workspace`, `WorkspaceSummary`, `WorkspaceGoalView` from Task 1.

- [ ] **Step 1: Write failing tests**

Rewrite `projection.test.ts` to exercise the new surface (replace the old per-goal tests). Use an in-memory db migrated to head. Core cases:

```ts
import Database from "better-sqlite3";
import { runMigrations, defaultMigrationsDir } from "../migrations.js";
import * as P from "./projection.js";

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db, defaultMigrationsDir());
  P.resetPreparedStatements();
  return db;
}
const ISO = "2026-06-19T00:00:00.000Z";
function goal(db: Database.Database, id: string, status = "active") {
  db.prepare("INSERT INTO goals (id,title,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, id, "", status, ISO, ISO);
}

it("insert + find by id and path", () => {
  const db = freshDb();
  P.insertWorkspaceEntity(db, { id: "w1", path: "/r/a", name: "a", description: "", createdAt: ISO, updatedAt: ISO });
  expect(P.findWorkspaceById(db, "w1")!.path).toBe("/r/a");
  expect(P.findWorkspaceByPath(db, "/r/a")!.id).toBe("w1");
  expect(P.findWorkspaceByPath(db, "/nope")).toBeNull();
});

it("update entity returns patched row", () => {
  const db = freshDb();
  P.insertWorkspaceEntity(db, { id: "w1", path: "/r/a", name: "a", description: "", createdAt: ISO, updatedAt: ISO });
  const out = P.updateWorkspaceEntity(db, "w1", { name: "renamed", description: "d" }, "2026-06-20T00:00:00.000Z");
  expect(out!.name).toBe("renamed");
  expect(out!.description).toBe("d");
  expect(out!.updatedAt).toBe("2026-06-20T00:00:00.000Z");
});

it("link/unlink and summaries with goalCounts", () => {
  const db = freshDb();
  goal(db, "g1", "active"); goal(db, "g2", "completed");
  P.insertWorkspaceEntity(db, { id: "w1", path: "/r/a", name: "a", description: "", createdAt: ISO, updatedAt: ISO });
  P.linkGoalWorkspace(db, "g1", "w1", ISO);
  P.linkGoalWorkspace(db, "g2", "w1", ISO);
  const [s] = P.listWorkspaceSummaries(db);
  expect(s.goalCounts).toEqual({ active: 1, completed: 1, archived: 0 });
  expect(P.listWorkspacesByGoal(db, "g1").map((w) => w.id)).toEqual(["w1"]);
  expect(P.unlinkGoalWorkspace(db, "g2", "w1")).toBe(true);
  expect(P.listWorkspaceSummaries(db)[0].goalCounts.completed).toBe(0);
});

it("goal views for a workspace include archived via archived_at", () => {
  const db = freshDb();
  goal(db, "g1", "active");
  db.prepare("UPDATE goals SET status='archived', archived_at=? WHERE id='g1'").run(ISO);
  P.insertWorkspaceEntity(db, { id: "w1", path: "/r/a", name: "a", description: "", createdAt: ISO, updatedAt: ISO });
  P.linkGoalWorkspace(db, "g1", "w1", ISO);
  const views = P.listGoalViewsForWorkspace(db, "w1");
  expect(views[0]).toMatchObject({ id: "g1", status: "archived", progress: null });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @orca/daemon test -- projection.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Rewrite `projection.ts`**

Replace the file body with the entity/junction implementation. Key points: prepared statements keyed on `db` (existing pattern); `listWorkspaceSummaries` joins `goal_workspaces`→`goals` and counts by status; `listGoalViewsForWorkspace` returns goals + `progress` from the goal's `active_workflow_run_id` step-runs (computed via the helper below).

```ts
import type Database from "better-sqlite3";
import { Workspace, WorkspaceSummary, WorkspaceGoalView } from "@orca/contracts";

export class DuplicateWorkspaceError extends Error {
  readonly code = "workspace_duplicate" as const;
  constructor(public readonly path: string) {
    super(`Workspace already exists for path: ${path}`);
    this.name = "DuplicateWorkspaceError";
  }
}

interface EntityRow { id: string; path: string; name: string; description: string; created_at: string; updated_at: string; }
function toWorkspace(r: EntityRow): Workspace {
  return Workspace.parse({ id: r.id, path: r.path, name: r.name, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at });
}

let _db: Database.Database | null = null;
let _s: Record<string, Database.Statement> | null = null;
function stmts(db: Database.Database) {
  if (db !== _db) {
    _db = db;
    _s = {
      insert: db.prepare("INSERT INTO workspaces (id,path,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)"),
      byId: db.prepare("SELECT id,path,name,description,created_at,updated_at FROM workspaces WHERE id = ?"),
      byPath: db.prepare("SELECT id,path,name,description,created_at,updated_at FROM workspaces WHERE path = ?"),
      update: db.prepare("UPDATE workspaces SET name = ?, description = ?, updated_at = ? WHERE id = ?"),
      link: db.prepare("INSERT OR IGNORE INTO goal_workspaces (goal_id,workspace_id,attached_at) VALUES (?,?,?)"),
      unlink: db.prepare("DELETE FROM goal_workspaces WHERE goal_id = ? AND workspace_id = ?"),
      byGoal: db.prepare(
        "SELECT w.id,w.path,w.name,w.description,w.created_at,w.updated_at FROM workspaces w " +
        "JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ? ORDER BY gw.attached_at ASC, w.id ASC"),
      summaries: db.prepare(
        "SELECT w.id,w.path,w.name,w.description,w.created_at,w.updated_at, " +
        " COALESCE(SUM(CASE WHEN g.status='active' THEN 1 ELSE 0 END),0) AS active, " +
        " COALESCE(SUM(CASE WHEN g.status='completed' THEN 1 ELSE 0 END),0) AS completed, " +
        " COALESCE(SUM(CASE WHEN g.status='archived' THEN 1 ELSE 0 END),0) AS archived " +
        "FROM workspaces w " +
        "LEFT JOIN goal_workspaces gw ON gw.workspace_id = w.id " +
        "LEFT JOIN goals g ON g.id = gw.goal_id " +
        "GROUP BY w.id ORDER BY w.name ASC, w.id ASC"),
      goalsForWs: db.prepare(
        "SELECT g.id,g.title,g.description,g.status,g.created_at,g.active_workflow_run_id AS run_id " +
        "FROM goals g JOIN goal_workspaces gw ON gw.goal_id = g.id " +
        "WHERE gw.workspace_id = ? ORDER BY g.created_at DESC, g.id ASC"),
      runProgress: db.prepare(
        "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) AS done " +
        "FROM workflow_step_runs WHERE workflow_run_id = ?"),
    };
  }
  return _s!;
}
export function resetPreparedStatements(): void { _db = null; _s = null; }

export function insertWorkspaceEntity(db: Database.Database, ws: Workspace): void {
  try {
    stmts(db).insert.run(ws.id, ws.path, ws.name, ws.description, ws.createdAt, ws.updatedAt);
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new DuplicateWorkspaceError(ws.path);
    }
    throw e;
  }
}
export function findWorkspaceById(db: Database.Database, id: string): Workspace | null {
  const r = stmts(db).byId.get(id) as EntityRow | undefined; return r ? toWorkspace(r) : null;
}
export function findWorkspaceByPath(db: Database.Database, path: string): Workspace | null {
  const r = stmts(db).byPath.get(path) as EntityRow | undefined; return r ? toWorkspace(r) : null;
}
export function updateWorkspaceEntity(db: Database.Database, id: string, patch: { name?: string; description?: string }, updatedAt: string): Workspace | null {
  const cur = findWorkspaceById(db, id);
  if (!cur) return null;
  const name = patch.name ?? cur.name;
  const description = patch.description ?? cur.description;
  stmts(db).update.run(name, description, updatedAt, id);
  return findWorkspaceById(db, id);
}
export function linkGoalWorkspace(db: Database.Database, goalId: string, workspaceId: string, attachedAt: string): void {
  stmts(db).link.run(goalId, workspaceId, attachedAt);
}
export function unlinkGoalWorkspace(db: Database.Database, goalId: string, workspaceId: string): boolean {
  return stmts(db).unlink.run(goalId, workspaceId).changes > 0;
}
export function listWorkspacesByGoal(db: Database.Database, goalId: string): Workspace[] {
  return (stmts(db).byGoal.all(goalId) as EntityRow[]).map(toWorkspace);
}
export function listWorkspaceSummaries(db: Database.Database): WorkspaceSummary[] {
  type Row = EntityRow & { active: number; completed: number; archived: number };
  return (stmts(db).summaries.all() as Row[]).map((r) => WorkspaceSummary.parse({
    ...toWorkspace(r), goalCounts: { active: r.active, completed: r.completed, archived: r.archived },
  }));
}
export function listGoalViewsForWorkspace(db: Database.Database, workspaceId: string): WorkspaceGoalView[] {
  type Row = { id: string; title: string; description: string; status: string; created_at: string; run_id: string | null };
  const rows = stmts(db).goalsForWs.all(workspaceId) as Row[];
  return rows.map((g) => {
    let progress: number | null = null;
    if (g.status === "active" && g.run_id) {
      const p = stmts(db).runProgress.get(g.run_id) as { total: number; done: number };
      progress = p.total > 0 ? p.done / p.total : 0;
    }
    return WorkspaceGoalView.parse({
      id: g.id, title: g.title, description: g.description, status: g.status, createdAt: g.created_at, progress,
    });
  });
}
```

> Verify the step-run table/columns: confirm `workflow_step_runs(workflow_run_id, status)` exist (grep `CREATE TABLE workflow_step_runs`). If the status value for a finished step differs from `'completed'`, adjust the `runProgress` CASE accordingly.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @orca/daemon test -- projection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workspaces/projection.ts apps/daemon/src/workspaces/projection.test.ts
git commit -m "feat(daemon): workspace entity + junction projection with aggregates"
```

---

### Task 4: Rewrite workspace usecases (create/update/attach/detach)

**Files:**
- Modify: `apps/daemon/src/workspaces/usecases.ts`
- Test: `apps/daemon/src/workspaces/usecases.test.ts`

**Interfaces:**
- Produces:
  - `createWorkspace(ctx, { inputPath, name?, description? }): Promise<Workspace>` — inspect path, insert entity (DuplicateWorkspaceError on existing path), emit `workspace.created`.
  - `updateWorkspace(ctx, { id, name?, description? }): Promise<Workspace>` — `NotFoundError` if missing, emit `workspace.updated`.
  - `attachWorkspace(ctx, { goalId, inputPath, name? }): Promise<Workspace>` — find-or-create entity by canonical path, link in junction, emit `workspace.attached`.
  - `detachWorkspace(ctx, { goalId, workspaceId }): Promise<void>` — unlink, emit `workspace.removed`.
- Consumes: `WorkspaceCtx { db, bus, inspectWorkspace }` (unchanged), projection fns from Task 3.

- [ ] **Step 1: Write failing tests**

Rewrite `usecases.test.ts` core cases (mirror existing harness: in-memory db migrated to head, a fake `inspectWorkspace`, an `EventBus` capturing published events):

```ts
it("createWorkspace inserts entity and emits workspace.created", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: "main", isDirty: false, gitProbe: "ok" } });
  const ws = await createWorkspace(ctx, { inputPath: "/r/a", description: "d" });
  expect(ws).toMatchObject({ path: "/r/a", name: "a", description: "d" });
  expect(published(ctx).map((e) => e.type)).toContain("workspace.created");
});

it("createWorkspace rejects a duplicate path", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: null, isDirty: null, gitProbe: "ok" } });
  await createWorkspace(ctx, { inputPath: "/r/a" });
  await expect(createWorkspace(ctx, { inputPath: "/r/a" })).rejects.toBeInstanceOf(DuplicateWorkspaceError);
});

it("attachWorkspace find-or-creates the entity then links the goal", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: null, isDirty: null, gitProbe: "ok" } });
  goal(ctx.db, "g1");
  const ws = await attachWorkspace(ctx, { goalId: "g1", inputPath: "/r/a" });
  goal(ctx.db, "g2");
  const ws2 = await attachWorkspace(ctx, { goalId: "g2", inputPath: "/r/a" });
  expect(ws2.id).toBe(ws.id); // same entity reused
  expect(listWorkspacesByGoal(ctx.db, "g2").map((w) => w.id)).toEqual([ws.id]);
});

it("updateWorkspace renames + emits workspace.updated", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: null, isDirty: null, gitProbe: "ok" } });
  const ws = await createWorkspace(ctx, { inputPath: "/r/a" });
  const out = await updateWorkspace(ctx, { id: ws.id, name: "renamed" });
  expect(out.name).toBe("renamed");
  expect(published(ctx).map((e) => e.type)).toContain("workspace.updated");
});

it("detachWorkspace unlinks without deleting the entity", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: null, isDirty: null, gitProbe: "ok" } });
  goal(ctx.db, "g1");
  const ws = await attachWorkspace(ctx, { goalId: "g1", inputPath: "/r/a" });
  await detachWorkspace(ctx, { goalId: "g1", workspaceId: ws.id });
  expect(listWorkspacesByGoal(ctx.db, "g1")).toEqual([]);
  expect(findWorkspaceById(ctx.db, ws.id)).not.toBeNull(); // entity survives
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @orca/daemon test -- usecases.test.ts` (in `src/workspaces`)
Expected: FAIL.

- [ ] **Step 3: Rewrite `usecases.ts`**

```ts
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DomainEvent, DomainEventType, InspectWorkspacePreview, Workspace } from "@orca/contracts";
import type { EventBus } from "../events.js";
import { NotFoundError } from "../goals.js";
import {
  DuplicateWorkspaceError, findWorkspaceByPath, findWorkspaceById,
  insertWorkspaceEntity, updateWorkspaceEntity, linkGoalWorkspace, unlinkGoalWorkspace,
} from "./projection.js";

export { DuplicateWorkspaceError };

export interface WorkspaceCtx {
  db: Database.Database;
  bus: EventBus;
  inspectWorkspace(inputPath: string): Promise<InspectWorkspacePreview>;
}

function emit(ctx: WorkspaceCtx, type: DomainEventType, goalId: string | null, payload: Record<string, unknown>): void {
  const now = new Date().toISOString();
  let event!: DomainEvent;
  ctx.db.transaction(() => {
    const id = randomUUID();
    const result = ctx.db.prepare(
      "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, type, goalId, JSON.stringify(payload), now);
    event = { seq: Number(result.lastInsertRowid), id, type, goalId, payload, createdAt: now };
  })();
  ctx.bus.publish(event);
}

// find-or-create the canonical entity for a path (no event)
function ensureEntity(ctx: WorkspaceCtx, preview: InspectWorkspacePreview, name?: string): { ws: Workspace; created: boolean } {
  const existing = findWorkspaceByPath(ctx.db, preview.path);
  if (existing) return { ws: existing, created: false };
  const now = new Date().toISOString();
  const ws: Workspace = { id: randomUUID(), path: preview.path, name: name ?? preview.name, description: "", createdAt: now, updatedAt: now };
  insertWorkspaceEntity(ctx.db, ws);
  return { ws, created: true };
}

export async function createWorkspace(
  ctx: WorkspaceCtx,
  input: { inputPath: string; name?: string; description?: string },
): Promise<Workspace> {
  const preview = await ctx.inspectWorkspace(input.inputPath);
  if (findWorkspaceByPath(ctx.db, preview.path)) throw new DuplicateWorkspaceError(preview.path);
  const now = new Date().toISOString();
  const ws: Workspace = {
    id: randomUUID(), path: preview.path, name: input.name ?? preview.name,
    description: input.description ?? "", createdAt: now, updatedAt: now,
  };
  insertWorkspaceEntity(ctx.db, ws);
  emit(ctx, "workspace.created", null, { workspaceId: ws.id, path: ws.path, name: ws.name });
  return ws;
}

export async function updateWorkspace(
  ctx: WorkspaceCtx,
  input: { id: string; name?: string; description?: string },
): Promise<Workspace> {
  const updated = updateWorkspaceEntity(ctx.db, input.id, { name: input.name, description: input.description }, new Date().toISOString());
  if (!updated) throw new NotFoundError(input.id);
  emit(ctx, "workspace.updated", null, { workspaceId: updated.id, name: updated.name });
  return updated;
}

export async function attachWorkspace(
  ctx: WorkspaceCtx,
  input: { goalId: string; inputPath: string; name?: string },
): Promise<Workspace> {
  const goalRow = ctx.db.prepare("SELECT id, archived_at FROM goals WHERE id = ?").get(input.goalId) as { id: string; archived_at: string | null } | undefined;
  if (!goalRow || goalRow.archived_at !== null) throw new NotFoundError(input.goalId);
  const preview = await ctx.inspectWorkspace(input.inputPath);
  const { ws } = ensureEntity(ctx, preview, input.name);
  linkGoalWorkspace(ctx.db, input.goalId, ws.id, new Date().toISOString());
  emit(ctx, "workspace.attached", input.goalId, { workspaceId: ws.id, path: ws.path, name: ws.name });
  return ws;
}

export async function detachWorkspace(
  ctx: WorkspaceCtx,
  input: { goalId: string; workspaceId: string },
): Promise<void> {
  const removed = unlinkGoalWorkspace(ctx.db, input.goalId, input.workspaceId);
  if (!removed) throw new NotFoundError(input.workspaceId);
  emit(ctx, "workspace.removed", input.goalId, { workspaceId: input.workspaceId });
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @orca/daemon test -- usecases.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workspaces/usecases.ts apps/daemon/src/workspaces/usecases.test.ts
git commit -m "feat(daemon): workspace create/update + find-or-create attach usecases"
```

---

### Task 5: Daemon routes — list/get/create/update + goal-detail via junction

**Files:**
- Modify: `apps/daemon/src/server.ts` (workspace route block ~1002–1075; goal-detail handler ~660–690)
- Test: `apps/daemon/src/server.test.ts`

**Interfaces:**
- Produces routes: `GET /v1/workspaces`, `GET /v1/workspaces/:id`, `POST /v1/workspaces`, `PATCH /v1/workspaces/:id`. `GoalDetailResponse.workspaces` now `listWorkspacesByGoal`. Attach/detach call the rewritten usecases. Error mapping: `DuplicateWorkspaceError` → 409, `NotFoundError` → 404, Zod parse error → 400.
- Consumes: usecases (Task 4), projection (Task 3), contracts (Task 1).

- [ ] **Step 1: Write failing tests**

Add to `server.test.ts` (mirror existing route-test setup — build the server, seed via existing helpers):

```ts
it("POST then GET /v1/workspaces returns the entity with goalCounts", async () => {
  const app = await buildTestServer();             // existing helper
  const create = await app.inject({ method: "POST", url: "/v1/workspaces",
    payload: { inputPath: TEST_REPO_DIR } });       // a real temp dir from existing helpers
  expect(create.statusCode).toBe(201);
  const list = await app.inject({ method: "GET", url: "/v1/workspaces" });
  const body = list.json() as { workspaces: { path: string; goalCounts: { active: number } }[] };
  expect(body.workspaces).toHaveLength(1);
  expect(body.workspaces[0]!.goalCounts.active).toBe(0);
});

it("POST /v1/workspaces twice on same path -> 409", async () => {
  const app = await buildTestServer();
  await app.inject({ method: "POST", url: "/v1/workspaces", payload: { inputPath: TEST_REPO_DIR } });
  const dup = await app.inject({ method: "POST", url: "/v1/workspaces", payload: { inputPath: TEST_REPO_DIR } });
  expect(dup.statusCode).toBe(409);
});

it("PATCH /v1/workspaces/:id renames", async () => {
  const app = await buildTestServer();
  const created = (await app.inject({ method: "POST", url: "/v1/workspaces", payload: { inputPath: TEST_REPO_DIR } })).json() as { workspace: { id: string } };
  const patched = await app.inject({ method: "PATCH", url: `/v1/workspaces/${created.workspace.id}`, payload: { name: "renamed", description: "d" } });
  expect(patched.statusCode).toBe(200);
  expect((patched.json() as { workspace: { name: string } }).workspace.name).toBe("renamed");
});

it("GET /v1/workspaces/:id returns associated goals", async () => {
  const app = await buildTestServer();
  // Create a goal that attaches TEST_REPO_DIR via the existing create-goal route
  // helper used elsewhere in this file (search for an existing POST /v1/goals
  // test with a `workspaces: [{ inputPath }]` body and reuse it).
  const goalId = await createGoalWithRepo(app, TEST_REPO_DIR);
  // Find the workspace id the attach produced.
  const list = (await app.inject({ method: "GET", url: "/v1/workspaces" })).json() as { workspaces: { id: string }[] };
  const wsId = list.workspaces[0]!.id;
  const res = await app.inject({ method: "GET", url: `/v1/workspaces/${wsId}` });
  const body = res.json() as { goals: { id: string; status: string }[] };
  expect(body.goals.map((g) => g.id)).toContain(goalId);
  expect(body.goals.find((g) => g.id === goalId)!.status).toBe("active");
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @orca/daemon test -- server.test.ts`
Expected: FAIL (404 — routes absent).

- [ ] **Step 3: Add routes + reshape goal-detail**

In the workspace route block of `server.ts`, add (the `ctx` for usecases is already constructed for attach/detach — reuse it):

```ts
server.get('/v1/workspaces', async (_request, reply) => {
  const workspaces = listWorkspaceSummaries(db);
  return reply.send({ workspaces } satisfies ListWorkspacesResponse);
});

server.get('/v1/workspaces/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const workspace = findWorkspaceById(db, id);
  if (!workspace) return reply.code(404).send({ error: { code: "not_found", message: "workspace not found" } });
  const goals = listGoalViewsForWorkspace(db, id);
  return reply.send({ workspace, goals } satisfies GetWorkspaceResponse);
});

server.post('/v1/workspaces', async (request, reply) => {
  const parsed = CreateWorkspaceRequest.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", message: parsed.error.message } });
  try {
    const workspace = await createWorkspace(workspaceCtx, parsed.data);
    return reply.code(201).send({ workspace } satisfies CreateWorkspaceResponse);
  } catch (err) {
    if (err instanceof DuplicateWorkspaceError) return reply.code(409).send({ error: { code: err.code, message: err.message } });
    throw err;
  }
});

server.patch('/v1/workspaces/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = UpdateWorkspaceRequest.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", message: parsed.error.message } });
  try {
    const workspace = await updateWorkspace(workspaceCtx, { id, ...parsed.data });
    return reply.send({ workspace } satisfies UpdateWorkspaceResponse);
  } catch (err) {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: { code: "not_found", message: "workspace not found" } });
    throw err;
  }
});
```

Update imports at the top of `server.ts`: add `listWorkspaceSummaries, findWorkspaceById, listGoalViewsForWorkspace, listWorkspacesByGoal` from `./workspaces/projection.js`, and `createWorkspace, updateWorkspace` from `./workspaces/usecases.js`, and the new contract types.

In the goal-detail handler (where it builds `GoalDetailResponse`), replace the old workspace lookup with:
```ts
const workspaces = listWorkspacesByGoal(db, goalId);
```

> Confirm the `workspaceCtx` variable name used by the existing attach/detach handlers and reuse it; if attach/detach build the ctx inline, hoist it so all four routes share it.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @orca/daemon test -- server.test.ts`
Expected: PASS. Then run the full daemon suite to catch snapshot/contract breaks: `pnpm --filter @orca/daemon test`. Update any goal-detail/workspace snapshots that legitimately changed shape (drop of git fields).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.test.ts
git commit -m "feat(daemon): workspace registry routes + goal-detail via junction"
```

---

### Task 6: Set goal status `completed` on workflow-run completion

**Files:**
- Modify: `apps/daemon/src/workflows/runs/usecases.ts` (`completeWorkflowRun`, ~248–255)
- Test: `apps/daemon/src/workflows/runs/usecases.test.ts` (or the suite covering `completeWorkflowRun`)

**Interfaces:**
- Consumes: the existing `completeWorkflowRun(ctx, runId)`.
- Produces: side effect — the goal's `status` becomes `'completed'`.

- [ ] **Step 1: Write failing test**

Add a case to the suite that already exercises `completeWorkflowRun` (it will
already have a `ctx`, a `goalId`, and a started `runId` via this file's run-setup
helpers — reuse them; find the existing `describe("completeWorkflowRun", …)` or
the test that calls `startWorkflowRun`/`completeWorkflowRun`):
```ts
it("completing a run marks the goal completed", () => {
  // Reuse this file's setup that creates a goal with an active run, yielding
  // `ctx`, `goalId`, `runId` (the goal's status is 'active' at this point).
  completeWorkflowRun(ctx, runId);
  const g = ctx.db.prepare("SELECT status, active_workflow_run_id FROM goals WHERE id = ?").get(goalId) as { status: string; active_workflow_run_id: string | null };
  expect(g.status).toBe("completed");
  expect(g.active_workflow_run_id).toBeNull();
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @orca/daemon test -- runs/usecases.test.ts`
Expected: FAIL (status still `active`).

- [ ] **Step 3: Edit `completeWorkflowRun`**

Change the goal UPDATE inside the transaction:
```ts
ctx.db
  .prepare(
    "UPDATE goals SET active_workflow_run_id = NULL, status = 'completed', updated_at = ? WHERE id = ? AND active_workflow_run_id = ?"
  )
  .run(now, run.goalId, runId);
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @orca/daemon test -- runs/usecases.test.ts`
Expected: PASS. Run full daemon suite; update snapshots where a completed goal's status legitimately changed.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/runs/usecases.ts apps/daemon/src/workflows/runs/usecases.test.ts
git commit -m "feat(daemon): mark goal completed when its workflow run completes"
```

---

## PHASE 3 — Desktop

### Task 7: API client functions

**Files:**
- Modify: `apps/desktop/src/api.ts`
- Test: `apps/desktop/src/api.test.ts` (add cases following existing fetch-mock pattern)

**Interfaces:**
- Produces: `listWorkspaces(): Promise<WorkspaceSummary[]>`, `getWorkspace(id): Promise<GetWorkspaceResponse>`, `createWorkspace(body: CreateWorkspaceRequest): Promise<Workspace>`, `updateWorkspace(id, body: UpdateWorkspaceRequest): Promise<Workspace>`.

- [ ] **Step 1: Write failing tests** (mirror existing `api.test.ts` mock-fetch cases) asserting URL/method/parse for `listWorkspaces` and `createWorkspace`.

- [ ] **Step 2: Run, verify fail** — `pnpm --filter @orca/desktop test -- api.test.ts`

- [ ] **Step 3: Implement** in `api.ts` (import the new contract types in the existing import block):

```ts
export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const { baseUrl, token } = await loadConfig();
  const body = await requestJson(`${baseUrl}/v1/workspaces`, { headers: authHeaders(token) },
    ListWorkspacesResponse, "List workspaces failed");
  return body.workspaces;
}
export async function getWorkspace(id: string): Promise<GetWorkspaceResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(`${baseUrl}/v1/workspaces/${encodeURIComponent(id)}`, { headers: authHeaders(token) },
    GetWorkspaceResponse, "Get workspace failed");
}
export async function createWorkspace(body: CreateWorkspaceRequest): Promise<Workspace> {
  const { baseUrl, token } = await loadConfig();
  const res = await requestJson(`${baseUrl}/v1/workspaces`,
    { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(token) }, body: JSON.stringify(CreateWorkspaceRequest.parse(body)) },
    CreateWorkspaceResponse, "Create workspace failed");
  return res.workspace;
}
export async function updateWorkspace(id: string, body: UpdateWorkspaceRequest): Promise<Workspace> {
  const { baseUrl, token } = await loadConfig();
  const res = await requestJson(`${baseUrl}/v1/workspaces/${encodeURIComponent(id)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders(token) }, body: JSON.stringify(UpdateWorkspaceRequest.parse(body)) },
    UpdateWorkspaceResponse, "Update workspace failed");
  return res.workspace;
}
```

- [ ] **Step 4: Run, verify pass** — `pnpm --filter @orca/desktop test -- api.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/api.test.ts
git commit -m "feat(desktop): workspace registry API client functions"
```

---

### Task 8: Rewrite `data.ts` + wire `WorkspacesPage` to real data

**Files:**
- Modify: `apps/desktop/src/workspaces/data.ts` (delete seeds; 3-state model; keep `slugify`)
- Modify: `apps/desktop/src/workspaces/WorkspacesPage.tsx`

**Interfaces:**
- Consumes: `listWorkspaces`, `getWorkspace`, `createWorkspace`, `updateWorkspace` (Task 7); `inspectWorkspace`, `openEventStream` (existing).
- Produces: `WorkspacesPage` props unchanged (`onCreateGoal`, `onOpenGoal`), now sourcing real data.

- [ ] **Step 1: Rewrite `data.ts`** — remove `SEED_WORKSPACES`, `SEED_GOALS`, `FS_FOLDERS`, and the `Workspace`/`WorkspaceGoal` local types (use the contract types). Keep `slugify`. Replace status meta/order with the 3-state model:

```ts
import type { GoalStatus } from "@orca/contracts";
export const GOAL_STATE_META: Record<GoalStatus, { label: string; tone: "run" | "warn" | "neutral" }> = {
  active: { label: "Active", tone: "run" },
  completed: { label: "Completed", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};
export const GOAL_STATE_ORDER: GoalStatus[] = ["active", "completed", "archived"];
export function slugify(value: string): string {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
```

- [ ] **Step 2: Rewrite `WorkspacesPage` data layer** — replace seed state with fetched state. Use contract types (`WorkspaceSummary`, `WorkspaceGoalView`). On mount, `listWorkspaces()` → set list + select first; subscribe via `openEventStream` and refetch the list on any `workspace.*`/`goal.*` event. On selection, `getWorkspace(id)` → set `{ workspace, goals }`. Empty state renders when the list is empty (remove the `?workspaces=empty` flag + `forceEmptyWorkspaces`).

Key shape changes inside the component:
- Workspace rows: drop the live dot; subline `${s.goalCounts.active + s.goalCounts.completed + s.goalCounts.archived} goals · ${s.goalCounts.active} active`.
- Detail groups: iterate `GOAL_STATE_ORDER` over the fetched `goals` (now `WorkspaceGoalView[]`); card fields map `g.title`, `g.description`, `g.status`, `g.createdAt` (age), and `g.progress`. Show the progress bar only when `g.status === "active"`. Drop the abandoned/paused branches.
- `WorkspaceGoalCard` age: derive from `createdAt` with a small `formatAge(iso)` helper (e.g. days/hours since).

> The visual markup already exists from the seeded version — change data sources and the status set; do not restyle.

- [ ] **Step 3: Typecheck** — `pnpm --filter @orca/desktop typecheck`. Expected: PASS (test file updated in Task 10).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/workspaces/data.ts apps/desktop/src/workspaces/WorkspacesPage.tsx
git commit -m "feat(desktop): source Workspaces tab list + detail from the daemon"
```

---

### Task 9: Real create/manage modals + goal-detail ripple + New-Goal pre-seed

**Files:**
- Modify: `apps/desktop/src/workspaces/WorkspacesPage.tsx` (modals)
- Modify: `apps/desktop/src/goal-detail/WorkspaceListPanel.tsx` (drop git chips on attached rows)
- Modify: `apps/desktop/src/create-goal-flow/state.ts` + `apps/desktop/src/App.tsx` (pre-seed)

**Interfaces:**
- Consumes: `createWorkspace`, `updateWorkspace`, `inspectWorkspace`, `openDialog`.

- [ ] **Step 1: Create modal → native folder + inspect + createWorkspace.** Replace the simulated `~/code` list with a **Browse…** button calling `openDialog({ directory: true, multiple: false })`, then `inspectWorkspace({ inputPath })`. Show the inspected `path` + git preview chips (`workspaceType`, `branch`, `isDirty`) from the transient preview, the name field (prefilled from `preview.name`), and description. On submit call `createWorkspace({ inputPath, name, description })`; on success refetch list + select new; map a 409 (`ApiError.code === "workspace_duplicate"`) to an inline "already added" message.

- [ ] **Step 2: Manage modal → updateWorkspace.** Replace local patch with `await updateWorkspace(ws.id, { name, description })`; on success update the list/detail (or refetch). Folder shown read-only from `ws.path`.

- [ ] **Step 3: Goal-detail chip removal.** In `WorkspaceListPanel.tsx`, delete the attached-row chip block (lines ~105–111: the `<div className="workspace-chips">` with `ws.workspaceType` / `ws.branch` / `ws.isDirty`). Attached rows now show `name` + `path` only. Leave the add-preview chips (from `inspect`) intact.

- [ ] **Step 4: New-Goal pre-seed.** Add an optional initial pending workspace to the create-goal flow. In `create-goal-flow/state.ts`, accept an optional `initialWorkspace?: { path: string; name: string }` (or pre-populated `pendingWorkspaces`) in the flow's initializer. In `App.tsx`, change the Workspaces tab's `onCreateGoal` to open `CreateGoalFlow` seeded with the selected workspace's `{ path, name }`. (If the flow validates folders via `inspect`, pre-seed as a path to inspect on open rather than a trusted attachment.)

- [ ] **Step 5: Typecheck + commit.**

Run: `pnpm --filter @orca/desktop typecheck`
```bash
git add apps/desktop/src/workspaces/WorkspacesPage.tsx apps/desktop/src/goal-detail/WorkspaceListPanel.tsx apps/desktop/src/create-goal-flow/state.ts apps/desktop/src/App.tsx
git commit -m "feat(desktop): real workspace create/manage + New-Goal pre-seed; drop goal-detail git chips"
```

---

### Task 10: Rewrite the WorkspacesPage test for real API

**Files:**
- Modify: `apps/desktop/src/workspaces/WorkspacesPage.test.tsx`

**Interfaces:**
- Consumes: mocked `../api` (`listWorkspaces`, `getWorkspace`, `createWorkspace`, `updateWorkspace`, `inspectWorkspace`) + mocked `@tauri-apps/plugin-dialog`.

- [ ] **Step 1: Rewrite the test** — mock `../api` and the dialog (mirror `WorkflowsPage.test.tsx`'s `vi.mock` pattern). Cover:
  - list renders rows + selecting fetches detail goals grouped Active/Completed/Archived;
  - empty state when `listWorkspaces` resolves `[]`;
  - create: Browse → inspect resolves a preview → submit calls `createWorkspace` and refetches;
  - manage: rename calls `updateWorkspace`;
  - progress bar shows for an `active` goal and is absent for a `completed` goal;
  - duplicate-path create surfaces the inline error.

```ts
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue("/repo/a") }));
const listWorkspacesMock = vi.fn();
const getWorkspaceMock = vi.fn();
const createWorkspaceMock = vi.fn();
const updateWorkspaceMock = vi.fn();
const inspectWorkspaceMock = vi.fn();
vi.mock("../api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api")>();
  return { ...mod,
    listWorkspaces: (...a: unknown[]) => listWorkspacesMock(...a),
    getWorkspace: (...a: unknown[]) => getWorkspaceMock(...a),
    createWorkspace: (...a: unknown[]) => createWorkspaceMock(...a),
    updateWorkspace: (...a: unknown[]) => updateWorkspaceMock(...a),
    inspectWorkspace: (...a: unknown[]) => inspectWorkspaceMock(...a),
    openEventStream: () => ({ close() {} }),
  };
});
// beforeEach: seed listWorkspacesMock / getWorkspaceMock with fixtures, then assertions.
```

- [ ] **Step 2: Run, verify pass** — `pnpm --filter @orca/desktop test -- WorkspacesPage.test.tsx`

- [ ] **Step 3: Full desktop suite + typecheck** — `pnpm --filter @orca/desktop test` and `pnpm --filter @orca/desktop typecheck`. Fix fallout.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/workspaces/WorkspacesPage.test.tsx
git commit -m "test(desktop): WorkspacesPage against the real workspace API"
```

---

## Final Verification

- [ ] `pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test`
- [ ] `pnpm --filter @orca/contracts typecheck && pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/desktop typecheck`
- [ ] `npx knip --workspace apps/desktop` — no new unused exports from the workspaces module.
- [ ] Manual smoke (daemon running): Workspaces tab shows real workspaces, empty state with 0 rows, create via folder dialog, rename via Manage, goal cards grouped Active/Completed/Archived with progress on active goals.

## Spec Coverage Notes

- Standalone create / rename / description → Tasks 1, 4, 5, 9.
- Many-to-many + junction → Tasks 2, 3.
- `completed` status on run completion → Task 6.
- Progress from workflow step completion (active only) → Tasks 3, 8.
- Transient git (inspect only); entity has no git columns → Tasks 1, 2, 9.
- `tasks.workspace_id` remap → Task 2.
- Goal-detail attached-row chips dropped → Task 9.
- Out of scope (delete, live-session indicators) → omitted by design.
