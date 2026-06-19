# Workspaces as First-Class Objects — Design

**Date:** 2026-06-19
**Status:** Approved (brainstorming) — ready for implementation plan

## Problem

The Workspaces tab currently renders from seeded placeholder data
(`apps/desktop/src/workspaces/data.ts`). We need it backed by the real daemon
with no placeholder data.

The blocker: in the backend today a "workspace" is **not** a standalone entity.
The `workspaces` table holds per-goal repo attachments
(`{ id, goalId, path, name, workspace_type, branch, is_dirty, git_probe, attached_at }`).
There is no workspace registry, no standalone create, and no rename/description.
The only routes are attach (`POST /v1/goals/:id/workspaces`), detach, and
inspect (`POST /v1/workspaces/inspect`). Goal status is only `active | archived`,
and the goals list carries no progress or session data.

## Decisions

1. **Promote workspaces to first-class entities.** A workspace *is* a repo
   (1 workspace == 1 repo == 1 canonical path).
2. **Goal ↔ workspace is many-to-many.** A goal can be associated with one or
   more workspaces.
3. **Goal status gains `completed`.** Status becomes `active | completed |
   archived`. `completed` is set automatically when the goal's single workflow
   run completes. `archived` stays a separate manual action.
4. **Full fidelity minus live-session indicators.** Goal cards keep the progress
   bar (derived from workflow step completion). No live-session dots/counts.
5. **Approach B (clean model).** Reshape the `workspaces` table into a canonical
   entity plus a `goal_workspaces` junction. The old per-goal ids are retired.
6. **Lean entity columns.** Drop `workspace_type`, `branch`, `is_dirty`,
   `git_probe` from the persisted entity. Git probing stays transient (used at
   create/attach time only, never stored).
7. **No delete-workspace in v1.** Mutations are create + rename + edit
   description, matching the prototype.

## Data Model

```
workspaces  (canonical entity — one row per repo)
  id           text PK
  path         text UNIQUE   -- canonical realpath; the workspace identity
  name         text          -- folder basename by default, user-overridable
  description  text          -- new, user-editable
  created_at   text
  updated_at   text

goal_workspaces  (junction — many-to-many)
  goal_id      text
  workspace_id text
  attached_at  text
  PRIMARY KEY (goal_id, workspace_id)
```

## Migration — `0036_workspaces_first_class.sql` (+ data step)

1. Create the new `workspaces` entity table and `goal_workspaces` junction
   (build under temporary names, then swap).
2. For each **distinct canonical `path`** in the old table, create one entity
   row. `name` from the first attachment for that path; `description` empty.
3. For each old attachment row, insert a `goal_workspaces` link
   (old `goal_id` → the path's new `workspace_id`).
4. **Remap `tasks.workspace_id`**: each old per-goal workspace id maps to the new
   entity id for its path. This is the highest-risk step and gets explicit test
   coverage (a task pointing at an old workspace id resolves to the right entity
   after migration).
5. Drop the old table; rename the new tables into place.

Registration: add `0036_workspaces_first_class.sql` to `migrationFiles` in
`apps/daemon/src/migrations.ts`.

## Contract Changes (`packages/contracts/src/index.ts`)

- **`GoalStatus`** → `z.enum(["active", "completed", "archived"])`.
- **`Workspace`** reshaped to the entity:
  `{ id, path, name, description, createdAt, updatedAt }`
  (drops `goalId`, `attachedAt`, `workspaceType`, `branch`, `isDirty`,
  `gitProbe`).
- **`InspectWorkspacePreview`** becomes a standalone shape (no longer
  `Workspace.omit(...)`): `{ path, name, workspaceType, branch, isDirty,
  gitProbe }`. Inspect still returns live git metadata; it is transient.
- **New:** `CreateWorkspaceRequest` `{ inputPath, name?, description? }`,
  `CreateWorkspaceResponse { workspace }`, `UpdateWorkspaceRequest
  { name?, description? }`, `ListWorkspacesResponse`, `GetWorkspaceResponse`.
- `WorkspaceSummary` (list row): `Workspace` + `{ goalCounts: { active,
  completed, archived } }`.
- `GetWorkspaceResponse`: `{ workspace, goals: WorkspaceGoalView[] }` where
  `WorkspaceGoalView` = `{ id, title, description, status, createdAt, progress }`
  (`progress` = completed steps ÷ total steps of the goal's workflow run, or
  `null` when no run).
- New domain event types: `workspace.created`, `workspace.updated`. Existing
  `workspace.attached` / `workspace.removed` remain.

## Daemon API Surface

- `GET /v1/workspaces` → `{ workspaces: WorkspaceSummary[] }`. Single aggregate
  query joining `goal_workspaces` + `goals` for status counts. No N+1.
- `GET /v1/workspaces/:id` → `{ workspace, goals: WorkspaceGoalView[] }`. Goal
  `progress` derived from the run's step-run states.
- `POST /v1/workspaces` → create standalone entity. Runs inspect on `inputPath`
  (validates folder), rejects duplicate canonical path (409,
  `DuplicateWorkspaceError`). Emits `workspace.created`.
- `PATCH /v1/workspaces/:id` → rename + description. Emits `workspace.updated`.
- Keep `POST /v1/workspaces/inspect`, `POST /v1/goals/:id/workspaces` (attach),
  `DELETE /v1/goals/:id/workspaces/:workspaceId` (detach). Attach becomes
  **find-or-create entity by canonical path**, then link in `goal_workspaces`.
- Daemon modules: `workspaces/projection.ts` (entity + junction CRUD,
  find-or-create-by-path, aggregate list query), `workspaces/usecases.ts`
  (create/update/attach/detach), plus route handlers in `server.ts`.

## Goal Completion

`GoalStatus` includes `completed`. In `completeWorkflowRun`
(`apps/daemon/src/workflows/runs/usecases.ts`), the existing
`UPDATE goals SET active_workflow_run_id = NULL WHERE id = ? AND
active_workflow_run_id = ?` also sets `status = 'completed'`. This is the only
completion trigger. (Archiving remains the existing manual path in `goals.ts`.)

## Goal-Detail Consequence

`apps/desktop/src/goal-detail/WorkspaceListPanel.tsx` renders `type / branch /
dirty` chips on **already-attached** workspaces (lines ~106–108) from persisted
fields. With the lean entity those fields no longer persist, so attached-row
chips are removed — attached workspaces show `name + path`. The add-preview chips
just below (from `inspect`) are unaffected and stay.

## Frontend (desktop)

Replace all seeded data with real API calls.

- Delete seeds from `workspaces/data.ts` (`SEED_WORKSPACES`, `SEED_GOALS`,
  `FS_FOLDERS`); keep pure helpers (`slugify`, status meta/order — updated to
  the 3-state model).
- **`api.ts`:** add `listWorkspaces()`, `getWorkspace(id)`,
  `createWorkspace({ inputPath, name, description })`,
  `updateWorkspace(id, { name, description })`. Reuse existing
  `inspectWorkspace`.
- **`WorkspacesPage`:** fetch `listWorkspaces()` on mount and refresh on
  `workspace.*` / `goal.*` events via the existing event stream. Selecting a row
  fetches `getWorkspace(id)`. Empty state is real (0 rows); the
  `?workspaces=empty` preview flag is removed.
- **List rows:** `name` + `"N goals · M active"` from `goalCounts`. No live dots.
- **Detail pane:** goals grouped **Active / Completed / Archived**; cards show
  title, 2-line description clamp, status pill, and age from `createdAt`. The
  progress bar shows for **Active** goals only (hidden for completed/archived,
  matching the prototype's in-flight-only rule). Paused/abandoned styling
  removed.
- **Create modal:** replace the simulated `~/code` list with **Browse… →
  `openDialog({ directory: true })` → `inspectWorkspace`** (shows path + git
  preview chips), then name (prefilled) + description → `createWorkspace`.
  Duplicate path → inline error from the 409.
- **Manage modal:** `updateWorkspace` (name + description); bound folder shown
  read-only.
- **"New goal" from a workspace:** opens the existing `CreateGoalFlow` with that
  workspace's folder pre-seeded as a pending attachment.

## Testing

- **Daemon:** migration round-trip including `tasks.workspace_id` remap;
  duplicate-path rejection; the new list/get/create/update routes; aggregate
  status counts; `completeWorkflowRun` setting `status = 'completed'`; attach
  find-or-create behavior.
- **Contracts:** reshaped `Workspace`, new request/response schemas, the
  `completed` status round-trip.
- **Desktop:** `WorkspacesPage` against a mocked `api` (list → render groups,
  select → detail goals, create → optimistic add + refetch, manage → rename
  validation, duplicate-path error). The existing
  `WorkspacesPage.test.tsx` is rewritten for real calls.

## Out of Scope (v1)

Delete-workspace; live-session indicators; associating an existing goal to a
workspace from the tab (goals associate via creation/attach); workspace
color/icon/slug; live git state on the entity.
