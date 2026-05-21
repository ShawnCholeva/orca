# Orca — Milestone 7 Implementation Plan

**Source milestone:** `docs/milestones/7.md`
**Builds on:** `docs/implementation-plans/milestone-6.md` (M6 must be complete and green).
**Status:** Ready for AI-assisted execution.
**Scope guard:** Tasks below MUST NOT introduce Level 4 supervised execution, Level 5 autonomy, approval gates, automatic session launch, automatic context preparation, automatic validation command execution, automatic task status transitions from session activity without user action, automatic retry/backoff, AI-backed recommendation provider implementations, model provider/SDK integration, provider/model configuration UI, prompt template libraries, prompt experiments, token-accurate accounting, provider cost tracking, generic skill invocation endpoints, generic reasoning-job endpoints, generic action execution endpoints, generic workflow endpoints, public `POST /v1/recommendations/:id/execute`, `POST /v1/recommendations/:id/regenerate`, cross-Goal recommendation/task list endpoints, `POST /v1/skills/:id/invoke`, `POST /v1/tasks/:id/archive` as a separate endpoint, recommendation history/diff/editor pages, task board/Gantt/dependency graph UI, global task or recommendation dashboards, command-center panels, recommendation analytics, multi-step workflow planning, workflow engines, distributed queues, background workers, schedulers, continuous reasoning loops, cloud infrastructure, multi-agent scheduling, agent task assignment endpoints, cross-Goal memory, workspace indexing/scanning, file watching, knowledge graphs, embeddings, vector search, semantic search, global search, memory consolidation, semantic ranking, relevance engines, aging/decay systems, analytics dashboards, policy/governance, audit engines, full transcript capture/replay/export/analytics, raw M4 output-tail reads during M7 orchestration, persistence of raw terminal output / raw provider input/output / prompts / raw model responses / model reasoning / recommendation bodies / conflict bodies / feedback comments / task descriptions / acceptance criteria / validation steps / proposedAction bodies / source memory/decision/summary text in domain event payloads, source reverse-index join tables (sources are stored as compact JSON on the respective rows), WebSocket commands for task/recommendation/conflict mutation, rendered context payload events, raw provider prompt/template events, feedback comment events, continuous reasoning events, manual conflict creation endpoint, external PM integrations, or new top-level packages. Any task requiring such code is out of scope for M7.

### Inherited constraints from M1 / M2 / M3 / M4 / M5 / M6

**DaemonContext seam.** All new M7 use cases MUST be wired through the explicit `DaemonContext`. M7 adds: `recommendationProvider: RecommendationProvider` (deterministic default; fake-replaceable for tests), `taskGenerator: TaskGenerator` (deterministic), `conflictDetector: ConflictDetector` (deterministic), and reuses existing `now`, `idFactory`, SQLite handles, `contextAssembler`. No DI framework, no container, no decorators.

**Registry immutability (M2).** Adapter, skill, and provider registrations happen before the HTTP listener accepts connections. M7 must not add hot-registration paths. The three new internal skill descriptors (`orca/recommendation-generation`, `orca/task-generation`, `orca/conflict-detection`) are registered in the existing boot path with `invocation: 'daemon-internal'` and no public invocation route.

**Native-import isolation (M4).** Only `apps/daemon/src/pty/manager.ts` may `import` `node-pty`. M7 does not touch this.

**Output isolation rule (M4, carried forward).** Terminal output remains persisted only in M4's session output store. M7 MUST NOT read raw M4 output tails or transcripts during orchestration. The only acceptable signal sources are: M3 refinement, M3 workspace projection, M4 session row + lifecycle/status fields, M5 session_summaries, M5 memory items, M5 decisions, M6 context packages (id + small metadata), and M7's own tasks/recommendations/conflicts/feedback rows. A static check or unit test enforces that `apps/daemon/src/orchestrator`, `apps/daemon/src/recommendations`, `apps/daemon/src/tasks`, `apps/daemon/src/conflicts` do not import `apps/daemon/src/sessions/output-store.ts` (or whichever module owns M4 output tails) and do not import transcript modules.

**Content-free events rule (M5/M6, extended).** All M7 domain events carry ids, status, counts, byte sizes, changed-field keys, and failure codes. They MUST NOT carry recommendation rationale text, task title/description/acceptance-criteria/validation-step text, conflict description/resolution text, proposed-action body, feedback comments, raw provider input/output, prompts, raw model responses, raw memory/decision/summary text, rendered context bytes, or transcript content. 4 KiB per-event payload cap enforced in tests.

**Atomicity rule (carried forward).** Every M7 daemon write that emits domain events MUST insert events and projection rows inside the same SQLite transaction and broadcast on the event bus **only after** `COMMIT` returns. Cross-projection cascades (e.g. `conflict.detected` + the linked `resolve_conflict` recommendation; `conflict.resolved` + auto-dismiss of the linked recommendation) MUST commit in a single TX.

**Goal-scoped boundary (carried forward).** Every M7 row carries `goal_id`; every M7 list/read is Goal-scoped; no cross-Goal endpoint or selection exists. Source refs that point outside the Goal are rejected at the validation layer.

**Suggestion-only rule (new in M7).** No M7 endpoint, runner, or rule may auto-launch a session, auto-prepare a context package, auto-run a validation command, auto-modify a task, or auto-execute a `proposedAction`. The only allowed automatic cross-projection mutation is the conflict-resolution auto-dismiss of the linked `resolve_conflict` recommendation (Section 12 of the milestone plan), implemented as a single-purpose helper, not a generic framework.

**Existing wire shapes frozen.** All existing M1/M2/M3/M4/M5/M6 endpoint responses, event names, event payloads, and WebSocket frames remain byte-identical. M7 only adds: new endpoints (Section 9 of the milestone plan), new event types (Section 7), optional `taskId` and `fromRecommendationId` fields on `CreateSessionRequest`, session read responses, the `session.created` event, `CreateContextPackageRequest`, context package read responses, and the `context.package.created` event. Without those optional fields the M4/M6 flows are byte-identical.

This document decomposes Milestone 7 (Suggested Orchestration) into bounded executable tasks. Each task is sized for a single AI session, has explicit acceptance criteria, and is reviewable in isolation.

The single proof point for M7 is:

```text
Meaningful Goal activity occurs
  -> daemon evaluates deterministic orchestration triggers
  -> daemon gathers bounded Goal, task, workspace, session, memory, decision, summary, and context-package inputs
  -> daemon runs explicit internal task/recommendation/conflict jobs only when needed
  -> deterministic providers generate bounded tasks, recommendations, conflicts, and supervision records
  -> daemon validates, deduplicates, supersedes, caps, and persists orchestration state atomically
  -> daemon records content-free lifecycle events with ids, counts, statuses, and failure codes only
  -> desktop shows Goal-scoped tasks, recommendations, and conflicts
  -> user accepts, rejects, dismisses, modifies, or resolves suggestions
  -> accepted recommendations can prefill existing M3/M4/M5/M6/M7 flows but never auto-launch work
  -> validation recommendations appear after implementation-like activity
  -> conservative conflicts are surfaced for human resolution
  -> task, recommendation, conflict, and feedback state survives daemon restart
```

---

## Conventions

- **Task ID:** `M7-NNN` (zero-padded, sequenced for default execution order).
- **Affected Areas:** paths relative to repo root.
- **Validation Steps:** every task lists at least one deterministic command or scenario.
- **No task may exceed its declared scope** even if adjacent work seems easy — additive scope belongs in a follow-up task.
- **Full-suite gates:** `pnpm -r typecheck` and `pnpm -r test` run at **M7-010** (deterministic rules complete) and **M7-024** (final). Targeted tests run inside every other task.
- **Atomicity rule:** every generation completion (success or failure), every recommendation lifecycle action, every conflict mutation, every task mutation inserts the row(s) and all associated domain events in **one** SQLite transaction. Broadcast occurs **only after** `COMMIT`.
- **Generation idempotency rule:** `request_fingerprint = sha256(goalId + ':' + triggerKind + ':' + (triggerSourceId ?? '') + ':' + providerId + ':' + providerVersion + ':' + inputFingerprint)`. Partial unique index on `(goal_id, request_fingerprint) WHERE status IN ('pending','running','succeeded')` prevents duplicate active generations. Failed rows are terminal and excluded from active idempotency so retry creates a new row.
- **Input fingerprint rule:** deterministic over the bounded snapshot (Section 5 of the milestone plan): goal id + refinement id/version + sorted workspace ids/dirty flags + sorted task ids/statuses/updated_at + sorted memory item ids/updated_at + sorted decision ids/status/updated_at + sorted recent session summary ids/updated_at + latest context package id + sorted active recommendation ids/status + sorted active conflict ids/status + trigger discriminator. Same snapshot → same fingerprint.
- **Recommendation fingerprint rule:** `sha256(goalId + ':' + type + ':' + canonicalProposedActionJson)`; used for cross-generation dedup/supersede.
- **Task fingerprint rule:** `sha256(goalId + ':' + canonicalTitle + ':' + role)` for generator-origin tasks; manual tasks bypass the active-fingerprint unique index.
- **Conflict fingerprint rule:** `sha256(goalId + ':' + conflictType + ':' + sortedSourceIds)`.
- **Privacy rule:** never log recommendation rationale, task description, acceptance criteria, validation steps, proposed-action body, conflict description, feedback note, memory/decision/summary body, provider input/output, prompts, model responses, secrets, or workspace file paths. Apply M5's best-effort secret redaction helper (`password=`, `token=`, `api_key=`, `authorization: bearer`) to every persisted free-text field captured at API boundaries before writing. Failure messages cap 256 chars after redaction.
- **Tail isolation rule:** code under `apps/daemon/src/orchestrator/`, `apps/daemon/src/recommendations/`, `apps/daemon/src/tasks/`, `apps/daemon/src/conflicts/` MUST NOT import the M4 output-tail module nor any transcript module. A unit test enforces this.
- **Suggestion-only rule:** no M7 code path may automatically call `POST /v1/sessions`, `POST /v1/goals/:goalId/context-packages`, `POST /v1/goals/:goalId/refinements/*`, or any task-mutation endpoint as a downstream effect of accepting a recommendation. Acceptance returns the `proposedAction`; the user must initiate the existing flow.
- **Defaults (from the milestone plan):** recommendation title ≤ 256 chars; recommendation rationale ≤ 4 KiB; `proposedAction` JSON ≤ 4 KiB; sources ≤ 32 per recommendation; task title ≤ 256 chars; task description ≤ 8 KiB; acceptance criteria ≤ 20 items × 256 chars; validation steps ≤ 20 items × 256 chars; conflict description ≤ 1 KiB; conflict resolution note ≤ 4 KiB; feedback note ≤ 2 KiB; failure message ≤ 256 chars; per-event payload ≤ 4 KiB; recommendation input caps — 30 memory, 20 decisions, 5 summaries, 20 tasks, 10 active recommendations, 10 active conflicts, 10 recent feedback; generation output ≤ 10 candidates.

---

## Tasks

---

### M7-000 — Baseline Verification

**Purpose.** Lock in a known-good M1/M2/M3/M4/M5/M6 baseline before any M7 change lands. Establishes the regression anchor so every later M7 failure is unambiguously attributable to M7 work, and so the M7-010 and M7-024 gates can compare against a recorded green state.

**Scope.**
- IS: install, typecheck, run tests, record commit SHA and test summary, verify named M1–M6 regression anchors PASS, record pre-existing dirty paths.
- IS NOT: any code change, dependency upgrade, new test, doc edit, or migration.

**Requirements.**
- From a clean working tree, run:
  - `pnpm install --frozen-lockfile`
  - `pnpm -r typecheck`
  - `pnpm -r test`
- Confirm the following named tests appear in the test summary as PASS:
  - the M1 integration anchor (Goal CRUD + live events);
  - the M2 plugin/skill registry test;
  - the M3 Goal-with-workspaces integration test;
  - the M4 session lifecycle integration test (final M4 anchor);
  - the M5 daemon proof-loop integration test (final M5 anchor);
  - the M6 daemon proof-loop integration test (final M6 anchor).
- Record in `docs/implementation-plans/notes/m7-000-baseline.md`:
  - `git rev-parse HEAD`;
  - final test summary line counts (typecheck + test);
  - pre-existing dirty paths from `git status` (do not attribute them to M7).

**Affected Areas.** None — verification only. New file: `docs/implementation-plans/notes/m7-000-baseline.md`.

**Dependencies.** M6 complete and green.

**Acceptance Criteria.**
- All listed commands exit `0`.
- All named M1–M6 regression anchors PASS.
- Baseline SHA and summary recorded in the notes file.

**Validation Steps.**
- `pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm -r test`.
- Inspect summary for the named tests.
- `cat docs/implementation-plans/notes/m7-000-baseline.md`.

**Risks / Notes.**
- Do not "fix" pre-existing dirty files; record them.
- If baseline fails, stop and resolve before proceeding — M7 must not absorb pre-existing breakage.

**Suggested model:** Human + Sonnet 4.6 (run + record).

---

### M7-001 — Contracts (Tasks, Recommendations, Conflicts, Feedback, Generations, Events, Session/Context Extensions)

**Purpose.** Establish the wire and runtime contract surface for M7 in `packages/contracts`. Contracts are the freeze-point that downstream daemon and desktop tasks build against, and the place where the prohibition on content-leaking event payloads is enforced.

**Scope.**
- IS: zod schemas + TypeScript types for `Task`, `TaskStatus`, `TaskRole`, `TaskAcceptanceCriterion`, `TaskValidationStep`, `TaskSourceRef`, `TaskGeneration`, `Recommendation`, `RecommendationType`, `RecommendationStatus`, `RecommendationSource`, `RecommendationSourceRef`, `RecommendationFeedback`, `RecommendationFeedbackAction`, `RecommendationGeneration`, `Conflict`, `ConflictType`, `ConflictSeverity`, `ConflictStatus`, `ConflictSourceRef`, `ProposedAction` (discriminated union on `kind`), generation lifecycle status enum (`pending|running|succeeded|failed`), failure code enum (`invalid_input|invalid_output|provider_error|daemon_restart|goal_archived|sparse_input|internal_error`), `TriggerKind`, M7 event literal union (see Section 7 of the milestone plan), HTTP request/response payload schemas for every new endpoint listed in Section 9, extension fields (`taskId?`, `fromRecommendationId?`) on `CreateSessionRequest`, `Session`, `CreateContextPackageRequest`, `ContextPackage`, `session.created` payload, `context.package.created` payload; contract unit tests covering parse + reject paths.
- IS NOT: daemon use cases, migrations, projection helpers, HTTP routes, provider implementation, generator implementation, conflict detectors, runner, desktop wrappers, UI.

**Requirements.**
- Each enum exposed as both a zod `z.enum([...])` and a TypeScript union for type narrowing.
- `ProposedAction` is a zod discriminated union on `kind` with one variant per kind listed in Section 5 of the milestone plan: `create_session`, `continue_session`, `review_output`, `refine_goal`, `split_task`, `run_validation`, `resolve_conflict`, `update_plan`, `ask_user`, `mark_complete`, `pause_work`.
- All recommendation candidates are validated through the `ProposedAction` union; unknown `kind` is rejected.
- All free-text fields carry max length validators matching the caps in Conventions.
- Event payload schemas explicitly reject any string field that is not listed in Section 7 (no rationale, no description, no body).
- `RecommendationGeneratedPayload` carries `recommendationIds: string[]`, `supersededIds: string[]`, `count: number`, `sparse: boolean`, `goalId`, `generationId`; no candidate bodies.
- `TaskGeneratedPayload` carries `taskIds: string[]`, `count`, `sparse`, `goalId`, `generationId`.
- Extension fields are **optional**; default omission keeps prior M4/M6 schemas backward-compatible. Add explicit parse tests proving an M6-shaped request (no new fields) still validates.
- HTTP request schemas for `/tasks/generate` and `/recommendations/generate` accept `{ trigger: 'manual' }` only at the API boundary.
- `RecommendationSourceRef.type` enum: `goal | refinement | workspace | task | memory_item | decision | session_summary | session | context_package | conflict`.
- `TaskSourceRef.type` enum: `refinement | memory_item | decision | session_summary | context_package | recommendation`.
- `ConflictSourceRef.type` enum: `session | workspace | task | decision | memory_item | session_summary`.
- All event-literal strings exported as `M7EventType` union.

**Affected Areas.**
- `packages/contracts/src/` (extend `index.ts`; if diff too large, split into `tasks.ts`, `recommendations.ts`, `conflicts.ts`, `events-m7.ts`, `proposed-action.ts` and re-export from `index.ts`).
- `packages/contracts/src/__tests__/m7-*.test.ts` (new test files per domain).

**Dependencies.** M7-000.

**Acceptance Criteria.**
- `pnpm --filter @orca/contracts typecheck` passes.
- `pnpm --filter @orca/contracts test` passes.
- Every `ProposedAction.kind` has at least one parse-pass test and one reject test (missing/extra field, wrong discriminator).
- Every event literal has a payload-parse test and a reject test (payload with body field rejected).
- Every status/failure-code enum has at least one rejection test for an unknown value.
- An M6-shaped `CreateSessionRequest` payload (no `taskId`/`fromRecommendationId`) parses unchanged; adding both fields parses; adding a foreign-Goal id is structurally accepted (foreign-Goal rejection lives at the use-case layer, not the schema).
- Schema rejects oversized title/rationale/description/proposed-action JSON/conflict description/feedback note.

**Validation Steps.**
- `pnpm --filter @orca/contracts test`.
- Visual inspection: every exported schema referenced in at least one test.

**Risks / Notes.**
- Schema drift across endpoints: reference the **same** zod schema from request, persistence, and response paths; do not redeclare.
- `ProposedAction` is the contract Level 4 will gate over later — keep field names stable.
- Do not introduce `RecommendationCandidate` as a public contract type; it is provider-output-only and lives in the daemon.
- Optional fields must use `.optional()` not `.nullable()` to keep M4/M6 wire shapes byte-identical when omitted.

**Suggested model:** GPT 5.4 / Codex.

---

### M7-002 — SQLite Migration (Tables, Indexes, Column Adds)

**Purpose.** Land every M7 table, index, and column add in one forward migration. This is the persistence floor every later task builds on. Establishes idempotency and supersede behavior at the DB layer.

**Scope.**
- IS: single forward migration creating `tasks`, `task_generations`, `recommendations`, `recommendation_generations`, `recommendation_feedback`, `conflicts`; `ALTER TABLE sessions ADD COLUMN task_id`, `ALTER TABLE sessions ADD COLUMN from_recommendation_id`, `ALTER TABLE context_packages ADD COLUMN task_id`, `ALTER TABLE context_packages ADD COLUMN from_recommendation_id`; all indexes listed in Section 8 of the milestone plan; migration registration in the existing migrator; migration tests for fresh DB and recorded M6 fixture DB; no projection/usecase wiring.
- IS NOT: projection helpers, use cases, routes, runner, UI, contract edits.

**Requirements.**
- Single migration file: `apps/daemon/src/migrations/m7-001-suggested-orchestration.sql` containing every DDL statement in Section 8 of the milestone plan, in execution-safe order (parents before children).
- Registered in `apps/daemon/src/migrations.ts` after the latest M6 migration.
- All foreign keys point at existing/new tables; cascade behavior left default (no `ON DELETE CASCADE`).
- All listed `CREATE INDEX` and `CREATE UNIQUE INDEX` statements present with matching `WHERE` clauses.
- `tasks` includes `parent_task_id` self-FK, `workspace_id` nullable FK, `generation_id` nullable FK to `task_generations`.
- `recommendations` includes `generation_id`, `related_task_id`, `related_session_id`, `related_context_pkg_id`, `related_conflict_id`, `superseded_by_id` (self-FK).
- `recommendation_feedback` enforces unique terminal action via `idx_feedback_terminal_action` (partial unique on `(recommendation_id, action) WHERE action IN ('accept','reject','dismiss')`).
- New columns on `sessions` / `context_packages` default `NULL`; existing rows unaffected.
- Migration test 1 — fresh DB: apply all migrations, assert every M7 table and index exists via `PRAGMA index_list` / `sqlite_master` queries.
- Migration test 2 — M6 fixture DB: copy a recorded M6-baseline DB file into a temp dir, apply M7 migration, assert tables/indexes appear, assert pre-existing row counts unchanged, assert `sessions.task_id IS NULL` for every pre-existing row.
- Boot path runs the migration before HTTP listen (existing migrator behavior preserved).
- No data backfill.

**Affected Areas.**
- `apps/daemon/src/migrations/m7-001-suggested-orchestration.sql` (new).
- `apps/daemon/src/migrations.ts` (register).
- `apps/daemon/src/migrations/__tests__/m7-001.test.ts` (new).
- `apps/daemon/test-fixtures/m6-baseline.sqlite` (record one fixture if none exists; otherwise reuse).

**Dependencies.** M7-001.

**Acceptance Criteria.**
- `pnpm --filter @orca/daemon test apps/daemon/src/migrations` passes on fresh DB and on the recorded M6 fixture DB.
- All indexes listed in Section 8 of the milestone plan exist, including partial unique indexes for active generation fingerprints, active recommendation fingerprints, active task fingerprints (generator-origin only), open conflict fingerprints, and terminal feedback actions.
- After migration the M1–M6 regression anchors still PASS.
- Migration is idempotent against an already-migrated DB (running the migrator twice does not error).
- `ALTER TABLE` adds preserve existing row counts and existing column values.

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/migrations`.
- `pnpm -r typecheck` (no signature drift).
- Manual: open the M6 fixture DB after migration and inspect schema via `sqlite3 .schema`.

**Risks / Notes.**
- `CREATE TABLE` ordering: `tasks` references `task_generations`; create the generations table first or use a deferred FK declaration acceptable to the SQLite version in use. Recommend ordering: `task_generations` → `tasks` → `recommendation_generations` → `recommendations` → `conflicts` → `recommendation_feedback` → `ALTER TABLE sessions` → `ALTER TABLE context_packages`.
- Self-FK on `tasks.parent_task_id` and `recommendations.superseded_by_id`: SQLite accepts within `CREATE TABLE`.
- Partial unique indexes are SQLite-specific syntax; the project already uses them (M6); follow that pattern.
- Do not add `ON DELETE` cascades; archived behavior is read-layer only.

**Suggested model:** GPT 5.4 / Codex.

**Review Gate 1:** After M7-002, verify contracts, SQLite migration surface, session/context package columns, indexes, and upgrade path from an M6 database before daemon orchestration implementation. Human + GPT 5.5.

---

### M7-003 — Tasks Projection And CRUD Use Cases (No Generation Yet)

**Purpose.** Implement read/write helpers for `tasks` and `task_generations` rows. No generation logic; no HTTP routes. Establishes the persistence seam every later task feature uses.

**Scope.**
- IS: projection helpers (by goal, by id, by session, by workspace, with status/role/parent filters, with archived filter, pagination by `created_at DESC`), `tasks` CRUD use cases (create, get, list, patch, split, associate-session, associate-context-package, status transitions), `task_generations` lifecycle helpers (insert pending, mark running, succeeded, failed), fingerprint computation helpers, atomic write helpers, status transition guard table.
- IS NOT: HTTP routes, deterministic generator, recommendation provider, conflict detectors, orchestrator triggers, runner, UI.

**Requirements.**
- `projection.ts`: read functions return typed `Task` rows; lists are Goal-scoped; `includeArchived: boolean` defaults `false`; `cursor` supports pagination on `created_at DESC` tiebroken by id.
- `usecases.ts`:
  - `createTask({ goalId, origin, ... })` validates field caps, computes `fingerprint`, enforces generator-origin active-fingerprint uniqueness, inserts row, emits `task.created` in same TX, broadcasts after commit.
  - `updateTask(id, patch)` validates transitions, emits `task.updated` (with `changedFields` enum array) and `task.status_changed` (when status changed) in same TX.
  - `splitTask(parentId, children, setParentStatus?)` inserts N child rows with `parent_task_id` set, optionally moves parent to `blocked`, emits `task.split` + N `task.created` (+ optional `task.status_changed`) in same TX.
  - `associateTaskWithSession(taskId, sessionId)` updates `tasks` reference (if M7's model stores the reverse) — note: the canonical reverse pointer is `sessions.task_id`. This use case only emits `task.associated_with_session`; it does not duplicate state. (Validation: same Goal.)
  - `associateTaskWithContextPackage(taskId, contextPackageId)` likewise emits `task.associated_with_context_package`.
- Status guard table (deterministic):
  - `proposed → open` allowed.
  - `open ↔ in_progress`, `in_progress ↔ blocked` allowed.
  - `→ done` allowed from `open|in_progress|blocked`; warning surfaced if acceptance criteria present but no satisfied validation step (warning, not block).
  - `→ cancelled` from any non-terminal.
  - `→ archived` from terminal only (`done|cancelled`).
- `task_generations` lifecycle helpers: `insertPendingGeneration`, `markRunning`, `markSucceeded(taskIds, sparse)`, `markFailed(failureCode, message)`; all emit the matching `task.generation.*` event in the same TX as the row update.
- Fingerprint helper: `taskFingerprint(goalId, title, role)` with canonical lowercase + whitespace-trim of title.
- Request fingerprint helper: `taskGenerationRequestFingerprint(goalId, triggerKind, triggerSourceId, generatorId, generatorVersion, inputFingerprint)`.
- Single-flight enforcement uses `BEGIN IMMEDIATE` + the partial unique index `idx_task_generations_active_fp` to return the existing pending/running/succeeded row on duplicate submit.
- All writes commit projection + event(s) in one TX, broadcast after commit.

**Affected Areas.**
- `apps/daemon/src/tasks/projection.ts` (new).
- `apps/daemon/src/tasks/usecases.ts` (new).
- `apps/daemon/src/tasks/fingerprint.ts` (new).
- `apps/daemon/src/tasks/projection.test.ts`, `usecases.test.ts`, `fingerprint.test.ts` (new).
- `apps/daemon/src/daemon-context.ts` (no new fields yet for orchestration; reuse existing handles).

**Dependencies.** M7-001, M7-002.

**Acceptance Criteria.**
- Unit tests cover: create → get → list; archived filter excludes archived; pagination cursor stable; status guard rejects illegal transitions; split creates children with parent linkage; associate-session emits the right event and rejects cross-Goal session; task.created/task.updated payloads include `changedFields` enum only (no text fields); double create with same generator-fingerprint rejected; manual create with same fingerprint allowed.
- Atomicity test: simulate event-store insert failure, assert task row not committed.
- Broadcast test: assert event bus receives event **after** COMMIT (counter increments after `db.transaction(...)` returns).

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/tasks`.

**Risks / Notes.**
- Race on `idx_tasks_goal_fingerprint_active` during split: tests cover by running two concurrent splits in a Promise.all and asserting one wins.
- `task.updated`'s `changedFields` must be a closed enum; do not pass dynamic strings.
- `dependencies` array stored as JSON; validate each id belongs to the same Goal.
- Do not auto-transition status from session activity here; only manual or recommendation-accepted paths.

**Suggested model:** Sonnet 4.6.

---

### M7-004 — Recommendations Projection, Feedback Projection, Lifecycle Use Cases (No Provider Yet)

**Purpose.** Implement read/write helpers for `recommendations`, `recommendation_generations`, `recommendation_feedback` rows and the accept/reject/dismiss/modify/supersede lifecycle. No provider logic; no HTTP routes.

**Scope.**
- IS: projection helpers, generation lifecycle helpers, feedback insert helpers, lifecycle use cases (`acceptRecommendation`, `rejectRecommendation`, `dismissRecommendation`, `modifyRecommendation`, `supersedeRecommendation`), supersede-on-fingerprint behavior, terminal feedback idempotency, fingerprint helper.
- IS NOT: provider implementation, input builder, rules, HTTP routes, conflict integration, orchestrator triggers.

**Requirements.**
- `projection.ts`: list by goal+status+type+relatedTaskId, get by id (returns `sources_json` parsed), paginated by `created_at DESC`. `GET` response shape includes feedback rows joined by id (separate query, capped at most-recent N).
- Feedback projection: append-only insert; the partial unique `idx_feedback_terminal_action` enforces one-shot for accept/reject/dismiss.
- Lifecycle use cases:
  - `acceptRecommendation(id, note?)`:
    - validation: status is `proposed` or `modified`;
    - inserts feedback row `(action='accept', note)`;
    - updates recommendation `status='accepted'`, `resolved_at=now`;
    - emits `recommendation.accepted` + `user.feedback.recorded` in same TX;
    - idempotent: repeated accept on already-accepted recommendation returns the existing rows and emits **no** new events (caught by the partial unique constraint + a status guard).
  - `rejectRecommendation`, `dismissRecommendation`: same shape; terminal status; one-shot.
  - `modifyRecommendation(id, patch)`:
    - validation: status not terminal;
    - captures pre-modify payload snapshot in feedback `(action='modify', modified_payload_json=<snapshot>, note)`;
    - updates row fields, sets `source='user_modified'`, `status='modified'`;
    - emits `recommendation.modified` + `user.feedback.recorded`.
    - Multiple modifies allowed (each creates a new feedback row, but `idx_feedback_terminal_action`'s partial filter excludes `modify`).
  - `supersedeRecommendation(id, bySupersedingId|null, reason)`:
    - validation: row is `proposed`;
    - updates `status='superseded'`, `superseded_by_id`, `superseded_reason`, `resolved_at=now`;
    - emits `recommendation.superseded` in same TX.
- Recommendation fingerprint helper: canonicalize `proposedAction` JSON (sorted keys, normalized whitespace) before hashing.
- Generation lifecycle helpers mirror M7-003: insert pending → running → succeeded/failed; failure events carry only `failureCode`.

**Affected Areas.**
- `apps/daemon/src/recommendations/projection.ts`, `feedback.ts`, `usecases.ts`, `fingerprint.ts` (new).
- Test files: `projection.test.ts`, `feedback.test.ts`, `usecases.test.ts`, `fingerprint.test.ts` (new).

**Dependencies.** M7-001, M7-002.

**Acceptance Criteria.**
- Unit tests cover: active fingerprint uniqueness; supersede preserves accept/reject/dismiss audit history; terminal-action one-shot enforced via DB constraint (assert that a second insert with same `(recommendation_id, action='accept')` raises a constraint error and the use case returns the existing row); modify allows subsequent accept; modify captures pre-modify snapshot in `modified_payload_json`.
- Event payload tests: `recommendation.accepted/rejected/dismissed/modified/superseded` payloads contain only ids, type, changedFields (for modified), `bySupersedingId`/`reason` (for superseded), and `goalId` — no rationale/proposed-action body.
- Atomicity test: simulate failure mid-TX, assert row unchanged.
- Idempotency: repeated accept on accepted recommendation returns the existing recommendation row, returns the existing feedback row, emits no new events, returns HTTP-200-equivalent semantics (use case returns `{ alreadyAccepted: true }` flag — route layer maps to 200).

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/recommendations`.

**Risks / Notes.**
- Off-by-one in the partial unique condition: cover the `proposed`-only active-fingerprint case explicitly (a `modified` row with the same fingerprint must not block a new `proposed` insert).
- Modify must not increment the active-fingerprint conflict (the modified row is no longer `status='proposed'`, so the partial unique releases the slot).
- `proposed_action_json` is stored verbatim per the canonicalization rule; canonicalize before hashing but persist the user-visible JSON.
- Do not write feedback `note` text to events.

**Suggested model:** Sonnet 4.6.

---

### M7-005 — Conflicts Projection And Resolve/Dismiss Use Cases (No Detectors Yet)

**Purpose.** Implement read/write helpers for `conflicts` rows and the resolve/dismiss lifecycle. No detector logic; no HTTP routes.

**Scope.**
- IS: projection helpers, lifecycle use cases (`resolveConflict`, `dismissConflict`, `insertOpenConflict`), fingerprint helper, single-purpose helper `autoDismissResolveConflictRecommendation(conflictId, txn)` invoked inside the resolve/dismiss TX.
- IS NOT: detector rules, orchestrator hookup, HTTP routes, UI.

**Requirements.**
- `projection.ts`: list by goal+status+severity, get by id, paginated `detected_at DESC`.
- `insertOpenConflict({ goalId, conflictType, severity, title, description, sources, fingerprint })`:
  - validation: title/description capped; sources non-empty; same-Goal source refs;
  - inserts row with `status='open'`;
  - the partial unique `idx_conflicts_goal_fp_open` prevents duplicate open rows for the same fingerprint — duplicate insert returns the existing row;
  - emits `conflict.detected` in same TX (caller composes the TX with whatever else is happening; this helper accepts an optional `txn` handle).
- `resolveConflict(id, note?)`:
  - validation: status is `open`;
  - updates row `status='resolved'`, `resolution_note`, `resolved_at`;
  - calls the auto-dismiss helper for the linked `resolve_conflict` recommendation in the same TX (no-op if none exists, no-op if it is already terminal);
  - emits `conflict.resolved` + (if applicable) `recommendation.dismissed` + `user.feedback.recorded` (with `action='dismiss'`, `note='conflict_resolved'` — content-free deterministic string) in same TX.
- `dismissConflict(id, note?)`: same shape; status `dismissed`; same auto-dismiss linkage; emits `conflict.dismissed` instead.
- `autoDismissResolveConflictRecommendation` is a single-purpose helper exported only to the resolve/dismiss path; comment explicitly notes it is the only "automatic" lifecycle transition in M7 and why (Section 12 of the milestone plan).

**Affected Areas.**
- `apps/daemon/src/conflicts/projection.ts`, `usecases.ts`, `fingerprint.ts` (new).
- Test files: `projection.test.ts`, `usecases.test.ts`, `fingerprint.test.ts` (new).

**Dependencies.** M7-001, M7-002, M7-004 (auto-dismiss helper uses recommendation use case).

**Acceptance Criteria.**
- Unit tests cover: open → resolved; open → dismissed; duplicate insert with same `(goalId, fingerprint)` while open returns existing row; second insert allowed after resolution (status no longer `open`).
- Auto-dismiss test: insert an open conflict + a linked `resolve_conflict` recommendation in `proposed` status; resolve the conflict; assert the recommendation row becomes `dismissed`, feedback row inserted with `action='dismiss'`, `recommendation.dismissed` and `user.feedback.recorded` events emitted in same TX as `conflict.resolved`.
- Auto-dismiss test 2: linked recommendation already in `accepted` status → no change to recommendation; only `conflict.resolved` emitted.
- Event payloads carry only ids/type/severity/resolution discriminator — no description text.

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/conflicts`.

**Risks / Notes.**
- Auto-dismiss is the single deliberate exception to the suggestion-only rule; keep it scoped to the resolve/dismiss path and call it out in code comments.
- Conflict `description` cap is 1 KiB on the row; never embed it in events.
- Severity enum: `info | warning | blocker`.

**Suggested model:** Sonnet 4.6.

---

### M7-006 — Generation Lifecycle Model And Single-Flight Helpers

**Purpose.** Extract the common shape used by task generation and recommendation generation into a small lifecycle/single-flight module. Ensures consistent fingerprint computation, transactional row-state transitions, and matching event emission across generators.

**Scope.**
- IS: shared lifecycle helpers (`insertOrGetPendingGeneration`, `markGenerationRunning`, `markGenerationSucceeded`, `markGenerationFailed`), shared request fingerprint helper, single-flight enforcement via `BEGIN IMMEDIATE` + partial unique index, failure message capping + redaction, `runner.ts` skeleton scaffolding only (no rules wired), per-Goal pending-dirty-flag map (in-memory).
- IS NOT: rules, detectors, provider implementation, trigger subscription, HTTP routes.

**Requirements.**
- `apps/daemon/src/orchestrator/runner.ts` exports a typed `runGeneration({ kind: 'task'|'recommendation', goalId, trigger, triggerSourceId, providerId, providerVersion, inputFingerprint, execute })` where `execute` is the caller-provided async function that produces candidates. The runner:
  - computes `request_fingerprint`;
  - in a TX with `BEGIN IMMEDIATE`, attempts to insert a pending row; if the partial unique index blocks, returns the existing row;
  - if newly inserted, returns `{ generationId, status: 'pending', new: true }` and asynchronously transitions to `running` then invokes `execute`, then `succeeded` or `failed` (each transition is its own TX with matching event emission);
  - failures: catch thrown errors, redact (M5 helper) and cap to 256 chars, classify (`provider_error` for caught throws, `invalid_output` for schema rejections, `internal_error` fallback);
  - enforces single-flight per goal via an in-process `Map<goalId, Promise>`; while a generation is running, a new trigger for the same Goal sets a pending dirty flag instead of starting a new generation; on completion, if the dirty flag is set, re-evaluate (re-runs the trigger map for that Goal once).
- `request_fingerprint` helper centralized here; used by both task and recommendation generation.
- Failure message goes through M5 redaction helper before being stored.
- All transitions and emits go through the existing event store + broadcast-after-commit machinery.
- Boot reconciliation function signature stubbed (`reconcileInFlightGenerations(db)`); implementation lives in M7-012.
- Unit tests cover: double submit returns existing row; failed row terminal and excluded from idempotency (retry creates new row); single-flight per Goal (concurrent runs queue behind the first); dirty flag triggers re-evaluation exactly once on completion.

**Affected Areas.**
- `apps/daemon/src/orchestrator/runner.ts`, `runner.test.ts` (new).
- `apps/daemon/src/orchestrator/fingerprint.ts`, `fingerprint.test.ts` (new).
- `apps/daemon/src/orchestrator/reconcile.ts` (stub only).
- `apps/daemon/src/tasks/usecases.ts`, `apps/daemon/src/recommendations/usecases.ts` (use the new lifecycle helpers in place of any inline lifecycle code from M7-003/M7-004).

**Dependencies.** M7-003, M7-004.

**Acceptance Criteria.**
- Targeted tests pass.
- Concurrent double-submit test (Promise.all) asserts exactly one new generation row inserted; the other call returns the existing row without inserting.
- Failure path test: provider throws → row marked failed with `provider_error` failure code, redacted message ≤ 256 chars, matching `*.generation.failed` event emitted.
- Retry test after failure: a fresh call with same input fingerprint creates a **new** generation row (failed rows excluded from active idempotency by index condition).
- Dirty-flag test: emit two triggers in rapid succession during a slow `execute`; assert exactly two generations total (initial + one re-evaluation), not three.

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/orchestrator`.

**Risks / Notes.**
- Deadlock between fingerprint check and insert: `BEGIN IMMEDIATE` plus the partial unique index avoids it; tests cover.
- Dirty flag is in-memory; daemon restart loses the flag — acceptable, because the next event will re-trigger.
- Single-flight key is `goalId` only; cross-Goal generations run in parallel.
- Do **not** add backoff, retry queues, or schedulers.
- `redact` helper must handle thrown error stacks without leaking secret values.

**Suggested model:** Sonnet 4.6.

**Review Gate 2:** After M7-006, verify projection helpers, generation lifecycle, request fingerprinting, active idempotency, transaction boundaries, and content-free events. Human + GPT 5.5.

---

### M7-007 — Deterministic Task Generator And Input Builder

**Purpose.** Implement the production task generator: bounded input from M3 refinement + workspaces, deterministic rules producing task candidates from success criteria, fingerprint dedup, schema validation. Plugs into the lifecycle helpers from M7-006.

**Scope.**
- IS: `TaskGenerator` interface, `DeterministicTaskGenerator` implementation, fake generator for tests, bounded input builder (refinement, workspaces, existing tasks for dedup), keyword classifier table, snapshot tests on ≥ 8 fixture refinements.
- IS NOT: recommendation provider, conflict detectors, orchestrator triggers, HTTP routes, UI.

**Requirements.**
- `input.ts` exports `buildTaskGenerationInput({ goalId, db })`:
  - reads latest refinement row, attached workspace rows, existing non-terminal tasks (capped 20);
  - returns a typed `TaskGenerationInput` snapshot with ids and small fields only;
  - computes `inputFingerprint` deterministically;
  - never reads M4 output tails or transcripts.
- `rules.ts` exports `generateTasks(input: TaskGenerationInput): TaskCandidate[]`:
  - parses refinement success criteria as discrete items: split on newline, semicolon, "and then"; max 20 candidates;
  - for each item: `title` = first 80 chars (whitespace-collapsed); `description` = full item (capped 8 KiB); `role` from keyword classifier (`implement|build|add|create|fix|refactor` → `engineer`; `review|audit|verify diff` → `reviewer`; `design|plan|architect|spec` → `architect`; `verify|test|validate|qa` → `qa`; else `generalist`); `workspaceId` = single attached workspace id if exactly one attached, else `null`;
  - computes per-candidate fingerprint; drops candidates whose fingerprint matches an existing non-terminal generator-origin task;
  - assembles `sources: TaskSourceRef[]` listing the refinement id (`type: 'refinement'`, `reason: 'driver'`);
  - returns at most 20 candidates;
  - on empty success criteria but non-empty objective, returns one task scoped to "fulfill objective" with `role='generalist'` and `sources: [{ type: 'refinement', id, reason: 'objective_only' }]`;
  - on entirely empty refinement, returns empty list with `sparse=true` (the runner persists `sparse` on the generation row; no `refine_goal` recommendation is emitted from here — that lives in the recommendation provider).
- `TaskGenerator` interface:
  ```ts
  interface TaskGenerator {
    readonly id: string;          // 'orca/deterministic-task-generator'
    readonly version: string;     // '0.1.0'
    generate(input: TaskGenerationInput): Promise<{ candidates: TaskCandidate[]; sparse: boolean; warnings: string[] }>;
  }
  ```
- `DaemonContext` gains `taskGenerator: TaskGenerator`.
- `tasks/usecases.ts` gains `runTaskGeneration({ goalId, trigger, triggerSourceId })` which uses `runGeneration` from M7-006 + the generator + persists candidate tasks (origin `generator`, with `generation_id` set) and emits `task.generation.requested` (on enqueue), `task.created` per task, `task.generated` (on success) — all per the atomicity rule.
- Snapshot tests for ≥ 8 fixture refinements: empty refinement; single-objective; 3-criteria; multi-role mixed; ambiguous-role defaults; oversize input (truncation behavior); archived workspace (excluded from default workspace inference); no workspaces.
- Output schema validation rejects malformed candidates (caught by `runGeneration`'s `invalid_output` path).

**Affected Areas.**
- `apps/daemon/src/tasks/rules.ts`, `input.ts`, `rules.test.ts`, `input.test.ts` (new).
- `apps/daemon/src/tasks/usecases.ts` (add `runTaskGeneration`).
- `apps/daemon/src/daemon-context.ts` (add `taskGenerator`).
- `apps/daemon/src/tasks/fixtures/*.json` (snapshot fixtures).

**Dependencies.** M7-006.

**Acceptance Criteria.**
- Snapshot tests stable across runs (deterministic id factory in tests).
- Same input → same `inputFingerprint`.
- Fingerprint dedup prevents duplicate generated tasks across regeneration.
- Sparse path returns empty list with `sparse=true`.
- Schema validation rejects a candidate with oversize title/description (caught test).
- `task.generated.payload.taskIds` ordered by creation order.

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/tasks/rules src/tasks/input`.

**Risks / Notes.**
- Keyword classifier produces wrong role on edge cases; document defaults; conservative fallback to `generalist`.
- Bullet/list parsing is conservative — free prose with no delimiters yields one task.
- Do not invoke this generator from anywhere except the runner.
- The `sparse=true` empty result is **not** a failure; do not mark the generation `failed`.

**Suggested model:** GPT 5.4 / Codex (rules + fixtures); Sonnet 4.6 (input builder + runner glue).

---

### M7-008 — Deterministic Recommendation Provider And Input Builder

**Purpose.** Implement the production recommendation provider: bounded input from existing projections, per-type deterministic rules, fingerprint dedup + cross-generation supersede, schema validation. This is the largest single task in M7; keep it tight.

**Scope.**
- IS: `RecommendationProvider` interface, `DeterministicRecommendationProvider` implementation, fake provider for tests, bounded input builder, per-type rule functions for `refine_goal`, `create_session`, `continue_session`, `split_task`, `update_plan`, `ask_user`, `mark_complete`, `pause_work` and the `resolve_conflict` rule (the latter wired to `conflict.detected`), fingerprint helper, provider `generate(input)` returning validated candidates, persistence path (insert recommendations + emit events) wired through M7-006's runner.
- IS NOT: validation/review rules (M7-009), conflict detectors (M7-010), trigger subscription (M7-011), boot reconciliation (M7-012), HTTP routes (M7-014), UI.

**Requirements.**
- `RecommendationProvider` interface and `RecommendationProviderOutput` shape match Section 11 of the milestone plan exactly.
- `input.ts` exports `buildRecommendationInput({ goalId, db, trigger, triggerSourceId })`:
  - reads goal row, latest refinement, workspaces, tasks (capped 20, status filter excludes archived), recent session summaries (capped 5), recent decisions (capped 20), recent memory items (capped 30), latest context package id, active recommendations (capped 10), active conflicts (capped 10), recent feedback (capped 10);
  - includes typed-field bodies (memory text, decision text, summary text) **only** where the rules deterministically need them, length-capped; bodies do **not** leak into events or logs;
  - returns typed snapshot + `inputFingerprint`;
  - never reads M4 output tails / transcripts.
- `rules.ts` exports one pure function per recommendation type (subset for this task; remaining `run_validation` and `review_output` ship in M7-009):
  - `refine_goal`: fires when refinement missing required fields, or when memory has ≥ 1 open-question; confidence 0.9 / 0.6.
  - `create_session`: fires when ≥ 1 task in `open` has no associated session for its workspace; default adapter `shell/manual`; upgrade to `claude-code` if a previous session for the same workspace used it; emits `contextPackageId` if a fresh package matches `(adapter, workspace, role, objective)` fingerprint, else `contextRequest` block; confidence 0.7 / 0.85.
  - `continue_session`: fires when a `running`/`paused` session is associated with `in_progress` task and latest summary does not indicate completion; confidence 0.75.
  - `split_task`: fires when a task description > 4 KiB OR ≥ 4 success criteria and no children exist; confidence 0.55.
  - `resolve_conflict`: invoked by the conflict detector pipeline (M7-010 wires this); each new conflict yields one recommendation referencing the conflict; confidence 1.0.
  - `update_plan`: fires on confirmed decision linked to a task, or on memory blocker linked to a task; confidence 0.6.
  - `ask_user`: fires on `decision.confirmation_required`; confidence 0.95.
  - `mark_complete`: fires when all task acceptance criteria mentioned in a session summary AND a reviewer session completed without negative outcome; confidence 0.6.
  - `pause_work`: fires when ≥ 2 active conflicts target the same task; confidence 0.7.
- `provider.ts` `DeterministicRecommendationProvider`:
  - `id='orca/deterministic-recommendation-provider'`, `version='0.1.0'`;
  - calls each rule in order, concatenates, dedupes within generation by recommendation fingerprint, drops over-budget excess (>10 candidates) with a warning, validates output schema, returns.
- Persistence path (in `recommendations/usecases.ts`) `runRecommendationGeneration({ goalId, trigger, triggerSourceId })`:
  - uses `runGeneration` from M7-006;
  - inside `execute`: builds input, calls provider, computes per-candidate recommendation fingerprint, queries existing `proposed` rows for the Goal with matching fingerprints, marks each as `superseded` (via the use case from M7-004), inserts new rows with `source='deterministic_provider'`, status `proposed`, emits per-row `recommendation.superseded` and a single `recommendation.generated` payload listing `recommendationIds` + `supersededIds` + `sparse` — all in one TX with the generation status transition;
  - `sparse=true` when input is empty enough that the provider returns 0 candidates; in that case the provider still emits a single `refine_goal` recommendation when there is no refinement (per Section 11 spec) — handled by the `refine_goal` rule.
- Per-type rule snapshot tests + fire/no-fire condition tests for each type.

**Affected Areas.**
- `apps/daemon/src/recommendations/provider.ts`, `input.ts`, `rules.ts` (per-type), `fingerprint.ts` (extend), `usecases.ts` (extend with `runRecommendationGeneration`), corresponding test files (new).
- `apps/daemon/src/daemon-context.ts` (add `recommendationProvider`).
- `apps/daemon/src/recommendations/fixtures/*.json`.

**Dependencies.** M7-006.

**Acceptance Criteria.**
- Per-rule fire and no-fire tests pass.
- Snapshot tests on full-input fixtures produce deterministic candidate lists.
- Output schema validation rejects: discriminator mismatch (`type` vs `proposedAction.kind`), oversize title/rationale/proposed-action JSON, confidence outside [0,1], > 32 source refs, foreign-Goal source ref.
- Supersede behavior: regeneration with mutated input replaces prior `proposed` rows with same fingerprint, emits one `recommendation.superseded` per replaced row + one `recommendation.generated` per new row, all in same TX.
- Sparse path: empty input + no refinement returns single `refine_goal` recommendation with `sparse=false`; entirely empty Goal returns `sparse=true` empty list (provider output) — runner persists sparse on generation row.
- Logs from the provider contain only ids and counts; redaction test asserts secret-shaped strings in inputs do not appear in any log line.
- Recommendation row persists `sources_json` matching candidate sources.

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/recommendations`.

**Risks / Notes.**
- Rules drift from spec: cross-reference Section 11 of the milestone plan; keep table-driven where possible.
- Do not invoke the provider outside the runner.
- Memory/decision/summary bodies may appear in the input snapshot for rule consumption — they must not leak into events, logs, or persisted free-text fields beyond rule-constructed rationales (and rationales are built from typed fields with templated strings, not by inlining the body).
- Fingerprint canonicalization must sort `proposedAction` keys recursively.

**Suggested model:** Sonnet 4.6 (provider + input + persistence); GPT 5.4 / Codex (per-rule fixtures and snapshot tests).

---

### M7-009 — Validation And Review Recommendation Rules

**Purpose.** Lock in `run_validation` and `review_output` deterministic rules — broken out from M7-008 because the implementation-evidence and reviewer-rejection detectors are subtle and merit a focused task.

**Scope.**
- IS: `run_validation` rule, `review_output` rule, shared `detectImplementationEvidence(summary)` helper, shared `detectReviewerRejection(summary)` helper, double-review suppression logic, fixtures and snapshot tests.
- IS NOT: trigger subscription, conflict detectors, routes, UI.

**Requirements.**
- `detectImplementationEvidence(summary)`:
  - deterministic check on an M5 session summary;
  - returns true when `outcome='completed'` AND (summary text contains any of test/build/lint/diff/commit/pr/merge tokens, case-insensitive, on word boundaries) OR a `memory_items` row of type `validation_result` exists for the same session;
  - operates on M5's already-curated summary fields only — does not read raw transcripts or output tails.
- `detectReviewerRejection(summary)`:
  - returns true when the latest reviewer-role session summary has `outcome='rejected'` (M5 field).
- `run_validation` rule:
  - fires after engineer-role `session.completed` with implementation evidence, and no reviewer/qa session with positive outcome exists since;
  - `proposedAction.kind='run_validation'` with `taskId` (if associated), `sessionId`, `suggestedRole: 'reviewer'|'qa'`, `objective` constructed from typed task title/role (no transcript text);
  - confidence 0.85;
  - sources: session + summary refs with deterministic `reason` strings.
- `review_output` rule:
  - fires on `decision.confirmation_required`, OR ≥ N new memory items of type `architecture_note` since last review (deterministic cursor based on `created_at`), OR reviewer-role session with negative summary outcome;
  - `proposedAction.kind='review_output'` with `sessionId`, `reviewerRole?`;
  - confidence 0.8.
- Double-review suppression: if a `review_output` or `run_validation` recommendation with the same fingerprint exists in any non-terminal status (`proposed`/`modified`), do not emit a new one (the supersede path handles `proposed`; modified rows count as "addressed" per Section 11).
- Snapshot tests for: engineer-completed-with-evidence, engineer-completed-without-evidence, reviewer-rejected, double-review-suppressed (after first emission, second trigger emits no new candidate).

**Affected Areas.**
- `apps/daemon/src/recommendations/rules.ts` (extend), `apps/daemon/src/recommendations/evidence.ts` (helpers, new), test files.
- `apps/daemon/src/recommendations/fixtures/` (new fixtures).

**Dependencies.** M7-008.

**Acceptance Criteria.**
- All snapshot tests pass.
- Implementation-evidence helper rejects negative cases (completed without evidence; partial outcome).
- Reviewer-rejection helper rejects positive cases.
- Suppression test asserts no duplicate `run_validation` / `review_output` recommendation when a prior `modified` one exists for the same fingerprint.

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/recommendations`.

**Risks / Notes.**
- Implementation-evidence keyword set must be small and deterministic; document the token list inline.
- Rationale strings built from M5 summary fields (e.g., `outcome`, `last_role`) — not from raw summary body.
- Do not introduce embeddings or fuzzy matching.

**Suggested model:** Sonnet 4.6.

---

### M7-010 — Conflict Detectors

**Purpose.** Implement the five conservative deterministic detector rules and wire them to emit `conflict.detected` + a linked `resolve_conflict` recommendation in one TX. After this task, run the full-suite gate.

**Scope.**
- IS: pure functions per conflict type (`workspace_overlap`, `contradictory_decisions`, `reviewer_rejection`, `blocker_reported`, `unresolved_question`), `ConflictDetector` interface, `DeterministicConflictDetector` implementation, fingerprint helper, orchestrator-callable `detectAndPersist({ goalId, triggerEvent })` that inserts new conflict rows + a `resolve_conflict` recommendation per new conflict, all in one TX.
- IS NOT: orchestrator trigger subscription (M7-011), routes (M7-015), UI.

**Requirements.**
- Detectors:
  1. `workspace_overlap`: input — sessions with `status='running'`; predicate — two sessions share `workspace_id`; severity `warning` if distinct tasks, `blocker` if same task; sources — both sessions + workspace + task(s).
  2. `contradictory_decisions`: input — confirmed decisions; predicate — Jaccard token overlap > 0.5 on whitespace-tokenized titles (stopwords removed deterministically) AND body strings differ by at least one negation token (`not`, `no`, `never`, `should not`, `must not`) in canonical positions; severity `warning`; sources — both decisions; conservative (false positives accepted).
  3. `reviewer_rejection`: input — latest reviewer-role session summary; predicate — `outcome='rejected'`; severity `warning`; sources — session + summary + linked task.
  4. `blocker_reported`: input — memory items of type `blocker` not archived/resolved; predicate — presence; severity `warning` (`blocker` if linked to `in_progress` task); sources — memory item + linked task.
  5. `unresolved_question`: input — memory items type `open_question`, not archived; predicate — linked to `in_progress` task OR linked to `decision.confirmation_required`; severity `info`; sources — memory item + task or decision.
- `ConflictDetector.run({ goalId, db, triggerEvent })`:
  - runs all detectors over the Goal snapshot;
  - computes `conflict_fingerprint` per candidate (`goalId + type + sortedSourceIds`);
  - for each candidate: `INSERT OR IGNORE` (or equivalent partial-unique-respecting insert) into `conflicts` with status `open`; on actual insert, emit `conflict.detected`; in the same TX, call `runRecommendationGeneration` path for a single `resolve_conflict` candidate referencing the new conflict id, inserting the recommendation row + emitting `recommendation.generated` (with `count=1`) within the same TX.
- Reset-on-state-change behavior: dismissed conflicts with same fingerprint that reappear after at least one source row's `updated_at` advances are allowed to reset to `open` — deterministic via timestamp comparison; document the comparison rule inline.
- Per-type fixture tests including a no-conflict baseline.
- Integration test runs the detector set against a fixture Goal snapshot and asserts the expected conflicts + linked recommendations.

**Affected Areas.**
- `apps/daemon/src/conflicts/detectors.ts`, `detectors.test.ts`, `usecases.ts` (extend with `detectAndPersist`) (new/extend).
- `apps/daemon/src/daemon-context.ts` (add `conflictDetector`).

**Dependencies.** M7-005, M7-008.

**Acceptance Criteria.**
- Per-type fixture tests pass.
- No-conflict baseline: zero detections.
- Double-fingerprint test: same underlying state runs detectors twice, only one `open` row persists.
- Same-TX cascade: assert `conflict.detected` and the linked `recommendation.generated` (with `count=1`, `recommendationIds=[<resolveId>]`) appear at the same event store offset commit (same TX).
- Reset-on-state-change test: dismiss a conflict, advance a source `updated_at`, rerun detectors, assert a new `open` conflict appears.
- Full-suite gate: `pnpm -r typecheck` and `pnpm -r test` exit 0; M1–M6 anchors still green.

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/conflicts`.
- `pnpm -r typecheck && pnpm -r test`.

**Risks / Notes.**
- `contradictory_decisions` false positives: ensure dismiss flow works (covered by M7-014 routes); document conservative behavior.
- Cross-TX cascade leakage: assert single-TX behavior via event-store offset comparison.
- Do not re-emit `conflict.detected` on duplicate fingerprint while open.

**Suggested model:** Sonnet 4.6 (detector wiring), GPT 5.4 / Codex (fixtures).

**Review Gate 3:** After M7-010, run `pnpm -r typecheck` and `pnpm -r test`; verify bounded inputs, no raw output-tail/transcript access, deterministic task/recommendation/conflict rules, source refs, caps, superseding, and false-positive conflict handling. Human + GPT 5.5.

---

### M7-011 — Orchestrator Triggers And Runner Integration

**Purpose.** Subscribe to committed domain events, map them to candidate generation jobs and conflict detector invocations, and run them through the M7-006 single-flight runner. Closes the event-driven loop.

**Scope.**
- IS: `apps/daemon/src/orchestrator/triggers.ts` — committed-event subscriber, trigger-to-job table, conflict re-check hooks; `apps/daemon/src/orchestrator/runner.ts` extensions (wire generator + provider + detector calls); per-Goal single-flight + dirty-flag re-evaluation; daemon bootstrap hookup (subscribe to event bus, register `DaemonContext` fields).
- IS NOT: boot reconciliation (M7-012), HTTP routes, UI.

**Requirements.**
- Trigger map (matches Section 6 of the milestone plan):
  | Event | Candidate suggestion classes / detectors |
  |---|---|
  | `goal.refinement.applied` | task generation (if zero tasks); `refine_goal` |
  | `session.completed` | `review_output`, `run_validation`, `continue_session`, `update_plan`, `mark_complete`, workspace_overlap detector |
  | `session_summary.created`/`.updated` | `review_output`, `update_plan`, blocker detector, reviewer_rejection detector |
  | `memory.promoted`/`.canonical` | `update_plan`, `split_task`, unresolved_question detector |
  | `decision.confirmed` | `update_plan`, contradictory_decisions detector |
  | `decision.confirmation_required` | `ask_user`, `refine_goal` |
  | `context.package.created` | informational only; no new recommendation |
  | `task.created`/`task.status_changed` | re-check `mark_complete`, blocked-question detectors |
  | `conflict.detected` | `resolve_conflict` (already handled in M7-010 cascade; trigger map skips duplicate emission) |
  | `user.feedback.recorded` (modify only) | re-evaluate recommendations once |
- The triggers subscribe to the **committed** event bus only (broadcast-after-commit) — never to raw output chunks, WebSocket frames, or pre-commit hooks.
- Each trigger invocation: derives `(goalId, triggerKind, triggerSourceId)`; if any detector is in the candidate set, runs `detectAndPersist`; if any recommendation class is in the candidate set, enqueues a recommendation generation via `runGeneration` with the Goal-scoped input builder; if task generation is in the candidate set, enqueues task generation.
- Single-flight per Goal (already implemented in M7-006) plus dirty-flag re-evaluation.
- Daemon bootstrap (`apps/daemon/src/index.ts` or equivalent): construct `DaemonContext` with `taskGenerator`, `recommendationProvider`, `conflictDetector`; subscribe `orchestrator/triggers` to the committed-event bus; do not call `reconcileInFlightGenerations` yet (M7-012 wires that before HTTP listen).
- Integration test using file-backed SQLite + fake provider + fake generator + fake detector: emit `session.completed` → assert one generation row, expected events, expected rows; double-emit during in-flight → asserts dirty-flag + one re-evaluation; emit conflicting workspace overlap → asserts both `conflict.detected` and the linked `resolve_conflict` recommendation appear in same TX.

**Affected Areas.**
- `apps/daemon/src/orchestrator/triggers.ts`, `triggers.test.ts` (new).
- `apps/daemon/src/orchestrator/runner.ts` (extend wiring).
- `apps/daemon/src/index.ts` (or daemon bootstrap file) — wire subscription.
- `apps/daemon/src/daemon-context.ts` (finalize all three new fields).

**Dependencies.** M7-007, M7-008, M7-009, M7-010.

**Acceptance Criteria.**
- Integration test passes.
- Trigger map is data-driven (a const object/table), not inline branching, and has a corresponding completeness test that asserts every event type listed in the table is handled.
- Conflict cascade test asserts `conflict.detected` and `recommendation.generated` from the linked `resolve_conflict` share the same TX boundary.
- Concurrent double-trigger test (Promise.all) asserts single-flight + exactly one re-evaluation.
- Raw output tail / transcript modules not imported by `orchestrator/` (static check passes).

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/orchestrator`.

**Risks / Notes.**
- Trigger map drift: keep table-driven and tested.
- Re-entrancy: a recommendation generation may itself emit events that map to triggers; the trigger subscriber must ignore M7 events that originate from M7 generation paths (deterministic discriminator on event source or a small allowlist of triggering events).
- `context.package.created` deliberately produces no new recommendation; verify in tests.

**Suggested model:** Sonnet 4.6.

---

### M7-012 — Boot Reconciliation For In-Flight Generations

**Purpose.** Reconcile `pending`/`running` task and recommendation generation rows to `failed/daemon_restart` before HTTP listens, emitting matching failure events in the same TX. Mirrors M6's reconciliation pattern.

**Scope.**
- IS: `apps/daemon/src/orchestrator/reconcile.ts` implementation; bootstrap hookup before HTTP listen; restart test using file-backed SQLite.
- IS NOT: trigger subscription (already wired in M7-011), HTTP routes, UI.

**Requirements.**
- `reconcileInFlightGenerations(db)`:
  - selects every row in `task_generations` with `status IN ('pending','running')`;
  - for each: update to `status='failed'`, `failure_code='daemon_restart'`, capped failure message `'reconciled at boot'`, and append `task.generation.failed` in the same TX;
  - same for `recommendation_generations` + `recommendation.generation.failed`;
  - does **not** touch already-persisted task/recommendation/conflict rows.
- Called by daemon bootstrap **before** HTTP/WebSocket listen, after migrations, after registry registration, before trigger subscription.
- Restart test: file-backed SQLite; insert pending generation rows; simulate process restart (close DB, reopen, call boot); assert all rows transitioned to failed with matching events; assert events appear before the trigger subscriber starts emitting.

**Affected Areas.**
- `apps/daemon/src/orchestrator/reconcile.ts`, `reconcile.test.ts` (new).
- `apps/daemon/src/index.ts` (bootstrap order).

**Dependencies.** M7-011.

**Acceptance Criteria.**
- Restart test passes: pre-shutdown pending rows become failed post-boot; events emitted.
- Reconciler runs **before** HTTP listen (assert via test that an HTTP request rejected during reconciliation period).
- Failure messages are capped and redacted.
- Successfully persisted tasks/recommendations/conflicts unchanged after reconciliation.

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/orchestrator/reconcile`.
- Manual restart smoke (optional).

**Risks / Notes.**
- Reconciliation must be idempotent (running it twice produces no state change after first run).
- Do not abort generation rows that succeeded mid-shutdown — only `pending`/`running`.

**Suggested model:** GPT 5.4 / Codex.

**Review Gate 4:** After M7-012, verify orchestrator trigger mapping, single-flight behavior, dirty-flag re-evaluation, boot reconciliation, daemon restart behavior, and broadcast-after-commit. Human + GPT 5.5.

---

### M7-013 — Task HTTP Routes

**Purpose.** Expose the task endpoints listed in Section 9 of the milestone plan.

**Scope.**
- IS: HTTP route handlers for `POST /v1/goals/:goalId/tasks/generate`, `GET /v1/goals/:goalId/tasks`, `POST /v1/goals/:goalId/tasks`, `PATCH /v1/tasks/:id`, `POST /v1/tasks/:id/split`, `POST /v1/tasks/:id/associate-session`; zod validation at the route boundary; integration with use cases from M7-003 and M7-007.
- IS NOT: recommendation routes, conflict routes, session/context extension, UI.

**Requirements.**
- Routes mount on the existing M1 server with the existing auth header.
- `POST /v1/goals/:goalId/tasks/generate`:
  - request `{ trigger: 'manual' }`;
  - validates Goal exists and not archived (`409 goal_archived` otherwise);
  - calls `runTaskGeneration(...)`;
  - returns `202 { generation: <TaskGeneration> }` immediately; runner completes async; UI subscribes to broadcast events.
- `GET /v1/goals/:goalId/tasks`:
  - filters `status`, `workspaceId`, `role`, `parentTaskId`, `limit` (default 50, cap 200), `cursor`;
  - returns `{ tasks: Task[], generations: TaskGeneration[] }` with the latest 5 generations.
- `POST /v1/goals/:goalId/tasks`:
  - validates per contract (caps, role enum, workspace/parent/dependency same Goal);
  - returns `{ task: Task }` after `task.created`.
- `PATCH /v1/tasks/:id`:
  - partial update; rejects illegal status transitions with `409 invalid_status_transition`;
  - emits `task.updated` and `task.status_changed` when applicable.
- `POST /v1/tasks/:id/split`:
  - children optional `setParentStatus`;
  - emits `task.split` + N `task.created`.
- `POST /v1/tasks/:id/associate-session`:
  - validates session belongs to same Goal;
  - emits `task.associated_with_session`.
- HTTP tests cover 200/202/400/404/409 paths per endpoint.

**Affected Areas.**
- `apps/daemon/src/tasks/routes.ts`, `routes.test.ts` (new).
- `apps/daemon/src/server.ts` (mount).

**Dependencies.** M7-007.

**Acceptance Criteria.**
- All endpoints covered with at least one positive and one negative test.
- Idempotent generate: same input fingerprint within active generation returns the existing row (asserts no new generation inserted).
- Wire shape matches the contract schemas exactly.
- Goal-scope rejection for cross-Goal session id on `associate-session`.

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/tasks/routes`.

**Risks / Notes.**
- `archive` is folded into `PATCH ... { status: 'archived' }`; no separate endpoint.
- `POST /v1/tasks/:id/associate-context-package` is **not** in scope; association via context-package creation handles the reverse direction (M7-017).

**Suggested model:** Sonnet 4.6.

---

### M7-014 — Recommendation HTTP Routes

**Purpose.** Expose recommendation endpoints from Section 9 of the milestone plan, including lifecycle actions accept/reject/dismiss/modify.

**Scope.**
- IS: HTTP route handlers for `POST /v1/goals/:goalId/recommendations/generate`, `GET /v1/goals/:goalId/recommendations`, `GET /v1/recommendations/:id`, `POST /v1/recommendations/:id/accept`, `POST /v1/recommendations/:id/reject`, `POST /v1/recommendations/:id/dismiss`, `PATCH /v1/recommendations/:id`; zod validation; integration with use cases from M7-004 and M7-008.
- IS NOT: conflict routes, session/context extension, UI.

**Requirements.**
- `POST /v1/goals/:goalId/recommendations/generate`: request `{ trigger: 'manual' }`; idempotent on `(goalId, triggerKind='manual', triggerSourceId='manual', inputFingerprint)`; returns `202 { generation }`.
- `GET /v1/goals/:goalId/recommendations`: filters `status` (default `proposed`), `type`, `relatedTaskId`, `limit`, `cursor`, `includeGenerations=true|false` (default true); returns `{ recommendations, generations }`.
- `GET /v1/recommendations/:id`: full row with `sources_json` parsed; includes most-recent feedback entries.
- Accept/reject/dismiss handlers:
  - request body `{ note?: string }` capped 2 KiB;
  - idempotent (repeat call returns existing row without new event, 200 status);
  - response shape per Section 9 includes `recommendation`, `feedback`, and (for accept only) `proposedAction`.
- PATCH (modify):
  - body `{ title?, rationale?, proposedAction? }`;
  - status must not be terminal;
  - captures pre-modify snapshot in `recommendation_feedback.modified_payload_json`;
  - emits `recommendation.modified` + `user.feedback.recorded`.
- HTTP tests: each lifecycle path; idempotency; terminal one-shot; modify-then-accept; supersede surfaced in list with `status='superseded'`.

**Affected Areas.**
- `apps/daemon/src/recommendations/routes.ts`, `routes.test.ts` (new).
- `apps/daemon/src/server.ts` (mount).

**Dependencies.** M7-008.

**Acceptance Criteria.**
- All listed routes covered; all listed acceptance criteria from contracts and M7-004 use cases satisfied at the wire layer.
- Accept response includes `proposedAction` payload; explicit test asserts no downstream M4/M6 HTTP call is made during accept (mock-based assertion).
- `POST /v1/recommendations/:id/execute` and `POST /v1/recommendations/:id/regenerate` are **not** registered; assert via a route-list test that they return 404.

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/recommendations/routes`.

**Risks / Notes.**
- Idempotency relies on DB-level partial unique constraint on `(recommendation_id, action) WHERE action IN ('accept','reject','dismiss')`; ensure the use case returns the existing rows rather than throwing on the constraint error.
- Modify is non-terminal; tests assert subsequent accept works.

**Suggested model:** Sonnet 4.6.

---

### M7-015 — Conflict HTTP Routes

**Purpose.** Expose `GET /v1/goals/:goalId/conflicts` and `POST /v1/conflicts/:id/resolve`. Wire the cross-projection cascade (auto-dismiss of linked `resolve_conflict` recommendation).

**Scope.**
- IS: HTTP route handlers for conflict list + resolve/dismiss; zod validation; integration with M7-005 use cases.
- IS NOT: detector logic (M7-010), recommendation routes, UI.

**Requirements.**
- `GET /v1/goals/:goalId/conflicts`: filters `status` (default `open`), `severity`, `limit`; returns `{ conflicts: Conflict[] }`.
- `POST /v1/conflicts/:id/resolve`:
  - body `{ resolution: 'resolved'|'dismissed', note?: string }`;
  - validation: `status='open'`;
  - calls `resolveConflict` or `dismissConflict` use case;
  - response: `{ conflict }`; cascade emits `recommendation.dismissed` + `user.feedback.recorded` for the linked `resolve_conflict` recommendation if it exists in non-terminal status.
- HTTP tests cover positive resolve/dismiss, second resolve on resolved row → 409, cross-projection cascade observable in event store.

**Affected Areas.**
- `apps/daemon/src/conflicts/routes.ts`, `routes.test.ts` (new).
- `apps/daemon/src/server.ts` (mount).

**Dependencies.** M7-010.

**Acceptance Criteria.**
- HTTP tests pass including the cascade.
- Same-TX behavior asserted by event-store inspection (single offset jump for both events).

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/conflicts/routes`.

**Risks / Notes.**
- Cascade is the only "automatic" cross-projection lifecycle change — keep it documented in code.
- Manual conflict creation endpoint deliberately omitted.

**Suggested model:** Sonnet 4.6.

---

### M7-016 — Session Create Extension (Optional taskId / fromRecommendationId)

**Purpose.** Extend `POST /v1/sessions` to accept optional `taskId` and `fromRecommendationId` without regressing existing M4 behavior.

**Scope.**
- IS: schema extension validation, persistence of new columns, `session.created` payload extension, emission of `task.associated_with_session` when `taskId` provided.
- IS NOT: PTY changes, adapter changes, recommendation accept logic, UI prefill (UI ships in M7-021).

**Requirements.**
- `apps/daemon/src/sessions/usecases.ts`:
  - accepts optional `taskId`, `fromRecommendationId`;
  - validates: both, if present, belong to the same Goal as the session's Goal (Goal id is derivable from existing M4 logic); if `fromRecommendationId` provided, the recommendation must be `accepted` for the same Goal (`409 invalid_recommendation_state` otherwise); if `taskId` references an archived task → `409 archived_target`;
  - stores both columns; emits the existing `session.created` event with the new optional fields present when provided;
  - when `taskId` provided, emits `task.associated_with_session` in same TX.
- M4 PTY lifecycle, output tail behavior, reconciliation behavior **unchanged**.
- Without the new fields, the use case + event payload are byte-identical to M4.
- Tests cover: no association (regression for M4); with task only; with recommendation only; with both; mismatched-Goal task; mismatched-Goal recommendation; recommendation in non-`accepted` state; archived task.
- Existing M4 session lifecycle integration test still PASSES unchanged.

**Affected Areas.**
- `apps/daemon/src/sessions/usecases.ts`, `routes.ts` (extend), `projection.ts` (return new columns), test files.
- `apps/daemon/src/sessions/__tests__/m4-anchor.test.ts` (run unchanged to confirm no regression).

**Dependencies.** M7-013, M7-014.

**Acceptance Criteria.**
- New tests pass.
- M4 regression anchor passes unchanged.
- `session.created` payload omits the new fields when not provided (byte-identical), includes them when provided.
- Associated event `task.associated_with_session` emitted in same TX as `session.created`.
- Reconciler unchanged: post-restart, the session row keeps `task_id` and `from_recommendation_id` pinned to original associations.

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/sessions`.

**Risks / Notes.**
- Do not modify PTY manager.
- Schema for the optional fields must use `.optional()` not `.nullable()` to preserve omission semantics.

**Suggested model:** Sonnet 4.6.

---

### M7-017 — Context Package Create Extension (Optional taskId / fromRecommendationId)

**Purpose.** Extend `POST /v1/goals/:goalId/context-packages` symmetrically to M7-016 without regressing M6 behavior.

**Scope.**
- IS: schema extension, persistence, `context.package.created` payload extension, optional `task.associated_with_context_package` emission.
- IS NOT: assembler changes, source-ref join tables, UI prefill.

**Requirements.**
- `apps/daemon/src/context/usecases.ts`:
  - accepts optional `taskId`, `fromRecommendationId`;
  - validation mirrors M7-016 (same-Goal, `accepted` recommendation, non-archived task);
  - stores both columns; includes them in `context.package.created` when provided;
  - emits `task.associated_with_context_package` in same TX when `taskId` provided.
- Without the new fields, behavior is byte-identical to M6.
- Source list on the package does **not** include the task or recommendation (the link goes on the package row, not into `sources_json`).
- Adapter delivery rules, assembler behavior, redaction rules unchanged.
- Tests cover: M6 regression (no fields), with task, with recommendation, with both, validation failures.
- Existing M6 final anchor passes unchanged.

**Affected Areas.**
- `apps/daemon/src/context/usecases.ts`, `routes.ts` (extend), `projection.ts`, test files.

**Dependencies.** M7-013, M7-014.

**Acceptance Criteria.**
- New tests pass.
- M6 final anchor passes unchanged.
- `context.package.created` payload omits new fields when absent.

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/context`.

**Risks / Notes.**
- M6 assembler must not branch on the new fields.

**Suggested model:** Sonnet 4.6.

**Review Gate 5:** After M7-017, verify daemon API, event, persistence, idempotency, restart, privacy, session-create, context-create, and M1-M6 regression behavior for association extensions. Human + GPT 5.5.

---

### M7-018 — Internal Skill Descriptors

**Purpose.** Register the three internal skill descriptors with the M2 registry for diagnostics. No public invocation route.

**Scope.**
- IS: registration of `orca/recommendation-generation`, `orca/task-generation`, `orca/conflict-detection` with `category: 'internal'` and `invocation: 'daemon-internal'` in the existing M2 boot path; M2 diagnostics test asserting their presence.
- IS NOT: public invocation routes, generic skill invocation API, new skill capabilities.

**Requirements.**
- Three descriptors registered before HTTP listen.
- M2 skill diagnostics test asserts: each descriptor present with `version='0.1.0'`, `category='internal'`, `invocation='daemon-internal'`.
- No public route accepts these skill ids.

**Affected Areas.**
- `apps/daemon/src/skills/` (existing registry; new descriptor files).
- M2 skill registry test (extend).

**Dependencies.** M7-011 (uses these labels indirectly).

**Acceptance Criteria.**
- M2 registry test passes including new assertions.
- `POST /v1/skills/orca/recommendation-generation/invoke` (or equivalent) returns 404 (asserted in test).

**Validation Steps.**
- `pnpm --filter @orca/daemon test src/skills`.

**Risks / Notes.**
- Do not introduce a public `POST /v1/skills/:id/invoke` route.

**Suggested model:** GPT 5.4 / Codex.

---

### M7-019 — Desktop API Wrappers

**Purpose.** Add typed wrappers for every new endpoint to the desktop API layer. Foundation for the three new panels.

**Scope.**
- IS: typed wrapper functions in `apps/desktop/src/api.ts` for every new route + extension; type re-exports from `@orca/contracts`; wrapper unit tests.
- IS NOT: UI panels, live refresh, navigation.

**Requirements.**
- One wrapper per route: `generateTasks(goalId)`, `listTasks(goalId, query)`, `createTask(goalId, body)`, `patchTask(id, patch)`, `splitTask(id, body)`, `associateTaskWithSession(id, sessionId)`, `generateRecommendations(goalId)`, `listRecommendations(goalId, query)`, `getRecommendation(id)`, `acceptRecommendation(id, body)`, `rejectRecommendation(id, body)`, `dismissRecommendation(id, body)`, `modifyRecommendation(id, patch)`, `listConflicts(goalId, query)`, `resolveConflict(id, body)`.
- Extension wrappers: existing `createSession`, `createContextPackage` gain optional `taskId`, `fromRecommendationId` parameters; existing call sites continue to work without changes.
- Wrapper tests assert request shape, response parsing, error mapping (404/409 mapped to typed errors).
- Style matches existing `api.ts` (fetch + zod parse pattern).

**Affected Areas.**
- `apps/desktop/src/api.ts`, `api.test.ts` (extend).

**Dependencies.** M7-013, M7-014, M7-015, M7-016, M7-017.

**Acceptance Criteria.**
- `pnpm --filter @orca/desktop typecheck` passes.
- Wrapper tests pass.
- Backward compatibility: existing tests for `createSession` / `createContextPackage` pass unchanged.

**Validation Steps.**
- `pnpm --filter @orca/desktop test`.

**Risks / Notes.**
- Wrappers must reference `@orca/contracts` schemas, not redeclare.

**Suggested model:** GPT 5.4 / Codex.

---

### M7-020 — Tasks Panel UI

**Purpose.** Render the Goal-scoped Tasks panel inside the existing Goal detail view, including generate / list / edit / split flows. No live refresh wiring yet (M7-023).

**Scope.**
- IS: `TasksPanel`, `TaskRow`, `TaskEditDialog`, `TaskSplitDialog` components; integration with M7-019 wrappers; loading / empty / generating / failed / loaded states; status/role/workspace chip filters; "Generate tasks" button.
- IS NOT: recommendations panel, conflicts banner, live WebSocket refresh, navigation changes.

**Requirements.**
- Panel placement inside Goal detail per Section 14 of the milestone plan.
- States rendered:
  - loading (skeleton);
  - empty (hint + "Generate tasks" CTA);
  - loaded (filterable list);
  - generating banner (pending/running/failed/succeeded with timestamp);
  - per-task editing/splitting dialogs.
- Each row shows title, role badge, status badge, workspace name (if any), associated session count (derived from list metadata or `GET /v1/tasks/:id` lazy fetch), source-count badge, kebab menu (edit/split/cancel/archive).
- Edit dialog enforces field caps client-side.
- Split dialog supports N child rows; submit calls split endpoint.
- Manual create flow optional in this task — at minimum "Generate tasks" CTA is wired; manual create can ship in M7-024 polish if needed.
- Component tests cover each state.

**Affected Areas.**
- `apps/desktop/src/goal-detail/tasks/*` (new).
- `apps/desktop/src/goal-detail/GoalDetail.tsx` (mount).

**Dependencies.** M7-019.

**Acceptance Criteria.**
- Component tests cover: empty, loaded, generating, failed, edit submit, split submit, status filter, role filter.
- `pnpm --filter @orca/desktop typecheck && test` pass.
- No new top-level route added.
- Field caps enforced before submission (avoids 400 round-trips).

**Validation Steps.**
- `pnpm --filter @orca/desktop test apps/desktop/src/goal-detail/tasks`.

**Risks / Notes.**
- Do not introduce a global task dashboard.
- Live refresh wired in M7-023.

**Suggested model:** Sonnet 4.6.

---

### M7-021 — Recommendations Panel UI With Accept/Reject/Dismiss/Modify And Per-Kind Prefill

**Purpose.** Render the recommendations panel and wire lifecycle actions. Implement the per-kind prefill map from accepted recommendations into existing M3/M4/M5/M6/M7 flows. **No auto-launch** of any downstream flow.

**Scope.**
- IS: `RecommendationsPanel`, `RecommendationCard`, `RecommendationDetails` drawer, `RecommendationModifyDialog`; lifecycle action handlers; per-kind prefill into existing flows; component tests; explicit no-auto-launch assertions.
- IS NOT: live WebSocket refresh (M7-023), conflicts banner, navigation changes.

**Requirements.**
- Three sections: `Active` (default visible), `Modified` (collapsible), `History (recent)` (collapsible).
- Card shows: title, type badge (color-coded), confidence badge (low/med/high; thresholds `<0.5`, `<0.8`, `≥0.8`), rationale (truncated, click-to-expand), proposed-action one-line summary (rendered per kind), source list summary (e.g., `"3 memory · 1 decision · 1 summary"`), action buttons (Accept primary, Reject, Dismiss, Modify in overflow).
- Detail drawer: full rationale, proposed action JSON (collapsed code block), source list with titles resolved via existing M3/M5/M6 endpoints.
- Modify dialog: title, rationale, proposed-action editor (kind picker + per-kind form).
- Per-kind prefill (Section 13 of the milestone plan):
  - `create_session` → opens existing M4 new-session form with `adapterId`, `workspaceId`, `role`, `objective`, `contextPackageId` (or `contextRequest` two-step) prefilled, plus `taskId` and `fromRecommendationId` pre-set. **User must press Submit to launch.**
  - `continue_session` → navigates to existing session detail/terminal view (no new launch path).
  - `review_output` / `run_validation` → opens M4 new-session form with reviewer/qa role + task pre-associated. **User must press Submit.**
  - `refine_goal` → opens existing M3 refinement flow with missing-field hints.
  - `update_plan` → opens M7 task PATCH dialog with suggested patch prefilled.
  - `split_task` → opens M7 task split dialog with suggested children prefilled.
  - `mark_complete` → opens M7 task PATCH dialog with status `done` prefilled.
  - `resolve_conflict` → opens M7 conflict resolve dialog.
  - `ask_user` → opens existing M5 decision-confirmation flow.
  - `pause_work` → no-op accept (records signal); displays a small toast confirming.
- Each Accept handler calls only the recommendation accept endpoint; it does **not** call the downstream endpoint. The downstream flow is opened with prefilled UI state but requires user submission.
- Component tests assert per-kind prefill mapping by mocking the navigation/dialog open helpers and asserting they were called with the expected prefilled payload.
- Explicit no-auto-launch test: accept a `create_session` recommendation; assert the session create wrapper was **not** called by the accept handler.

**Affected Areas.**
- `apps/desktop/src/goal-detail/recommendations/*` (new).
- `apps/desktop/src/goal-detail/GoalDetail.tsx` (mount).

**Dependencies.** M7-019, M7-020 (shares some dialog components for task PATCH/split).

**Acceptance Criteria.**
- Component tests cover: each card state (Active, Modified, History), each lifecycle action, each per-kind prefill mapping.
- No-auto-launch assertion passes for all session/context-related kinds.
- Field caps enforced in modify dialog.

**Validation Steps.**
- `pnpm --filter @orca/desktop test apps/desktop/src/goal-detail/recommendations`.

**Risks / Notes.**
- The prefill map is verbose by design — do not introduce a generic action executor.
- Do not auto-call downstream endpoints.
- `proposedAction.contextRequest` two-step flow: open M6 context preparation first; on success, open M4 new-session with the resulting `contextPackageId`. Both steps still require user submission.

**Suggested model:** Sonnet 4.6.

---

### M7-022 — Conflicts Banner UI

**Purpose.** Render the conflicts banner (visible when ≥ 1 open conflict exists), the drawer, and the resolve/dismiss dialog. Visualize the cross-projection cascade (linked recommendation auto-dismiss).

**Scope.**
- IS: `ConflictsBanner`, `ConflictResolveDialog`; visibility logic; resolve / dismiss handlers; component tests.
- IS NOT: detector logic, live refresh (M7-023).

**Requirements.**
- Banner visible only when `conflicts.filter(c => c.status === 'open').length > 0`.
- Banner one-liner: "N conflicts need review" → opens drawer.
- Drawer rows: type, severity, description (rule-generated, capped), source-count badge; `Resolve` and `Dismiss` buttons.
- Resolve dialog: optional note (capped 4 KiB); submit calls `resolveConflict` wrapper.
- On successful resolve/dismiss, drawer refreshes; banner hides if no remaining open conflicts.
- Component tests cover: hidden (no open), shown (≥ 1 open), resolve flow, dismiss flow, cascade visibility (linked recommendation dismissed afterward — asserted by mocking the list reload).

**Affected Areas.**
- `apps/desktop/src/goal-detail/conflicts/*` (new).
- `apps/desktop/src/goal-detail/GoalDetail.tsx` (mount).

**Dependencies.** M7-019.

**Acceptance Criteria.**
- Component tests pass.

**Validation Steps.**
- `pnpm --filter @orca/desktop test apps/desktop/src/goal-detail/conflicts`.

**Risks / Notes.**
- Banner placement: above existing refinement panel.
- Description text is rule-generated and capped; do not display raw memory/decision body in the drawer.

**Suggested model:** Sonnet 4.6.

---

### M7-023 — Live Refresh Integration

**Purpose.** Wire the three new panels to the existing WebSocket subscription so they react to broadcast events without polling.

**Scope.**
- IS: extension of the desktop event handler to dispatch `task.*` / `recommendation.*` / `conflict.*` / `user.feedback.recorded` events to per-panel refetch helpers; debounce (200 ms); per-panel scope.
- IS NOT: new WebSocket commands, new socket frames, navigation changes.

**Requirements.**
- Event handler maps:
  - `task.*` → refetch `/v1/goals/:goalId/tasks` for the active Goal;
  - `recommendation.*` → refetch `/v1/goals/:goalId/recommendations` (and refetch tasks if the recommendation's `proposedAction` touches a task);
  - `conflict.*` → refetch `/v1/goals/:goalId/conflicts`;
  - `user.feedback.recorded` → refetch the affected recommendation only.
- Debounce 200 ms per panel.
- Generation events (`*.generation.*`) update banner state only (no full list refetch unless terminal).
- jsdom-based integration test: push mock events through the handler; assert each panel's refetch is called the expected number of times.

**Affected Areas.**
- `apps/desktop/src/events/` (existing handler) extend.
- Test files.

**Dependencies.** M7-020, M7-021, M7-022.

**Acceptance Criteria.**
- Integration test passes.
- Debounce verified: 10 rapid events trigger one refetch within 200 ms.
- Per-panel scope verified: a `task.*` event does not refetch recommendations.

**Validation Steps.**
- `pnpm --filter @orca/desktop test apps/desktop/src/events`.

**Risks / Notes.**
- Do not introduce new WebSocket commands; only consume broadcast events.
- A stale-state trap: ensure the panel always refetches on `*.generation.succeeded` / `*.generation.failed`.

**Suggested model:** Sonnet 4.6.

**Review Gate 6:** After M7-023, run desktop manual smoke with one refined Goal, one attached workspace, M5 memory/decisions/session summaries, an M6 context package, task generation, recommendation generation, accept/reject/dismiss/modify, context/session prefill, conflict detection/resolution, reload, and daemon restart. Human.

---

### M7-024 — End-To-End Proof, Restart Test, Full Regression, Docs

**Purpose.** Final proof loop, restart-safety verification, full regression, and documentation completion. Final M7 deliverable.

**Scope.**
- IS: integration test `apps/daemon/src/__tests__/m7-loop.test.ts` exercising the full proof point; restart test; full `pnpm -r typecheck` and `pnpm -r test`; documentation completion (this file + README/CHANGELOG entries if any); final notes record in `docs/implementation-plans/notes/m7-024-final.md`.
- IS NOT: new features, scope absorption from earlier tasks, new architecture.

**Requirements.**
- Integration test loop:
  1. Create Goal; refine it; attach one workspace.
  2. `POST /v1/goals/:goalId/tasks/generate`; assert task generation completes; assert ≥ 1 task row with `sources` listing the refinement.
  3. Create + complete an engineer-role session with an implementation-evidence summary (via M4/M5 test fixtures).
  4. Wait for trigger evaluation; assert recommendation generation runs; assert ≥ 1 `run_validation` recommendation with sources including the session + summary; assert sparse=false.
  5. Accept the recommendation; assert response contains the `proposedAction`; assert that no automatic call to `POST /v1/sessions` was made (mock the wrapper or assert event log absence of new `session.created` until manually invoked).
  6. Insert two `running` sessions on the same workspace; emit `session.completed` (or trigger evaluation directly); assert `workspace_overlap` conflict + linked `resolve_conflict` recommendation appear in same TX.
  7. `POST /v1/conflicts/:id/resolve`; assert auto-dismiss of the linked recommendation; assert `conflict.resolved` + `recommendation.dismissed` + `user.feedback.recorded` in same TX.
  8. Restart the daemon mid-generation: insert a pending generation row directly, kill the process (or close DB and reopen), reboot; assert reconciliation marked the row failed; assert tasks/recommendations/conflicts/feedback rows preserved; assert UI list endpoints return the expected rows.
- Run `pnpm -r typecheck` and `pnpm -r test`; record summary.
- Verify Definition of Done items 1–18 from Section 18 of the milestone plan with a checklist in the notes file.
- Verify non-goals: assert via tests / static checks / route lists that none of the rejected endpoints exist; assert no event carries body text > 4 KiB.
- Documentation: ensure this implementation plan covers all 25 tasks; update CHANGELOG or release-notes equivalent if the project has one (otherwise skip).
- Record final commit SHA + test summary in `docs/implementation-plans/notes/m7-024-final.md`.

**Affected Areas.**
- `apps/daemon/src/__tests__/m7-loop.test.ts` (new).
- `docs/implementation-plans/notes/m7-024-final.md` (new).
- Any minor doc updates required by the proof.

**Dependencies.** All prior M7 tasks.

**Acceptance Criteria.**
- Integration test passes end-to-end including restart.
- `pnpm -r typecheck` and `pnpm -r test` exit 0.
- All named M1–M6 anchors PASS.
- All 18 Definition of Done items satisfied (checklist in notes file).
- No-auto-launch and content-free-event regressions caught by tests.

**Validation Steps.**
- `pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm -r test`.
- Manual smoke (per Review Gate 6) optional but recommended.

**Risks / Notes.**
- Do not absorb scope from earlier tasks.
- Final task; treat as the definitive proof, not a catch-all.

**Suggested model:** Sonnet 4.6 (test authoring); Human + GPT 5.5 (final acceptance).

**Review Gate 7:** After M7-024, run `pnpm -r typecheck` and `pnpm -r test`; verify Definition of Done, final docs, and non-goals. Human + GPT 5.5.

---

## Task Dependency Graph

```
M7-000  Baseline Verification
   │
M7-001  Contracts ────────────────────────────────────────────────────────────────────┐
   │                                                                                  │
M7-002  Migration ───── [Review Gate 1] ───┐                                          │
   │                                       │                                          │
   ├─► M7-003  Tasks Projection + CRUD ────┤                                          │
   │                                       │                                          │
   ├─► M7-004  Recommendations Projection ─┤                                          │
   │                                       │                                          │
   └─► M7-005  Conflicts Projection ───────┘                                          │
                                           │                                          │
                              M7-006  Generation Lifecycle ── [Review Gate 2]         │
                                  │                                                   │
                ┌─────────────────┼─────────────────┐                                  │
                ▼                                   ▼                                  │
        M7-007  Task Generator              M7-008  Recommendation Provider           │
                                                    │                                 │
                                            M7-009  Validation/Review Rules           │
                                                    │                                 │
                                            M7-010  Conflict Detectors ─ [Gate 3 full-suite]
                                                    │
                                            M7-011  Orchestrator Triggers
                                                    │
                                            M7-012  Boot Reconciliation ─ [Review Gate 4]
                                                    │
       ┌────────────────────────────────────────────┼────────────────────────┐
       ▼                                            ▼                        ▼
  M7-013 Task Routes                       M7-014 Recommendation Routes   M7-015 Conflict Routes
       │                                            │                        │
       └────────────────────┬───────────────────────┘                        │
                            ▼                                                │
                    M7-016 Session Extension                                 │
                            │                                                │
                    M7-017 Context Extension ─ [Review Gate 5]               │
                                                    │                        │
                                            M7-018  Internal Skill Descriptors
                                                    │                        │
                                            M7-019  Desktop API Wrappers ◄───┘
                                                    │
                              ┌─────────────────────┼─────────────────────┐
                              ▼                                           ▼
                       M7-020 Tasks Panel    M7-021 Recommendations Panel    M7-022 Conflicts Banner
                              │                          │                          │
                              └──────────────────────────┼──────────────────────────┘
                                                         ▼
                                                M7-023  Live Refresh ─ [Review Gate 6 manual smoke]
                                                         │
                                                M7-024  Proof + Regression ─ [Review Gate 7]
```

**Parallelizable clusters.**
- M7-003 / M7-004 / M7-005 can run in parallel after M7-002 (independent projections).
- M7-013 / M7-014 / M7-015 can run in parallel after M7-008 / M7-010 (independent route files).
- M7-016 and M7-017 can run in parallel after M7-013 + M7-014.
- M7-020 / M7-021 / M7-022 can run in parallel after M7-019.

**Blocking gates.**
- M7-002 blocks everything after it (no projection without migration).
- M7-006 blocks generators/provider (no generation without lifecycle helpers).
- M7-010 blocks orchestrator triggers (no trigger map without detectors).
- M7-011 blocks boot reconciliation (reconciler depends on the generation rows the runner produces).
- M7-019 blocks all UI panels.
- M7-023 blocks final proof (live refresh must work before the proof asserts it).

**Persistence gates.** M7-002 (schema), M7-006 (generation lifecycle), M7-012 (restart reconciliation).
**Generation/idempotency gates.** M7-006 (request fingerprint + single-flight), M7-008 (recommendation supersede), M7-010 (conflict fingerprint dedup).
**Accepted-recommendation integration gates.** M7-016 (session extension), M7-017 (context extension), M7-021 (prefill UI), M7-024 (end-to-end no-auto-launch assertion).
**Desktop integration gates.** M7-019 (wrappers), M7-023 (live refresh).
**Full-suite review gates.** M7-010 (mid-milestone), M7-024 (final).

---

## Suggested Model Assignment

| Task | Primary model | Notes |
|---|---|---|
| M7-000 Baseline | Human + Sonnet 4.6 | Run, observe, record. |
| M7-001 Contracts | Codex | Schema/test boilerplate. |
| M7-002 Migration | Codex | Mechanical DDL + tests. |
| M7-003 Tasks Projection | Sonnet 4.6 | Domain logic + status guards. |
| M7-004 Recommendations Projection | Sonnet 4.6 | Lifecycle nuance + idempotency. |
| M7-005 Conflicts Projection | Sonnet 4.6 | Cross-projection auto-dismiss helper. |
| M7-006 Generation Lifecycle | Sonnet 4.6 | Single-flight + dirty-flag. |
| M7-007 Task Generator | Codex (rules + fixtures); Sonnet 4.6 (input builder + runner glue) | |
| M7-008 Recommendation Provider | Sonnet 4.6 (provider + persistence); Codex (per-rule fixtures) | Largest task; budget carefully. |
| M7-009 Validation/Review Rules | Sonnet 4.6 | Subtle implementation-evidence detection. |
| M7-010 Conflict Detectors | Sonnet 4.6 (wiring); Codex (fixtures) | Full-suite gate. |
| M7-011 Orchestrator Triggers | Sonnet 4.6 | Trigger map + re-entrancy. |
| M7-012 Boot Reconciliation | Codex | Mirrors M6 pattern. |
| M7-013 Task Routes | Sonnet 4.6 | API implementation. |
| M7-014 Recommendation Routes | Sonnet 4.6 | Lifecycle idempotency. |
| M7-015 Conflict Routes | Sonnet 4.6 | Cross-projection cascade. |
| M7-016 Session Extension | Sonnet 4.6 | M4 regression risk. |
| M7-017 Context Extension | Sonnet 4.6 | M6 regression risk. |
| M7-018 Internal Skill Descriptors | Codex | Registration only. |
| M7-019 Desktop API Wrappers | Codex | Boilerplate. |
| M7-020 Tasks Panel UI | Sonnet 4.6 | UI implementation. |
| M7-021 Recommendations Panel UI | Sonnet 4.6 | Per-kind prefill map; no-auto-launch. |
| M7-022 Conflicts Banner UI | Sonnet 4.6 | Banner + drawer. |
| M7-023 Live Refresh | Sonnet 4.6 | Debounce + per-panel scope. |
| M7-024 Proof + Regression | Sonnet 4.6 (tests); Human + GPT 5.5 (acceptance) | Final gate. |

**Architecture drift reviews.** GPT 5.5 at Review Gates 1, 2, 3, 4, 5, 7.
**Final product judgment + manual smoke.** Human at Review Gate 6 and Review Gate 7.

---

## Recommended Review Gates

| Gate | After Task | Reviewer | Focus |
|---|---|---|---|
| 1 | M7-002 | Human + GPT 5.5 | Contracts, migration surface, session/context columns, indexes, upgrade path from M6 DB. |
| 2 | M7-006 | Human + GPT 5.5 | Projection helpers, generation lifecycle, request fingerprinting, active idempotency, TX boundaries, content-free events. |
| 3 | M7-010 | Human + GPT 5.5 + full-suite `pnpm -r typecheck && pnpm -r test` | Bounded inputs, no raw output-tail/transcript access, deterministic rules, source refs, caps, superseding, false-positive conflict handling. |
| 4 | M7-012 | Human + GPT 5.5 | Trigger mapping, single-flight, dirty-flag re-evaluation, boot reconciliation, restart behavior, broadcast-after-commit. |
| 5 | M7-017 | Human + GPT 5.5 | Daemon API, events, persistence, idempotency, restart, privacy, session-create, context-create, M1–M6 regression for association extensions. |
| 6 | M7-023 | Human | Desktop manual smoke: refined Goal + workspace + M5/M6 inputs + task generation + recommendation generation + accept/reject/dismiss/modify + context/session prefill + conflict detection/resolution + reload + daemon restart. |
| 7 | M7-024 | Human + GPT 5.5 + full-suite `pnpm -r typecheck && pnpm -r test` | Definition of Done, final docs, non-goals. |

---
