# Orca — Milestone 3 Implementation Plan

**Source milestone:** `docs/milestones/3.md`
**Builds on:** `docs/implementation-plans/milestone-2.md` (M2 must be complete and green)
**Status:** Ready for AI-assisted execution
**Scope guard:** Tasks below MUST NOT introduce PTY/session runtime, agent adapters, memory extraction/promotion, recommendation generation, workflow engine, task graph, workspace indexing, workspace file watching, AI-backed refinement, cloud sync, command-center placeholder panels, URL routing, deep-linking, generic skill invocation endpoints (`POST /v1/skills/:id/invoke`), cross-Goal workspace listing (`GET /v1/workspaces`), Goal-scoped workspace listing as a separate endpoint (`GET /v1/goals/:id/workspaces`), workspace patching (`PATCH /v1/workspaces/:id`), persisted `input_path`, boot-time git probing, refinement upsert/re-refinement behavior, a visible skill picker, a "Create without refinement" path inside the new M3 flow, or any new top-level package. Any task that requires such code is out of scope for M3.

### Inherited constraints from M1 / M2 reviews

**DaemonContext seam (from M1 review, reaffirmed by M2).** M3 work that touches `createGoal` or introduces new daemon use cases MUST keep the explicit `DaemonContext` seam established in M2: `{ db, bus, now, invokeSkill, ... }` passed in by caller. Add new dependencies (e.g. `inspectWorkspace`) as additional fields on `DaemonContext` rather than reaching for module globals. Production wiring stays in `apps/daemon/src/index.ts`; tests construct an explicit context per case. No DI framework, no container, no decorators.

**Sidecar surface freeze (from M1 review, reaffirmed by M2).** Do not modify `apps/daemon/scripts/build-sidecar.mjs`, `apps/daemon/src/sidecar-bootstrap.ts`, or the desktop spawn paths in `apps/desktop/src-tauri/src/lib.rs`. New M3 code must be exercised by the standalone daemon (`pnpm --filter @orca/daemon dev`) and via the existing Tauri dev path; M3 must not depend on SEA bundle layout changes.

**Registry immutability (from M2).** The `goal.refine` extension point and the `guided-goal-refinement` skill are registered before the HTTP listener accepts connections and before registries are frozen (M2 invariant). M3 must not add hot-registration paths or skill-mutation APIs.

**Existing M1/M2 wire shapes are frozen.** The M1/M2 `POST /v1/goals` minimal body (`{ title, description }`) and the `CreateGoalResponse` shape MUST remain byte-identical. M3 extends `CreateGoalRequest` additively (optional `refined`, optional `workspaces`); the response is unchanged. The desktop Create Goal flow performs `GET /v1/goals/:id` after a successful create to load refinement + workspaces — it does not depend on a richer create response.

This document decomposes Milestone 3 (Goal Creation and Workspaces) into bounded executable tasks. Each task is sized for a single AI session, has explicit acceptance criteria, and is reviewable in isolation.

The single proof point for M3 is:

```text
User starts a Goal creation flow
  -> daemon auto-selects the internal Goal refinement skill (goal.refine)
  -> user enters a rough Goal
  -> user reviews deterministic refined Goal fields
  -> user attaches one or more local workspaces
  -> daemon validates absolute paths and captures basic git metadata
  -> daemon commits Goal, refinement, workspace projections, and domain events
     atomically where appropriate (skill.invoked, goal.created, goal.refined?,
     workspace.attached × N in that order, single SQLite transaction)
  -> daemon broadcasts events only after commit
  -> UI opens a Goal detail view showing refined Goal details and attached workspaces
  -> refined Goal and workspace state survive daemon restart
```

---

## Conventions

- **Task ID:** `M3-NNN` (zero-padded, sequenced for default execution order).
- **Affected Areas:** Paths are relative to repo root.
- **Validation Steps:** Every task lists at least one deterministic command or scenario.
- **No task may exceed its declared scope** even if adjacent work seems easy — additive scope belongs in a follow-up task.
- **Full-suite gates:** `pnpm -r typecheck` and `pnpm -r test` run at M3-009 (daemon integration) and M3-012 (final). Targeted tests run inside every other task.
- **Atomicity rule:** every M3 daemon write that emits events MUST insert events and projection rows inside the same SQLite transaction and broadcast on the event bus **only after** `COMMIT` returns.

---

## Tasks

---

### M3-000 — Baseline Verification

**Purpose.** Lock in a known-good M1/M2 baseline before any M3 change lands. Establishes the regression anchor so every later M3 failure is unambiguously attributable to M3 work, and so M3-011 / M3-012 can compare against a recorded green state.

**Scope.**
- IS: run typecheck + tests; record commit SHA and test summary; verify M1 and M2 named tests are present and green.
- IS NOT: any code changes, dependency upgrades, new tests, doc edits, or migrations.

**Requirements.**
- From a clean working tree, run:
  - `pnpm install --frozen-lockfile`
  - `pnpm -r typecheck`
  - `pnpm -r test`
- Confirm `apps/daemon/test/m1-017.integration.test.ts` appears in the test summary as PASS.
- Confirm `apps/daemon/src/m2-loop.test.ts` appears in the test summary as PASS.
- Record in implementation notes / PR description:
  - `git rev-parse HEAD`
  - Date / time
  - One-line summary of test results

**Affected Areas.** None (read-only verification).

**Dependencies.** None.

**Acceptance Criteria.**
- Baseline SHA recorded.
- M1 integration test and M2 loop test both observed as PASS.
- Working tree is clean at the recorded SHA (`git status` reports no changes).

**Validation Steps.**
- `git status` → clean.
- `pnpm -r typecheck` → exit 0.
- `pnpm -r test` → exit 0, with M1 and M2 named tests present.

**Risks / Notes.**
- If baseline is red, do not begin M3-001 — investigate upstream first.
- Do not commit anything in this task.

---

### M3-001 — Contracts for M3 Goal Detail, Refinement, Workspaces, and Events

**Purpose.** Establish the shared wire contracts before daemon or desktop code depends on them. The contracts package is the single source of truth that both ends of the local IPC must agree on. If this is wrong, every downstream task is wrong. This task unlocks typed shapes for the new endpoints, the new `goal.refine` extension point, and the three new event types.

**Scope.**
- IS: extend `DomainEventType` enum; extend `SkillExtensionPoint`; add new request/response schemas; add new domain-object schemas; extend `CreateGoalRequest` additively; add a structured error-code union for workspace/refinement errors; round-trip parse tests.
- IS NOT: daemon code, DB code, desktop code; no `ListWorkspacesResponse`; no `GET /v1/goals/:id/workspaces` schema; no `PATCH /v1/workspaces/:id` schema; no `skillId` field on `RefineGoalRequest`; no change to `CreateGoalResponse`.

**Requirements.**
- File: `packages/contracts/src/index.ts`.
- Extend `DomainEventType` enum with literals `"goal.refined"`, `"workspace.attached"`, `"workspace.removed"`. Preserve existing literals in their existing order; append the new ones.
- Extend `SkillExtensionPoint` enum with `"goal.refine"`. Preserve `"goal.create"`.
- Add `WorkspaceType = z.enum(["repo", "folder"])`.
- Add `GitProbe = z.enum(["ok", "unavailable", "errored", "not_a_repo"])`.
- Add `Workspace = z.object({ id, goalId, path, name, workspaceType: WorkspaceType, branch: z.string().nullable(), isDirty: z.boolean().nullable(), gitProbe: GitProbe, attachedAt })`.
- Add `GoalRefinement = z.object({ goalId, skillId, successCriteria: z.array(z.string()), constraints: z.array(z.string()), assumptions: z.array(z.string()), refinedAt })`.
- Add `GuidedRefinementInput = z.object({ title: z.string().min(1).max(200), description: z.string().max(4000).default("") })`.
- Add `GuidedRefinementOutput = z.object({ skillId: z.literal("guided-goal-refinement"), title: z.string().min(1).max(200), description: z.string().max(4000), successCriteria: z.array(z.string().min(1).max(200)).max(20), constraints: z.array(z.string().min(1).max(200)).max(20), assumptions: z.array(z.string().min(1).max(200)).max(20) })`.
- Add `RefineGoalRequest = z.object({ title: z.string().min(1).max(200), description: z.string().max(4000).default("") }).strict()`. No `skillId`.
- Add `RefineGoalResponse = z.object({ draft: GuidedRefinementOutput })`.
- Add `InspectWorkspaceRequest = z.object({ inputPath: z.string().min(1).max(1024) }).strict()`.
- Add `InspectWorkspacePreview = Workspace.omit({ id: true, goalId: true, attachedAt: true })`.
- Add `InspectWorkspaceResponse = z.object({ preview: InspectWorkspacePreview })`.
- Add `AttachWorkspaceRequest = z.object({ inputPath: z.string().min(1).max(1024), name: z.string().trim().min(1).max(100).optional() }).strict()`.
- Add `AttachWorkspaceResponse = z.object({ workspace: Workspace })`.
- Add `GoalDetailResponse = z.object({ goal: Goal, refinement: GoalRefinement.nullable(), workspaces: z.array(Workspace) })` where `Goal` is the existing M1 Goal schema (do not redefine it).
- Extend `CreateGoalRequest` additively: add optional `refined: GuidedRefinementOutput.optional()` and optional `workspaces: z.array(z.object({ inputPath: z.string().min(1).max(1024), name: z.string().trim().min(1).max(100).optional() })).optional()`. Do not change existing required fields. Do not change `CreateGoalResponse`.
- Add `M3ErrorCode = z.enum(["invalid_input", "not_found", "not_a_directory", "not_readable", "inspection_timeout", "workspace_duplicate", "duplicate_workspace_in_request", "runtime_misconfigured"])` and export it.
- Add a round-trip parse fixture suite covering each new schema (happy + at least one reject path each, e.g. rejecting unknown keys on `RefineGoalRequest`).

**Affected Areas.**
- `packages/contracts/src/index.ts`
- `packages/contracts/` tests (new fixtures).

**Dependencies.** M3-000.

**Acceptance Criteria.**
- M1/M2 minimal create body `{ title, description }` still parses through `CreateGoalRequest`.
- `CreateGoalResponse` schema is byte-identical to its pre-M3 form (compare against M3-000 baseline file diff for `CreateGoalResponse`).
- `RefineGoalRequest` rejects unknown keys, including a sneaked-in `skillId`.
- `GuidedRefinementOutput.skillId` is `z.literal("guided-goal-refinement")` — any other value rejected.
- No `ListWorkspacesResponse` is exported.
- No `GoalWorkspacesListResponse` is exported.
- No `PATCH`-style workspace request is exported.
- All round-trip fixtures pass.

**Validation Steps.**
- `pnpm --filter @orca/contracts typecheck` → exit 0.
- `pnpm --filter @orca/contracts test` → exit 0.
- `grep -n "ListWorkspacesResponse" packages/contracts/src/index.ts` → empty.
- `grep -n "skillId" packages/contracts/src/index.ts` → only inside `GuidedRefinementOutput` and existing M2 contexts; not inside `RefineGoalRequest`.

**Risks / Notes.**
- `refined.skillId` must remain a literal until a second `goal.refine` skill ships (deferred to M5+).
- Use `.strict()` on request schemas to catch typos and unknown fields at parse time.
- Resist the temptation to introduce a `Path = z.string()` brand type; absolute-path enforcement is M3-004's responsibility, not contracts.

---

### M3-002 — Database Migration for Refinements and Workspaces

**Purpose.** Add the two M3 projection tables (`goal_refinements`, `workspaces`) and their indexes. These tables are the post-restart source of truth for refinement and workspace state, satisfying the proof-point requirement that "refined Goal and workspace state survive daemon restart." This task unlocks all M3 projection helpers and use cases.

**Scope.**
- IS: new migration file `0002_workspaces_refinements.sql`; migration test extensions covering apply / replay / fresh DB.
- IS NOT: any memory/session/task/recommendation/workflow/scan/index table; no `input_path` column on `workspaces`; no read/write helpers (those land in M3-005); no event-store schema change.

**Requirements.**
- File: `apps/daemon/migrations/0002_workspaces_refinements.sql`.
- Create table `goal_refinements`:
  - `goal_id TEXT PRIMARY KEY`
  - `skill_id TEXT NOT NULL`
  - `success_criteria TEXT NOT NULL` (JSON array<string>)
  - `constraints TEXT NOT NULL` (JSON array<string>)
  - `assumptions TEXT NOT NULL` (JSON array<string>)
  - `refined_at TEXT NOT NULL`
  - `FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE`
- Create table `workspaces`:
  - `id TEXT PRIMARY KEY`
  - `goal_id TEXT NOT NULL`
  - `path TEXT NOT NULL` (canonical realpath; no `input_path`)
  - `name TEXT NOT NULL`
  - `workspace_type TEXT NOT NULL` (`'repo'` | `'folder'`)
  - `branch TEXT` (NULL when unknown)
  - `is_dirty INTEGER` (0 | 1 | NULL)
  - `git_probe TEXT NOT NULL` (`'ok' | 'unavailable' | 'errored' | 'not_a_repo'`)
  - `attached_at TEXT NOT NULL`
  - `FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE`
- Create `CREATE UNIQUE INDEX idx_workspaces_goal_path ON workspaces(goal_id, path)`.
- Create `CREATE INDEX idx_workspaces_goal_attached ON workspaces(goal_id, attached_at)`.
- Extend `apps/daemon/src/migrations.test.ts` (or matching pattern) to assert:
  - Fresh DB applies `0001` and `0002` in order; both tables and both indexes exist post-apply.
  - An M1-initialized DB (only `0001`) upgrades cleanly to `0002` without losing existing rows.
  - Reapplying migrations is a no-op (idempotent via existing `_migrations` registry).
  - Foreign key constraints are enforced (insert workspace with bogus `goal_id` → fails when `PRAGMA foreign_keys = ON`).

**Affected Areas.**
- `apps/daemon/migrations/0002_workspaces_refinements.sql` (new)
- `apps/daemon/src/migrations.test.ts` (extended)

**Dependencies.** M3-001 (contracts must exist so tests can assert that columns line up with `Workspace` / `GoalRefinement` shapes).

**Acceptance Criteria.**
- Migration tests pass.
- Schema introspection (`PRAGMA table_info(workspaces)`) returns exactly the columns above — no extra `input_path`, no `metadata_json`, no other speculative columns.
- The two indexes exist (`PRAGMA index_list(workspaces)`).
- No memory, sessions, tasks, recommendations, workflow, scan, or index tables are created.

**Validation Steps.**
- `pnpm --filter @orca/daemon test --run migrations.test` → exit 0.
- `sqlite3 :memory: < migrations/0001_init.sql; sqlite3 :memory: < migrations/0002_workspaces_refinements.sql` smoke (or equivalent in-test SQL).
- `grep -n "input_path" apps/daemon/migrations/0002_workspaces_refinements.sql` → empty.

**Risks / Notes.**
- Keep `is_dirty` as `INTEGER` (SQLite has no native boolean); JSON/TS layers convert to `boolean | null` at the projection boundary.
- Do not enable WAL / journal-mode tweaks here; M1 owns DB pragmas.
- `ON DELETE CASCADE` is intentional even though M1/M2 only archive Goals — future hard-delete must clean refinements/workspaces.

**Review Gate 1 (mandatory).** After M3-002, halt and verify contracts (M3-001) + migration surface (M3-002) before any daemon domain code lands. Reviewer checks: no forbidden tables, no forbidden columns, no forbidden contract fields.

---

### M3-003 — Deterministic `guided-goal-refinement` Skill

**Purpose.** Provide the only M3 refinement skill and register the new `goal.refine` extension point. Deterministic parsing means M3 has zero AI cost and zero non-determinism in tests. This task unlocks M3-006's refined-create path and the `POST /v1/goals/refine` endpoint in M3-008.

**Scope.**
- IS: new file `apps/daemon/src/skills/guided-goal-refinement.ts`; registry-type extension; registry bootstrap registration; targeted unit tests covering parsing rules.
- IS NOT: AI calls, prompts, model providers, randomness, timestamps inside the parser output, background reasoning, generic skill invocation surface, regenerate/upsert semantics, a second `goal.refine` skill.

**Requirements.**
- Extend `apps/daemon/src/registry/types.ts` so the registry's `SkillExtensionPoint` includes `"goal.refine"`. Keep the M2 internal type aligned with the contract (M3-001) literal.
- Create `apps/daemon/src/skills/guided-goal-refinement.ts` exporting a deterministic skill descriptor matching the existing M2 skill descriptor shape:
  - `id: "guided-goal-refinement"`
  - `pluginId: "orca.default-skills"`
  - `extensionPoint: "goal.refine"`
  - `title: "Guided Goal Refinement"`
  - `description`: as per §10.2 of the milestone doc.
  - `inputSchema = GuidedRefinementInput`
  - `outputSchema = GuidedRefinementOutput`
  - `invoke(input): GuidedRefinementOutput` — synchronous, pure.
- Implement deterministic parsing per `docs/milestones/3.md` §10.3:
  - Case-insensitive line-anchored section headers (regex):
    - `^\s*(Goals?|Success criteria|Outcomes?)\s*:` → `successCriteria`
    - `^\s*(Constraints?|Requirements?|Must)\s*:` → `constraints`
    - `^\s*(Assumptions?|Given)\s*:` → `assumptions`
  - Inside a section, items extracted as:
    1. Bullet lines: `^\s*(?:[-*•]|\d+\.)\s+(.+)$` → one item per match.
    2. Otherwise: one item per non-empty trimmed line until the next section header or end.
  - Items trimmed, deduplicated by `String.prototype.toLocaleLowerCase()` equality, truncated to 200 chars, capped at 20 per array.
  - Unmatched text remains in `description` verbatim after collapsing 3+ consecutive blank lines to 2.
  - Output `skillId` is always `"guided-goal-refinement"`.
  - Output `title` is the trimmed input title (length validated by schema).
- Extend `apps/daemon/src/registry/bootstrap.ts` (or M2's equivalent) to register the skill under plugin `orca.default-skills`. The registration must occur before registries are frozen and before the HTTP listener starts.
- Add `apps/daemon/src/skills/guided-goal-refinement.test.ts` covering:
  - Empty description → all arrays empty.
  - Single `Goals:` section with bullets → populated `successCriteria`.
  - Mixed `Constraints:` / `Assumptions:` headers in any order → correct routing.
  - Bullet variants (`- `, `* `, `• `, `1. `) all extract.
  - Duplicate items (case-insensitive) deduped.
  - Items > 200 chars truncated to 200.
  - More than 20 items → capped at 20.
  - Unmatched preamble preserved in `description`, with collapsed blank lines.
  - Registry boot test: after bootstrap, `skillRegistry.byExtensionPoint("goal.refine")` returns exactly one entry whose `id === "guided-goal-refinement"`.

**Affected Areas.**
- `apps/daemon/src/skills/guided-goal-refinement.ts` (new)
- `apps/daemon/src/skills/guided-goal-refinement.test.ts` (new)
- `apps/daemon/src/registry/types.ts` (extended)
- `apps/daemon/src/registry/bootstrap.ts` (extended)
- Existing M2 registry tests, if any, may need a single assertion update to reflect the new registered skill count.

**Dependencies.** M3-001.

**Acceptance Criteria.**
- All targeted unit tests pass.
- `skillRegistry.byExtensionPoint("goal.refine")` returns the skill.
- The skill invocation is purely synchronous and depends on nothing outside its inputs (no clock, no random, no IO).
- M2 Quick Goal (`goal.create`) skill is untouched and still passes its existing tests.
- No AI provider import, no `fetch` call, no `Math.random`, no `Date.now` in the skill module.

**Validation Steps.**
- `pnpm --filter @orca/daemon test --run guided-goal-refinement.test` → exit 0.
- `pnpm --filter @orca/daemon test --run registry` → exit 0 (any existing registry test still passes plus new assertion).
- `grep -nE "fetch|Math\\.random|Date\\.now|node:crypto" apps/daemon/src/skills/guided-goal-refinement.ts` → empty.

**Risks / Notes.**
- Deduplication must use case-folded equality, but the kept item should preserve the first occurrence's original casing.
- Branch behavior for unmatched preamble plus matched sections is easy to miss; cover with a fixture that mixes both.
- Skill must remain free of side effects; the M2 invariant that skill invocation is a pure function of its input is preserved.

---

### M3-004 — Workspace Inspection Helper

**Purpose.** Validate absolute local paths and capture attach-time git metadata. This helper is the only place in M3 that touches the filesystem and the only place that shells out to `git`. Inspection is bounded (per-workspace 5s ceiling) and is called from both the `POST /v1/workspaces/inspect` preview endpoint and the commit-time re-inspection in `POST /v1/goals` and `POST /v1/goals/:id/workspaces`.

**Scope.**
- IS: new files `apps/daemon/src/workspaces/inspect.ts` and `apps/daemon/src/workspaces/errors.ts`; targeted unit tests with real tmpdirs and real `git`; missing-`git` and timeout handling.
- IS NOT: persistence, transactions, event emission, HTTP routing, projection writes, file watching, periodic refresh, library-based git access (`simple-git`/`isomorphic-git`/`nodegit`/`dugite` are forbidden), session/PTY/agent code.

**Requirements.**
- File: `apps/daemon/src/workspaces/errors.ts` defining a typed error union:
  - `WorkspaceInspectionError` with discriminator `code: M3ErrorCode` (`"invalid_input" | "not_found" | "not_a_directory" | "not_readable" | "inspection_timeout"`).
  - Constructor helpers (`invalidInput(message)`, `notFound(path)`, etc.) that emit structured shapes the server layer can serialize directly.
- File: `apps/daemon/src/workspaces/inspect.ts` exporting:
  - `inspectWorkspace(inputPath: string): Promise<InspectWorkspacePreview>`
  - Implementation pipeline (short-circuit on failure):
    1. Type check: non-empty string ≤ 1024 chars and `path.isAbsolute(inputPath)`. Reject relative paths with `invalid_input`.
    2. `await fs.realpath(inputPath)` → canonical path. ENOENT/EACCES → `not_found`.
    3. `await fs.stat(canonical)` → must be a directory. ENOENT → `not_found`; non-dir → `not_a_directory`.
    4. `await fs.access(canonical, fs.constants.R_OK)` → must be readable. Error → `not_readable`.
    5. Detect workspace type: `fs.stat(path.join(canonical, ".git"))` ok (file OR directory) → `'repo'`, else `'folder'`.
    6. If `repo`, run two `execFile('git', ...)` calls with `{ cwd: canonical, timeout: 2000, maxBuffer: 1MB }`:
       - `git rev-parse --abbrev-ref HEAD` → `branch`; if stdout trim equals `HEAD` → treat as detached, `branch = null`, `gitProbe = 'errored'` (per §6.5).
       - `git status --porcelain` → `isDirty = stdout.length > 0`.
       - Compose `gitProbe = 'ok'` only when both commands succeed and branch is not `HEAD`.
       - Missing `git` binary (ENOENT from `execFile`) → return `{ workspaceType: 'repo', branch: null, isDirty: null, gitProbe: 'unavailable' }`.
       - Any other git failure → `{ workspaceType: 'repo', branch: null, isDirty: null, gitProbe: 'errored' }`.
       - A per-workspace inspection wall-clock deadline of 5000ms applies; on exceedance reject with `inspection_timeout`.
    7. If `folder`, return `{ workspaceType: 'folder', branch: null, isDirty: null, gitProbe: 'not_a_repo' }`.
  - Always set `name = path.basename(canonical)` unless a caller-supplied name is passed in (helper signature in this task is path-only; name override is added in the use-case layer, M3-007).
  - Capture only success/failure + the dirty boolean from `git status`. Do not log captured stdout/stderr.
- Add tests `apps/daemon/src/workspaces/inspect.test.ts` covering:
  - Relative input → `invalid_input`.
  - Missing path → `not_found`.
  - File (not directory) path → `not_a_directory`.
  - Unreadable directory → `not_readable` (skip on platforms where chmod semantics are unreliable; document the skip with a comment + `if (process.platform === 'win32') return;`).
  - Non-git folder → `workspaceType: 'folder'`, `gitProbe: 'not_a_repo'`.
  - Clean git repo with a real commit → `branch` matches `main` OR `master` (read, don't hardcode), `isDirty: false`, `gitProbe: 'ok'`.
  - Dirty git repo (touch a new file) → `isDirty: true`.
  - Unborn HEAD (`git init` with no commit) → `branch: null`, `gitProbe: 'errored'`.
  - Detached HEAD (`git checkout <sha>`) → `branch: null`, `gitProbe: 'errored'`.
  - Missing `git` binary simulated by `PATH` override → `gitProbe: 'unavailable'`.
  - Hanging `git` simulated by a `cwd` pointing to a tmpdir with a wrapper script (POSIX only; skip on Windows) → `inspection_timeout`.
- Fixture setup must use `fs.mkdtemp(path.join(os.tmpdir(), 'orca-m3-inspect-'))`, set per-test `user.name`/`user.email` via `git config --local`, and clean via `afterEach`.

**Affected Areas.**
- `apps/daemon/src/workspaces/inspect.ts` (new)
- `apps/daemon/src/workspaces/errors.ts` (new)
- `apps/daemon/src/workspaces/inspect.test.ts` (new)

**Dependencies.** M3-001.

**Acceptance Criteria.**
- All targeted tests pass on Linux CI.
- No library import other than `node:fs/promises`, `node:path`, `node:os`, `node:child_process`.
- No global state inside the module (no module-level `let`).
- `inspectWorkspace` never logs captured `git status` stdout.
- Missing `git` is handled lazily — the module loads even when `git` is absent.

**Validation Steps.**
- `pnpm --filter @orca/daemon test --run workspaces/inspect` → exit 0.
- `grep -nE "simple-git|isomorphic-git|nodegit|dugite|chokidar|fs\\.watch" apps/daemon/src/workspaces/inspect.ts` → empty.
- Manual: temporarily rename `git` on PATH and re-run inspection in a REPL (`gitProbe: 'unavailable'` expected).

**Risks / Notes.**
- `execFile` with explicit `cwd` and `timeout` is mandatory; do not use `exec` (shell injection surface).
- `git status --porcelain` output is never logged or returned; only the boolean surfaces.
- Worktrees: `.git` may be a file; `fs.stat` (not `fs.lstat`) is correct.
- Windows: chmod-based unreadable test is unreliable; skip without failing the suite.
- Branch name `HEAD` from `rev-parse --abbrev-ref` always means detached; treat as `branch: null`.

---

### M3-005 — Refinement and Workspace Projection Helpers

**Purpose.** Provide small DB helpers used by the refined-create path (M3-006), attach/detach use cases (M3-007), and Goal detail reads (M3-008). Separating projection I/O from use cases keeps the SQL surface in one place and makes prepared-statement reuse explicit.

**Scope.**
- IS: `apps/daemon/src/goal-refinements.ts`; `apps/daemon/src/workspaces/projection.ts`; targeted projection tests with in-memory SQLite and both migrations applied.
- IS NOT: HTTP routes, event emission, transactions (transactions are owned by the use-case caller), `WorkspaceProvider` abstraction, projection runner / consumer process, event replay utility.

**Requirements.**
- File: `apps/daemon/src/goal-refinements.ts`. Export:
  - `insertGoalRefinement(db, row: { goalId, skillId, successCriteria: string[], constraints: string[], assumptions: string[], refinedAt: string })`
  - `getGoalRefinement(db, goalId): GoalRefinement | null`
  - JSON encode arrays on write; decode and validate against `GuidedRefinementOutput`-compatible shape on read (use the contract schema where appropriate).
  - Surface a typed `RefinementExistsError` only if and when the M3 use case decides to forbid replace (M3 spec uses insert-or-replace semantics for the projection itself, but the create path commits exactly one refinement; the helper SHOULD use `INSERT OR REPLACE` semantics keyed by `goal_id` to keep the rule local).
- File: `apps/daemon/src/workspaces/projection.ts`. Export:
  - `insertWorkspace(db, row: Workspace): void`
  - `deleteWorkspace(db, goalId: string, workspaceId: string): boolean` (returns true if a row was deleted).
  - `findWorkspaceByPath(db, goalId: string, path: string): Workspace | null`
  - `listWorkspacesByGoal(db, goalId: string): Workspace[]` ordered by `attached_at ASC, id ASC` (uses `idx_workspaces_goal_attached`).
  - All boolean ↔ integer (`is_dirty`) and JSON conversions live here.
  - Typed `DuplicateWorkspaceError extends Error & { code: "workspace_duplicate" }` thrown when `findWorkspaceByPath` returns a row pre-insert OR when SQLite raises a unique-index violation (catch and rethrow as the typed error).
- Both modules use M2's prepared-statement cache pattern. Provide a `resetPreparedStatements()` (or whatever the M2 convention is) so test DB swaps don't leak across tests.
- Add tests:
  - `apps/daemon/src/goal-refinements.test.ts` covering insert/get round-trip, replace-on-second-insert (latest wins), get-missing returns null, JSON encode/decode preserves array contents.
  - `apps/daemon/src/workspaces/projection.test.ts` covering insert, list (ordered), find-by-path, delete (returns true vs false), duplicate `(goal_id, path)` raises `DuplicateWorkspaceError`, empty list returns `[]`.
- Tests use in-memory SQLite created via M1's existing `openDatabase()` test helper and apply both migrations.

**Affected Areas.**
- `apps/daemon/src/goal-refinements.ts` (new)
- `apps/daemon/src/goal-refinements.test.ts` (new)
- `apps/daemon/src/workspaces/projection.ts` (new)
- `apps/daemon/src/workspaces/projection.test.ts` (new)

**Dependencies.** M3-002 (tables must exist).

**Acceptance Criteria.**
- All targeted tests pass.
- No helper opens a transaction internally — transactions are the caller's responsibility (M3-006 / M3-007).
- No helper emits events — event emission is the caller's responsibility.
- Prepared statements are reused across calls within a session and reset on DB swap.
- `listWorkspacesByGoal` returns deterministic ordering tied to `attached_at`.

**Validation Steps.**
- `pnpm --filter @orca/daemon test --run goal-refinements.test` → exit 0.
- `pnpm --filter @orca/daemon test --run workspaces/projection` → exit 0.
- `grep -nE "BEGIN|TRANSACTION|bus\\.publish|emit" apps/daemon/src/workspaces/projection.ts apps/daemon/src/goal-refinements.ts` → empty.

**Risks / Notes.**
- Do not introduce a `Repository` or `Projection` base class — single consumer per table.
- The unique-index race is the final guard; the pre-insert `findWorkspaceByPath` exists to make the common case a clean 409 rather than a constraint-violation message.

---

### M3-006 — Extend `createGoal` for Refined Goals with Workspace Attachments

**Purpose.** Commit the refined Goal and its initial workspaces atomically while preserving the M1/M2 minimal create response. This is the central transactional fan-in for M3: one `BEGIN` → events + projections → `COMMIT` → bus broadcasts. Without this, the proof-point cannot be demonstrated.

**Scope.**
- IS: extend `apps/daemon/src/goals.ts::createGoal` signature; await re-inspection of each workspace; validate `refined` payload against `GuidedRefinementOutput`; insert events in the documented order; insert projection rows; broadcast post-commit only; preserve M1/M2 minimal-body return shape; extended `goals.test.ts`.
- IS NOT: HTTP route changes (M3-008); attach/detach use cases (M3-007); skill picker; AI refinement; refinement upsert at the use-case level; `WorkspaceProvider` abstraction.

**Requirements.**
- `createGoal` becomes `async`. All existing call sites MUST be audited and updated to `await` (likely only `server.ts` and tests).
- Extend the input shape to accept optional `refined: GuidedRefinementOutput` and optional `workspaces: Array<{ inputPath: string, name?: string }>` (matches contracts from M3-001).
- Reuse the M2 `DaemonContext` seam; add `inspectWorkspace` to the context type.
- Pre-transaction validation:
  - If `refined` is present, parse it through the contract schema. Reject with `invalid_input` on parse failure.
  - If `workspaces` is present, check for duplicate canonical-path collisions within the request body: run `inspectWorkspace` for each entry, collect canonical paths, reject the entire request with `duplicate_workspace_in_request` if any duplicates are present after canonicalization (per §11.8).
  - Any per-workspace inspection failure rejects the entire request with that failure's structured code; no DB write, no event.
- Transaction body (single SQLite transaction):
  1. Insert `skill.invoked` event only if `refined` is present. Payload `{ skillId: "guided-goal-refinement", extensionPoint: "goal.refine", durationMs: 0 }` (deterministic skill, no measured duration in M3).
  2. Insert `goal.created` event and the `goals` row (preserved M1/M2 behavior; reuse existing helper).
  3. If `refined` is present: insert `goal.refined` event with payload `{ skillId, successCriteria, constraints, assumptions }` and insert one row into `goal_refinements` via the M3-005 helper.
  4. For each workspace, in user-supplied order: insert `workspace.attached` event with the full payload from §7.2 and insert one row into `workspaces` via the M3-005 helper.
- After `COMMIT`, broadcast each newly inserted event in committed order via the existing event bus (same pattern M2 established for `skill.invoked`).
- On any error inside the transaction (including unique-index violation): roll back, broadcast nothing, return the structured error.
- Return shape: the existing `CreateGoalResponse` (`{ goal }`). Do not add fields.

**Affected Areas.**
- `apps/daemon/src/goals.ts` (extended)
- `apps/daemon/src/goals.test.ts` (extended)
- `apps/daemon/src/server.ts` (call site `await` only; route extension belongs to M3-008)
- `apps/daemon/src/index.ts` (production `DaemonContext` factory: add `inspectWorkspace`)
- Any test that fakes `DaemonContext` (extend the fake)

**Dependencies.** M3-003, M3-004, M3-005.

**Acceptance Criteria.**
- M2 minimal create (`{ title, description }`) still produces exactly two events in order: `skill.invoked` (Quick Goal) then `goal.created`. The M2 loop test (`m2-loop.test.ts`) remains unchanged and still passes.
- Refined-only create (`refined` present, no workspaces) persists `skill.invoked` (guided-goal-refinement) → `goal.created` → `goal.refined`, and one row in `goal_refinements`.
- Refined + 2-workspace create persists 5 events in order: `skill.invoked`, `goal.created`, `goal.refined`, `workspace.attached`, `workspace.attached`; two rows in `workspaces`; one row in `goal_refinements`.
- Any inspection failure (path missing, not readable, timeout) on any workspace rejects the entire request with NO rows written and NO events broadcast.
- Duplicate canonical paths within a single request → `duplicate_workspace_in_request`, no partial write.
- Bus broadcasts occur only after `COMMIT` returns; tests assert "no broadcast on rollback".
- `createGoal` is `async` and every call site uses `await`.
- The response body for M2 minimal create is byte-equal to its pre-M3 form.

**Validation Steps.**
- `pnpm --filter @orca/daemon test --run goals.test` → exit 0.
- `pnpm --filter @orca/daemon test --run m2-loop.test` → exit 0 (unchanged).
- `pnpm --filter @orca/daemon typecheck` → exit 0 (catches missed `await`).
- `grep -n "createGoal(" apps/daemon/src apps/daemon/test packages | grep -v "await createGoal"` → only definitions / type usages; no unawaited call sites.

**Risks / Notes.**
- Most common defect: missing `await` on a call site. Typecheck will flag if the call site is in TS; runtime would silently drop the promise otherwise.
- Spy the event bus in tests to assert ordering AND post-commit-only emission; reset between cases.
- The M2 `skill.invoked` payload for Quick Goal stays as-is for the M2 minimal path; the new `skill.invoked` payload for `guided-goal-refinement` is emitted only on the refined path.

**Review Gate 2 (mandatory).** After M3-006, halt and verify (a) atomic create behavior — all-or-nothing, broadcast only after commit; (b) M1/M2 regression safety — minimal create unchanged, M2 loop test green. No further work in M3-007+ until this is verified.

---

### M3-007 — Workspace Attach / Detach Use Cases

**Purpose.** Support post-creation workspace lifecycle (the "I forgot a repo" flow and removal) without building sessions or any background re-inspection. These are the second and third transactional surfaces in M3.

**Scope.**
- IS: `apps/daemon/src/workspaces/usecases.ts` exporting `attachWorkspace` and `detachWorkspace`; targeted use-case tests with a DB and a bus spy.
- IS NOT: HTTP routes (M3-008); WebSocket envelopes; `WorkspaceProvider` interface; periodic refresh; metadata patch; multi-workspace attach in a single call.

**Requirements.**
- `attachWorkspace(ctx, { goalId, inputPath, name? }): Promise<Workspace>`:
  1. Verify the Goal exists and is not archived; otherwise return a typed not-found error → 404 surface at the route layer.
  2. `inspectWorkspace(inputPath)` (authoritative; UI preview is not trusted).
  3. `findWorkspaceByPath(db, goalId, canonical)` → if found, throw `DuplicateWorkspaceError` (route maps to 409).
  4. Begin transaction; insert `workspace.attached` event; insert `workspaces` row; commit.
  5. After commit, `bus.publish` the event.
  6. Return the inserted `Workspace`.
- `detachWorkspace(ctx, { goalId, workspaceId }): Promise<void>`:
  1. Load the workspace; if not found OR its `goal_id` does not match the URL Goal, return typed not-found (route maps to 404).
  2. Begin transaction; insert `workspace.removed` event with payload `{ workspaceId }`; `deleteWorkspace(...)`; commit.
  3. After commit, `bus.publish` the event.
- Both use cases route through the same `DaemonContext` as `createGoal`. No new global imports.
- Tests `apps/daemon/src/workspaces/usecases.test.ts`:
  - attach to existing Goal, non-git folder → row inserted, event broadcast post-commit.
  - attach a real git repo → branch/isDirty captured.
  - attach with same canonical path twice → 409, second invocation does not insert, does not broadcast.
  - attach to nonexistent Goal → 404 surface, no event, no row.
  - detach existing workspace → row gone, event broadcast.
  - detach when `goalId` ≠ workspace's `goal_id` → 404, no event.
  - detach nonexistent `workspaceId` → 404, no event.
  - inspection failure inside `attachWorkspace` → no event, no row, error propagated.

**Affected Areas.**
- `apps/daemon/src/workspaces/usecases.ts` (new)
- `apps/daemon/src/workspaces/usecases.test.ts` (new)

**Dependencies.** M3-004, M3-005.

**Acceptance Criteria.**
- All use-case tests pass.
- Event broadcasts occur only after `COMMIT`; failure cases broadcast zero events.
- Duplicate canonical path produces a typed `workspace_duplicate` error.
- Mismatched `goal_id`/`workspaceId` produces a typed not-found.
- No background re-inspection or refresh.

**Validation Steps.**
- `pnpm --filter @orca/daemon test --run workspaces/usecases` → exit 0.
- `grep -nE "setInterval|setTimeout|fs\\.watch|chokidar" apps/daemon/src/workspaces/usecases.ts` → empty.

**Risks / Notes.**
- Reuse `inspectWorkspace` directly. Do not introduce a `WorkspaceProvider` interface — only one source (local FS) is needed.
- TOCTOU between inspect and DB insert is mitigated by the unique index — the 409 path covers concurrent inserts.

---

### M3-008 — HTTP Routes for M3

**Purpose.** Expose the minimum public API the desktop flow and integration tests need. Every M3 route inherits M1's bearer-token auth and CORS list. No new auth surface, no generic skill invocation, no list-of-workspaces endpoint.

**Scope.**
- IS: six routes (one new pure-compute endpoint, one extended create, one Goal detail, one attach, one detach, one inspect); structured error mapping from typed daemon errors to HTTP responses; server tests.
- IS NOT: `GET /v1/goals/:id/workspaces`, `GET /v1/workspaces`, `PATCH /v1/workspaces/:id`, `POST /v1/skills/:id/invoke`, websocket envelopes / typed broadcast channels, URL routing on the desktop side.

**Requirements.**
- File: `apps/daemon/src/server.ts`. Routes:
  - `POST /v1/goals/refine`
    - Parse body against `RefineGoalRequest`.
    - Look up the single registered `goal.refine` skill via `skillRegistry.byExtensionPoint("goal.refine")`. If missing → 500 `runtime_misconfigured`.
    - Invoke the skill synchronously with `{ title, description }`; respond `200 { draft }`.
    - No persistence, no event.
  - `POST /v1/goals` (extended)
    - Parse body against `CreateGoalRequest`. If body lacks `refined` and `workspaces`, fall through to M2 minimal path unchanged.
    - If body contains `refined` and/or `workspaces`, delegate to the extended `createGoal` (M3-006).
    - Response is the existing `CreateGoalResponse` shape.
  - `GET /v1/goals/:id`
    - Load goal; if archived or missing → 404.
    - Load refinement via M3-005 helper.
    - Load workspaces via M3-005 helper (ordered by `attached_at`).
    - Respond `200 { goal, refinement, workspaces }` (matches `GoalDetailResponse`).
  - `POST /v1/goals/:id/workspaces`
    - Parse body against `AttachWorkspaceRequest`.
    - Delegate to `attachWorkspace`. Map errors:
      - `workspace_duplicate` → 409.
      - inspection failures → 400 (or 504 for `inspection_timeout`).
      - Goal missing → 404.
    - Respond `201 { workspace }`.
  - `DELETE /v1/goals/:id/workspaces/:workspaceId`
    - Delegate to `detachWorkspace`. Mismatched IDs → 404. Success → 204 no content.
  - `POST /v1/workspaces/inspect`
    - Parse body against `InspectWorkspaceRequest`.
    - Call `inspectWorkspace(inputPath)`. Map inspection errors to 400 (with `code` from the typed error). `inspection_timeout` → 504.
    - Respond `200 { preview }`.
- All routes use the existing M1 bearer-token middleware; CORS allow-list is unchanged.
- Structured error response shape: `{ error: { code, message } }` (consistent with M1/M2).
- File: `apps/daemon/src/server.test.ts` (extended) covering:
  - `POST /v1/goals/refine` happy path; auth missing → 401.
  - `POST /v1/goals` with M2 minimal body returns the existing response shape (snapshot compared against M3-000 baseline).
  - `POST /v1/goals` with `refined` + 2 workspaces returns 201 and emits events in correct order (assert via bus spy).
  - `POST /v1/goals` with one bad workspace path → 400, zero events, zero rows.
  - `POST /v1/goals` with duplicate paths in request body → 400 `duplicate_workspace_in_request`.
  - `GET /v1/goals/:id` returns 404 for nonexistent / archived.
  - `GET /v1/goals/:id` returns the bundle for an existing refined Goal with 2 workspaces.
  - `POST /v1/goals/:id/workspaces` happy + 409 on duplicate canonical path.
  - `DELETE /v1/goals/:id/workspaces/:workspaceId` happy + 404 mismatched IDs.
  - `POST /v1/workspaces/inspect` happy + each error code.
  - All routes return 401 when the bearer token is missing.

**Affected Areas.**
- `apps/daemon/src/server.ts` (extended)
- `apps/daemon/src/server.test.ts` (extended)

**Dependencies.** M3-006, M3-007.

**Acceptance Criteria.**
- All new server tests pass; existing M1/M2 server tests pass unchanged.
- `POST /v1/goals` minimal-body snapshot is byte-equal to the M3-000 baseline.
- No `GET /v1/workspaces` route exists.
- No `GET /v1/goals/:id/workspaces` route exists.
- No `PATCH /v1/workspaces/:id` route exists.
- No generic `POST /v1/skills/:id/invoke` route exists.
- All M3 routes enforce bearer auth.

**Validation Steps.**
- `pnpm --filter @orca/daemon test --run server.test` → exit 0.
- `grep -nE "v1/workspaces[^/]|GET .*goals/:id/workspaces|PATCH .*workspaces|skills/:id/invoke" apps/daemon/src/server.ts` → empty.

**Risks / Notes.**
- Keep route handlers thin — parse body, call use case, map errors. Domain logic stays in the use cases.
- The minimal-body snapshot test is the regression guard for the frozen M1/M2 response shape.

---

### M3-009 — Daemon Integration Test for the Full M3 Loop

**Purpose.** Prove HTTP + DB + events + projections + git inspection + restart persistence all hold together. This is the architectural gate: if this test passes, the M3 proof point is met at the daemon level even before any UI exists.

**Scope.**
- IS: one integration test `apps/daemon/test/m3-create-goal-with-workspaces.integration.test.ts`; helper utilities for tmpdir + git fixture if not already present.
- IS NOT: desktop UI; manual smoke; performance test; cross-process WS stress.

**Requirements.**
- Test layout follows the existing `m1-017.integration.test.ts` pattern (boot a real daemon, real SQLite, real fastify, real bus).
- Each test owns:
  - `fs.mkdtemp(path.join(os.tmpdir(), 'orca-m3-int-'))`
  - A subdirectory created via `git init`, configured with `user.name`/`user.email` locally, with one initial commit, branch read from `git rev-parse --abbrev-ref HEAD` (don't hardcode `main` vs `master`).
  - A subdirectory created as a plain folder (no `.git`).
  - Daemon DB path inside the tmpdir.
- Test scenario:
  1. Boot daemon. Issue `POST /v1/workspaces/inspect` against the git repo → assert `gitProbe: 'ok'`, `branch` matches what `git rev-parse` reports.
  2. Issue `POST /v1/workspaces/inspect` against the plain folder → assert `gitProbe: 'not_a_repo'`.
  3. Issue `POST /v1/goals/refine` with a description containing `Goals:` and `Constraints:` sections; assert `draft` contents.
  4. Issue `POST /v1/goals` with the draft (as `refined`) and both workspaces; assert 201 and the response body matches the M1/M2 shape.
  5. Query the `events` table directly and assert the exact event order by `seq`: `skill.invoked`, `goal.created`, `goal.refined`, `workspace.attached`, `workspace.attached`.
  6. `GET /v1/goals/:id` → assert the bundle includes the refinement and both workspaces in attach order, with correct git metadata.
  7. Shut down the daemon (close DB, close server).
  8. Reboot the daemon against the same DB path.
  9. `GET /v1/goals/:id` → assert the bundle is byte-equal to the pre-shutdown bundle (modulo any timestamps, which should be stable since attach time).
  10. `DELETE /v1/goals/:id/workspaces/:wsId` for one workspace; assert 204; refetch detail; assert the workspace is gone and a `workspace.removed` event exists.
  11. Verify all temp dirs are cleaned in `afterAll`.
- Asserts that the bus published events in the same order they were committed (subscribe a spy before issuing requests, assert recorded order matches DB `seq` order).

**Affected Areas.**
- `apps/daemon/test/m3-create-goal-with-workspaces.integration.test.ts` (new)

**Dependencies.** M3-008.

**Acceptance Criteria.**
- Integration test passes locally and in CI.
- All temp dirs cleaned.
- No reliance on a global `git` config (per-test `user.name`/`user.email` set).
- Branch name comparison is structural (matches whatever `git rev-parse` reports), not hardcoded.
- Bundle survives daemon restart byte-for-byte.

**Validation Steps.**
- `pnpm --filter @orca/daemon test --run m3-create-goal-with-workspaces.integration` → exit 0.
- `pnpm -r typecheck` → exit 0 **(full-suite gate)**.
- `pnpm -r test` → exit 0 **(full-suite gate)**.

**Risks / Notes.**
- CI must have `git ≥ 2.20`; document in `README.md` (M3-012).
- Don't compare timestamps literally; use `expect.any(String)` or shape-only matchers for ISO fields whose values can drift.
- The bus spy must be installed BEFORE the first request — late subscription misses events.

**Review Gate 3 (mandatory).** After M3-009, halt and run the full `pnpm -r typecheck` and `pnpm -r test`. Reviewer verifies: daemon API surface, event order, projection state post-restart. No desktop code lands until this gate is signed off.

---

### M3-010 — Desktop API Client Extensions

**Purpose.** Add typed client calls for the M3 endpoints so the Create Goal flow and Goal detail view can talk to the daemon without inline `fetch` calls.

**Scope.**
- IS: extend `apps/desktop/src/api.ts` with five new methods; preserve existing client behavior; small mocked-fetch tests for success and structured-error parsing.
- IS NOT: UI components, reducer, routing, styling, URL handling.

**Requirements.**
- File: `apps/desktop/src/api.ts`. Add methods, each typed via the M3-001 contracts:
  - `refineGoal(input: RefineGoalRequest): Promise<RefineGoalResponse>` → `POST /v1/goals/refine`.
  - `getGoalDetail(goalId: string): Promise<GoalDetailResponse>` → `GET /v1/goals/:id`.
  - `inspectWorkspace(input: InspectWorkspaceRequest): Promise<InspectWorkspaceResponse>` → `POST /v1/workspaces/inspect`.
  - `attachWorkspace(goalId: string, input: AttachWorkspaceRequest): Promise<AttachWorkspaceResponse>` → `POST /v1/goals/:id/workspaces`.
  - `detachWorkspace(goalId: string, workspaceId: string): Promise<void>` → `DELETE /v1/goals/:id/workspaces/:workspaceId`.
- Extend the existing `createGoal` client method's input type to accept the optional `refined` and `workspaces` fields from the extended contract. Do not change its return type.
- All methods reuse the existing `ApiError` class. `ApiError.code` is optional and is populated from `error.code` in the response body when present.
- Add (or extend) `apps/desktop/src/api.test.ts` with mocked `fetch` covering:
  - Each method's happy path.
  - 400 with structured `error.code` → `ApiError` with `.code` populated.
  - 401 → `ApiError` (unauthorized).
  - 404 → `ApiError`.
  - 409 → `ApiError` with `.code === "workspace_duplicate"`.
  - 504 → `ApiError` with `.code === "inspection_timeout"`.

**Affected Areas.**
- `apps/desktop/src/api.ts` (extended)
- `apps/desktop/src/api.test.ts` (extended or new)

**Dependencies.** M3-001, M3-008.

**Acceptance Criteria.**
- Desktop typecheck passes.
- Mocked tests pass.
- No inline `fetch` calls anywhere outside `api.ts` (grep guard).

**Validation Steps.**
- `pnpm --filter @orca/desktop typecheck` → exit 0.
- `pnpm --filter @orca/desktop test --run api.test` → exit 0.
- `grep -nE "fetch\\(" apps/desktop/src | grep -v "apps/desktop/src/api.ts"` → empty.

**Risks / Notes.**
- Keep `ApiError.code` optional to remain backward-compatible with M1/M2 errors that lack a code.
- Do not introduce a generic invoke client (`POST /v1/skills/:id/invoke`) — the daemon doesn't expose it.

---

### M3-011 — Desktop Create Goal Flow and Goal Detail View

**Purpose.** Prove the user-facing refined Goal + multi-workspace loop with the minimum UI required to demonstrate the proof point. This is the only UI work in M3. Everything is mounted from the existing M1 goal list.

**Scope.**
- IS: three-step Create Goal flow (rough → refine review → workspace attach); `useReducer`-based local state; Goal detail view with refinement and workspaces sections; attach/remove controls on the detail view; WebSocket-driven detail refetch; reducer tests; component smoke tests; additive CSS; manual smoke against a real daemon.
- IS NOT: URL routing, deep-linking, command-center placeholders, sessions panel, memory panel, task panel, recommendations panel, workflow panel, skill picker UI, state-management library (Redux/Zustand), styling framework (Tailwind/styled-components), confirmation step component, "Create without refinement" branch inside the new flow.

**Requirements.**
- Directories (new):
  - `apps/desktop/src/create-goal-flow/CreateGoalFlow.tsx`
  - `apps/desktop/src/create-goal-flow/state.ts`
  - `apps/desktop/src/create-goal-flow/state.test.ts`
  - `apps/desktop/src/create-goal-flow/steps/RoughGoalStep.tsx`
  - `apps/desktop/src/create-goal-flow/steps/RefinementReviewStep.tsx`
  - `apps/desktop/src/create-goal-flow/steps/WorkspaceAttachStep.tsx`
  - `apps/desktop/src/goal-detail/GoalDetailView.tsx`
  - `apps/desktop/src/goal-detail/WorkspaceListPanel.tsx`
- `state.ts`: tagged-union state with reducer actions:
  - `{ phase: 'rough', title, description }`
  - `{ phase: 'refining', title, description }` (async)
  - `{ phase: 'review', title, description, draft }`
  - `{ phase: 'workspaces', title, description, draft, pendingWorkspaces[], inspecting?, error? }`
  - `{ phase: 'submitting', ... }`
  - `{ phase: 'done', goalId }`
- Actions: `refineRequested`, `refineSucceeded`, `refineFailed`, `editArrayItem`, `addArrayItem`, `removeArrayItem`, `backToRough`, `proceedToWorkspaces`, `inspectRequested`, `inspectSucceeded`, `inspectFailed`, `removePending`, `backToReview`, `submitRequested`, `submitSucceeded`, `submitFailed`.
- All async results enter via reducer actions — no `setState` for async outputs.
- `RoughGoalStep`: title (required, ≤200), description (optional, ≤4000), "Refine" button (disabled when daemon connection is closed or title empty).
- `RefinementReviewStep`: three editable arrays (success criteria, constraints, assumptions). Each item is a one-line input with delete affordance. "Add" appends an empty row. "Continue" advances. "Back" returns to step 1.
- `WorkspaceAttachStep`:
  - Path input (absolute path). Tilde may be expanded client-side via a Tauri command before calling `inspectWorkspace`.
  - "Inspect" button debounced 250ms; loading spinner on the row.
  - On success, render `name` (editable, ≤100 chars), type chip (`repo`/`folder`), branch chip (if any), dirty dot, Remove affordance.
  - On failure, inline error + Retry.
  - Soft UI cap: 8 pending workspaces per request (server has no cap in M3).
  - "Create Goal" submits even with zero pending workspaces but shows a soft warning ("This Goal has no workspaces yet").
- Submit flow:
  1. `createGoal({ title, description, refined: draft, workspaces: pendingWorkspaces.map(toCreatePayload) })`.
  2. On 201, call `getGoalDetail(goal.id)`.
  3. Close the modal; `App.tsx` sets `{ mode: 'detail', currentGoalId }`.
- `GoalDetailView`:
  - Back button → `{ mode: 'list' }`.
  - Title + description.
  - Refinement section: visible only if refinement exists. Three bullet lists.
  - Workspaces section: count + `+ Add` button. Each row shows name, canonical path, type chip, branch chip (if any), dirty dot, Remove.
  - `+ Add` opens an inline path input → `inspectWorkspace` preview → confirm → `attachWorkspace`.
  - Remove → confirmation prompt → `detachWorkspace`.
  - No placeholder panels for sessions / memory / tasks / recommendations.
- WebSocket handling (extend M1 listener):
  - If a `goal.refined`, `workspace.attached`, or `workspace.removed` event arrives whose `goalId === currentGoalId`, refetch `getGoalDetail`.
  - `goal.created` / `goal.updated` / `goal.archived` still drive the goal-list refetch (M1/M2 behavior).
  - `skill.invoked` is ignored (M2 behavior).
- Routing in `App.tsx`: add a `mode` state (`'list' | 'detail'`) and `currentGoalId` — no router, no URL fragment.
- CSS: extend `styles.css` additively. No new selectors that touch M1/M2 elements.
- Tests:
  - `state.test.ts`: pure reducer transitions for each action; back transitions preserve typed input; error transitions leave the prior valid state intact.
  - `goal-detail/*.test.tsx`: render with mocked api; assert refinement section visibility, workspace list ordering, refetch on incoming WS event for the open Goal id, no-op for events on other goal ids.
- Manual smoke (recorded per CLAUDE.md):
  - Start `pnpm --filter @orca/daemon dev`.
  - Start `pnpm --filter @orca/desktop dev`.
  - Create one Goal spanning a real local git repo and a non-git folder.
  - Confirm the detail view renders refinement, both workspaces, correct branch + dirty status on the git repo.
  - Attach a third workspace from the detail view; remove the non-git one.
  - Stop and restart the daemon; reopen the desktop app; confirm state survives.

**Affected Areas.**
- `apps/desktop/src/App.tsx` (extended for `mode`/`currentGoalId`)
- `apps/desktop/src/create-goal-flow/` (new directory)
- `apps/desktop/src/goal-detail/` (new directory)
- `apps/desktop/src/styles.css` (additive)
- Targeted tests above.

**Dependencies.** M3-010.

**Acceptance Criteria.**
- Reducer tests cover every action transition listed above.
- Component tests pass with mocked api.
- Manual smoke recorded with at least one git repo and one non-git folder; restart cycle proven.
- No URL routing; no `react-router`, no `next/router`.
- No state-management library imported.
- No placeholder panels for sessions / memory / tasks / recommendations / workflows.
- The refinement skill picker is not visible in the UI.
- The Create Goal flow does not expose a "skip refinement" path.

**Validation Steps.**
- `pnpm --filter @orca/desktop typecheck` → exit 0.
- `pnpm --filter @orca/desktop test` → exit 0.
- Manual smoke documented in `docs/operation-flow/5-implementation-review.md` (or the M3-equivalent doc spawned in M3-012) with a one-line outcome.
- `grep -nE "react-router|next/router|zustand|redux" apps/desktop` → empty.

**Risks / Notes.**
- Async result handling: every API result MUST dispatch a reducer action. Never `setState` async results directly.
- Path expansion: `~` is expanded client-side via Tauri (if available) before calling the daemon; the daemon rejects relative paths.
- The 250ms debounce on inspect is to keep paste-heavy entry from spamming the daemon.
- Keep CSS purely additive — modifying existing M1/M2 selectors risks visual regressions in goal-list and diagnostics views.

**Review Gate 4 (mandatory).** After M3-011, run the desktop manual smoke against one git repo and one non-git folder. Restart cycle MUST pass.

---

### M3-012 — Documentation and Final Review

**Purpose.** Record the actual M3 surface for future agents and contributors and verify Definition of Done.

**Scope.**
- IS: surgical updates to `README.md`; update or create an M3 implementation-review note under `docs/operation-flow/`; final `pnpm -r typecheck` and `pnpm -r test`; self-review against the milestone DoD (§16).
- IS NOT: rewriting M1/M2 docs; adding new architecture documents; expanding scope; refactors discovered during review.

**Requirements.**
- `README.md` additions (high level):
  - Brief description of the Create Goal flow and the three steps.
  - List of M3 endpoints with one-line purpose each.
  - Workspace path rules (absolute only, canonical realpath stored, no `~` server-side).
  - Git behavior (lazy, missing-`git` mapping, snapshot-only).
  - Deferred non-goals reaffirmed.
- An M3 implementation review note under `docs/operation-flow/` (parallel to existing M1/M2 review files) recording:
  - Manual smoke outcome.
  - Any deviations from the milestone spec.
  - Any TODOs explicitly accepted as out-of-scope.
- Final validation:
  - `pnpm -r typecheck` → exit 0.
  - `pnpm -r test` → exit 0.
  - All M1, M2, and M3 named tests still green.
- Self-review checklist against `docs/milestones/3.md` §16 Definition of Done — record each item as confirmed.

**Affected Areas.**
- `README.md` (extended)
- `docs/operation-flow/` (review note added or updated)

**Dependencies.** M3-011.

**Acceptance Criteria.**
- Docs match implemented behavior.
- `pnpm -r typecheck` and `pnpm -r test` both green.
- Manual smoke outcome recorded.
- All fifteen Definition-of-Done items in §16 are confirmed in the review note.

**Validation Steps.**
- `pnpm -r typecheck` → exit 0.
- `pnpm -r test` → exit 0.
- Read-through of the M3 review note against `docs/milestones/3.md` §16.

**Risks / Notes.**
- Keep documentation surgical. Do not rewrite earlier milestone docs.
- Do not introduce planning for M4 in this task — that belongs in a future milestone planning artifact.

**Review Gate 5 (mandatory).** After M3-012, verify Definition of Done and non-goals confirmed. Only then is the codebase ready to enter Milestone 4.

---

## Deliverable 1 — Task Dependency Graph

```text
M3-000  (baseline)
   │
   ▼
M3-001  (contracts)
   │
   ├──────────────┬───────────────────────┐
   ▼              ▼                       ▼
M3-002         M3-003                   M3-004
(migration)    (skill)                  (inspect)
   │              │                       │
   ▼              │                       │
M3-005            │                       │
(projections)     │                       │
   │              │                       │
   └──────┬───────┴───────────────────────┘
          ▼
       M3-006  (createGoal refined+workspaces)   ── GATE 2 ──
          │
          │   ┌─ M3-007 (attach/detach use cases)  ◄── needs M3-004, M3-005
          ▼   ▼
       M3-008  (HTTP routes)
          │
          ▼
       M3-009  (daemon integration test)         ── GATE 3 (full typecheck/test) ──
          │
          ▼
       M3-010  (desktop api client)              ◄── also needs M3-001
          │
          ▼
       M3-011  (desktop UI + manual smoke)       ── GATE 4 (manual smoke) ──
          │
          ▼
       M3-012  (docs + DoD)                       ── GATE 5 (DoD verified) ──
```

**Parallelizable clusters.**
- After M3-001: M3-002, M3-003, M3-004 can proceed in parallel (no shared files).
- After M3-002: M3-005 can begin while M3-003 / M3-004 are still in flight.
- After M3-005: M3-007 unblocks alongside M3-006 once M3-003 and M3-004 are done. M3-007 does not require M3-006; both can land in parallel before M3-008.
- M3-010 can begin in parallel with M3-009 once M3-008 lands, but M3-011 SHOULD wait for the Gate 3 sign-off so desktop work isn't built against a possibly-incorrect daemon contract.

**Blocking tasks.**
- M3-001 blocks everything below it.
- M3-006 blocks M3-008 (and therefore M3-009, M3-010, M3-011).
- M3-009 blocks Gate 3, which is the recommended go/no-go before any desktop UI code.

**Full-suite review gates.**
- Gate 1: after M3-002 (contracts + migration surface).
- Gate 2: after M3-006 (atomic create + M1/M2 regression safety).
- Gate 3: after M3-009 (daemon integration; full `pnpm -r typecheck` + `pnpm -r test`).
- Gate 4: after M3-011 (manual desktop smoke with git + non-git workspace, restart cycle).
- Gate 5: after M3-012 (Definition of Done, non-goals confirmed).

---

## Deliverable 2 — Suggested Model Assignment

| Task | Recommended | Rationale |
|---|---|---|
| M3-000 Baseline verification | **Human** | Verification + judgment about whether baseline is acceptable; trivial to run, but a green/red decision the human should own. |
| M3-001 Contracts + zod schemas | **Codex (GPT 5.3)** | Schema-heavy, mechanical, high-precision. Strong fit for a structured-output model. |
| M3-002 Migration + tests | **Codex (GPT 5.3)** | SQL DDL + migration tests; tightly bounded, deterministic. |
| M3-003 Refinement skill | **Sonnet 4.6** | Mix of regex parsing, schema validation, and registry wiring; medium implementation complexity. |
| M3-004 Workspace inspection | **Sonnet 4.6** | Multi-step IO logic + execFile + several failure-mode tests; medium implementation complexity. |
| M3-005 Projection helpers | **Codex (GPT 5.3)** | Simple SQL helpers + tests; very structured. |
| M3-006 Extend `createGoal` | **Sonnet 4.6** | Transactional fan-in, async refactor of an existing module with regression risk; runtime integration. |
| M3-007 Attach/detach use cases | **Sonnet 4.6** | Two use cases with shared shape; runtime integration. |
| M3-008 HTTP routes | **Sonnet 4.6** | Route wiring + error mapping + bus assertions; UI-adjacent runtime work. |
| M3-009 Daemon integration test | **Sonnet 4.6** | Realistic multi-component test; fixture setup is non-trivial. |
| M3-010 Desktop API client | **Codex (GPT 5.3)** | Typed fetch wrappers + mocked-fetch tests; mechanical. |
| M3-011 Desktop UI + manual smoke | **Sonnet 4.6** (implementation) + **Human** (manual smoke + restart verification) | UI wiring is Sonnet's sweet spot; manual smoke is irreducibly human. |
| M3-012 Documentation + DoD | **Opus** (DoD review) or **Sonnet 4.6** (docs drafting) + **Human** sign-off | Cross-cutting verification benefits from Opus's reasoning; final DoD sign-off is human. |

Opus reserved for cross-cutting decisions only:
- Any mid-milestone scope conflict (e.g. a task proposes a structurally new abstraction).
- Final DoD review (M3-012) if scope drift is suspected.

---

## Deliverable 3 — Recommended Review Gates (with checkpoints)

| Gate | When | Reviewer focus | Mandatory checks |
|---|---|---|---|
| **Gate 1** | After M3-002 | Contracts + migration surface | No `ListWorkspacesResponse`; no `skillId` on `RefineGoalRequest`; `CreateGoalResponse` unchanged; no forbidden tables; `workspaces.path` is canonical-only (no `input_path`); both indexes present. |
| **Gate 2** | After M3-006 | Atomic create + M1/M2 regression safety | M2 minimal create still produces exactly `skill.invoked` + `goal.created`; M2 loop test still green; refined+workspaces commit emits the exact event sequence and persists projections; rollback emits no broadcasts; every call site of `createGoal` is awaited. |
| **Gate 3** | After M3-009 | Full-suite green; daemon API + event + persistence correctness | `pnpm -r typecheck` green; `pnpm -r test` green; integration test asserts event order by `seq` and round-trip restart persistence; bus broadcasts occur post-commit only. |
| **Gate 4** | After M3-011 | Desktop manual smoke | Create flow works with one git repo + one non-git folder; refinement editing works; submit lands on detail view; attach/remove from detail works; daemon restart preserves all state; no URL routing introduced; no placeholder panels. |
| **Gate 5** | After M3-012 | DoD + non-goals | All fifteen DoD items in §16 are confirmed; no `node-pty`, no `chokidar`, no `simple-git`, no AI provider import has been added; no new top-level package; docs match implementation. |

**Recommended sequencing of human attention.**
- Gates 1 and 2 are short reviews — focus on diffs.
- Gate 3 is the single largest review point: run the full suite locally, scan integration test output, spot-check the event-ordering assertions.
- Gate 4 is irreducibly manual — budget at least 20 minutes for the smoke (open app, create, restart, reopen, attach, remove).
- Gate 5 is a checklist pass against §16; if any item is unclear, send back to the M3-012 owner for clarification before declaring M3 complete.

---

## Out-of-scope Reminder (read before any task)

If a task is about to introduce any of the following, **stop and reject the diff**:

- PTY / `node-pty` import
- Any agent adapter or session lifecycle code
- Memory tables, extraction engine, promotion rules, canonical-memory storage
- Recommendation generation, task graph, workflow engine
- `chokidar`, `fs.watch`, or any file watcher
- `simple-git`, `isomorphic-git`, `nodegit`, `dugite`
- AI provider SDKs, prompt management, model calls in the refinement skill
- `GET /v1/workspaces`, `GET /v1/goals/:id/workspaces`, `PATCH /v1/workspaces/:id`, `POST /v1/skills/:id/invoke`
- `ListWorkspacesResponse`, `skillId` on `RefineGoalRequest`, persisted `input_path`
- A skill picker UI, a "create without refinement" path inside the new Create Goal flow, a confirmation step component
- URL routing or deep-linking in the desktop app
- A new top-level package
- Any new state-management or styling library

When in doubt: M3 is the refined-Goal + multi-workspace loop. Everything else is later.
