# M4-016 — Final Regression and Documentation

## Snapshot

- Date: 2026-05-19
- Branch: `main`
- Baseline anchor: M4-000 recorded SHA `279d435af82a55e08544a6f46cce473c7c3426de`
- Final implementation head before M4-016 commit: `b059e95`

## Automated Validation

- `pnpm -r typecheck` -> exit 0
  - `@orca/contracts`, `@orca/daemon`, and `@orca/desktop` typechecked.
- `pnpm -r test` -> exit 0
  - `packages/contracts`: 1 file, 21 tests passed.
  - `apps/desktop`: 5 files, 74 tests passed.
  - `apps/daemon`: 30 files passed, 4 smoke files skipped by env gate; 366 tests passed, 5 skipped.

Required regression anchors observed as PASS:

- `apps/daemon/test/m1-017.integration.test.ts` — PASS (6 tests)
- `apps/daemon/src/m2-loop.test.ts` — PASS (8 tests)
- `apps/daemon/test/m3-create-goal-with-workspaces.integration.test.ts` — PASS (1 test)
- `apps/daemon/test/m4-011-shell-vertical-slice.integration.test.ts` — PASS (2 tests)

Sidecar packaging invariant:

- `node apps/daemon/scripts/m4-015-sidecar-smoke.mjs` -> exit 0
  - Output included `[m4-015] sidecar PTY smoke passed`.

## Manual Smoke Record

The M4 shell loop was validated through the existing real-shell integration
smoke in `apps/daemon/test/m4-011-shell-vertical-slice.integration.test.ts`.
That smoke creates one Goal with an attached workspace, creates a
`shell-manual` session, subscribes over the existing `/v1/events` WebSocket,
starts the session, sends terminal input, observes `session.output`, exits the
shell, reads the persisted output tail, restarts the daemon against the same
database, and confirms the session detail plus output tail still exist.

Desktop UI coverage for the embedded terminal path is covered by:

- `apps/desktop/src/goal-detail/sessions/SessionsPanel.test.tsx`
- `apps/desktop/src/goal-detail/sessions/SessionTerminalView.test.tsx`
- `apps/desktop/src/goal-detail/GoalDetailView.test.tsx`

No separate Tauri GUI smoke was run in this M4-016 pass.

## Gate 7 DoD Checklist

1. Confirmed. Refined Goal detail can create a session for an attached workspace via the Sessions panel and daemon route.
2. Confirmed. `GET /v1/adapters` exposes shell/manual, Claude Code, opencode, and codex with availability status.
3. Confirmed. Session create/start validate Goal, workspace, adapter, and workspace availability.
4. Confirmed. Create/start/exit/fail/stop lifecycle transitions persist projection rows and domain events transactionally.
5. Confirmed. Lifecycle broadcasts happen after usecase transactions return.
6. Confirmed. `SessionRuntime` tracks one live PTY handle per running session.
7. Confirmed. Desktop renders one embedded xterm.js terminal for the selected session.
8. Confirmed. Input, resize, and output use JSON frames on the existing `/v1/events` WebSocket.
9. Confirmed. Input and resize are not persisted.
10. Confirmed. Output is not persisted in the general `events` table.
11. Confirmed. Capped output tail is stored in `session_output_chunks`.
12. Confirmed. Session list/detail and output tail survive daemon restart.
13. Confirmed. Boot reconciliation marks `starting`/`running` sessions `failed` with `daemon_restart` before listen.
14. Confirmed. Stop sends SIGTERM, then SIGKILL after `ORCA_SESSION_STOP_GRACE_MS`.
15. Confirmed. Command-not-found persists `session.failed` and maps to HTTP 422.
16. Confirmed with one permitted caveat: production PTY code imports `node-pty` only in `apps/daemon/src/pty/manager.ts`; the M4-001 feasibility spike also imports it as a scratch script.
17. Confirmed. Adapters are pure spawn factories and do not own PTY behavior.
18. Confirmed. `pnpm -r typecheck` and `pnpm -r test` exit 0 with M1/M2/M3 and M4 shell/restart tests passing.
19. Confirmed by M4-015: sidecar build includes `node-pty` for linux/x64 and the bundled smoke exits 0.
20. Confirmed. No memory extraction, summary extraction, context assembly, task graph, recommendation engine, workflow engine, file watcher/indexer, global sessions dashboard, adapter config UI, terminal multiplexer, process re-parenting, cloud/distributed runtime, or Level 4/5 automation was added.

## Scope-Guard Check

Code search confirmed no M4-excluded session HTTP surface was added:

- No `GET /v1/sessions` collection route.
- No `POST /v1/sessions/:id/input`.
- No `POST /v1/sessions/:id/resize`.
- No `GET /v1/sessions/:id/output`.
- No `POST /v1/adapters/:id/invoke`.
- No `PATCH /v1/adapters/:id/config`.
- No `session.output.received`, `session.input.sent`, or `session.resized` domain event.

## Documentation Updates

- `README.md` now documents the M4 Sessions loop, endpoints, WebSocket frames,
  environment variables, output retention cap, restart policy, and sidecar
  native binding caveat for `node-pty`.
- `docs/operation-flow/4-do-implementation-plan.md` identifies the current
  bounded task as M4-016.
