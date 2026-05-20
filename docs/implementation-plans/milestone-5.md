# Orca — Milestone 5 Implementation Plan

**Source milestone:** `docs/milestones/5.md`
**Builds on:** `docs/implementation-plans/milestone-4.md` (M4 must be complete and green).
**Status:** Ready for AI-assisted execution.
**Scope guard:** Tasks below MUST NOT introduce context assembly, prompt injection, sibling-session startup awareness, context packages or context scoring, recommendations, task/work-unit generation, conflict detection, workflow automation, supervised execution, autonomous launch controls, canonical memory state, automatic decision confirmation, cross-Goal memory, workspace indexing/scanning/file watching, knowledge graphs, embeddings, vector search, semantic search, memory consolidation, ranking/relevance, aging/decay, policy/governance engines, full transcript capture or replay, raw output / extractor prompt / raw extractor response persistence, AI provider SDKs, model selection, provider configuration UI, prompt template libraries, token accounting beyond hard byte/char caps, generic skill invocation endpoints, public extractor invocation endpoints, multi-extractor routing, plugin marketplace loading, background workers / queues / schedulers, new top-level packages, new top-level navigation, global memory dashboards, command-center panels, `POST /v1/memory/:id/promote`, `POST /v1/memory/:id/canonicalize`, `POST /v1/memory/:id/archive`, `POST /v1/decisions/:id/confirm`, `POST /v1/decisions/:id/archive`, `GET /v1/sessions/:sessionId/extractions`, WebSocket commands for memory edits or extraction triggers, or `session.summary.created` events. Any task requiring such code is out of scope for M5.

### Inherited constraints from M1 / M2 / M3 / M4

**DaemonContext seam.** All new M5 use cases MUST be wired through the explicit `DaemonContext`. M5 adds at minimum: `extractor: SessionMemoryExtractor`, `extractionRunner: ExtractionRunner`, and `memoryClock` (or reuses `now`). Production wiring stays in `apps/daemon/src/index.ts`; tests construct an explicit context per case. No DI framework, no container, no decorators.

**Registry immutability (M2).** Adapter and skill registries register descriptors before the HTTP listener accepts connections. M5 must not add hot-registration paths.

**Native-import isolation (M4).** Only `apps/daemon/src/pty/manager.ts` may `import` `node-pty`. M5 must not touch this isolation.

**Existing M1/M2/M3/M4 wire shapes are frozen.** Existing endpoint responses, event names, event payloads, and WebSocket frames must remain byte-identical. M5 only adds new endpoints, new event types, and new optional fields on existing reads (`latestExtraction`, `latestSummaryHeadline`, etc.). Nothing existing is repurposed.

**Atomicity rule (carried forward).** Every M5 daemon write that emits domain events MUST insert events and projection rows inside the same SQLite transaction and broadcast on the event bus **only after** `COMMIT` returns.

**Output isolation rule (M4, extended).** Terminal output is persisted only in `session_output_chunks`. M5 must not copy raw output into memory rows, decision rows, summary rows, event payloads, logs, prompts, or any other persisted location. The M4 capped output tail is read-only input to extraction.

**Content-free events (new).** M5 domain events carry ids, counts, status, type, and source pointers. They MUST NOT carry memory content, decision text, summary body, candidate text, prompts, raw extractor output, or model reasoning.

**Goal-scoped boundary (new).** Every M5 row has `goal_id`; every M5 read is Goal-scoped; no global-memory endpoint exists.

This document decomposes Milestone 5 (Shared Memory) into bounded executable tasks. Each task is sized for a single AI session, has explicit acceptance criteria, and is reviewable in isolation.

The single proof point for M5 is:

```text
User opens a Goal with completed or stopped sessions
  -> daemon detects eligible sessions without scanning the workspace
  -> daemon reads Goal/refinement/session metadata and capped M4 output tail
  -> daemon runs one daemon-local extraction job
  -> extractor returns summary, memory candidates, and decision candidates
  -> daemon validates output with zod and normalizes/redacts candidate text
  -> daemon commits summary, memory, decisions, extraction state, and events in one SQLite transaction
  -> daemon broadcasts committed events only after commit
  -> Goal detail UI refetches memory, decisions, sessions, and summaries
  -> user can review, edit, promote/archive memory, and confirm/archive decisions
  -> all committed rows survive daemon restart
```

---

## Conventions

- **Task ID:** `M5-NNN` (zero-padded, sequenced for default execution order).
- **Affected Areas:** paths relative to repo root.
- **Validation Steps:** every task lists at least one deterministic command or scenario.
- **No task may exceed its declared scope** even if adjacent work seems easy — additive scope belongs in a follow-up task.
- **Full-suite gates:** `pnpm -r typecheck` and `pnpm -r test` run at **M5-012** (daemon proof-loop integration) and **M5-017** (final). Targeted tests run inside every other task.
- **Atomicity rule:** every extraction commit (success or failure) inserts the summary row (if any), memory rows, decision rows, `memory_extractions` update, and all associated domain events in **one** SQLite transaction. Broadcast occurs **only after** `COMMIT`.
- **Content-free events rule:** event payloads contain ids, type, status, counts, and source pointers — never memory content, decision text, summary text, raw output, prompts, or model responses.
- **Idempotency rule:** `source_fingerprint = sha256(session_id + ':' + source_offset_first + ':' + source_offset_last + ':' + extractor_version)`. The partial unique index on `(session_id, source_fingerprint) WHERE status IN ('pending','running','succeeded')` prevents duplicate active extractions. Memory dedupe uses partial unique `(goal_id, type, content_hash) WHERE status != 'archived'`.
- **Privacy rule:** never log candidate content, output lines, prompts, or raw extractor responses. Apply best-effort secret redaction (`password=`, `token=`, `api_key=`, `authorization: bearer`) before persisting any candidate text.

---

## Tasks

---

### M5-000 — Baseline Verification

**Purpose.** Lock in a known-good M1/M2/M3/M4 baseline before any M5 change lands. Establishes the regression anchor so every later M5 failure is unambiguously attributable to M5 work, and so M5-012 / M5-017 can compare against a recorded green state.

**Scope.**
- IS: install, typecheck, run tests, record commit SHA and test summary, verify named regression anchors exist.
- IS NOT: any code change, dependency upgrade, new test, doc edit, or migration.

**Requirements.**
- From a clean working tree, run:
  - `pnpm install --frozen-lockfile`
  - `pnpm -r typecheck`
  - `pnpm -r test`
- Confirm the following named tests appear in the test summary as PASS:
  - `apps/daemon/test/m1-017.integration.test.ts`
  - `apps/daemon/src/m2-loop.test.ts`
  - `apps/daemon/test/m3-create-goal-with-workspaces.integration.test.ts`
  - The M4 session lifecycle integration test (final M4-016 anchor).
- Record in implementation notes / PR description:
  - `git rev-parse HEAD`
  - Final test summary line counts.
  - The pre-existing dirty paths from `git status` (if any) so they are not attributed to M5.

**Affected Areas.** None — verification only.

**Dependencies.** M4 complete and green.

**Acceptance Criteria.**
- All listed commands exit `0`.
- All named regression anchors PASS.
- Baseline SHA and summary recorded.

**Validation Steps.**
- `pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm -r test`.
- Inspect summary for named tests.

**Risks / Notes.**
- Do not "fix" pre-existing dirty files; just record them.
- If baseline fails, stop and resolve before proceeding — M5 must not absorb pre-existing breakage.

---

### M5-001 — Contracts for M5 Memory, Decisions, Summaries, Extractions, Extractor I/O, and Events

**Purpose.** Establish the wire and runtime contract surface for M5 in `packages/contracts` so daemon and desktop code can import strongly-typed schemas before either side begins implementation. Contracts are the freeze-point that downstream tasks build against.

**Scope.**
- IS: zod schemas + TypeScript types for memory items, decisions, session summaries, extraction rows, extractor input/output, and M5 event literals; contract unit tests.
- IS NOT: daemon use cases, migrations, projection helpers, HTTP routes, runner, extractor implementation, desktop wrappers, UI.

**Requirements.**
- Extend `packages/contracts/src/index.ts` with:
  - Enums:
    - `GoalMemoryStatus = 'candidate' | 'promoted' | 'archived'`
    - `GoalMemoryType = 'constraint' | 'success_criterion' | 'assumption' | 'blocker' | 'open_question' | 'validation_result' | 'architecture_note' | 'note'`
    - `GoalDecisionStatus = 'proposed' | 'confirmed' | 'archived'`
    - `MemoryExtractionStatus = 'pending' | 'running' | 'succeeded' | 'failed'`
    - `MemoryExtractionTrigger = 'terminal_state' | 'goal_open' | 'manual'`
    - `MemoryExtractionFailureCode = 'invalid_output' | 'timeout' | 'session_not_terminal' | 'output_unavailable' | 'source_truncated' | 'goal_archived' | 'session_archived' | 'daemon_restart' | 'internal_error'`
    - `MemorySourceType = 'refinement' | 'session' | 'manual'`
    - `DecisionSourceType = 'session' | 'manual'`
  - Row shapes:
    - `GoalMemoryItem` — `id`, `goalId`, `type`, `status`, `content` (≤ 4000 chars), `contentHash`, `confidence` (0..1, nullable), `sourceType`, `sourceId` (nullable), `sourceSessionId` (nullable), `sourceExtractionId` (nullable), `sourceOffsetFirst` (nullable), `sourceOffsetLast` (nullable), `createdAt`, `updatedAt`, `promotedAt` (nullable), `archivedAt` (nullable).
    - `GoalDecision` — `id`, `goalId`, `title` (≤ 200 chars), `decisionText` (≤ 4000 chars), `rationale` (≤ 4000 chars, nullable), `status`, `confirmationRequired` (boolean), `confidence` (0..1, nullable), `sourceType`, `sourceId` (nullable), `sourceSessionId` (nullable), `sourceExtractionId` (nullable), `sourceOffsetFirst` (nullable), `sourceOffsetLast` (nullable), `createdAt`, `updatedAt`, `confirmedAt` (nullable), `archivedAt` (nullable).
    - `SessionMemorySummary` — `id`, `sessionId`, `goalId`, `extractionId`, `headline` (≤ 200 chars), `summaryText` (≤ 4000 chars), `truncated` (boolean), `sourceOffsetFirst`, `sourceOffsetLast`, `createdAt`.
    - `MemoryExtraction` — `id`, `goalId`, `sessionId`, `trigger`, `status`, `extractorVersion`, `sourceFingerprint`, `sourceOffsetFirst` (nullable), `sourceOffsetLast` (nullable), `summaryId` (nullable), `itemCount`, `decisionCount`, `promotedCount`, `failureCode` (nullable), `failureMessage` (≤ 500 chars, nullable), `requestedAt`, `startedAt` (nullable), `finishedAt` (nullable).
  - Request schemas:
    - `CreateGoalMemoryRequest` — `type`, `content`, optional `status` (`candidate` default, `promoted` allowed), optional `confidence`.
    - `PatchGoalMemoryRequest` — optional `type`, optional `content`, optional `status`.
    - `CreateGoalDecisionRequest` — `title`, `decisionText`, optional `rationale`, optional `status` (`proposed` default, `confirmed` allowed), optional `confidence`, optional `confirmationRequired`.
    - `PatchGoalDecisionRequest` — optional `title`, optional `decisionText`, optional `rationale`, optional `status`.
  - Extractor I/O (internal but shared with tests):
    - `SessionExtractionInput` — `goal` (id, title, status, archived flag), `refinement` (id, problem statement, constraints[], successCriteria[], stakeholders[] — optional fields), `workspaces[]` (id, label, root path metadata only — no file contents), `session` (id, adapterId, role, instructions, exitCode, terminalReason, startedAt, terminatedAt), `outputTail` (`text`, `byteOffsetFirst`, `byteOffsetLast`, `truncated`), `extractorVersion`.
    - `SessionExtractionOutput` — `summary?: { headline, text, truncated }`, `memoryCandidates: MemoryCandidate[]` (max **25**), `decisionCandidates: DecisionCandidate[]` (max **10**).
    - `MemoryCandidate` — `type`, `content` (≤ 4000 chars), optional `confidence`, optional `confirmationRequired`, optional `sourceOffsetFirst`, optional `sourceOffsetLast`, optional `promoteEligible` (boolean default false).
    - `DecisionCandidate` — `title`, `decisionText`, optional `rationale`, optional `confidence`, optional `confirmationRequired` (default true for extracted decisions), optional `sourceOffsetFirst`, optional `sourceOffsetLast`.
  - List response wrappers (e.g., `ListGoalMemoryResponse = { items: GoalMemoryItem[] }`).
  - M5 event literal type union and per-event payload schemas:
    - `memory.extraction.requested` — `{ extractionId, goalId, sessionId, trigger }`.
    - `memory.extraction.started` — `{ extractionId, goalId, sessionId }`.
    - `memory.extraction.completed` — `{ extractionId, goalId, sessionId, summaryId: string|null, itemCount, decisionCount, promotedCount, truncated }`.
    - `memory.extraction.failed` — `{ extractionId, goalId, sessionId, failureCode }`.
    - `memory.item.created` — `{ memoryItemId, goalId, type, status, sourceType, sourceSessionId: string|null, sourceExtractionId: string|null }`.
    - `memory.item.updated` — `{ memoryItemId, goalId, type, status }`.
    - `memory.item.promoted` — `{ memoryItemId, goalId, type }`.
    - `memory.item.archived` — `{ memoryItemId, goalId }`.
    - `decision.created` — `{ decisionId, goalId, status, confirmationRequired, sourceType, sourceSessionId: string|null, sourceExtractionId: string|null }`.
    - `decision.updated` — `{ decisionId, goalId, status }`.
    - `decision.confirmed` — `{ decisionId, goalId }`.
    - `decision.archived` — `{ decisionId, goalId }`.
- All M5 event payload schemas MUST reject `content`, `decisionText`, `summaryText`, `rationale`, `outputTail`, `prompt`, `response`, and similar large/sensitive fields (use `.strict()` on zod objects).
- Add `latestExtraction?: { id, status, requestedAt, finishedAt, failureCode, truncated }` and `latestSummaryHeadline?: string|null` as optional fields on the existing session read response schema (back-compat: do not require them on inputs; do not change existing event payloads).
- Add `contracts.test.ts` cases covering:
  - Valid payload acceptance (one per row shape and one per event).
  - Rejection of oversized fields (`content` > 4000, `headline` > 200, etc.).
  - Rejection of unknown / forbidden fields on event payloads (e.g., `content` on `memory.item.created`).
  - Rejection of invalid status enums and invalid status transitions in request schemas where applicable.

**Affected Areas.**
- `packages/contracts/src/index.ts`
- `packages/contracts/src/index.test.ts`

**Dependencies.** M5-000.

**Acceptance Criteria.**
- Contracts compile with `pnpm -r typecheck`.
- Contract tests pass via `pnpm --filter @orca/contracts test`.
- Event payload schemas reject content/text fields (verified by test).
- Existing M1/M2/M3/M4 contract assertions still pass.

**Validation Steps.**
- `pnpm --filter @orca/contracts test`
- `pnpm --filter @orca/contracts typecheck`
- Grep daemon/desktop sources to confirm no compile breakage from new optional fields.

**Risks / Notes.**
- Avoid adding fields you do not need yet (rank, embedding ids, canonical, policy, tags) — out of scope.
- Use `.strict()` for event-payload schemas so accidental content leakage fails contract tests.
- Keep the extractor I/O schemas exported but mark them as internal in code comments — they MUST NOT be wired to any public HTTP route.

---

### M5-002 — SQLite Migration `0005_memory.sql`

**Purpose.** Create the four M5 tables and minimal indexes so projections, the extraction runner, and the API have durable storage. Migration must land before any daemon code references the new tables.

**Scope.**
- IS: a new migration file `0005_memory.sql`, migration-list registration, migration smoke + foreign-key + unique-index tests.
- IS NOT: projections, use cases, HTTP routes, extractor logic, desktop changes.

**Requirements.**
- Create `apps/daemon/migrations/0005_memory.sql` containing exactly:
  - `goal_memory_items` table with columns matching the M5 spec; `goal_id` REFERENCES `goals(id)` ON DELETE CASCADE; `source_session_id` REFERENCES `sessions(id)` ON DELETE SET NULL; `source_extraction_id` REFERENCES `memory_extractions(id)` ON DELETE SET NULL; CHECK constraints on `status` and `type` enumerations; `content_hash` NOT NULL.
  - `goal_decisions` table with columns matching the M5 spec; FK and CHECK constraints analogous to memory; `status` ∈ `('proposed','confirmed','archived')`; `confirmation_required` INTEGER (0/1) NOT NULL default 1 for extracted, but the migration default value is `0` (use cases set it explicitly).
  - `session_summaries` table; `session_id` REFERENCES `sessions(id)` ON DELETE CASCADE; `goal_id` REFERENCES `goals(id)` ON DELETE CASCADE; `extraction_id` REFERENCES `memory_extractions(id)` ON DELETE CASCADE; `truncated` INTEGER (0/1).
  - `memory_extractions` table with the spec fields and CHECK constraints on `status`, `trigger`, and `failure_code`.
- Required indexes:
  - `CREATE INDEX idx_memory_goal_status_created ON goal_memory_items(goal_id, status, created_at DESC);`
  - `CREATE INDEX idx_memory_goal_type ON goal_memory_items(goal_id, type);`
  - `CREATE UNIQUE INDEX idx_memory_dedupe ON goal_memory_items(goal_id, type, content_hash) WHERE status != 'archived';`
  - `CREATE INDEX idx_decision_goal_status_created ON goal_decisions(goal_id, status, created_at DESC);`
  - `CREATE INDEX idx_summary_session_created ON session_summaries(session_id, created_at DESC);`
  - `CREATE INDEX idx_summary_goal_created ON session_summaries(goal_id, created_at DESC);`
  - `CREATE INDEX idx_extraction_session_requested ON memory_extractions(session_id, requested_at DESC);`
  - `CREATE INDEX idx_extraction_goal_status ON memory_extractions(goal_id, status);`
  - `CREATE INDEX idx_extraction_runner_pickup ON memory_extractions(status, requested_at);`
  - `CREATE UNIQUE INDEX idx_extraction_active_fingerprint ON memory_extractions(session_id, source_fingerprint) WHERE status IN ('pending','running','succeeded');`
- Register the migration in `apps/daemon/src/migrations.ts` migration list at the next slot.
- Update `migrations.test.ts` to:
  - Apply migrations against a fresh in-memory DB and assert all four tables and listed indexes exist (`PRAGMA index_list`).
  - Verify foreign-key enforcement (PRAGMA `foreign_keys = ON`) on a deliberate FK violation.
  - Verify the partial unique active-fingerprint index by inserting two rows with same fingerprint but different statuses (`pending` and `failed`) — allowed; then a second `pending` — rejected.
  - Verify memory dedupe index by inserting two non-archived rows with same `(goal_id, type, content_hash)` — rejected; archiving the first then re-inserting — allowed.

**Affected Areas.**
- `apps/daemon/migrations/0005_memory.sql` (new)
- `apps/daemon/src/migrations.ts`
- `apps/daemon/src/migrations.test.ts`

**Dependencies.** M5-001 (contracts define enum values; migration CHECK lists must match).

**Acceptance Criteria.**
- Fresh DB migrates cleanly; all four tables and indexes exist.
- Foreign keys, status CHECKs, dedupe index, and active-fingerprint index all enforced as specified.
- `pnpm --filter @orca/daemon test migrations` passes.

**Validation Steps.**
- `pnpm --filter @orca/daemon test migrations.test`
- `sqlite3 :memory: < /tmp/full-schema-dump.sql` (or equivalent in-test assertion) — confirm `idx_extraction_active_fingerprint` and `idx_memory_dedupe` show up in `PRAGMA index_list`.

**Risks / Notes.**
- Partial unique indexes require SQLite ≥ 3.8.0 — already in use by M4.
- Do NOT add tables for prompts, context packages, recommendations, tasks, embeddings, workflows.
- Migration numbering: the prior installed migration set is `0001`, `0002`, `0004` — keep `0005_memory.sql`; do not retro-add a `0003`.

---

### M5-003 — Goal-Scoped Read/Write Projections for Memory, Decisions, Summaries, and Extractions

**Purpose.** Provide deterministic, Goal-scoped persistence helpers for the four M5 tables. Projections are the only daemon-side layer that touches these tables; use cases, runner, and HTTP layer call them.

**Scope.**
- IS: `projection.ts` modules under `apps/daemon/src/memory/`, `apps/daemon/src/decisions/`, and `apps/daemon/src/extractions/`; serialization to/from contract row shapes; restart-survival unit tests.
- IS NOT: extractor logic, runner, HTTP routes, status-transition rules (those live in use cases), desktop changes.

**Requirements.**
- Create `apps/daemon/src/memory/projection.ts`:
  - `listMemoryByGoal(db, goalId, { includeArchived })` ordered by `(status, created_at DESC)`.
  - `getMemoryById(db, id)`.
  - `insertMemoryItem(db, row)` — assumes `content_hash` is precomputed; throws a typed `MemoryDuplicateError` on dedupe-index violation.
  - `updateMemoryItem(db, id, patch)` — sets `updated_at`, `promoted_at`, `archived_at` from explicit caller arguments only.
  - All reads and writes accept an explicit `Database` handle (so callers can pass a transaction).
- Create `apps/daemon/src/decisions/projection.ts` analogously: `listDecisionsByGoal`, `getDecisionById`, `insertDecision`, `updateDecision`.
- Create `apps/daemon/src/extractions/projection.ts`:
  - `insertExtraction(db, row)` returning the row id.
  - `updateExtractionStatus(db, id, patch)` — single function for `started`, `succeeded`, `failed` updates; sets `started_at` / `finished_at` / `failure_code` / `failure_message` per patch.
  - `getExtractionById`, `getLatestExtractionForSession(db, sessionId)`.
  - `listEligibleSessionsForGoal(db, goalId)` — returns terminal sessions for the Goal that have **no** row in `memory_extractions` with `status IN ('pending','running','succeeded')` for the current fingerprint. (The fingerprint computation lives in M5-005; for now this helper returns sessions and lets the caller decide eligibility — but it MUST filter by `goal_id` and `sessions.status IN ('exited','failed','stopped')`.)
  - `listActiveAndRunningExtractions(db)` — for boot reconciliation.
  - `insertSummary(db, row)`, `getLatestSummaryForSession(db, sessionId)`.
- Add unit tests for each projection module:
  - Insert + read.
  - Reopen the SQLite file (file-backed `better-sqlite3` test DB) and verify rows survive restart.
  - Dedupe-index violation produces a typed error, not a raw SQLite throw.
  - `listMemoryByGoal` orders `promoted` rows first, then `candidate`, then `archived` only when `includeArchived` is true.
  - `getLatestExtractionForSession` returns null when none exists.
  - `listEligibleSessionsForGoal` ignores non-terminal sessions and sessions that already have a `succeeded` extraction.

**Affected Areas.**
- `apps/daemon/src/memory/projection.ts` (new) + `.test.ts`
- `apps/daemon/src/decisions/projection.ts` (new) + `.test.ts`
- `apps/daemon/src/extractions/projection.ts` (new) + `.test.ts`
- `apps/daemon/src/sessions/projection.ts` — extend the existing session read to surface `latestExtractionId`, `latestExtractionStatus`, `latestSummaryHeadline` via JOIN/subquery (read-only addition).

**Dependencies.** M5-001 (row shapes), M5-002 (tables exist).

**Acceptance Criteria.**
- Projection helpers compile; targeted tests pass.
- Restart-survival test reopens a file-backed DB and reads back rows.
- Existing session projection tests still pass; new optional fields are populated when extractions exist and null when they do not.

**Validation Steps.**
- `pnpm --filter @orca/daemon test memory/projection`
- `pnpm --filter @orca/daemon test decisions/projection`
- `pnpm --filter @orca/daemon test extractions/projection`
- `pnpm --filter @orca/daemon test sessions/projection`

**Risks / Notes.**
- Projections must accept an explicit DB handle to allow transactional composition in M5-006.
- Do not add ranking, relevance, embedding, or canonical fields.
- Do not write `content_hash` from inside the projection — callers compute it (normalization happens in M5-006 / M5-008).

---

### M5-004 — Minimal Manual Memory and Decision APIs

**Purpose.** Ship the user-facing manual create/edit/promote/archive (memory) and create/edit/confirm/archive (decisions) loop before any extractor writes the same rows, so the Goal-detail UI can be exercised without extraction.

**Scope.**
- IS: HTTP routes, use cases for manual transitions, content-hash computation for manual memory, transactional event emission, route tests.
- IS NOT: extractor, runner, summary endpoints, refinement seed memory, desktop UI.

**Requirements.**
- Create `apps/daemon/src/memory/usecases.ts`:
  - `createMemoryItem(ctx, { goalId, type, content, status, confidence })` — validates Goal exists and is not archived; trims/collapses whitespace; redacts known secret patterns; caps content; computes `content_hash`; rejects duplicate live row (typed `409 duplicate`); inserts row + `memory.item.created` event in one tx; broadcasts after commit.
  - `patchMemoryItem(ctx, id, patch)` — loads current row; validates status transitions: `candidate → promoted`, `candidate|promoted → archived`; rejects other transitions with `409 invalid_status_transition`; if content/type changes, recompute `content_hash` and re-check dedupe; emits `memory.item.updated` plus `memory.item.promoted` or `memory.item.archived` as appropriate, all in one tx.
- Create `apps/daemon/src/decisions/usecases.ts`:
  - `createDecision(ctx, { goalId, title, decisionText, rationale, status, confidence, confirmationRequired })` — validates Goal; trims/caps; inserts row + `decision.created` event in one tx.
  - `patchDecision(ctx, id, patch)` — `proposed → confirmed`, `proposed|confirmed → archived`; emits `decision.updated` plus `decision.confirmed` / `decision.archived`.
- Register routes in `apps/daemon/src/server.ts`:
  - `GET /v1/goals/:goalId/memory` → `listMemoryByGoal` (always excludes archived unless `?includeArchived=1`).
  - `POST /v1/goals/:goalId/memory` → `createMemoryItem`.
  - `PATCH /v1/memory/:id` → `patchMemoryItem`.
  - `GET /v1/goals/:goalId/decisions` → `listDecisionsByGoal`.
  - `POST /v1/goals/:goalId/decisions` → `createDecision`.
  - `PATCH /v1/decisions/:id` → `patchDecision`.
- Validate request bodies with contract zod schemas. Reject unknown fields with `400`.
- Route tests:
  - Create memory item → 201 → list reflects it → patch to `promoted` → list reflects status change → patch to `archived` → list excludes it.
  - Invalid transition (`archived → promoted`) returns 409.
  - Duplicate `(goal_id, type, content_hash)` returns 409.
  - Decision lifecycle parallel coverage.
  - Body validation rejects unknown fields and oversized strings.
  - Events asserted on the bus in committed order; broadcast not observed before tx commit (use a test bus that records timestamps).

**Affected Areas.**
- `apps/daemon/src/memory/usecases.ts` + `.test.ts`
- `apps/daemon/src/decisions/usecases.ts` + `.test.ts`
- `apps/daemon/src/server.ts` + `server.test.ts`
- `apps/daemon/src/events.ts` — add new event-type literals if a central registry exists.

**Dependencies.** M5-001, M5-002, M5-003.

**Acceptance Criteria.**
- All routes return contract-conformant responses.
- Status-transition rules enforced as specified.
- Events broadcast only after commit; a deliberately failing insert leaves no event on the bus and no row in DB.
- Duplicate-prevention path returns 409 without partially writing.

**Validation Steps.**
- `pnpm --filter @orca/daemon test memory`
- `pnpm --filter @orca/daemon test decisions`
- `pnpm --filter @orca/daemon test server`

**Risks / Notes.**
- Do not add `POST /v1/memory/:id/promote`, `POST /v1/memory/:id/canonicalize`, `POST /v1/memory/:id/archive`, or action endpoints for decisions — `PATCH` carries status.
- Do not introduce a WebSocket command path.
- Manual memory `sourceType = 'manual'`; manual decisions `sourceType = 'manual'`.
- Status default for manual memory: `candidate` unless the body sets `promoted`.

---

### M5-005 — Extraction State Lifecycle and Boot Reconciliation

**Purpose.** Implement the durable state machine for `memory_extractions` — enqueue, transition, idempotency, lookup, and boot reconciliation — before any extractor commits results. Reconciliation must run before the HTTP/WebSocket listener starts.

**Scope.**
- IS: enqueue, transition helpers, fingerprint computation, idempotency for active rows, latest-extraction lookup, boot reconciliation, request event emission.
- IS NOT: extractor I/O, input builder, runner loop, terminal hook, Goal-open detection, HTTP routes (covered later).

**Requirements.**
- Create `apps/daemon/src/extractions/fingerprint.ts`:
  - `computeSourceFingerprint({ sessionId, sourceOffsetFirst, sourceOffsetLast, extractorVersion })` — `sha256` of canonical `sessionId + ':' + sourceOffsetFirst + ':' + sourceOffsetLast + ':' + extractorVersion`.
- Create `apps/daemon/src/extractions/usecases.ts`:
  - `enqueueExtraction(ctx, { goalId, sessionId, trigger, sourceOffsetFirst, sourceOffsetLast, extractorVersion })`:
    - Validates session exists, is terminal, and is not archived; returns typed error otherwise.
    - Computes fingerprint.
    - If an active row (`pending` | `running` | `succeeded`) with this fingerprint exists, returns it without inserting (idempotent no-op; **no** new `memory.extraction.requested` event).
    - Otherwise inserts a `pending` row and emits `memory.extraction.requested` in one tx.
  - `markExtractionStarted(ctx, id)` — transitions `pending → running`, sets `started_at`, emits `memory.extraction.started` in one tx.
  - `markExtractionFailed(ctx, id, { failureCode, failureMessage })` — transitions `pending|running → failed`, sets `finished_at`, emits `memory.extraction.failed` in one tx. Failure rows are terminal.
  - `getLatestExtractionForSession` re-exported from projection for callers.
- Create `apps/daemon/src/extractions/reconciliation.ts`:
  - `reconcileStaleExtractions(ctx)` — selects rows with `status IN ('pending','running')`; for each, transitions to `failed` with `failure_code = 'daemon_restart'`; emits `memory.extraction.failed` for each in one tx per row (or one tx covering all — pick all-in-one and document).
  - Function must be **idempotent** and **safe to call again** if interrupted.
- Wire `reconcileStaleExtractions` into the daemon bootstrap **before** `server.listen()` in `apps/daemon/src/index.ts` (or wherever the M4 reconciliation is wired).
- Tests:
  - `enqueueExtraction` happy path inserts row + event in one tx.
  - Double `enqueueExtraction` with same fingerprint returns same id and emits only one `requested` event.
  - `enqueueExtraction` against a non-terminal session returns typed error.
  - State transitions reject invalid transitions (`failed → started`, `succeeded → failed`, etc.).
  - Boot reconciliation flips two seeded `pending` and one `running` row to `failed/daemon_restart`, emits the right events, and is safe to re-run.
  - Restart simulation: seed `pending` rows, call `reconcileStaleExtractions`, then verify no `pending`/`running` rows remain.

**Affected Areas.**
- `apps/daemon/src/extractions/fingerprint.ts` (new) + `.test.ts`
- `apps/daemon/src/extractions/usecases.ts` (new) + `.test.ts`
- `apps/daemon/src/extractions/reconciliation.ts` (new) + `.test.ts`
- `apps/daemon/src/index.ts` — boot wiring.

**Dependencies.** M5-001, M5-002, M5-003.

**Acceptance Criteria.**
- Idempotent enqueue verified by test.
- Boot reconciliation flips `pending`/`running` to `failed/daemon_restart` before listen.
- Transition rules enforced.
- Events committed in same tx as projection updates.

**Validation Steps.**
- `pnpm --filter @orca/daemon test extractions/usecases`
- `pnpm --filter @orca/daemon test extractions/reconciliation`
- `pnpm --filter @orca/daemon test extractions/fingerprint`

**Risks / Notes.**
- Reconciliation MUST run before listener bind. Confirm boot order with a tiny ordering test (set `process.env.M5_BOOT_TRACE` or use spy on `listen`).
- `succeeded` rows are also part of the active uniqueness predicate, so retries must NOT re-enqueue when a `succeeded` row exists for the same fingerprint — manual retry of a successful extraction returns the same row.
- A `failed` row drops out of the partial unique index, so retry creates a new `pending` row — exactly what we want.

---

### M5-006 — Fake Extractor Commit Slice (Atomic Success / Failure Commit)

**Purpose.** Implement the **transactional commit boundary** for an extraction result (or failure) using a fake extractor injected in tests. This proves the atomicity guarantee — summary + memory + decisions + extraction state + all events in one SQLite transaction — before the real deterministic extractor is built.

**Scope.**
- IS: `commitExtractionResult`, `commitExtractionFailure`, content hashing + normalization + redaction utility, summary insertion, candidate insertion with dedupe, auto-promotion rule wiring (interface only — the rules themselves remain trivial placeholders here), event emission for memory and decision creates and promotions, integration test using a `FakeExtractor`.
- IS NOT: real deterministic extractor, input builder, runner loop, terminal hook, Goal-open detection, refinement seed memory.

**Requirements.**
- Create `apps/daemon/src/memory/normalize.ts`:
  - `normalizeText(s)` — trim, collapse internal whitespace, drop trailing whitespace; cap to configured max chars.
  - `redactSecrets(s)` — replace obvious patterns (`password=...`, `token=...`, `api_key=...`, `authorization: bearer ...`) with `[redacted]`; case-insensitive; non-greedy.
  - `computeContentHash({ type, content })` — `sha256` of `type + '' + normalizedContent`.
- Create `apps/daemon/src/memory/promotion-rules.ts`:
  - `shouldAutoPromote(candidate, extractionContext)` — returns `true` only for:
    - `sourceType='refinement'` AND `type='constraint' | 'success_criterion'`.
    - `sourceType='session'` AND `type='blocker'` AND `candidate.confidence ≥ 0.9` AND `extractionContext.derivedFromExitCode === true`.
    - `sourceType='session'` AND `type='validation_result'` AND `candidate.confidence ≥ 0.9` AND `extractionContext.derivedFromCleanCompletion === true`.
  - Otherwise `false`. This module is **pure** and unit-tested.
- Create `apps/daemon/src/extractions/commit.ts`:
  - `commitExtractionResult(ctx, extractionId, output, sourceMeta)`:
    1. Open one SQLite transaction.
    2. Re-load extraction; if not in `running`, abort with internal error.
    3. If `output.summary` present, insert `session_summaries` row referencing the extraction.
    4. For each memory candidate: normalize + redact content; compute `content_hash`; check dedupe (`(goal_id, type, content_hash)` non-archived); skip duplicates silently (count them in returned stats); otherwise insert with `status` computed via `shouldAutoPromote`; emit `memory.item.created` (+ `memory.item.promoted` if promoted).
    5. For each decision candidate: normalize + redact title/decisionText/rationale; insert with `status='proposed'` and `confirmation_required` per candidate (default `true` for extracted); emit `decision.created`.
    6. Update `memory_extractions` row: status → `succeeded`, set `summary_id`, `item_count`, `decision_count`, `promoted_count`, `source_offset_first`, `source_offset_last`, `finished_at`.
    7. Emit `memory.extraction.completed` with **counts only** (no content).
    8. Commit. Broadcast all events to the bus **after** commit returns.
  - `commitExtractionFailure(ctx, extractionId, { failureCode, failureMessage })` is a single-tx wrapper around `markExtractionFailed`.
- Create a `FakeExtractor` test helper at `apps/daemon/src/extractions/fake-extractor.ts` (test-only export):
  - Reads from an in-memory script (`output | error`) keyed by `sessionId`.
- Integration tests in `apps/daemon/src/extractions/commit.test.ts`:
  - Successful commit inserts summary + N memory + M decisions + extraction update + emits the expected event sequence in committed order.
  - A deliberate insert failure mid-tx (e.g., violate dedupe by pre-seeding a row) rolls back **everything** — no summary, no memory, no decision, no events on the bus.
  - Bus broadcast spy records all events **after** `COMMIT` returns (use a test bus that timestamps publish-after-commit).
  - Duplicate candidates (same `content_hash` as an existing live row) are skipped, but extraction is still `succeeded` and the duplicate count is reflected in `item_count` minus inserted.
  - `commitExtractionFailure` emits only `memory.extraction.failed` and does not write memory/decision/summary rows.
  - Auto-promotion rule fires for a fake "refinement constraint" candidate and does NOT fire for a generic "note" candidate.

**Affected Areas.**
- `apps/daemon/src/memory/normalize.ts` (new) + `.test.ts`
- `apps/daemon/src/memory/promotion-rules.ts` (new) + `.test.ts`
- `apps/daemon/src/extractions/commit.ts` (new) + `.test.ts`
- `apps/daemon/src/extractions/fake-extractor.ts` (new, test-only)

**Dependencies.** M5-001, M5-002, M5-003, M5-005.

**Acceptance Criteria.**
- Atomic commit verified: forced rollback leaves zero rows and zero broadcast events.
- Broadcast occurs only after commit, asserted by a spying event bus.
- `memory.extraction.completed` payload contains counts only, asserted by contract schema.
- Duplicate candidates do not duplicate live memory rows.
- Promotion rule unit tests cover positive and negative cases.

**Validation Steps.**
- `pnpm --filter @orca/daemon test memory/normalize`
- `pnpm --filter @orca/daemon test memory/promotion-rules`
- `pnpm --filter @orca/daemon test extractions/commit`

**Risks / Notes.**
- `normalize.ts` and `redactSecrets` MUST be applied **before** `content_hash` is computed, otherwise dedupe is unstable across runs.
- Never log candidate content, even on failure. Failure messages must not echo candidate text.
- Promotion is silently a status decision at insert time, not a separate write — keeps the loop atomic.

---

### M5-007 — Bounded Extractor Input Builder

**Purpose.** Build the `SessionExtractionInput` deterministically from the Goal row, latest refinement, attached workspaces (metadata only), session metadata, and the M4 capped output tail. This is the data contract between the rest of the daemon and the extractor.

**Scope.**
- IS: a single pure-ish builder function with explicit DB reads, byte-window selection, ANSI/control stripping, truncation flag computation.
- IS NOT: extractor logic, extraction commit, runner, terminal hook, refinement seed memory.

**Requirements.**
- Create `apps/daemon/src/extractions/input.ts`:
  - `buildSessionExtractionInput(ctx, { sessionId, extractorVersion }) => Promise<SessionExtractionInput>`:
    - Read session row + Goal row + latest refinement + attached workspaces.
    - Read at most `memoryExtractionMaxInputBytes` (default `131072` = 128 KiB; configurable via `ctx.config.memoryExtractionMaxInputBytes`) from the M4 output tail.
    - Always read the **most recent** bytes when the tail exceeds the cap. Track and return `byteOffsetFirst`, `byteOffsetLast`.
    - Decode bytes as UTF-8 with replacement (`utf8` `replacement: true`).
    - Strip ANSI/CSI/OSC escape sequences and most C0 control characters except `\n`, `\t`, and printable ASCII.
    - If the M4 output tail itself reports a truncation marker, OR the byte window was capped, set `outputTail.truncated = true`.
    - If no output is available for the session (M4 tail unavailable / pruned), throw a typed `OutputUnavailableError`.
    - Workspaces include `id`, `label`, `rootPath` metadata — never read files or scan directories.
- Tests in `apps/daemon/src/extractions/input.test.ts`:
  - Empty output yields an empty `outputTail.text` and `truncated=false`.
  - Output exceeding 128 KiB returns only the **last** 128 KiB; offsets reflect that window; `truncated=true`.
  - ANSI sequences (`\x1b[31m`, `\x1b]0;title\x07`, mouse seqs) are stripped.
  - `\x00`-laden or invalid-UTF-8 bytes do not throw; they are replaced.
  - Unavailable output (mocked) throws `OutputUnavailableError`.
  - Workspaces metadata is included but no FS calls happen (assert via mocking `fs`).

**Affected Areas.**
- `apps/daemon/src/extractions/input.ts` (new) + `.test.ts`
- `apps/daemon/src/config.ts` — add `memoryExtractionMaxInputBytes` config field with default `131072`.

**Dependencies.** M5-001, M5-002, M5-003. Reads M4 output store (interface from `apps/daemon/src/sessions/output-store.ts`).

**Acceptance Criteria.**
- Builder produces a contract-valid `SessionExtractionInput`.
- Cap is enforced; truncation flag set correctly.
- ANSI stripping verified.
- No FS access for workspace contents.

**Validation Steps.**
- `pnpm --filter @orca/daemon test extractions/input`

**Risks / Notes.**
- Do **not** introduce a new transcript or change M4 output-store behavior.
- Make ANSI stripping conservative — strip what is unambiguously control, keep readable text including non-ASCII letters.
- The byte window MUST be aligned to bytes, not characters; record exact byte offsets for source attribution.

---

### M5-008 — Deterministic Extractor Implementation

**Purpose.** Provide the single production `SessionMemoryExtractor` for M5. Conservative, deterministic, fixture-driven. No model SDK, no provider, no prompts.

**Scope.**
- IS: the deterministic extractor implementing the contract, fixture-based unit tests, `extractorVersion` constant.
- IS NOT: runner integration, terminal hook, Goal-open detection, HTTP routes, desktop changes.

**Requirements.**
- Create `apps/daemon/src/extractions/deterministic-extractor.ts`:
  - Export `DETERMINISTIC_EXTRACTOR_VERSION = 'deterministic-1.0.0'`.
  - Implement `SessionMemoryExtractor`:
    - `version` = the constant.
    - `extract(input): Promise<SessionExtractionOutput>` — pure async, no DB, no FS, no network.
  - Extraction rules (all driven by `input.session` metadata + `input.outputTail.text`):
    - **Summary:** headline from session adapter + status + duration; text from last ≤ 10 non-empty, non-control output lines. Truncated flag carries through from input.
    - **Blocker memory:** if `session.exitCode != null && session.exitCode !== 0` → one `blocker` candidate with `confidence = 0.95`, `confirmationRequired = false`, content "Session exited with code N: <terminalReason if present>"; offsets reference the last 1 KiB byte window.
    - **Blocker memory (fatal lines):** for each occurrence of `/(?:^|\W)(ERROR|FATAL):?\s+(.+)$/m` (max 5 distinct lines), produce one `blocker` candidate with `confidence = 0.7`, offsets pointing at the matched bytes.
    - **Open question memory:** for each `/(?:TODO|FIXME)[:\s]+(.+)$/m` and explicit lines ending in `?` (max 5 each, deduped) → `open_question` candidate, `confidence = 0.5`.
    - **Validation result memory:** if `session.exitCode === 0` and last 2 KiB contain at least one match for `/(PASS|OK|SUCCESS|tests? passed)\b/i` → one `validation_result` candidate, `confidence = 0.9`, `confirmationRequired = false`.
    - **Decision candidates:** for each `/^\s*(?:DECISION|DECIDED)[:\s]+(.+)$/m` (max 5) → `DecisionCandidate` with `title = first 80 chars`, `decisionText = full line`, `confirmationRequired = true`, `confidence = 0.6`.
    - **No synthesis:** do not infer from vague prose. False negatives are acceptable; unsupported synthesis is not.
  - Cap candidate counts at the contract limits (25 memory, 10 decisions).
  - Mark `output.summary.truncated = input.outputTail.truncated`.
- Tests in `apps/daemon/src/extractions/deterministic-extractor.test.ts` using YAML/JSON fixtures under `apps/daemon/test/fixtures/extractor/`:
  - `clean-exit.json` — fixture with `exitCode=0` and `tests passed` line → one `validation_result` candidate, no blockers, no decisions.
  - `non-zero-exit.json` → one exit blocker, optional fatal-line blockers.
  - `decision-marker.json` → one decision candidate from `DECISION: Use SQLite WAL`.
  - `vague-prose.json` → no decision candidate.
  - `todo-and-question.json` → open-question candidates from TODO and `?`-terminated line.
  - `truncated-input.json` → summary's `truncated=true`, candidates still produced.
  - `empty-output.json` → summary present (from metadata only), no candidates.
  - Every fixture's output passes `SessionExtractionOutput` zod parse.

**Affected Areas.**
- `apps/daemon/src/extractions/deterministic-extractor.ts` (new) + `.test.ts`
- `apps/daemon/test/fixtures/extractor/*.json` (new)

**Dependencies.** M5-001 (contract output shape), M5-007 (input shape).

**Acceptance Criteria.**
- All fixture tests pass.
- No false-positive decision from vague prose.
- Output is zod-validated by tests against `SessionExtractionOutput`.
- Extractor never throws for malformed `outputTail.text`; it returns what it can.

**Validation Steps.**
- `pnpm --filter @orca/daemon test extractions/deterministic-extractor`

**Risks / Notes.**
- Resist adding clever heuristics — false positives become bad memory.
- Do not call into any network or model SDK.
- `extractorVersion` is part of the fingerprint; bumping it is a behavior change that invalidates dedupe — keep it stable through M5.

---

### M5-009 — Refinement Seed Memory

**Purpose.** Backfill M3 refinement fields (constraints, success criteria, plus optionally objective / stakeholders / assumptions if the refinement schema exposes them) into Goal memory as deterministic seed rows. This gives Goal detail useful memory before any session has run.

**Scope.**
- IS: a seeding use case, a Goal-creation/refinement hook, idempotent reseed-on-Goal-open path, tests.
- IS NOT: session extraction, runner, HTTP routes for seeding (it's an internal call), desktop changes.

**Requirements.**
- Create `apps/daemon/src/memory/refinement-seed.ts`:
  - `seedRefinementMemory(ctx, goalId)`:
    - Loads the latest refinement for the Goal.
    - For each constraint → one `constraint` memory with `sourceType='refinement'`, `sourceId=refinementId`, `status='promoted'`, `confidence=null`.
    - For each success criterion → one `success_criterion` memory, `status='promoted'`.
    - Computes normalized content + hash; uses the existing dedupe path so reruns are no-ops.
    - Emits `memory.item.created` + `memory.item.promoted` per inserted row, in **one** tx per call.
    - Returns `{ insertedCount, skippedCount }`.
- Wire `seedRefinementMemory` into the refinement-commit path (where M3 finalizes a refinement). Wire it again into the Goal-open detection path (M5-010) as a best-effort backfill when seed rows are missing — by virtue of dedupe, repeated calls are safe.
- Tests:
  - Fresh Goal with refined constraints + success criteria → seeded as `promoted` memory.
  - Re-running yields no new rows and no new events (dedupe path returns silently).
  - Missing refinement → no-op without error.
  - Empty constraints/criteria lists → no-op.

**Affected Areas.**
- `apps/daemon/src/memory/refinement-seed.ts` (new) + `.test.ts`
- `apps/daemon/src/goal-refinements.ts` — call seed after commit.

**Dependencies.** M5-001, M5-002, M5-003, M5-004, M5-006 (normalize + dedupe + promotion rules).

**Acceptance Criteria.**
- Constraints and success criteria appear as `promoted` memory after refinement commit.
- Re-running is idempotent (verified by row count).
- No event noise on idempotent runs.

**Validation Steps.**
- `pnpm --filter @orca/daemon test memory/refinement-seed`

**Risks / Notes.**
- Use the same normalization path as M5-006 so content_hashes match across seed and extractor outputs.
- Do not seed `assumption` rows automatically unless the refinement schema explicitly contains them; M5 prefers conservative seeding.
- Do not log refinement content.

---

### M5-010 — Extraction Runner, Terminal-State Hook, and Goal-Open Detection

**Purpose.** Tie the pieces together: a serial in-process runner consumes `pending` extractions, the M4 terminal-state path enqueues them, and Goal-detail reads enqueue eligible historical sessions for that Goal only.

**Scope.**
- IS: `ExtractionRunner` (start/stop, serial pickup), terminal-state hook in session lifecycle path, Goal-open detector, eligibility check + fingerprint computation tie-in.
- IS NOT: HTTP endpoints (`extract-memory` / `summary` come in M5-011), desktop UI.

**Requirements.**
- Create `apps/daemon/src/extractions/runner.ts`:
  - `class ExtractionRunner` with `start()`, `stop()`, and an internal serial loop:
    - On `start`: drains current `pending` rows, then waits on an internal signal.
    - `notify()`: signals the loop to re-check `pending` rows.
    - Per row: `markExtractionStarted` → `buildSessionExtractionInput` → `extractor.extract(input)` → zod-validate the output → `commitExtractionResult` (or `commitExtractionFailure` on validation/throw/timeout).
    - Wrap `extract` in a configurable timeout (`memoryExtractionTimeoutMs`, default `15000`); on timeout commit failure with `failure_code = 'timeout'`.
    - All exceptions caught; never tear down the loop on a single failure. Log at info level WITHOUT candidate content.
  - Singleton per daemon; constructed in `apps/daemon/src/index.ts` after migrations and after reconciliation, and stopped during `shutdown.ts`.
- Hook the terminal-state path in `apps/daemon/src/sessions/usecases.ts` (the lifecycle commit that fires `session.exited` / `session.failed` / `session.stopped`):
  - After the M4 lifecycle tx commits and broadcasts, call `tryEnqueueForTerminalSession(ctx, sessionId)`:
    - Resolves Goal + offsets from latest output-store byte range.
    - Calls `enqueueExtraction` with `trigger='terminal_state'`.
    - Calls `runner.notify()`.
  - This call is **after** the M4 tx commit/broadcast and **must not** mutate M4 streaming behavior.
- Create `apps/daemon/src/extractions/goal-open.ts`:
  - `enqueueEligibleForGoal(ctx, goalId)`:
    - Calls `seedRefinementMemory` (idempotent).
    - Lists Goal's terminal sessions with no active/succeeded extraction for the **current fingerprint**.
    - Enqueues one extraction per eligible session (`trigger='goal_open'`).
    - Calls `runner.notify()`.
  - Wire it into the existing Goal-detail read path so opening a Goal triggers the detector once (non-blocking; failure to enqueue must not fail the read).
- Tests:
  - Terminal-state event triggers exactly one enqueue per session; double events with same fingerprint enqueue once.
  - Goal-open detector enqueues only terminal sessions belonging to the opened Goal; non-terminal sessions and other Goals are untouched.
  - Runner processes pending rows serially and stops cleanly on `stop()`.
  - Runner commits failure with `timeout` when extractor exceeds the configured timeout.
  - Runner commits failure with `invalid_output` when extractor returns schema-invalid data.
  - Restart-then-runner: seed a `pending` row, `reconcileStaleExtractions` flips it to failed, runner does not pick it up (no infinite loop).
  - Archived Goal / archived session paths: enqueue returns typed error and no row is inserted.

**Affected Areas.**
- `apps/daemon/src/extractions/runner.ts` (new) + `.test.ts`
- `apps/daemon/src/extractions/goal-open.ts` (new) + `.test.ts`
- `apps/daemon/src/sessions/usecases.ts` — add terminal-state hook call.
- `apps/daemon/src/sessions/usecases.test.ts` — assert hook fires after M4 commit only.
- `apps/daemon/src/server.ts` or relevant Goal-detail use case — wire detector on Goal-detail read.
- `apps/daemon/src/index.ts` — construct + start runner after reconciliation.
- `apps/daemon/src/shutdown.ts` — stop runner.

**Dependencies.** M5-005, M5-006, M5-007, M5-008, M5-009.

**Acceptance Criteria.**
- Terminal session triggers enqueue + runner processing; commit completes atomically; events flow.
- Goal-open detector is Goal-scoped and never scans other Goals or the workspace FS.
- Runner survives extractor failures and continues processing the queue.
- Daemon shutdown stops the runner without leaving rows stuck.

**Validation Steps.**
- `pnpm --filter @orca/daemon test extractions/runner`
- `pnpm --filter @orca/daemon test extractions/goal-open`
- `pnpm --filter @orca/daemon test sessions/usecases`

**Risks / Notes.**
- Hook MUST be after M4 commit; calling before risks tying M4 lifecycle to extraction failures.
- Runner must use a single-threaded loop — no Promise.all over rows.
- Goal-open detector must not block the HTTP response; do the enqueue inline but never await the runner's completion of pending work.
- Configure a small idle backoff (e.g., 50–200 ms) instead of busy-waiting when `pending` is empty.

---

### M5-011 — Reduced Summary and Extraction Endpoints

**Purpose.** Expose the single manual-trigger / retry endpoint and the session-summary read. Together with M5-004 endpoints, this is the complete M5 HTTP surface.

**Scope.**
- IS: `GET /v1/sessions/:sessionId/summary` and `POST /v1/sessions/:sessionId/extract-memory`; existing session read fields filled out; route tests.
- IS NOT: `GET /v1/sessions/:sessionId/extractions`, action endpoints for memory/decisions, desktop UI.

**Requirements.**
- Implement `GET /v1/sessions/:sessionId/summary`:
  - Returns the latest `SessionMemorySummary` for the session or `404` when none exists.
- Implement `POST /v1/sessions/:sessionId/extract-memory`:
  - Validates session is terminal; otherwise `409 session_not_terminal`.
  - Computes current fingerprint (from latest available output tail + `DETERMINISTIC_EXTRACTOR_VERSION`).
  - If an active row exists (`pending`|`running`|`succeeded`) for that fingerprint, returns it (`200`) — idempotent.
  - If the latest row for the fingerprint is `failed`, inserts a new `pending` row, emits `memory.extraction.requested`, calls `runner.notify()`, returns `201`.
  - Trigger is `manual`.
- Confirm the existing session list/detail responses surface `latestExtraction` (id, status, requestedAt, finishedAt, failureCode, truncated) and `latestSummaryHeadline` from M5-003's projection extension.
- Tests:
  - Get summary returns 404 when no summary exists, returns it when present.
  - Manual extract on a `running` session is a no-op return (200), no duplicate row.
  - Manual extract after failure creates a new `pending` row (201), and the runner ultimately processes it.
  - Manual extract on a non-terminal session returns 409.
  - Double-click manual extract within a window does not create duplicate `pending` rows.

**Affected Areas.**
- `apps/daemon/src/server.ts` + `server.test.ts`
- `apps/daemon/src/extractions/usecases.ts` — add `manualExtractEnqueue` if helpful.
- `apps/daemon/src/sessions/projection.ts` — confirm fields exposed.

**Dependencies.** M5-005, M5-010.

**Acceptance Criteria.**
- Route surface matches the M5 specification exactly.
- Idempotency proved by tests.
- Existing session responses are unchanged for clients that ignore new optional fields.

**Validation Steps.**
- `pnpm --filter @orca/daemon test server`
- `pnpm --filter @orca/daemon test extractions`

**Risks / Notes.**
- Do not add `GET /v1/sessions/:sessionId/extractions`.
- Do not add separate `confirm` / `archive` action endpoints.
- Do not emit a new event type for summaries — `memory.extraction.completed` already tells UI when to refetch.

---

### M5-012 — Daemon Proof-Loop Integration Test (FULL-SUITE GATE)

**Purpose.** Prove the end-to-end M5 daemon loop in one integration test: refined Goal → terminal session with fixture output → Goal-open enqueue → runner extraction → atomic commit → REST reads → daemon restart → reads survive. Run the full repo regression to lock in M1–M4 stability.

**Scope.**
- IS: a single integration test exercising the full daemon loop end-to-end; `pnpm -r typecheck` + `pnpm -r test` gate.
- IS NOT: desktop changes.

**Requirements.**
- Create `apps/daemon/test/m5-shared-memory.integration.test.ts`:
  - Boot a daemon against a file-backed SQLite DB.
  - Create + refine a Goal (use existing M3 helpers).
  - Create a terminal session with a fixture output tail via the M4 fake PTY (or by writing directly to the output store using public test seams).
  - Open the Goal detail (HTTP read) — assert seed memory exists, eligible session is enqueued.
  - Wait for `memory.extraction.completed` event (with a bounded timeout, e.g., 5 s).
  - Assert via REST:
    - `GET /v1/goals/:goalId/memory` returns the expected seed + extracted rows.
    - `GET /v1/goals/:goalId/decisions` returns the expected decision rows (if fixture contains a `DECISION:` line).
    - `GET /v1/sessions/:sessionId/summary` returns the expected summary.
  - Force a duplicate extraction via `POST /v1/sessions/:sessionId/extract-memory` — assert no duplicate memory rows.
  - Force a failed extraction (inject a fake extractor that throws once) and retry via the same POST — assert previous successful memory rows still exist and no new duplicates.
  - Shut the daemon down; reopen against the same DB; reconcile path runs; assert no `pending`/`running` rows remain; all committed rows are still readable.
  - Assert event bus never received any event whose payload contains memory `content`, decision `decisionText`, or summary `summaryText` (privacy check).
- Run full-suite gate:
  - `pnpm -r typecheck`
  - `pnpm -r test`
  - Record summary in implementation notes.

**Affected Areas.**
- `apps/daemon/test/m5-shared-memory.integration.test.ts` (new)
- Minor helpers under `apps/daemon/test/helpers/` if needed.

**Dependencies.** M5-001 through M5-011.

**Acceptance Criteria.**
- Integration test green.
- `pnpm -r typecheck` green.
- `pnpm -r test` green.
- No M1/M2/M3/M4 regression.
- Event-content privacy check passes.

**Validation Steps.**
- `pnpm --filter @orca/daemon test m5-shared-memory.integration`
- `pnpm -r typecheck`
- `pnpm -r test`

**Risks / Notes.**
- Use a file-backed DB (not `:memory:`) so the restart assertion is meaningful.
- Bound waits with deterministic event-driven helpers, not arbitrary sleeps.
- This is **Gate 4** — do not proceed to desktop work until this is green and reviewed.

---

### M5-013 — Desktop API Wrappers for Memory, Decisions, Summaries, and Extractions

**Purpose.** Provide typed desktop client wrappers so panels can be built against stable functions rather than ad-hoc fetches. Keeps the desktop layer testable in isolation.

**Scope.**
- IS: API client functions in `apps/desktop/src/api.ts` for the new endpoints; type re-exports from `@orca/contracts`; mocked-fetch tests.
- IS NOT: components, hooks, state, panels.

**Requirements.**
- Extend `apps/desktop/src/api.ts` with:
  - `listGoalMemory(goalId, { includeArchived? }): Promise<GoalMemoryItem[]>`
  - `createGoalMemory(goalId, input): Promise<GoalMemoryItem>`
  - `patchMemoryItem(id, patch): Promise<GoalMemoryItem>`
  - `listGoalDecisions(goalId): Promise<GoalDecision[]>`
  - `createGoalDecision(goalId, input): Promise<GoalDecision>`
  - `patchDecision(id, patch): Promise<GoalDecision>`
  - `getSessionSummary(sessionId): Promise<SessionMemorySummary | null>` (returns null on 404).
  - `extractSessionMemory(sessionId): Promise<MemoryExtraction>` (handles 201/200 + 409 typed error).
- All wrappers must parse the response body with the contract schemas before returning.
- Add `api.test.ts` cases covering happy path, 404 handling for summary, and 409 handling for non-terminal extract.

**Affected Areas.**
- `apps/desktop/src/api.ts`
- `apps/desktop/src/api.test.ts`

**Dependencies.** M5-001 contracts; M5-004 + M5-011 endpoints.

**Acceptance Criteria.**
- Wrappers compile and pass tests.
- Each response parsed with the contract schema; tests assert parse failure for an unexpected shape.

**Validation Steps.**
- `pnpm --filter @orca/desktop test api`

**Risks / Notes.**
- Do NOT add a WebSocket command interface for memory or extraction.
- Keep these wrappers stateless — no caching here; that is the panel's concern.

---

### M5-014 — Goal Detail Memory Panel

**Purpose.** Render the Goal's memory in the existing Goal detail view with the manual review actions (edit / promote / archive) and the loading/empty/error/truncated/unavailable states.

**Scope.**
- IS: a `MemoryPanel` component, integrated into `GoalDetailView`; create/edit modal; component tests.
- IS NOT: decisions panel, session badges, live refresh wiring (M5-017).

**Requirements.**
- Create `apps/desktop/src/goal-detail/memory/MemoryPanel.tsx`:
  - Fetches memory via `listGoalMemory` on mount and Goal id change.
  - Groups by status: `promoted` first, then `candidate`; an "Show archived" toggle reveals `archived` rows.
  - Renders per row: type chip, status chip, source pointer (refinement / session id + offsets / manual), optional confidence, content (clamped with reveal), and actions:
    - Edit (opens modal that calls `patchMemoryItem`).
    - Promote (only for `candidate`).
    - Archive (for active rows).
  - Add-memory button opens the same modal in create mode (`createGoalMemory`).
  - States: loading skeleton, empty state, error state with retry, truncated badge from `latestSummaryHeadline`/source, "source output unavailable" annotation when `sourceOffsetFirst/Last` cannot be resolved.
  - Live refresh is **not** wired in this task; data is fetched on mount + explicit user actions. M5-017 wires the WS-triggered refetch.
- Component tests in `apps/desktop/src/goal-detail/memory/MemoryPanel.test.tsx` using the existing desktop test setup:
  - Loading → list render → empty state → error retry path.
  - Promote candidate → row moves to `promoted` group after PATCH.
  - Archive promoted → row hidden until toggle.
  - Create new memory via modal.
  - Invalid transition surfaces as a non-blocking error toast/inline message.

**Affected Areas.**
- `apps/desktop/src/goal-detail/memory/MemoryPanel.tsx` (new) + `.test.tsx`
- `apps/desktop/src/goal-detail/memory/MemoryEditModal.tsx` (new)
- `apps/desktop/src/goal-detail/GoalDetailView.tsx` — mount the panel.

**Dependencies.** M5-013.

**Acceptance Criteria.**
- Component renders all required states.
- Actions call the correct wrappers.
- Tests pass.

**Validation Steps.**
- `pnpm --filter @orca/desktop test memory/MemoryPanel`

**Risks / Notes.**
- Do not add a global memory dashboard.
- Do not display raw output offsets as a transcript; show only "from session <id> bytes [a..b]" or "unavailable".
- Keep the panel inside Goal detail; do not introduce new routing.

---

### M5-015 — Goal Detail Decisions Panel

**Purpose.** Render Goal decisions in the existing Goal detail view with confirm / archive / edit actions and a clear "needs confirmation" grouping for proposed decisions.

**Scope.**
- IS: a `DecisionsPanel` component; create/edit modal; component tests.
- IS NOT: memory panel (M5-014), session badges, live refresh wiring (M5-017).

**Requirements.**
- Create `apps/desktop/src/goal-detail/decisions/DecisionsPanel.tsx`:
  - Fetches via `listGoalDecisions` on mount and Goal id change.
  - Groupings: `needs confirmation` (proposed AND `confirmationRequired=true`) at top, then `proposed`, then `confirmed`. Archived hidden behind a toggle.
  - Renders per row: title, decisionText preview (clamp), rationale (collapsed), status chip, source pointer, optional confidence.
  - Actions per row: edit (modal → `patchDecision`), confirm (proposed only), archive.
  - Add-decision button opens modal in create mode (`createGoalDecision`).
  - States: loading, empty, error retry.
- Component tests:
  - Confirm proposed → moves to `confirmed`.
  - Archive proposed/confirmed → hidden until toggle.
  - Create decision via modal.
  - High-impact decision with `confirmationRequired=true` shown in "needs confirmation" group even after edits that do not touch status.
  - Invalid transition surfaces non-blocking error.

**Affected Areas.**
- `apps/desktop/src/goal-detail/decisions/DecisionsPanel.tsx` (new) + `.test.tsx`
- `apps/desktop/src/goal-detail/decisions/DecisionEditModal.tsx` (new)
- `apps/desktop/src/goal-detail/GoalDetailView.tsx` — mount the panel below memory.

**Dependencies.** M5-013, M5-014 (just for layout consistency).

**Acceptance Criteria.**
- All required states render.
- Actions call correct wrappers.
- Tests pass.

**Validation Steps.**
- `pnpm --filter @orca/desktop test decisions/DecisionsPanel`

**Risks / Notes.**
- Do not auto-confirm decisions on the client. Confirmation is always explicit.
- Do not add a recommendation panel.
- Show `confirmationRequired` prominently — these are the rows that block downstream automation in M6/M7.

---

### M5-016 — Session Extraction Badge, Manual Extract/Retry Button, and Summary Display

**Purpose.** Surface extraction status and summary in the existing session row/area so the user can see when an extraction is pending/running/failed/succeeded/truncated and retry manually.

**Scope.**
- IS: small UI additions inside `apps/desktop/src/goal-detail/sessions/`; component tests for each state.
- IS NOT: a new session-memory tab or routing; live refresh wiring (M5-017).

**Requirements.**
- Modify `SessionListItem.tsx` (or the equivalent component) to render a small badge based on `session.latestExtraction.status`:
  - `none` → grey "no extraction".
  - `pending` / `running` → spinner + label.
  - `succeeded` → green "extracted"; if `latestExtraction.truncated`, show "extracted (truncated)" tooltip.
  - `failed` → red "extraction failed" with `failureCode` tooltip.
- Add an "Extract now" / "Retry extraction" button visible only for terminal sessions. Disabled while `pending` or `running`. Wired to `extractSessionMemory(sessionId)`.
- Add a collapsible "Latest summary" panel in the session detail area that fetches via `getSessionSummary(sessionId)`:
  - Shows headline + body. If `truncated`, shows a badge.
  - "Source output unavailable" state when the summary references offsets that the M4 output store no longer has — surface from the daemon as an `outputUnavailable: true` flag on the extraction projection (already covered by `failureCode='output_unavailable'` for failed extractions; for succeeded summaries with later-pruned tails, the UI shows the summary text but flags source as unavailable).
- Component tests for each state (none / pending / running / succeeded / succeeded+truncated / failed / output-unavailable).

**Affected Areas.**
- `apps/desktop/src/goal-detail/sessions/SessionListItem.tsx`
- `apps/desktop/src/goal-detail/sessions/SessionSummaryPanel.tsx` (new) + `.test.tsx`
- `apps/desktop/src/goal-detail/sessions/SessionsPanel.tsx` — mount summary panel near the existing session view.
- `apps/desktop/src/goal-detail/sessions/SessionsPanel.test.tsx`

**Dependencies.** M5-013.

**Acceptance Criteria.**
- All badge/state combinations render with deterministic markup verifiable in tests.
- Retry button enqueues exactly once on click and goes disabled while pending.
- No new top-level navigation introduced.

**Validation Steps.**
- `pnpm --filter @orca/desktop test sessions`

**Risks / Notes.**
- Do not render raw output as the summary source — only the bounded summary text.
- Disable the retry button while `pending`/`running` to avoid duplicate enqueues; rely on server idempotency as a backstop.

---

### M5-017 — Live Refresh, Final Regression, and Documentation (FULL-SUITE GATE)

**Purpose.** Wire desktop live refresh on M5 events using the existing WebSocket channel, run the full regression suite, and finalize documentation of endpoints, event rules, retention/caps, extraction policy, restart policy, and non-goals.

**Scope.**
- IS: WS event-to-refetch wiring for memory / decisions / sessions / summaries; documentation file edits; final `pnpm -r typecheck` and `pnpm -r test` gate; Definition-of-Done checklist.
- IS NOT: new endpoints, new components, new events.

**Requirements.**
- In the existing desktop event subscription layer (the M1+ live-event WS handler used by Goal detail):
  - On `memory.extraction.requested` / `started` / `completed` / `failed`: refetch the affected session's `latestExtraction` (via session list refetch or scoped session read) and, on `completed`, refetch the session summary, Goal memory list, and Goal decisions list.
  - On `memory.item.created|updated|promoted|archived`: refetch Goal memory list.
  - On `decision.created|updated|confirmed|archived`: refetch Goal decisions list.
  - All refetches are scoped to the currently-open Goal — events for other Goals are ignored.
  - Do **not** patch local state from event payloads — REST is the source of truth.
- Add a reconnect handler: on WS reconnect, refetch memory, decisions, sessions, and the latest summary for any open session detail.
- Tests:
  - Simulated WS event triggers exactly one refetch per affected resource.
  - Events for other Goals do not refetch the open Goal's resources.
  - Reconnect triggers refetches.
- Documentation edits:
  - `docs/milestones/5.md` — append a "Status: Complete" header line + brief outcome notes (or create `docs/operation-flow/m5-implementation-review.md` matching the M4 pattern, if that is the project convention).
  - `docs/implementation-plans/milestone-5.md` — append a "Completion record" section with: final commit SHA, full-suite test summary, list of new endpoints, list of new events, list of new tables, list of non-goals reaffirmed.
  - Reaffirm in writing the non-goals: no context assembly, no prompts, no recommendations, no tasks, no AI provider, no cross-Goal memory, no embeddings, no transcript persistence.
- Full-suite gate:
  - `pnpm -r typecheck`
  - `pnpm -r test`
  - Manual desktop smoke per the checklist in §16 of `docs/milestones/5.md` (refined Goal, attached workspace, terminal session with fixture output, retry, promote/archive, confirm/archive, reload, daemon restart).

**Affected Areas.**
- `apps/desktop/src/...` event subscription module (location depends on M1's WS layout).
- `apps/desktop/src/goal-detail/GoalDetailView.tsx` — invalidate-on-event hooks.
- `docs/milestones/5.md`
- `docs/implementation-plans/milestone-5.md`
- Optional `docs/operation-flow/m5-implementation-review.md`.

**Dependencies.** M5-012, M5-013, M5-014, M5-015, M5-016.

**Acceptance Criteria.**
- Every M5 event type triggers the right refetch and nothing more.
- Cross-Goal events do not pollute the open Goal's state.
- Reconnect refetches everything visible.
- `pnpm -r typecheck` green.
- `pnpm -r test` green.
- Manual desktop smoke checklist passes.
- Definition-of-Done items in `docs/milestones/5.md` §17 are individually checked off in the completion record.

**Validation Steps.**
- `pnpm --filter @orca/desktop test`
- `pnpm -r typecheck`
- `pnpm -r test`
- Manual smoke (record in PR description).

**Risks / Notes.**
- Refetches scoped to the currently-open Goal avoid stale fan-out work and protect privacy by not pulling other Goals' data.
- Do not promote any temporary debug logging that prints output, candidate content, or summaries.
- Confirm the WS subscription does not introduce a memory leak across Goal detail unmounts.

---

## Task Dependency Graph

```
M5-000 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
   │
   ▼
M5-001 (Contracts)  ──────────────────────────────────────────────────────────────┐
   │                                                                              │
   ▼                                                                              │
M5-002 (Migration)  ─── Gate 1 ──────────┐                                        │
   │                                     │                                        │
   ▼                                     ▼                                        │
M5-003 (Projections)                     │                                        │
   │                                     │                                        │
   ├─────────────┐                       │                                        │
   ▼             ▼                       │                                        │
M5-004 (Manual APIs)    M5-005 (Extraction state + boot reconcile)                │
   │                       │                                                      │
   │                       ▼                                                      │
   │                    M5-006 (Fake extractor commit, atomic tx)  ── Gate 2 ─────┤
   │                       │                                                      │
   │                       ├────────────┐                                         │
   │                       ▼            ▼                                         │
   │                M5-007 (Input)   M5-009 (Refinement seed)                     │
   │                       │            │                                         │
   │                       ▼            │                                         │
   │                M5-008 (Determ. extractor) ◀─────────────────────┐            │
   │                       │                                         │            │
   │                       └────────────┬────────────────────────────┘            │
   │                                    ▼                                         │
   │                          M5-010 (Runner + terminal hook + Goal-open)         │
   │                                    │                                         │
   │                                    ▼                                         │
   │                          M5-011 (Summary + extract-memory endpoints)         │
   │                                    │                                         │
   │                                    ▼                                         │
   └───────────────────────────────▶ M5-012 (Daemon integration test) ── Gate 4 ──┘  pnpm -r typecheck/test
                                            │
                                            ▼
                                     M5-013 (Desktop API wrappers)
                                            │
                                            ▼
                                     M5-014 (Memory panel)
                                            │
                                            ▼
                                     M5-015 (Decisions panel)
                                            │
                                            ▼
                                     M5-016 (Session badges + summary) ── Gate 5 (manual smoke)
                                            │
                                            ▼
                                     M5-017 (Live refresh + final regression) ── Gate 6 (DoD)
                                            │
                                            ▼   pnpm -r typecheck/test
                                          DONE
```

### Sequencing notes

- **Strictly serial spine:** M5-000 → 001 → 002 → 003 → (004 ∥ 005) → 006 → 007 → 008 → 009 → 010 → 011 → 012 → 013 → 014 → 015 → 016 → 017.
- **Parallelizable pairs (only if reviewed together):**
  - M5-004 (manual APIs) and M5-005 (extraction state) can run in parallel after M5-003. Both depend only on contracts + migration + projections.
  - M5-007 (input builder) and M5-009 (refinement seed) can run in parallel after M5-006. They share no files.
  - M5-014 (memory panel) and M5-015 (decisions panel) can run in parallel after M5-013, but reviewing memory first keeps layout decisions consistent. Prefer 014 → 015.
- **Persistence gates:** Gate 1 (after 002) before any daemon code touches new tables. Gate 2 (after 006) before deterministic extractor or runner runs.
- **Integration gates:** Gate 3 (after 010) before desktop work begins. Gate 4 (after 012) is the daemon's full-suite checkpoint and the hard cutover to desktop work.
- **Runtime + UX gates:** Gate 5 (after 016) is the manual desktop smoke. Gate 6 (after 017) is Definition-of-Done verification and the final full-suite checkpoint.
- **Full-suite gates:** `pnpm -r typecheck` + `pnpm -r test` run at M5-012 and M5-017 only. Every other task runs targeted tests.

---

## Suggested Model Assignment

| Task | Recommended model | Rationale |
|---|---|---|
| M5-000 Baseline verification | Codex 5.3 | Deterministic checklist and evidence capture; strongest fit for precise command execution with no product judgment. |
| M5-001 Contracts | Codex 5.3 | Zod schemas + contract tests; schema-heavy, mechanical, and high-precision. |
| M5-002 Migration | Codex 5.3 | Pure SQL DDL, indexes, and migration assertions; tightly bounded and deterministic. |
| M5-003 Projections | GPT 5.4 | Projection helpers are bounded, but restart semantics and transaction composition need broader codebase reasoning than a purely mechanical pass. |
| M5-004 Manual APIs | Sonnet 4.6 | Status-transition rules + transactional event emission. |
| M5-005 Extraction state + reconciliation | Sonnet 4.6 | Lifecycle + boot ordering matters. |
| M5-006 Fake extractor commit slice | Sonnet 4.6 | Atomicity + privacy boundary; review-heavy. |
| M5-007 Bounded input builder | Sonnet 4.6 | Byte-window correctness + ANSI stripping. |
| M5-008 Deterministic extractor | Codex 5.3 | Fixture-driven string/rule logic with deterministic expected outputs; ideal for structured tests and conservative implementation. |
| M5-009 Refinement seed memory | GPT 5.4 | Bounded, but it crosses refinement commit paths, normalization, dedupe, and promotion rules; needs stronger integration judgment. |
| M5-010 Runner + terminal hook + Goal-open | Sonnet 4.6 | Cross-module integration. |
| M5-011 Reduced summary/extract endpoints | GPT 5.4 | Small endpoint surface, but retry/idempotency and terminal-session guards are behaviorally important. |
| M5-012 Daemon proof-loop integration test | Sonnet 4.6, reviewed by GPT 5.5 | High-signal test; must be deterministic. |
| M5-013 Desktop API wrappers | Codex 5.3 | Typed fetch wrappers and mocked API tests are mechanical once contracts and endpoints exist. |
| M5-014 Memory panel | Sonnet 4.6 | UI states + actions. |
| M5-015 Decisions panel | Sonnet 4.6 | UI states + actions. |
| M5-016 Session badges + summary | Sonnet 4.6 | Existing component edits + new summary panel. |
| M5-017 Live refresh + final regression | Sonnet 4.6, reviewed by GPT 5.5 + Human | Cross-cutting; final DoD. |
| Architecture/drift reviews at gates | Opus 4.7 (decomposition), GPT 5.5 (review) | Apply at Gates 1–6. |
| Final acceptance | Human + GPT 5.5 | Product judgment + non-goal validation. |

---

## Recommended Review Gates

- **Gate 1 — After M5-002.**
  - Reviewer: GPT 5.5 (architecture drift) + Sonnet 4.6 (impl sanity).
  - Focus: contract surface matches §6/§7/§8 of `docs/milestones/5.md`; migration creates exactly the four tables + listed indexes; no extra fields; partial unique indexes parse on SQLite.
- **Gate 2 — After M5-006.**
  - Reviewer: GPT 5.5 + Sonnet 4.6.
  - Focus: projection helpers correct; manual APIs reject invalid transitions; extraction state lifecycle covers all four statuses + boot reconciliation; fake-extractor commit is atomic and broadcasts only after commit; event payloads are content-free; no raw output written anywhere.
- **Gate 3 — After M5-010.**
  - Reviewer: GPT 5.5 + Sonnet 4.6.
  - Focus: bounded input cap and ANSI stripping; deterministic extractor's false-positive rate; refinement seed idempotency; runner survives extractor failures; terminal hook runs after M4 commit; Goal-open detector is Goal-scoped and non-blocking; reconciliation runs before HTTP listener.
- **Gate 4 — After M5-012 (FULL-SUITE).**
  - Reviewer: GPT 5.5 + Human.
  - Commands: `pnpm -r typecheck && pnpm -r test`.
  - Focus: daemon API surface, event sequencing, persistence/idempotency, restart semantics, privacy (no content in events/logs), full M1–M4 regression integrity.
- **Gate 5 — After M5-016 (MANUAL DESKTOP SMOKE).**
  - Reviewer: Human (operator) + Sonnet 4.6.
  - Scenario: one refined Goal with one attached workspace, one completed terminal session with fixture output, extraction retry, memory promote/archive, decision confirm/archive, reload, daemon restart. Verify all UI states render.
- **Gate 6 — After M5-017 (FINAL DOD + FULL-SUITE).**
  - Reviewer: GPT 5.5 + Human.
  - Commands: `pnpm -r typecheck && pnpm -r test`.
  - Focus: every Definition-of-Done item in `docs/milestones/5.md` §17 checked; documentation updated; non-goals reaffirmed; no provider/model/prompt scope introduced.

---

## Definition of Done (mirrored from `docs/milestones/5.md` §17)

M5 is complete when:

1. A terminal M4 session can produce a persisted `session_summary` plus zero-or-more memory items and decisions from bounded metadata and capped output tail.
2. Opening a Goal with eligible terminal sessions enqueues extraction without full transcripts or workspace scanning.
3. Terminal-state transitions enqueue extraction after the M4 event commit without destabilizing the PTY runtime.
4. Extractor output is zod-validated, normalized, capped, and best-effort redacted before persistence.
5. Extraction success/failure updates `memory_extractions` and domain events atomically with projection rows.
6. Broadcasts happen only after commit.
7. Retry is explicit and does not duplicate live memory items for the same content.
8. Boot reconciliation marks stale `pending`/`running` extractions failed and keeps already-committed memory visible.
9. Goal-scoped memory and decisions survive daemon restart.
10. Goal detail shows memory, decisions, session summary, extraction status (incl. failed/retry/truncated/output-unavailable).
11. Users can create / edit / promote / archive memory and create / edit / confirm / archive decisions via the minimal API.
12. Automatic promotion is limited to deterministic low-risk rules.
13. High-impact or uncertain decisions remain proposed and user-confirmable.
14. M3 refinement fields seed Goal memory without a generalized import system.
15. Events are small and content-free.
16. No context assembly, prompt injection, recommendations, tasks, workflows, cross-Goal memory, embeddings, vector search, provider configuration, generic skill invocation API, or autonomous execution has been introduced.

---

## Completion Record

**Final commit SHA:** TBD — see commit following this edit.

**Full-suite test summary (pnpm -r test):**
- contracts: 30 passed
- daemon: 553 passed, 5 skipped (4 smoke tests, 1 integration)
- desktop: 132 passed
- Total: 715 passed, 5 skipped, 0 failures

**Full-suite typecheck (pnpm -r typecheck):** green — contracts, daemon, desktop all pass.

### New Endpoints

- `GET /v1/goals/:goalId/memory`
- `POST /v1/goals/:goalId/memory`
- `PATCH /v1/memory/:id`
- `GET /v1/goals/:goalId/decisions`
- `POST /v1/goals/:goalId/decisions`
- `PATCH /v1/decisions/:id`
- `GET /v1/sessions/:sessionId/summary`
- `POST /v1/sessions/:sessionId/extract-memory`

### New Domain Events

- `memory.extraction.requested`
- `memory.extraction.started`
- `memory.extraction.completed`
- `memory.extraction.failed`
- `memory.item.created`
- `memory.item.updated`
- `memory.item.promoted`
- `memory.item.archived`
- `decision.created`
- `decision.updated`
- `decision.confirmed`
- `decision.archived`

### New Tables

- `goal_memory_items`
- `goal_decisions`
- `session_summaries`
- `memory_extractions`

### Non-Goals Reaffirmed

The following were explicitly not implemented in M5 and remain out of scope:

- **No context assembly** — memory is projected and queryable but never injected into agent sessions.
- **No prompt injection** — no session context is assembled or sent to agents from stored memory.
- **No recommendations** — the recommendation engine is not started; no recommendation events or tables.
- **No tasks** — no task decomposition, task events, or task tables.
- **No workflows** — no workflow engine, workflow events, or workflow tables.
- **No AI provider integration** — no AI SDK, no model calls, no provider configuration UI or tables. The deterministic extractor runs entirely in-process with no network calls.
- **No cross-Goal memory** — all memory items, decisions, and summaries are strictly Goal-scoped.
- **No embeddings or vector search** — no vector tables, no embedding generation, no similarity search.
- **No transcript persistence** — terminal output is not captured beyond the M4 capped output tail already stored by M4.
- **No continuous reasoning** — extraction is triggered at discrete points (terminal-state transitions, Goal-open) not continuously.
- **No global memory dashboard** — memory and decisions are accessible only within Goal detail.
