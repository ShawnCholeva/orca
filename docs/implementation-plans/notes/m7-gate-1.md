# M7 Gate 1 - After M7-002

Date: 2026-05-21
Reviewer: Codex
Baseline note: `docs/implementation-plans/notes/m7-000-baseline.md`
Baseline SHA: `bb011706b4c62a62b9f0acb4b49ca84870d484df`
M7-001 SHA: `83ce27d`
M7-002 SHA: `87df9d0`

## Scope

Gate 1 verifies the M7 contract surface and SQLite migration surface before daemon
orchestration projection, use-case, provider, route, or desktop work begins.

## Validation Runs

- `pnpm --filter @orca/contracts test` -> exit 0
  - 2 files passed, 46 tests passed
- `pnpm --filter @orca/daemon test -- src/migrations` -> exit 0
  - 2 files passed, 20 tests passed
- `pnpm -r typecheck` -> exit 0
  - `packages/contracts`, `apps/daemon`, and `apps/desktop` passed
- `pnpm --filter @orca/daemon test -- m1-017 m2-loop m3-create-goal-with-workspaces m4-011-shell-vertical-slice m5-shared-memory context-proof-loop` -> exit 0
  - 6 files passed, 20 tests passed
- Manual SQLite fixture inspection:
  - copied `apps/daemon/test-fixtures/m6-baseline.sqlite` to `/tmp/orca-m7-gate1.sqlite`
  - applied `apps/daemon/migrations/m7-001-suggested-orchestration.sql`
  - inspected schema with `sqlite3`

## Gate Checks

### Contracts

- M7 schemas cover tasks, task generations, recommendations, recommendation
  generations, recommendation feedback, conflicts, source refs, proposed actions,
  roles, statuses, trigger kinds, failure codes, M7 event literals, and HTTP
  request/response payloads.
- `CreateSessionRequest`, session read shapes, `session.created`,
  `CreateContextPackageRequest`, context package read shapes, and
  `context.package.created` accept optional `taskId` and `fromRecommendationId`.
- M6-shaped session and context package create requests still parse without M7
  fields.
- `ProposedAction` is a strict discriminated union over the planned M7 kinds.
- M7 event payload schemas are strict and content-free; tests reject an added
  `body` field for every M7 event literal.
- Caps are represented in schemas and tests reject oversized task,
  recommendation, conflict, feedback, and proposed-action payloads.

### SQLite Migration

- `m7-001-suggested-orchestration.sql` creates only the allowed M7 tables:
  `tasks`, `task_generations`, `recommendations`,
  `recommendation_generations`, `recommendation_feedback`, and `conflicts`.
- Migration registration applies `m7-001-suggested-orchestration.sql` after
  `0006_context.sql`.
- `sessions` gains nullable `task_id` and `from_recommendation_id` columns.
- `context_packages` gains nullable `task_id` and `from_recommendation_id`
  columns.
- Manual fixture inspection found the expected M7 partial unique indexes:
  `idx_task_generations_active_fp`, `idx_rec_generations_active_fp`,
  `idx_tasks_goal_fingerprint_active`, `idx_recs_goal_fingerprint_active`,
  `idx_conflicts_goal_fp_open`, and `idx_feedback_terminal_action`.
- Manual fixture inspection found the expected task lookup indexes:
  `idx_sessions_task` and `idx_context_packages_task`.
- The upgraded M6 fixture retained one pre-existing `sessions` row and one
  pre-existing `context_packages` row, with both new association columns still
  `NULL`.
- Existing migrator idempotency coverage confirms rerunning the migrator on an
  already migrated DB applies no migrations.

## Scope/Privacy Checks

- No daemon orchestration projections, providers, generators, conflict detectors,
  routes, desktop UI, queues, workers, schedulers, file watchers, git libraries,
  provider SDKs, or model calls were introduced by M7-001/M7-002.
- No WebSocket commands or recommendation execution endpoints were introduced.
- M7 event contracts contain ids, counts, statuses, changed-field keys, trigger
  ids, and failure codes only; detailed text remains available through future
  REST projection reads, not event payloads.

## Outcome

Gate 1 is green. M7-003 projection and CRUD work may begin.

## Notes

- Pre-existing dirty paths observed and left untouched:
  - `docs/operation-flow/4-do-implementation-plan.md`
  - `packages/contracts/tsconfig.tsbuildinfo`
