# Milestone 3 — Implementation Review

Recorded by: M3-012 (Documentation and Final Review).

Scope under review: M3 "Goal Refinement and Workspaces" — adds the `goal.refine`
extension point, the deterministic `guided-goal-refinement` skill, the
`goal_refinements` and `workspaces` projections, the refined-Goal + multi-workspace
create path, the Goal detail bundle, and the three-step desktop Create Goal flow
plus Goal detail view.

References:
- Milestone spec: [`docs/milestones/3.md`](../milestones/3.md) (§16 Definition of Done)
- Executable plan: [`docs/implementation-plans/milestone-3.md`](../implementation-plans/milestone-3.md)

## 1. Validation evidence

Commands run from the repo root at the close of M3-012:

- `pnpm -r typecheck` → exit 0. All three workspaces (`packages/contracts`,
  `apps/daemon`, `apps/desktop`) reported `Done` with no diagnostics.
- `pnpm -r test` → exit 0.
  - `apps/daemon`: 19 test files, 203 tests passed. Includes the M1 anchor
    (`test/m1-017.integration.test.ts`, 6 tests), the M2 loop
    (`src/m2-loop.test.ts`, 8 tests), and the M3 daemon integration
    (`test/m3-create-goal-with-workspaces.integration.test.ts`, 1 test covering
    inspect → refine → create-with-workspaces → detail → restart → detach).
  - `apps/desktop`: 3 test files, 44 tests passed — Create Goal reducer (29),
    typed API client (11), Goal detail view (4).
  - `packages/contracts`: no test runner configured for this package; its
    schemas are exercised by daemon and desktop tests.

## 2. Definition of Done — line-by-line check (`docs/milestones/3.md` §16)

### 16.1 Functional

1. **Create Goal flow end-to-end (rough → refine → workspaces → submit).** Confirmed
   in code: `apps/desktop/src/create-goal-flow/` implements the three steps with a
   `useReducer` state machine; the M3 daemon integration test exercises the same
   round-trip programmatically.
2. **Goal detail view shows title/description, refinement, workspace list.** Confirmed
   in `apps/desktop/src/goal-detail/GoalDetailView.tsx` and its tests; bundle is
   served by `GET /v1/goals/:id`.
3. **Attach / remove from detail view.** Confirmed — desktop attach/remove controls
   call `POST /v1/goals/:id/workspaces` and `DELETE /v1/goals/:id/workspaces/:workspaceId`;
   daemon use cases in `apps/daemon/src/workspaces/usecases.ts`.
4. **Restart preserves Goal, refinement, workspaces.** Confirmed by the M3 daemon
   integration test's explicit restart-and-reload assertion.
5. **M2 minimal create still works unchanged.** Confirmed — `src/m2-loop.test.ts`
   still passes; `CreateGoalResponse` is unchanged; `CreateGoalRequest` is extended
   additively (optional `refined` and `workspaces`); the M2 path emits exactly
   `skill.invoked` + `goal.created`.

### 16.2 Architectural

6. **Only `goal.refined`, `workspace.attached`, `workspace.removed` are new event
   types. Per-transaction ordering: `skill.invoked`, `goal.created`,
   `goal.refined?`, `workspace.attached*`.** Confirmed — `DomainEventType` in
   `packages/contracts/src/index.ts` lists exactly those new event types; ordering
   is enforced in the daemon `createGoal` use case and asserted by the M3
   integration test.
7. **`goal_refinements` and `workspaces` tables exist per §8.1.** Confirmed in
   migration `0002_workspaces_refinements.sql` and `src/migrations.test.ts`.
   The `workspaces` table stores canonical paths only — no `input_path` column.
8. **`guided-goal-refinement` is registered on `goal.refine` under
   `orca.default-skills` and is deterministic.** Confirmed in the M3-003 skill
   module and its unit tests; no model SDK is imported and no async I/O is
   performed during refinement.
9. **No `node-pty`, agent adapter, FS watcher, memory engine, task graph,
   recommendation engine, workflow engine, or Level 4/5 code added.** Confirmed by
   inspection of `package.json` dependencies and `apps/daemon/src/`: no new
   forbidden dependencies; M3 surfaces live only under
   `apps/daemon/src/workspaces/`, `apps/daemon/src/goal-refinements.ts`,
   `apps/daemon/src/skills/guided-goal-refinement.ts`, and `apps/daemon/src/server.ts`.
10. **No new top-level package; M3 lives under `apps/daemon/src/`,
    `apps/desktop/src/`, and `packages/contracts/src/index.ts`.** Confirmed —
    workspace package list unchanged from M2.

### 16.3 Quality gates

11. **`pnpm -r typecheck` green.** Confirmed (see §1 above).
12. **`pnpm -r test` green** including M1-017, M2 loop, M3 integration, and all
    new unit tests for refinement, inspection, projections, use cases, and
    reducer. Confirmed (see §1 above).
13. **Manual desktop smoke recorded.** **Not run in this M3-012 pass.** At the
    developer's direction, the manual smoke step was deferred; M3-012 is
    documentation and DoD review only. Gate 4 therefore remains the developer's
    outstanding obligation before declaring Milestone 3 shippable. The smoke
    procedure is the one named in the plan: open the app, create a Goal with one
    git repo and one non-git folder, edit the refined draft, submit, land on
    detail view, attach a third workspace, remove one, close and reopen the app
    and daemon, confirm state survives.
14. **`README.md` reflects M3 endpoints and the Create Goal flow at a high
    level.** Confirmed — the README's status banner, "What works today,"
    Create Goal flow section, endpoint table, workspace path rules, and git
    behavior section were added in M3-012.

### 16.4 Non-goals confirmed

15. **None of the following were introduced in M3:** PTY / session runtime,
    agent adapters, memory extraction, recommendation generation, workflow
    engine, task graph, workspace indexing, workspace file watching, Level 4
    approval gates, Level 5 autonomy, AI-backed refinement, cloud sync, or any
    network call beyond the existing local daemon API. Confirmed by dependency
    inspection and code review of the M3 diff.

## 3. Out-of-scope reminders cross-check

The plan's explicit "stop and reject" list was re-checked against the M3 diff:

- No `node-pty` import; no agent adapter or session lifecycle code.
- No memory tables; no extraction or promotion code.
- No recommendation, task graph, or workflow engine code.
- No `chokidar`, `fs.watch`, or other FS watcher.
- No `simple-git`, `isomorphic-git`, `nodegit`, or `dugite`. Git inspection uses
  `execFile` against the user's `git` with a bounded deadline.
- No AI provider SDK imports; the refinement skill is regex- and rules-based.
- No `GET /v1/workspaces`, `GET /v1/goals/:id/workspaces`,
  `PATCH /v1/workspaces/:id`, or `POST /v1/skills/:id/invoke` endpoints.
- No `ListWorkspacesResponse`, no `skillId` on `RefineGoalRequest`, no persisted
  `input_path`.
- No skill picker UI, no "create without refinement" path inside the new flow,
  no separate confirmation-step component.
- No URL routing or deep-linking introduced in the desktop app.
- No new top-level package, no new state-management or styling library.

## 4. Deviations from the milestone spec

None of substance. Two documentation-shape choices to note:

- The plan referenced an "M1/M2 review file" parallel under `docs/operation-flow/`,
  but no such per-milestone review files were ever created in those milestones.
  This M3 review note is therefore the first concrete instance of the pattern,
  filed at `docs/operation-flow/m3-implementation-review.md`.
- The Gate 4 manual smoke is recorded as **pending / not run in this M3-012
  pass** per the developer's direction during M3-012. All other gates (1, 2, 3,
  5) and all automated DoD items are confirmed.

## 5. Accepted out-of-scope TODOs

- Manual desktop smoke (Gate 4). Owner: developer. Must be completed before M3
  is declared shippable.
- M4 planning. Explicitly deferred per the plan's "Risks / Notes" — M4 belongs
  in its own milestone planning artifact and is not introduced here.

## 6. Conclusion

All automatable Milestone 3 Definition-of-Done items (DoD §16.1 except item 13,
§16.2, §16.3 items 11/12/14, §16.4) are confirmed. DoD item 13 (manual smoke)
remains open and is the only outstanding gate before M3 can be marked complete.
No excluded M3 surface was introduced, and the architectural guardrails listed
in the plan's out-of-scope reminder all hold.
