# Orca — Milestone 6 Implementation Plan

**Source milestone:** `docs/milestones/6.md`
**Builds on:** `docs/implementation-plans/milestone-5.md` (M5 must be complete and green).
**Status:** Ready for AI-assisted execution.
**Scope guard:** Tasks below MUST NOT introduce recommendations, task/work-unit generation, validation recommendations, conflict detection, workflow automation, supervised execution, autonomous launch, continuous reasoning, automatic session launch, automatic retry/backoff, AI provider SDKs, provider/model configuration UI, prompt template libraries, prompt experiments, token-accurate accounting, provider cost tracking, generic skill invocation endpoints, public context-builder invocation endpoints, prompt injection frameworks, generic adapter prompt routing, cross-Goal memory, workspace indexing/scanning, file watching, knowledge graphs, embeddings, vector search, semantic search, global search, memory consolidation, ranking/relevance engines, aging/decay systems, policy/governance, audit engines, full transcript capture/extraction/replay/export/analytics, raw M4 output-tail reads during context assembly, persistence of raw terminal output / rendered context / source text / raw assembler input or output / prompts / model responses in events, rendered-context bytes in process args / env vars / logs, global context dashboards, package history/diff/editor UI, new top-level navigation/routing, new top-level packages, `POST /v1/context-packages/:id/regenerate`, `GET /v1/sessions/:sessionId/context`, inline `assembleContext` inside `POST /v1/sessions`, package archive/update/delete endpoints, source reverse-index tables (`context_package_sources` is explicitly out — sources are stored as compact JSON on `context_packages`), `context.assembly.started`, `context.package.updated`, `context.package.archived`, WebSocket commands for context preparation or session launch, raw terminal/rendered-context/source-text events, automatic context retry, AI-backed assembler implementations, model provider integration, or background worker infrastructure. Any task requiring such code is out of scope for M6.

### Inherited constraints from M1 / M2 / M3 / M4 / M5

**DaemonContext seam.** All new M6 use cases MUST be wired through the explicit `DaemonContext`. M6 adds at minimum: `contextAssembler: SessionPreparationAssembler` (deterministic by default; fake-replaceable for tests), and reuses existing `now`, `idFactory`, and SQLite handles. No DI framework, no container, no decorators.

**Registry immutability (M2).** Adapter and skill registries register descriptors before the HTTP listener accepts connections. M6 must not add hot-registration paths. The new `orca/session-preparation` skill descriptor and any extended adapter `contextDelivery` capability are registered in the existing boot path.

**Native-import isolation (M4).** Only `apps/daemon/src/pty/manager.ts` may `import` `node-pty`. M6 must not touch this isolation. Adapter delivery code lives next to existing adapter modules, not inside the PTY manager.

**Output isolation rule (M4, extended).** Terminal output remains persisted only in M4's session output store. M6 MUST NOT read raw M4 output tails or transcripts when assembling context. The only acceptable consumption of session-derived signal is via M5 `session_summaries` rows.

**Content-free events rule (M5, extended).** All M6 domain events carry ids, status, counts, byte sizes, and failure codes. They MUST NOT carry rendered context, raw source text, memory content, decision text, summary body, prompts, raw assembler input/output, or model responses.

**Atomicity rule (carried forward).** Every M6 daemon write that emits domain events MUST insert events and projection rows inside the same SQLite transaction and broadcast on the event bus **only after** `COMMIT` returns.

**Goal-scoped boundary (carried forward).** Every M6 row has `goal_id`; every M6 read is Goal-scoped; no cross-Goal endpoint or selection exists.

**Existing wire shapes frozen.** Existing M1/M2/M3/M4/M5 endpoint responses, event names, event payloads, and WebSocket frames must remain byte-identical. M6 only adds new endpoints, new event types, a new optional `contextPackageId` field on the existing session create request, and a new optional `contextPackageId` field on session read responses and the `session.created` event.

This document decomposes Milestone 6 (Context Assembly) into bounded executable tasks. Each task is sized for a single AI session, has explicit acceptance criteria, and is reviewable in isolation.

The single proof point for M6 is:

```text
User opens a Goal and starts the new-session flow
  -> chooses adapter, workspace, role, and short session objective
  -> daemon reads bounded Goal/refinement/workspace/memory/decision/summary projections
  -> daemon runs one internal session-preparation job boundary
  -> deterministic assembler produces compact role-aware sections
  -> daemon validates, redacts, caps, and persists package + assembly events atomically
  -> daemon broadcasts committed events with ids and small metadata only
  -> desktop shows context preview, source counts, status, warnings, and retry/regenerate
  -> user starts a normal M4 PTY session with contextPackageId
  -> adapter receives context through an explicit adapter-safe path or declares preview-only
  -> session row stores contextPackageId
  -> package, assembly metadata, and session association survive daemon restart
```

---

## Conventions

- **Task ID:** `M6-NNN` (zero-padded, sequenced for default execution order).
- **Affected Areas:** paths relative to repo root.
- **Validation Steps:** every task lists at least one deterministic command or scenario.
- **No task may exceed its declared scope** even if adjacent work seems easy — additive scope belongs in a follow-up task.
- **Full-suite gates:** `pnpm -r typecheck` and `pnpm -r test` run at **M6-010** (session create link / daemon API surface complete) and **M6-016** (final). Targeted tests run inside every other task.
- **Atomicity rule:** every assembly commit (success or failure) inserts the assembly row, optional package row, and all associated domain events in **one** SQLite transaction. Broadcast occurs **only after** `COMMIT`.
- **Content-free events rule:** event payloads contain ids, status, counts, byte sizes, and failure codes — never rendered context, source text, memory content, decision text, summary text, prompts, raw assembler input/output, or model responses.
- **Idempotency rule:** `request_fingerprint = sha256(goal_id + ':' + adapter_id + ':' + role + ':' + objective_hash + ':' + (workspace_id ?? '') + ':' + source_fingerprint + ':' + assembler_version + ':' + (replace_package_id ?? ''))`. The partial unique index on `(goal_id, request_fingerprint) WHERE status IN ('pending','running','succeeded')` prevents duplicate active assemblies. Failed rows are terminal and excluded from active idempotency so retry can create a new row.
- **Source fingerprint rule:** `source_fingerprint = sha256(sorted compact source-id list with M5 row updated_at/content hashes + workspace metadata version + refinement id/version + role + adapter + objective_hash + assembler version)`. Deterministic across the same projection snapshot.
- **Privacy rule:** never log rendered context, raw source text, memory content, decision text, summary text, secrets, or adapter context-file paths. Apply M5's best-effort secret redaction (`password=`, `token=`, `api_key=`, `authorization: bearer`) to every section body before rendered context is persisted or delivered to an adapter.
- **Tail isolation rule:** code under `apps/daemon/src/context/` MUST NOT import the M4 output-tail module. A test or lint check enforces this.
- **Defaults (from the milestone plan):** rendered context cap 32 KiB; objective cap 4 KiB; per-section cap 8 KiB; max memory items 30; max decisions 20; max sibling summaries 5; failure message cap 256 chars; estimated token budget label `8000` with `Math.ceil(bytes/4)` heuristic.

---

## Tasks

---

### M6-000 — Baseline Verification

**Purpose.** Lock in a known-good M1/M2/M3/M4/M5 baseline before any M6 change lands. Establishes the regression anchor so every later M6 failure is unambiguously attributable to M6 work, and so M6-010 / M6-016 can compare against a recorded green state.

**Scope.**
- IS: install, typecheck, run tests, record commit SHA and test summary, verify named M1–M5 regression anchors exist.
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
- Record in implementation notes / PR description:
  - `git rev-parse HEAD`;
  - final test summary line counts;
  - pre-existing dirty paths from `git status` (do not attribute them to M6).

**Affected Areas.** None — verification only.

**Dependencies.** M5 complete and green.

**Acceptance Criteria.**
- All listed commands exit `0`.
- All named regression anchors PASS.
- Baseline SHA and summary recorded.

**Validation Steps.**
- `pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm -r test`.
- Inspect summary for named tests.

**Risks / Notes.**
- Do not "fix" pre-existing dirty files; just record them.
- If baseline fails, stop and resolve before proceeding — M6 must not absorb pre-existing breakage.

**Suggested model:** Human + Sonnet 4.6 (run + record).

---

### M6-001 — Contracts for Context Packages, Assemblies, Sources, Roles, Events, and Session Extension

**Purpose.** Establish the wire and runtime contract surface for M6 in `packages/contracts`. Contracts are the freeze-point that downstream daemon and desktop tasks build against, and the place where the prohibition on content-leaking event payloads is enforced.

**Scope.**
- IS: zod schemas + TypeScript types for context packages, context assemblies, context source refs, role/status/failure-code enums, M6 event literals, create/list/detail responses, and the `CreateSessionRequest` + session read/event extensions for optional `contextPackageId`; contract unit tests.
- IS NOT: daemon use cases, migrations, projection helpers, HTTP routes, assembler implementation, renderer, adapter delivery, desktop wrappers, UI.

**Requirements.**

- Extend `packages/contracts/src/index.ts` with:

  - Enums:
    - `ContextRole = 'architect' | 'engineer' | 'reviewer' | 'generalist'`.
    - `ContextPackageStatus = 'ready'` (single value in M6).
    - `ContextAssemblyStatus = 'pending' | 'running' | 'succeeded' | 'failed'`.
    - `ContextAssemblyTrigger = 'prepare' | 'regenerate' | 'retry'`.
    - `ContextAssemblyFailureCode = 'invalid_input' | 'invalid_output' | 'output_too_large' | 'goal_archived' | 'source_missing' | 'delivery_unavailable' | 'internal_error' | 'daemon_restart'`.
    - `ContextSourceType = 'goal' | 'refinement' | 'workspace' | 'memory_item' | 'decision' | 'session_summary'`.
    - `ContextSourceReason = 'required' | 'high_confidence' | 'recency' | 'role_match' | 'sibling' | 'objective_hint'`.
    - `AdapterContextDeliveryMode = 'initial_input' | 'context_file' | 'preview_only'`.

  - Row shapes:
    - `ContextSourceRef` — `type`, `id`, `sourceSessionId?` (string nullable), `label` (≤ 64 chars), `reason`, `marker` (≤ 64 chars).
    - `ContextPackage` — `id`, `goalId`, `supersedesPackageId?` (nullable), `adapterId`, `workspaceId?` (nullable), `role`, `objective` (≤ 4000 chars), `status` (`'ready'`), `renderedContext` (≤ 32 KiB), `renderedBytes`, `estimatedTokens`, `truncated` (boolean), `sparse` (boolean), `sourceCount`, `sources: ContextSourceRef[]`, `warnings: string[]` (each ≤ 200 chars, array ≤ 10), `sourceFingerprint`, `assemblerVersion`, `createdAt`.
    - `ContextAssembly` — `id`, `goalId`, `packageId?` (nullable), `replacePackageId?` (nullable), `adapterId`, `workspaceId?` (nullable), `role`, `objectiveHash`, `sourceFingerprint`, `assemblerVersion`, `requestFingerprint`, `status`, `trigger`, `failureCode?` (nullable), `failureMessage?` (≤ 256 chars, nullable), `requestedAt`, `startedAt?`, `finishedAt?`.

  - Request schemas:
    - `CreateContextPackageRequest` — `adapterId`, `role`, `objective`, optional `workspaceId`, optional `replacePackageId`.
    - `ListContextPackagesQuery` — optional `sessionId`, optional `adapterId`, optional `limit` (default 20, max 50).

  - Response shapes:
    - `CreateContextPackageResponse` — `{ package: ContextPackage | null, assembly: ContextAssembly, reused: boolean }`. `package` is null only when `assembly.status === 'failed'`.
    - `ListContextPackagesResponse` — `{ packages: ContextPackage[], assemblies: ContextAssembly[] }`.
    - `GetContextPackageResponse` — `{ package: ContextPackage }`.

  - Session contract extensions (optional, back-compat):
    - `CreateSessionRequest`: add optional `contextPackageId`.
    - Session read response (`Session`): add optional `contextPackageId` (`string | null`).
    - `session.created` event payload: add optional `contextPackageId` (`string | null`).

  - M6 event literals and payload schemas (use `.strict()` zod objects):
    - `context.assembly.requested` — `{ assemblyId, goalId, adapterId, role }`.
    - `context.assembly.completed` — `{ assemblyId, goalId, packageId, sourceCount, renderedBytes, truncated }`.
    - `context.assembly.failed` — `{ assemblyId, goalId, failureCode }`.
    - `context.package.created` — `{ packageId, goalId, adapterId, role, sourceCount, renderedBytes }`.

  - All event payload schemas MUST reject `renderedContext`, `objective`, `sourcesText`, `memoryContent`, `decisionText`, `summaryText`, `assemblerInput`, `assemblerOutput`, `prompt`, `response`, and similar large/sensitive fields. Tests verify rejection.

  - Internal assembler I/O contracts (exported but internal-only, never wired to public HTTP):
    - `ContextAssemblyInput` — `goal` (id, title, status, archivedAt), `refinement` (id, version, objective, constraints[], successCriteria[], scopeNotes? — all optional fields), `workspace?` (id, name, path display, branch?, dirty?), `role`, `adapterId`, `objective`, `memory: SelectableMemory[]`, `decisions: SelectableDecision[]`, `siblingSummaries: SelectableSummary[]`, `budget` (maxBytes, perSectionMaxBytes, estimatedTokenBudget).
    - `ContextAssemblyOutput` — `sections: ContextSection[]`, `sources: ContextSourceRef[]`, `warnings: string[]`, `truncated`, `sparse`, `estimatedTokens`.
    - `ContextSection` — `kind: 'objective'|'refinement'|'workspace'|'memory'|'decisions'|'sibling_summaries'|'notes'`, `title`, `body`, `markers: string[]`.

- Add `contracts.test.ts` cases covering:
  - Valid `ContextPackage`, `ContextAssembly`, `ContextSourceRef`, `CreateContextPackageRequest`, and event payload parse.
  - Reject `renderedBytes` > 32768, `objective` > 4000, `failureMessage` > 256, `warnings` > 10 entries, `sources.length > 60`.
  - Reject unknown / forbidden fields on event payloads (e.g., `renderedContext` on `context.package.created`).
  - Reject invalid role/status/failure-code enums.
  - Reject `CreateSessionRequest.contextPackageId` that is not a string.
  - Verify back-compat: existing M1–M5 contract assertions still pass.

**Affected Areas.**
- `packages/contracts/src/index.ts`.
- `packages/contracts/src/index.test.ts` (or equivalent).

**Dependencies.** M6-000.

**Acceptance Criteria.**
- Contracts compile with `pnpm -r typecheck`.
- Contract tests pass via `pnpm --filter @orca/contracts test`.
- Event payload schemas reject content/text fields (verified by test).
- `CreateSessionRequest` accepts payloads with and without `contextPackageId`.
- Existing M1/M2/M3/M4/M5 contract assertions still pass.

**Validation Steps.**
- `pnpm --filter @orca/contracts test`.
- `pnpm --filter @orca/contracts typecheck`.

**Risks / Notes.**
- Use `.strict()` for event-payload schemas so accidental content leakage fails contract tests.
- Mark `ContextAssemblyInput`/`Output` exports as `@internal` in code comments — they MUST NOT be wired to any public HTTP route.
- `sources` array on `ContextPackage` keeps `label`/`marker`/`reason` short — no content snippets.
- Keep role enum at exactly four values; resist the temptation to add `qa`/`debugger` until a later milestone.

**Suggested model:** GPT 5.4 / Codex (bounded schema work).

---

### M6-002 — SQLite Migration `0006_context.sql`

**Purpose.** Create the two M6 tables, the new `sessions.context_package_id` column, and minimal indexes so projections, use cases, and the API have durable storage. Migration must land before any daemon code references the new tables/columns.

**Scope.**
- IS: a new migration file `0006_context.sql`, migration-list registration, migration smoke + foreign-key + unique-index tests on fresh DB and on the M5 fixture DB.
- IS NOT: projections, use cases, HTTP routes, assembler logic, adapter changes, desktop changes.

**Requirements.**

- Create `apps/daemon/migrations/0006_context.sql` containing exactly:
  - `context_packages` table with columns matching the M6 spec:
    - `id` TEXT PRIMARY KEY;
    - `goal_id` TEXT NOT NULL REFERENCES `goals(id)` ON DELETE CASCADE;
    - `supersedes_package_id` TEXT REFERENCES `context_packages(id)` ON DELETE SET NULL;
    - `adapter_id` TEXT NOT NULL;
    - `workspace_id` TEXT REFERENCES `workspaces(id)` ON DELETE SET NULL;
    - `role` TEXT NOT NULL CHECK (`role` IN (`'architect'`,`'engineer'`,`'reviewer'`,`'generalist'`));
    - `objective` TEXT NOT NULL;
    - `status` TEXT NOT NULL CHECK (`status` IN (`'ready'`));
    - `rendered_context` TEXT NOT NULL;
    - `rendered_bytes` INTEGER NOT NULL;
    - `estimated_tokens` INTEGER NOT NULL;
    - `truncated` INTEGER NOT NULL DEFAULT 0;
    - `sparse` INTEGER NOT NULL DEFAULT 0;
    - `source_count` INTEGER NOT NULL;
    - `sources_json` TEXT NOT NULL;
    - `warnings_json` TEXT NOT NULL DEFAULT `'[]'`;
    - `source_fingerprint` TEXT NOT NULL;
    - `assembler_version` TEXT NOT NULL;
    - `created_at` TEXT NOT NULL.
  - `context_assemblies` table:
    - `id` TEXT PRIMARY KEY;
    - `goal_id` TEXT NOT NULL REFERENCES `goals(id)` ON DELETE CASCADE;
    - `package_id` TEXT REFERENCES `context_packages(id)` ON DELETE SET NULL;
    - `replace_package_id` TEXT REFERENCES `context_packages(id)` ON DELETE SET NULL;
    - `adapter_id` TEXT NOT NULL;
    - `workspace_id` TEXT REFERENCES `workspaces(id)` ON DELETE SET NULL;
    - `role` TEXT NOT NULL CHECK (`role` IN (`'architect'`,`'engineer'`,`'reviewer'`,`'generalist'`));
    - `objective_hash` TEXT NOT NULL;
    - `source_fingerprint` TEXT NOT NULL;
    - `assembler_version` TEXT NOT NULL;
    - `request_fingerprint` TEXT NOT NULL;
    - `status` TEXT NOT NULL CHECK (`status` IN (`'pending'`,`'running'`,`'succeeded'`,`'failed'`));
    - `trigger` TEXT NOT NULL CHECK (`trigger` IN (`'prepare'`,`'regenerate'`,`'retry'`));
    - `failure_code` TEXT;
    - `failure_message` TEXT;
    - `requested_at` TEXT NOT NULL;
    - `started_at` TEXT;
    - `finished_at` TEXT.
  - Required indexes:
    - `idx_context_packages_goal_created` ON `context_packages(goal_id, created_at DESC)`.
    - `idx_context_assemblies_goal_requested` ON `context_assemblies(goal_id, requested_at DESC)`.
    - `idx_context_assemblies_status_requested` ON `context_assemblies(status, requested_at)`.
    - `idx_context_assemblies_active_fingerprint` UNIQUE ON `context_assemblies(goal_id, request_fingerprint) WHERE status IN ('pending','running','succeeded')`.
  - Existing-table change:
    - `ALTER TABLE sessions ADD COLUMN context_package_id TEXT REFERENCES context_packages(id) ON DELETE SET NULL`.
    - `CREATE INDEX idx_sessions_context_package ON sessions(context_package_id) WHERE context_package_id IS NOT NULL`.

- Register migration `0006_context.sql` in the daemon migration list so it runs in order after `0005_memory.sql`.

- Add migration tests in `apps/daemon`:
  - fresh DB migration creates expected tables/columns/indexes;
  - upgrade from a fixture M5 DB applies the migration without data loss;
  - active-fingerprint unique index prevents two simultaneous `pending` rows with the same `request_fingerprint`;
  - `sessions.context_package_id` accepts NULL and a valid FK; SET NULL on package delete;
  - role CHECK rejects unknown role; status CHECK rejects unknown status.

**Affected Areas.**
- `apps/daemon/migrations/0006_context.sql`.
- `apps/daemon/migrations/index.ts` (or whatever registers migrations).
- `apps/daemon/test/migrations-0006.test.ts`.

**Dependencies.** M6-000, M6-001.

**Acceptance Criteria.**
- Migration script runs cleanly on a fresh DB and on an M5 fixture DB.
- Indexes match the spec; constraint checks reject invalid roles/statuses.
- `sessions.context_package_id` column exists with FK + partial index.
- Migration tests pass via `pnpm --filter @orca/daemon test -- migrations-0006`.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- migrations-0006`.
- Quick targeted typecheck: `pnpm --filter @orca/daemon typecheck`.

**Risks / Notes.**
- Do NOT create a `context_package_sources` table. Source attribution lives in `context_packages.sources_json` for M6.
- Partial unique index syntax: confirm SQLite version supports `WHERE` clause indexes (M1 already uses them; reuse the same idiom).
- Do not add cascading delete from `context_packages` to `sessions`. Use SET NULL so M4 session rows are not lost if a package is later deleted (no delete endpoint in M6, but the FK behavior is set conservatively).

**Suggested model:** GPT 5.4 / Codex.

---

### M6-003 — Context Projection Reads/Writes

**Purpose.** Implement the durable read/write helpers for `context_packages`, `context_assemblies`, and the session join. Prove storage and restart survival before any assembler or use-case logic depends on them.

**Scope.**
- IS: `apps/daemon/src/context/projection.ts` (or equivalent) — insert/get/list/update helpers and JSON (de)serialization for `sources_json`/`warnings_json`; tests using file-backed SQLite to prove restart-survival.
- IS NOT: assembler, renderer, input builder, selection rules, HTTP routes, use cases beyond direct row manipulation, adapter changes, desktop changes.

**Requirements.**

- Implement projection helpers:
  - `insertContextPackage(tx, row): ContextPackageRow`.
  - `insertContextAssembly(tx, row): ContextAssemblyRow`.
  - `updateAssemblyStarted(tx, id, startedAt)`.
  - `updateAssemblySucceeded(tx, id, { packageId, finishedAt })`.
  - `updateAssemblyFailed(tx, id, { failureCode, failureMessage, finishedAt })`.
  - `getContextPackageById(db, id): ContextPackage | null`.
  - `listContextPackagesByGoal(db, goalId, { sessionId?, adapterId?, limit }): { packages, assemblies }`.
  - `getActiveAssemblyByFingerprint(db, goalId, requestFingerprint): ContextAssemblyRow | null` — used by use cases for idempotency.
  - `getAssembliesByStatus(db, status[]): ContextAssemblyRow[]` — used by reconciliation.
  - `setSessionContextPackageId(tx, sessionId, packageId)`.

- Encode/decode rules:
  - `sources_json` and `warnings_json` are JSON-encoded `ContextSourceRef[]` and `string[]`.
  - Round-trip uses zod for validation on read; corrupted JSON returns a clear error rather than crashing.

- Add tests in `apps/daemon/test/context-projection.test.ts` covering:
  - insert + read of a `context_packages` row preserves `sources_json`/`warnings_json`/`truncated`/`sparse` flags;
  - file-backed DB closed + reopened still returns the row;
  - `listContextPackagesByGoal` orders by `created_at DESC`, respects `limit`, and joins recent `context_assemblies` for the same Goal;
  - `getActiveAssemblyByFingerprint` returns rows in `pending`/`running`/`succeeded` and ignores `failed`;
  - `setSessionContextPackageId` updates the FK and the index responds to lookups;
  - reading a session row returns the new `contextPackageId` field.

**Affected Areas.**
- `apps/daemon/src/context/projection.ts`.
- `apps/daemon/src/context/types.ts` (if internal row types are split out).
- `apps/daemon/test/context-projection.test.ts`.
- minor extension to `apps/daemon/src/sessions/projection.ts` (or equivalent) to read `context_package_id`.

**Dependencies.** M6-001, M6-002.

**Acceptance Criteria.**
- Projection tests pass with file-backed SQLite.
- Row round-trip preserves all M6 fields and JSON arrays.
- Closing and reopening the DB returns identical rows.
- Existing session reads compile with the new optional `contextPackageId` field.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- context-projection`.
- `pnpm --filter @orca/daemon typecheck`.

**Risks / Notes.**
- Do not introduce new write paths that bypass the helpers. All inserts/updates must take a `tx` argument so they can be composed atomically by use cases.
- Validate `sources_json` shape on read with zod to catch any future drift; failure should return a structured error, not throw uncaught.
- Keep helpers row-oriented (input = row, output = row); do not perform fingerprint computation, redaction, or rendering in this module.

**Suggested model:** Sonnet 4.6.

---

### M6-004 — Assembly State, Events, and Idempotency With Fake Assembler

**Purpose.** Implement the `requestContextPackage` use case end-to-end against a **fake** assembler. Prove atomic commit-and-broadcast, idempotency by `request_fingerprint`, and the exact event sequence before tackling the deterministic input/selection/render pipeline.

**Scope.**
- IS: `apps/daemon/src/context/usecases.ts` for `requestContextPackage(input)`; in-memory fake assembler implementing `SessionPreparationAssembler` returning a fixed valid output; commit-success and commit-failure transaction orchestration; event emission; idempotency.
- IS NOT: real input builder, real selection rules, deterministic assembler, renderer, HTTP routes, adapter delivery, desktop.

**Requirements.**

- Implement the `SessionPreparationAssembler` interface in `apps/daemon/src/context/assembler.ts` and export a `FakeContextAssembler` test helper that returns a fixed `ContextAssemblyOutput` with two sources and one warning. The fake exposes overrides to simulate `output_too_large`, `invalid_output`, and `internal_error`.

- Implement `requestContextPackage({ goalId, adapterId, workspaceId, role, objective, replacePackageId, trigger })`:

  - Validate `goalId` exists and is not archived → otherwise emit a failed assembly with `goal_archived` and return.
  - Compute `objectiveHash = sha256(normalizedObjective)`.
  - Use a **stub** source-fingerprint for this task (constant or hash of inputs) — M6-006/M6-007 will replace with a real fingerprint. Document this clearly inline.
  - Compute `requestFingerprint` per the documented formula.
  - Idempotency:
    - `getActiveAssemblyByFingerprint` → if present, return `{ assembly, package: package_id ? getContextPackageById(...) : null, reused: true }` and emit NO new events.
  - Insert `context_assemblies` row with `status='pending'`.
  - Emit `context.assembly.requested`.
  - Transition `pending → running` (in-memory only for the fake/synchronous M6 path; the `started_at` timestamp is set inside the same transaction as the eventual commit).
  - Invoke the assembler with `ContextAssemblyInput` (M6-004 builds a stub input; later tasks replace it).
  - On assembler success:
    - validate output shape with zod;
    - enforce hard cap (`renderedBytes ≤ 32768`); if exceeded, fail with `output_too_large`;
    - insert `context_packages` row;
    - update assembly → `succeeded` with `package_id`, `started_at`, `finished_at`;
    - append events: `context.assembly.completed`, `context.package.created`;
    - commit; **only then** broadcast events.
  - On assembler failure (thrown error or invalid output):
    - update assembly → `failed` with appropriate `failureCode` (`invalid_output`, `internal_error`) and capped/redacted `failure_message`;
    - append event: `context.assembly.failed`;
    - commit; broadcast.
  - Return `{ assembly, package, reused }`.

- Wire the use case through `DaemonContext`. Production wiring uses the real deterministic assembler (added later); tests inject `FakeContextAssembler`.

- Tests in `apps/daemon/test/context-usecases.test.ts`:
  - Happy path: pending row created, assembly transitions to succeeded, package row exists, events appear in order `requested`, `completed`, `package.created`.
  - Events recorded in same transaction; broadcast spy is NOT called before commit (use a transaction hook or commit-spy pattern already used in M5).
  - Idempotency: two consecutive calls with identical inputs produce one assembly + one package; second response carries `reused: true` and no new events.
  - Retry after failure: a previous `failed` row does NOT block a new request with the same fingerprint; a new assembly row is created (status `succeeded` or `failed`).
  - Failure path: assembler throws → assembly row `failed` with `internal_error`; no package row; `context.assembly.failed` event committed.
  - Oversize path: fake returns rendered context > 32 KiB → `output_too_large`; no package.
  - Goal archived path: `goal_archived` failure code; no package; assembly row created.
  - Event payload shape: assert no event payload contains `renderedContext`, `objective`, `memoryContent`, or other forbidden fields.

**Affected Areas.**
- `apps/daemon/src/context/assembler.ts` (interface + fake).
- `apps/daemon/src/context/usecases.ts`.
- `apps/daemon/src/context/types.ts`.
- `apps/daemon/src/context/index.ts` exports.
- `apps/daemon/test/context-usecases.test.ts`.
- `apps/daemon/src/daemon-context.ts` (or equivalent) — add `contextAssembler` slot.

**Dependencies.** M6-003.

**Acceptance Criteria.**
- `pnpm --filter @orca/daemon test -- context-usecases` passes.
- Events fire in the order specified, with content-free payloads.
- Idempotency holds for active fingerprint; retry after failure produces a new row.
- Commit-then-broadcast invariant is asserted in tests.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- context-usecases`.
- `pnpm --filter @orca/daemon typecheck`.

**Risks / Notes.**
- Keep the use case orchestration small and synchronous. No queue, no worker, no async retry.
- Source fingerprint stub MUST be replaced in M6-006 before HTTP routes ship.
- Tests must not depend on real Goal/refinement/memory rows yet — use minimal stubs through the existing M1 projection seam.
- Failure path must redact `failure_message` per the M5 redaction rules.

**Suggested model:** Sonnet 4.6.

---

### M6-005 — Boot Reconciliation For Stale Assemblies

**Purpose.** Ensure daemon boot resolves any `pending`/`running` `context_assemblies` rows left behind by a previous crash or shutdown. Without this, the UI could indefinitely show "preparing context" for assemblies that will never complete.

**Scope.**
- IS: `apps/daemon/src/context/reconcile.ts` implementing `reconcileStaleAssemblies(db, now)`; wiring into the existing boot sequence **before** HTTP/WebSocket listen; tests using a file-backed DB.
- IS NOT: HTTP routes, runtime cancellation, queue infrastructure, assembler invocation.

**Requirements.**

- Implement `reconcileStaleAssemblies(deps)`:
  - Open one SQLite transaction.
  - Query `context_assemblies WHERE status IN ('pending','running')`.
  - For each row:
    - update `status='failed'`, `failure_code='daemon_restart'`, `failure_message='daemon restarted while assembly was in flight'`, `finished_at=now`;
    - append `context.assembly.failed` event with payload `{ assemblyId, goalId, failureCode: 'daemon_restart' }`.
  - Commit.
  - After commit, broadcast (defer broadcast until the WebSocket server is ready; M1 already supports a "queued broadcast on listen" pattern — reuse it).

- Wire into daemon boot:
  - Run after migrations and before HTTP server `listen`.
  - Use the existing M4/M5 reconciliation slot (M4 reconciles PTY sessions; M5 reconciles extractions; M6 reconciles context assemblies). Order: migrations → M4 → M5 → M6 → HTTP listen.

- Tests in `apps/daemon/test/context-reconcile.test.ts`:
  - File-backed DB containing two `pending` and one `running` row; after `reconcileStaleAssemblies`, all three are `failed/daemon_restart` and three `context.assembly.failed` events were appended.
  - Already `succeeded` and `failed` rows are untouched.
  - Reconciliation is idempotent (running it twice does nothing the second time).
  - Reconciliation runs before HTTP listens (assert ordering via a boot-instrumentation hook or sequence assertion).

**Affected Areas.**
- `apps/daemon/src/context/reconcile.ts`.
- `apps/daemon/src/boot.ts` (or equivalent boot composition root).
- `apps/daemon/test/context-reconcile.test.ts`.

**Dependencies.** M6-003, M6-004.

**Acceptance Criteria.**
- Tests pass via `pnpm --filter @orca/daemon test -- context-reconcile`.
- Stale rows become `failed/daemon_restart` in one transaction; failure events follow.
- Reconciliation is invoked before HTTP listen.
- Existing M4/M5 reconciliation behavior remains intact.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- context-reconcile`.
- Run M4 and M5 integration anchors locally to confirm no regression in reconciliation ordering.

**Risks / Notes.**
- Do not broadcast events before subscribers are ready; reuse the existing queued-broadcast pattern.
- Reconciliation must be a single transaction so a crash mid-reconcile leaves the DB consistent.
- Failure message is capped at 256 chars — reuse the M5 cap helper.

**Suggested model:** Sonnet 4.6.

---

### M6-006 — Bounded Input Builder

**Purpose.** Build `ContextAssemblyInput` strictly from M3/M5 projection reads with explicit per-source caps and best-effort redaction. Enforce — at the code-organization level — that M4 output tails and full transcripts are never read by M6 context assembly.

**Scope.**
- IS: `apps/daemon/src/context/input.ts` implementing `buildContextAssemblyInput(deps, request)`; the real source-fingerprint computation; redaction at the input boundary; tests for sparse/missing/oversized/archived/no-transcript cases.
- IS NOT: selection rules (M6-007), assembler/renderer (M6-008), HTTP routes, adapter delivery.

**Requirements.**

- Implement `buildContextAssemblyInput(deps, { goalId, workspaceId?, role, adapterId, objective })`:
  - Read Goal row (existing M1 projection).
  - Read latest refinement (existing M3 projection). If no refinement exists, set `refinement` to `null` and add a warning candidate `"goal_not_refined"` for the assembler.
  - Read attached workspace metadata only if `workspaceId` is provided AND attached to this Goal (existing M3 workspace_attachments). Use only already-known M3 metadata — DO NOT call git or scan the filesystem. If workspace is missing/foreign, return `null` and add a warning candidate.
  - Read M5 `goal_memory_items` for this Goal (existing M5 projection). Apply per-item caps (each content ≤ 4000 chars already enforced by M5; reapply redaction).
  - Read M5 `goal_decisions` for this Goal.
  - Read M5 `session_summaries` for this Goal whose source `sessions.archived_at IS NULL` (existing M5 join).
  - Apply best-effort redaction (M5 regex set) to each text field before passing it to the assembler.
  - Compute `source_fingerprint = sha256(...)` over:
    - sorted `(memory_item.id + ':' + memory_item.updated_at + ':' + memory_item.content_hash)`,
    - sorted `(decision.id + ':' + decision.updated_at)`,
    - sorted `(session_summary.id + ':' + session_summary.created_at)`,
    - workspace id + name + branch + dirty (if known),
    - refinement id + version,
    - role + adapter id + objective hash,
    - assembler version.

- Add a **tail isolation test** in `apps/daemon/test/context-input-isolation.test.ts`:
  - Use a static check (e.g., AST/regex over the file) asserting `apps/daemon/src/context/input.ts` (and `selection.ts`, `assembler.ts`, `renderer.ts`) do NOT contain an import from any module path matching M4's output-tail module (e.g., `pty/output-tail`, `sessions/output`). The test fails fast if any future edit introduces such an import.

- Add fixture tests in `apps/daemon/test/context-input.test.ts`:
  - Empty Goal: only objective + warnings sections populated.
  - Sparse Goal (refinement only): warnings include `goal_has_no_memory`, `goal_has_no_decisions`, `goal_has_no_sibling_summaries`.
  - Oversized memory list (50 items): input builder still returns all rows (selection trims later); per-item content is capped.
  - Archived memory / decisions / sibling sessions: excluded from input.
  - Workspace missing/foreign: workspace input is `null`; warning recorded.
  - Redaction: a memory item containing `password=abc` is redacted before being passed to the assembler.
  - Source fingerprint deterministic: identical inputs produce identical fingerprints; changing one memory `updated_at` changes the fingerprint.

**Affected Areas.**
- `apps/daemon/src/context/input.ts`.
- `apps/daemon/src/context/fingerprint.ts` (small helper, optional).
- `apps/daemon/test/context-input.test.ts`.
- `apps/daemon/test/context-input-isolation.test.ts`.

**Dependencies.** M6-003, M6-004 (provides the consumer use case shape).

**Acceptance Criteria.**
- All input tests pass.
- Tail-isolation static check passes.
- Source fingerprint is stable for identical inputs and changes when any source-relevant field changes.
- No M4 output-tail module is imported under `apps/daemon/src/context/`.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- context-input`.
- `pnpm --filter @orca/daemon typecheck`.

**Risks / Notes.**
- Resist the urge to add ranking/relevance scoring here — that's M6-007.
- Resist the urge to read git or workspace files — use M3 metadata only.
- Do not log redacted-pre or redacted-post text.
- Fingerprint formula must match the documented rule exactly; downstream idempotency depends on it.

**Suggested model:** Sonnet 4.6 (with GPT 5.4 for fixture data).

---

### M6-007 — Deterministic Selection Rules

**Purpose.** Implement pure deterministic selection functions over the bounded input. Selection is what makes context "compact and useful" rather than "everything dumped." Confirmation-required decisions are pinned here.

**Scope.**
- IS: `apps/daemon/src/context/selection.ts` exporting `selectMemory`, `selectDecisions`, `selectSiblingSummaries`; pure functions taking input + role + budget; deterministic, stable-ordered outputs.
- IS NOT: rendering, assembler orchestration, HTTP routes.

**Requirements.**

- `selectMemory(input, role, budget): SelectedMemory[]`:
  - Always include: promoted constraints, promoted success_criteria, promoted architecture_notes.
  - Include if budget allows: promoted blocker, validation_result, assumption — ordered by recency.
  - Include open_question only for roles `architect`, `engineer`, `reviewer`.
  - Include promoted `note` only if recent and budget allows.
  - Never include archived items.
  - Candidate items only if `confidence ≥ 0.7` AND budget allows; mark `labelAsCandidate=true` for renderer.
  - Tie-break ordering: `(type priority, status, -createdAt, id ASC)` for deterministic ordering.
  - Hard count cap 30.

- `selectDecisions(input, role, budget): SelectedDecisions`:
  - Output is `{ needsConfirmation: Decision[], confirmed: Decision[], proposed: Decision[] }`.
  - `needsConfirmation`: every decision with `confirmation_required=true` AND `status='proposed'`. Always included regardless of budget pressure.
  - `confirmed`: `status='confirmed'`, ordered by `-confirmedAt`, then `id ASC`.
  - `proposed`: `status='proposed'` AND `confirmation_required=false`, included only if budget remains; ordered by `-createdAt`, `id ASC`.
  - Hard count cap across all three sub-lists: 20.

- `selectSiblingSummaries(input, role, budget): SelectedSummary[]`:
  - Order by `-createdAt`, `id ASC`.
  - Drop summaries whose source session is archived (already filtered by input builder, but double-check).
  - Hard count cap 5.
  - Per-summary text already capped by M5; selection does not re-cap.

- All three functions are PURE: no I/O, no clock, no randomness, no logging. Deterministic.

- Tests in `apps/daemon/test/context-selection.test.ts`:
  - Empty input → empty selections.
  - Many promoted memory items → cap at 30, stable ordering preserved.
  - Mixed status memory (promoted/candidate/archived) → archived excluded, candidates only above threshold.
  - Confirmation-required decisions always present even when budget tight.
  - Role-specific exclusion of `open_question` for `generalist` role.
  - Stable ordering: re-running with identical input produces identical output.
  - Sibling summaries cap respected; ordering by recency then id.

**Affected Areas.**
- `apps/daemon/src/context/selection.ts`.
- `apps/daemon/test/context-selection.test.ts`.

**Dependencies.** M6-006.

**Acceptance Criteria.**
- Tests pass.
- Functions are pure (no I/O imports).
- Selection is deterministic across runs.
- Confirmation-required decisions are always present in `needsConfirmation`.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- context-selection`.
- `pnpm --filter @orca/daemon typecheck`.

**Risks / Notes.**
- No semantic scoring, no embedding, no LLM-based selection.
- Resist adding "relevance" parameters; deterministic rules only.
- Ensure tie-breakers exist for every ordering — otherwise SQLite or Map iteration order may vary across platforms.

**Suggested model:** GPT 5.4 / Codex (bounded pure-function work).

---

### M6-008 — Deterministic Assembler And Renderer

**Purpose.** Produce the role-aware sectioned plaintext from selected sources, render to the final canonical context, enforce caps and warnings, validate output, and emit source refs aligned with inline markers. This is the heart of M6.

**Scope.**
- IS: `apps/daemon/src/context/deterministic-assembler.ts` implementing `SessionPreparationAssembler`; `apps/daemon/src/context/renderer.ts` producing canonical sectioned plaintext; small snapshot tests per role; cap/failure tests; marker/source-ref alignment tests; replacing `FakeContextAssembler` in production wiring.
- IS NOT: HTTP routes, adapter framing helpers (added in M6-011 if needed), desktop UI.

**Requirements.**

- Implement `DeterministicAssembler` (version literal, e.g., `'0.1.0'`):
  - Invoke selection (M6-007).
  - Build sections in role-aware order:
    - `architect`: Objective, Refinement, Decisions, Memory, Sibling Sessions, Workspace, Notes.
    - `engineer`: Objective, Workspace, Refinement, Memory, Decisions, Sibling Sessions, Notes.
    - `reviewer`: Objective, Decisions, Memory, Sibling Sessions, Refinement, Workspace, Notes.
    - `generalist`: Objective, Refinement, Memory, Decisions, Sibling Sessions, Workspace, Notes.
  - Each section produced by a small pure rendering function (`renderObjective`, `renderRefinement`, `renderWorkspace`, `renderMemory`, `renderDecisions`, `renderSiblingSummaries`, `renderNotes`).
  - Inline markers: `[mem:<id>]`, `[dec:<id>]`, `[sum:<id>]`, `[ref:<id>]`, `[ws:<id>]`, `[goal:<id>]`.
  - Each marker corresponds to one `ContextSourceRef` entry; markers and refs are 1:1 on unique ids.
  - Sections that exceed per-section cap (8 KiB) drop lowest-priority items first and set `truncated=true` and append a warning.
  - Global cap (32 KiB): if exceeded after dropping low-priority items, fail with `output_too_large`.
  - Confirmation-required decisions are NEVER dropped to stay within budget; failing instead is the correct outcome.
  - `sparse=true` when input has no memory, no decisions, no sibling summaries (Objective+Refinement only).
  - `warnings` are short strings (≤ 200 chars, max 10) such as `goal_not_refined`, `no_promoted_memory`, `no_decisions`, `no_sibling_summaries`, `truncated_low_priority`.

- Implement the renderer (`renderer.ts`):
  - Produce a final newline-terminated canonical plaintext (the value stored in `context_packages.rendered_context`).
  - Headers like `# Objective`, `# Decisions — Needs confirmation`, `# Memory`. Avoid Markdown features that some terminals can't show; plain ASCII is fine.
  - Run M5-compatible redaction on every section body before emitting (defense in depth — input builder already redacts).
  - Compute `renderedBytes` (UTF-8 byte length) and `estimatedTokens = Math.ceil(renderedBytes/4)`.

- Wire the deterministic assembler into the production `DaemonContext`. Tests continue to inject the fake.

- Tests in `apps/daemon/test/context-assembler.test.ts`:
  - Snapshot per role with the same small fixture input; verify section order differs and section bodies are identical across roles.
  - Markers map 1:1 to sources; no dangling marker; no dangling source.
  - Confirmation-required pinning under tight budget: drops candidate memory + sibling summaries first; renders confirmation block intact.
  - `output_too_large` when confirmation block alone exceeds 32 KiB.
  - `truncated` flag set when low-priority drop occurred.
  - `sparse` flag set when no memory/decisions/summaries available.
  - Output passes the M6-001 zod schema validation.

- Tests in `apps/daemon/test/context-renderer.test.ts`:
  - Byte counting matches `Buffer.byteLength(rendered, 'utf8')`.
  - Redaction is applied to rendered output.
  - No marker leakage between sections.

**Affected Areas.**
- `apps/daemon/src/context/deterministic-assembler.ts`.
- `apps/daemon/src/context/renderer.ts`.
- `apps/daemon/src/context/assembler.ts` (interface exports + production wiring).
- `apps/daemon/src/daemon-context.ts` (swap in deterministic assembler).
- `apps/daemon/test/context-assembler.test.ts`.
- `apps/daemon/test/context-renderer.test.ts`.

**Dependencies.** M6-006, M6-007.

**Acceptance Criteria.**
- All targeted tests pass.
- Markers and source refs are 1:1.
- Caps and warning flags behave per spec.
- Confirmation-required decisions are pinned; `output_too_large` raised when required content cannot fit.
- M6-004's use-case tests still pass with deterministic assembler in place (when explicitly opted-in by test wiring), plus the fake path remains usable.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- context-assembler context-renderer context-usecases`.
- `pnpm --filter @orca/daemon typecheck`.

**Risks / Notes.**
- Snapshot tests should use very small fixtures to avoid noisy diffs.
- Avoid any locale-sensitive sort; use byte-comparison or `String.prototype.localeCompare('en')` with explicit options.
- Do not introduce a tokenizer dependency for `estimatedTokens` — the heuristic is enough.
- Do not embed package id or timestamps in the rendered context (would break fingerprint stability and reproducibility).

**Suggested model:** Sonnet 4.6.

---

### M6-009 — HTTP Routes For Context Packages

**Purpose.** Expose the three M6 context routes so the desktop (and future M7 readers) can drive context preparation, listing, and detail reads against the deterministic assembler.

**Scope.**
- IS: `POST /v1/goals/:goalId/context-packages`, `GET /v1/goals/:goalId/context-packages`, `GET /v1/context-packages/:id` route handlers; zod-driven request/response validation; standard error mapping; HTTP tests.
- IS NOT: session create extension (M6-010), adapter delivery (M6-011), WebSocket commands (none for M6), regenerate endpoint (rejected), `GET /v1/sessions/:sessionId/context` (rejected).

**Requirements.**

- Add route handlers in `apps/daemon/src/context/routes.ts` (or wherever the existing route style places them).

- `POST /v1/goals/:goalId/context-packages`:
  - Request: `CreateContextPackageRequest`.
  - Validate `goalId` path param matches an existing non-archived Goal.
  - Validate `adapterId` exists in the adapter registry.
  - Validate `role` matches the four-value enum.
  - Validate `workspaceId` if present is attached to the Goal.
  - Validate `replacePackageId` if present belongs to the same Goal and is a `ready` package.
  - Trigger:
    - `replacePackageId` provided → `trigger='regenerate'`;
    - latest assembly for this fingerprint was `failed` → `trigger='retry'`;
    - otherwise → `trigger='prepare'`.
  - Call `requestContextPackage(...)` use case.
  - Response:
    - 200 + `reused: true` if an existing active package was returned.
    - 201 + `reused: false` on first synchronous creation.
    - 200 + `assembly.status='failed'` + `package: null` when assembly failed; do NOT return 5xx for assembler failures.
    - 400 for request validation errors.
    - 404 for unknown Goal / adapter / workspace / replacePackageId.
    - 409 for archived Goal.

- `GET /v1/goals/:goalId/context-packages`:
  - Query params: `sessionId?`, `adapterId?`, `limit?` (default 20, max 50).
  - Returns latest packages and recent assemblies for the Goal so the UI can show failed/pending states.

- `GET /v1/context-packages/:id`:
  - Returns one package with full rendered context and compact source refs.
  - 404 if not found.

- Tests in `apps/daemon/test/context-routes.test.ts`:
  - Happy path create returns 201, package fields, and reused=false.
  - Duplicate identical create returns 200 + reused=true and no new events.
  - Retry after failed assembly returns 200/201 + new assembly id.
  - Regenerate path passes `replacePackageId`; resulting package has `supersedesPackageId` set.
  - List endpoint orders by `created_at DESC` and respects `limit`.
  - Detail endpoint returns rendered context and source refs.
  - 4xx/5xx mapping for invalid role, unknown adapter, archived Goal, foreign workspace, foreign `replacePackageId`.

**Affected Areas.**
- `apps/daemon/src/context/routes.ts`.
- `apps/daemon/src/server.ts` (route registration only; preserve the M2 registry-before-listen pattern).
- `apps/daemon/test/context-routes.test.ts`.

**Dependencies.** M6-004, M6-008.

**Acceptance Criteria.**
- Routes return the documented status codes.
- HTTP request/response shapes match the contracts.
- Events emitted by the use case are observable via the existing event bus spy.
- 4xx mapping covers all listed validation paths.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- context-routes`.
- `pnpm --filter @orca/daemon typecheck`.

**Risks / Notes.**
- Do NOT add `POST /v1/context-packages/:id/regenerate`. Use `replacePackageId` on the create endpoint.
- Do NOT add `GET /v1/sessions/:sessionId/context`. The session read response (extended in M6-010) carries `contextPackageId`, and the UI calls `GET /v1/context-packages/:id`.
- Do NOT accept `assembleContext` on `POST /v1/sessions` — the two-step flow is intentional.
- Validate `adapterId` against the registry's snapshot taken at boot — no hot lookups.

**Suggested model:** Sonnet 4.6.

---

### M6-010 — Session Create Link

**Purpose.** Extend `POST /v1/sessions` to accept an optional `contextPackageId`, store it on the session row, and include it on reads and the `session.created` event. Preserve the no-context M4 path byte-identically. **Full-suite gate** runs here.

**Scope.**
- IS: session create handler extension; session read response extension; `session.created` payload extension; integration tests for no-context / valid / foreign / archived / missing package; full-suite typecheck and test.
- IS NOT: adapter delivery (M6-011), desktop changes, WebSocket commands.

**Requirements.**

- Extend `POST /v1/sessions` handler:
  - Accept optional `contextPackageId`.
  - If present:
    - Validate the package exists.
    - Validate `package.goalId` matches the Goal implied by the session create request (the session is being created for the same Goal).
    - Validate `package.status === 'ready'`.
    - Validate `package.adapterId === request.adapterId` (a package prepared for `claude-code` cannot be used to start an `opencode` session). Note: the milestone plan favors strict matching; if a future change loosens this, do so explicitly.
    - Validate `package.workspaceId == null || package.workspaceId === request.workspaceId`.
    - On any mismatch: 400 with a structured error code (e.g., `context_package_mismatch`).
  - Store `sessions.context_package_id = contextPackageId` in the same transaction as session creation.
  - Include `contextPackageId` in the `session.created` event payload.
  - Return the session row with `contextPackageId` populated.

- Update session read endpoints to include `contextPackageId` (or null).

- Preserve the no-context path:
  - When `contextPackageId` is absent, the session create must behave identically to M4 — same row shape (except the new nullable column), same event payload (except the new optional field).

- Integration tests in `apps/daemon/test/context-session-link.test.ts`:
  - No-context session creation behaves identically to M4 (event payload diff is the optional `contextPackageId: null`).
  - Valid context: session row has `context_package_id`, event payload carries it, GET returns it.
  - Foreign Goal package: 400 with `context_package_mismatch`.
  - Foreign adapter package: 400.
  - Missing package id: 404.
  - Archived Goal (the session's): existing behavior; M6 does not loosen this.

- Run full-suite tests: `pnpm -r typecheck && pnpm -r test`. All M1–M5 anchors plus M6-001..M6-010 must pass.

**Affected Areas.**
- `apps/daemon/src/sessions/routes.ts` (or equivalent).
- `apps/daemon/src/sessions/usecases.ts`.
- `apps/daemon/src/sessions/projection.ts` (read extension).
- `apps/daemon/test/context-session-link.test.ts`.

**Dependencies.** M6-009.

**Acceptance Criteria.**
- Session create with `contextPackageId` stores the FK and emits the extended event.
- No-context session create preserves M4 byte-identical behavior except for the new optional event field (which is `null`).
- Mismatch validation returns documented 4xx codes.
- `pnpm -r typecheck` and `pnpm -r test` are green at the end of this task.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- context-session-link`.
- `pnpm -r typecheck`.
- `pnpm -r test`.

**Risks / Notes.**
- Resist adding `assembleContext` inline. The user-driven two-step flow is the M6 design.
- The mismatch check on `adapterId`/`workspaceId` is intentionally strict; it prevents preview/use confusion.
- Keep the session.created payload diff backwards-compatible: existing consumers parsing the event ignore unknown optional fields.

**Suggested model:** Sonnet 4.6.

---

### M6-011 — Adapter Delivery

**Purpose.** Wire actual context delivery into the M4 adapter startup path while staying conservative about which adapters claim auto-delivery vs `preview_only`. No rendered context bytes in argv/env/logs anywhere.

**Scope.**
- IS: `AdapterContextDelivery` metadata on adapter descriptors; delivery dispatch in the adapter startup branch; temp-file writer with mode `0600`; cleanup on terminal-state and best-effort on boot; per-adapter tests using M4 fakes; explicit `preview_only` fallback for any adapter without a verified safe startup surface.
- IS NOT: invention of new CLI flags for Claude Code / opencode / codex; desktop UI changes.

**Requirements.**

- Add `contextDelivery: AdapterContextDelivery` to adapter descriptors:

  ```ts
  interface AdapterContextDelivery {
    mode: 'initial_input' | 'context_file' | 'preview_only';
    contextFileEnvVar?: string;  // only when mode === 'context_file' via env path
    contextFileArgFlag?: string; // only when mode === 'context_file' via argv path
    maxBytes: number;            // typically 32768
  }
  ```

- Implement delivery dispatch in the adapter startup branch:
  - `initial_input` (shell/manual only): after PTY spawn, write the rendered context to PTY stdin followed by a terminator visible to the user (`# END ORCA CONTEXT\n`). No file is written.
  - `context_file` (only when the adapter has a VERIFIED safe startup surface):
    - write rendered context to `${dataDir}/sessions/<sessionId>/context.txt` with mode `0600`;
    - pass the **file path** via the declared `contextFileArgFlag` or `contextFileEnvVar`. Never pass the content.
    - Use `O_CREAT|O_EXCL|O_WRONLY` (or equivalent) so a stale file cannot be silently overwritten.
  - `preview_only`: do not deliver; the package is rendered and persisted but no PTY input or file write happens. Adapter starts as in M4. The session record still carries `contextPackageId` for UI display.

- Initial per-adapter mode assignments for M6:
  - `shell-manual` → `initial_input`.
  - `claude-code` → `preview_only` unless a verified CLI surface is documented in the M4 implementation (do NOT invent flags; check the M4 implementation plan and notes). If verified, use `context_file` with the documented flag.
  - `opencode` → `preview_only` unless a verified safe startup is documented.
  - `codex` → `preview_only` unless a verified safe startup is documented.

- Argv/env safety:
  - Implement a defensive check that fails the session create with `delivery_unavailable` if any element of `argv` or `env` value would equal the rendered context string (defensive against future regressions). Use string-equality or substring-equality against the first 1 KiB of rendered content.

- Logging safety:
  - Never log the rendered context.
  - Never log the temp-file path.
  - Log only `{ sessionId, adapterId, deliveryMode, contextPackageId, bytes }`.

- Cleanup:
  - On session terminal-state, delete the per-session `context.txt` if present.
  - On daemon boot, sweep `${dataDir}/sessions/*/context.txt` for sessionIds no longer present in `sessions` table (best-effort).

- Tests in `apps/daemon/test/context-delivery.test.ts`:
  - shell/manual: rendered context is sent to PTY stdin via the M4 fake; argv and env do not contain the rendered content.
  - Adapters declared `preview_only`: no file is written; no PTY input is sent; session creation succeeds.
  - When `context_file` is declared (test fixture adapter): file is written with mode `0600`; argv contains the path; env does not contain the content (only the path if `contextFileEnvVar` is declared).
  - Defensive argv/env check fires if a misconfigured adapter attempts to inline rendered context.
  - Cleanup deletes the temp file on session terminal-state.
  - Boot sweep removes orphan files.

**Affected Areas.**
- `apps/daemon/src/adapters/*` (descriptor extensions).
- `apps/daemon/src/sessions/usecases.ts` (delivery dispatch on create).
- `apps/daemon/src/sessions/cleanup.ts` (temp file cleanup hook).
- `apps/daemon/test/context-delivery.test.ts`.

**Dependencies.** M6-010.

**Acceptance Criteria.**
- All delivery tests pass.
- No rendered context bytes appear in argv, env, or logs.
- Shell/manual delivers visibly; `context_file` writes mode-`0600` files; `preview_only` writes nothing.
- Cleanup tests pass for both terminal-state and boot sweep.
- Pre-existing M4 session tests pass unchanged.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- context-delivery`.
- `pnpm --filter @orca/daemon test -- sessions` (M4 regression).
- `pnpm --filter @orca/daemon typecheck`.

**Risks / Notes.**
- Do NOT invent or document unverified CLI flags. If Claude Code / opencode / codex do not expose a known-safe context-file flag, leave them as `preview_only` for M6. The M7 plan can add modes when surfaces are verified.
- `chmod 0600` may behave differently on Windows; document the platform assumption and accept best-effort on non-POSIX where mode bits are limited.
- Use the existing M4 fake adapter pattern to avoid spawning real subprocesses in tests.
- Failure to write the temp file before spawn must cause `delivery_unavailable` and rollback session creation — never spawn with promised context that wasn't delivered.

**Suggested model:** Sonnet 4.6.

---

### M6-012 — Desktop API Wrappers

**Purpose.** Add typed desktop wrappers for the three M6 context routes and extend the existing session-create wrapper with optional `contextPackageId`. Wrappers are the boundary the UI tasks build on.

**Scope.**
- IS: `apps/desktop/src/api/context.ts` exporting `createContextPackage`, `listContextPackages`, `getContextPackage`; updates to the existing `createSession` wrapper to accept optional `contextPackageId`; mocked API tests; typecheck.
- IS NOT: UI components (M6-013/M6-014/M6-015), live-event subscription wiring (M6-014/M6-015).

**Requirements.**

- Implement wrappers calling the daemon HTTP API. Reuse the existing fetch/error helpers in `apps/desktop/src/api/`.

- `createContextPackage(goalId, request: CreateContextPackageRequest): Promise<CreateContextPackageResponse>`.
- `listContextPackages(goalId, query?: ListContextPackagesQuery): Promise<ListContextPackagesResponse>`.
- `getContextPackage(packageId): Promise<GetContextPackageResponse>`.

- Extend `createSession(goalId, request: CreateSessionRequest)` to pass `contextPackageId` when present.

- Add tests in `apps/desktop/src/api/__tests__/context.test.ts`:
  - Wrappers serialize requests correctly and parse responses through the shared zod schemas.
  - Error responses propagate `failureCode`/`error` fields.
  - Type assertions confirm the wrapper return types match `packages/contracts` schemas.

**Affected Areas.**
- `apps/desktop/src/api/context.ts`.
- `apps/desktop/src/api/sessions.ts` (extension).
- `apps/desktop/src/api/__tests__/context.test.ts`.

**Dependencies.** M6-009, M6-010.

**Acceptance Criteria.**
- Wrappers compile against `packages/contracts` types.
- Mocked tests pass.
- Existing session creation flows continue to work with `contextPackageId` omitted.

**Validation Steps.**
- `pnpm --filter @orca/desktop test -- api/context`.
- `pnpm --filter @orca/desktop typecheck`.

**Risks / Notes.**
- Keep the wrapper thin; no UI state should leak in here.
- Do not couple wrappers to React hooks; UI tasks add the hooks.

**Suggested model:** GPT 5.4 / Codex.

---

### M6-013 — New-Session Context Controls

**Purpose.** Extend the existing Goal-detail new-session flow with role/objective inputs, a Prepare-context button, and a Skip-context button. Skip MUST preserve the M4 session create path byte-identically.

**Scope.**
- IS: a single `SessionCreateModal` (or equivalent existing entry-point) extension that adds: adapter selector (reused from M4), workspace selector (reused from M3/M4), role select (4 enum values), objective textarea (≤ 4000 chars), Prepare-context button, Skip-context button; component tests.
- IS NOT: preview/status/retry (M6-014), session badges (M6-015), live event subscription.

**Requirements.**

- Extend the existing new-session UI component(s) under `apps/desktop/src/goal-detail/`:
  - Add `<RoleSelect>` with the four roles.
  - Add `<ObjectiveTextarea>` with character count and 4000-char hard cap.
  - Two CTAs:
    - **Prepare context** → calls `createContextPackage(...)` and transitions the modal into "preparing" state (handled in M6-014).
    - **Skip context** → calls existing `createSession(...)` with no `contextPackageId`. Behavior identical to M4 except for the new optional event field carrying `null`.

- Validation:
  - `role` is required if Prepare-context is clicked.
  - `objective` is required if Prepare-context is clicked (min 4 chars, max 4000).
  - Adapter/workspace required as in M4.

- Component tests in `apps/desktop/src/goal-detail/__tests__/session-create-modal.test.tsx`:
  - Default state matches M4 (Skip + Prepare both visible, no preview area yet).
  - Skip-context path calls the existing `createSession` wrapper with the M4-shaped request.
  - Prepare-context path calls `createContextPackage` with the expected payload.
  - Validation: Prepare-context disabled when role/objective missing.
  - Objective textarea character counter at boundaries (0, 1, 3999, 4000).

**Affected Areas.**
- `apps/desktop/src/goal-detail/session-create-modal/` (or equivalent).
- `apps/desktop/src/goal-detail/__tests__/session-create-modal.test.tsx`.

**Dependencies.** M6-012.

**Acceptance Criteria.**
- Skip-context path preserves M4 behavior.
- Prepare-context path triggers the API wrapper with correct payload.
- Validation states match the spec.

**Validation Steps.**
- `pnpm --filter @orca/desktop test -- session-create-modal`.

**Risks / Notes.**
- Keep the modal layout incremental; avoid redesigning M4 surfaces.
- Do not introduce a route for "context preparation"; it remains a state of the existing modal.

**Suggested model:** Sonnet 4.6.

---

### M6-014 — Preview, Status, Retry, And Regenerate

**Purpose.** Render the prepared context package, show source counts and budget usage, surface assembly status (pending/running/ready/failed/sparse/truncated), and provide retry/regenerate actions. Subscribe to context events for live refresh.

**Scope.**
- IS: a `ContextPreviewPanel` (or equivalent) inside the existing session-create modal flow; source-count summary; budget bar; warning chips; retry/regenerate buttons; live-refresh wiring to the existing WebSocket event subscription for `context.*` events; component tests for all states.
- IS NOT: session-row badge (M6-015), source drawer with M5 lookups, package history/diff/editor.

**Requirements.**

- Add `<ContextPreviewPanel>` rendering:
  - Header row: `<role> · <adapter> · <bytes>/<32 KiB> · ~<tokens> tokens · <sourceCount> sources`.
  - Warning chips for each `warnings[]` entry (e.g., `goal_not_refined`, `no_sibling_summaries`, `truncated_low_priority`).
  - `Sparse` and `Truncated` indicators when the corresponding flags are true.
  - The rendered context body in a monospaced read-only block.
  - Source summary: counts grouped by type (`memory_item`, `decision`, `session_summary`, `refinement`, `workspace`, `goal`).
  - Action buttons: **Regenerate** (calls `createContextPackage` with `replacePackageId = currentPackageId`), **Retry** (called after assembly failure with same payload), **Start session** (advances the modal to launch with `contextPackageId`).

- States:
  - `idle` (no preparation triggered yet).
  - `preparing` (assembly `pending`/`running`).
  - `ready` (package available).
  - `failed` (assembly `failed`; display `failureCode` and friendly message; Retry visible).
  - `sparse` (package ready but `sparse=true`).
  - `truncated` (package ready but `truncated=true`).

- Live refresh:
  - Subscribe to existing Goal-scoped WebSocket channel for `context.assembly.requested`, `context.assembly.completed`, `context.assembly.failed`, `context.package.created`.
  - On any matching event for this Goal, refetch via `getContextPackage` or `listContextPackages` as appropriate.
  - Do NOT patch state from event payloads — refetch.

- Component tests in `apps/desktop/src/goal-detail/__tests__/context-preview-panel.test.tsx`:
  - Empty preview shows guidance to click Prepare-context.
  - Preparing state shows spinner; subsequent ready event transitions to ready.
  - Failed assembly with various failure codes (e.g., `output_too_large`, `internal_error`) shows the right copy and Retry button.
  - Sparse state shows the badge and "Context is thin" warning.
  - Truncated state shows the badge.
  - Regenerate calls the API with `replacePackageId`.
  - Retry calls the API with the same request and no `replacePackageId`.

**Affected Areas.**
- `apps/desktop/src/goal-detail/context-preview-panel/`.
- `apps/desktop/src/goal-detail/__tests__/context-preview-panel.test.tsx`.

**Dependencies.** M6-012, M6-013.

**Acceptance Criteria.**
- All preview states render correctly in component tests.
- Live event subscription triggers refetch; UI does not patch from payloads.
- Regenerate and retry call the API with the expected payloads.

**Validation Steps.**
- `pnpm --filter @orca/desktop test -- context-preview-panel`.

**Risks / Notes.**
- Cap fixture sizes in snapshots to avoid noisy diffs.
- Do not implement source-drawer lookups against M5 in M6; the source summary is counts + labels only.

**Suggested model:** Sonnet 4.6.

---

### M6-015 — Session Badge And Restart UI

**Purpose.** Surface context status on the session list (and any existing session detail surface) and verify the desktop reads persisted packages correctly after daemon restart.

**Scope.**
- IS: a small `<SessionContextBadge>` component shown on existing session rows; an unobtrusive context indicator on the existing session detail surface (if one exists); minimum reload behavior so the UI re-fetches packages after daemon reconnect; component tests; one daemon-desktop smoke check.
- IS NOT: a new session detail page (M4 owns that surface), context history, diff UI.

**Requirements.**

- Add `<SessionContextBadge>` shown on each session row whose `contextPackageId` is non-null:
  - States: `ready`, `sparse`, `truncated`, `preview-only`, `failed`, `none`.
  - Render a small label like `ctx: ready · 12.4 KiB · 9 sources` (sparse/truncated badges add a small icon).
  - `preview-only` is determined from the package's adapter delivery mode metadata (the daemon includes this on the package via the adapter descriptor; if the package's adapter has `mode='preview_only'`, the badge says `preview-only`).
  - `none` shown for sessions without a context package (subtle, e.g., a small "no context" hint or no badge at all per UX preference).

- On any existing session detail surface, show the package summary with a link to open the preview drawer/panel (reuse `<ContextPreviewPanel>` in read-only mode).

- Reload behavior:
  - On WebSocket reconnect after daemon restart, refetch the Goal's packages list and the current Goal's sessions list.
  - Surface a banner if any session's most-recent assembly is in `failed/daemon_restart` state.

- Component tests in `apps/desktop/src/goal-detail/__tests__/session-context-badge.test.tsx`:
  - States render correct labels.
  - Click on badge opens preview panel for the package.
  - Reconnect refetches.

- One smoke test (manual or scripted under `apps/desktop/test/manual/`):
  - Prepare a package, start a session, kill the daemon, restart, verify badge and preview still reflect the persisted package and the most-recent assembly.

**Affected Areas.**
- `apps/desktop/src/goal-detail/session-row/`.
- `apps/desktop/src/goal-detail/session-detail/` (if present from M4).
- `apps/desktop/src/goal-detail/__tests__/session-context-badge.test.tsx`.

**Dependencies.** M6-012, M6-014.

**Acceptance Criteria.**
- Badge renders in all documented states.
- Reload after daemon restart refetches packages and sessions.
- `preview-only` state visibly indicates the adapter did not auto-deliver context.

**Validation Steps.**
- `pnpm --filter @orca/desktop test -- session-context-badge`.
- Local manual smoke: kill daemon, restart, observe badge.

**Risks / Notes.**
- Resist enabling a marker drawer in M6; defer to a later UX milestone.
- Keep visual changes contained to existing session-row layout to avoid M4 regression.

**Suggested model:** Sonnet 4.6.

---

### M6-016 — End-To-End Proof Loop And Final Regression

**Purpose.** Execute the documented M6 proof loop end-to-end against a real daemon + desktop build and run the full regression suite. Verify Definition of Done items and update documentation. **Full-suite gate** runs here.

**Scope.**
- IS: one daemon integration test exercising the full proof loop; manual smoke checklist; final `pnpm -r typecheck` and `pnpm -r test`; documentation updates limited to M6 cross-references and the implementation notes file.
- IS NOT: new features, optional polish, scope expansion.

**Requirements.**

- Add `apps/daemon/test/context-proof-loop.integration.test.ts`:
  - Create a Goal; refine it; attach a workspace.
  - Seed M5 memory items (mix of promoted and candidate, including one confirmation-required decision and at least one archived row).
  - Seed an M5 sibling `session_summary` for the Goal.
  - Call `POST /v1/goals/:goalId/context-packages` with role=`engineer` and a real adapter id (the test fake adapter).
  - Assert events: `context.assembly.requested`, `context.assembly.completed`, `context.package.created` in commit order.
  - Assert package: `truncated=false`, `sparse=false`, contains `[mem:*]` and `[dec:*]` markers, confirmation-required decision appears under `Needs confirmation`.
  - Start a session: `POST /v1/sessions` with `contextPackageId`; assert `session.created` payload includes the id and the session row stores it.
  - Adapter delivery (using the test fake): assert the rendered context was delivered per the adapter's `mode`.
  - Restart the daemon (close + reopen file-backed DB; rerun boot reconciliation).
  - Assert: package and assembly rows persist; session still references the package; no stale `pending` assembly rows remain; the `failed/daemon_restart` reconciliation path does not fire for `succeeded` rows.

- Update documentation:
  - Add `docs/implementation-plans/notes/milestone-6-final.md` with: baseline SHA, final SHA, summary of validation, mapping of M6-001..M6-016 to PRs/commits, and any noted operational caveats.
  - Update `docs/milestones/6.md` Status to `Complete` only after M6-016 acceptance (this is the human gate at the end).

- Run full-suite tests:
  - `pnpm -r typecheck`.
  - `pnpm -r test`.

- Run the manual proof checklist from `docs/milestones/6.md` section 17.

**Affected Areas.**
- `apps/daemon/test/context-proof-loop.integration.test.ts`.
- `docs/implementation-plans/notes/milestone-6-final.md`.
- `docs/milestones/6.md` status line (final).

**Dependencies.** All prior M6 tasks.

**Acceptance Criteria.**
- Integration test passes.
- `pnpm -r typecheck` and `pnpm -r test` are green.
- Manual proof loop executed successfully.
- Definition of Done items in `docs/milestones/6.md` §18 are all checked.
- No M1–M5 regression.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- context-proof-loop`.
- `pnpm -r typecheck`.
- `pnpm -r test`.
- Execute the manual checklist with one refined Goal, one workspace, M5 fixtures, prepare/retry/regenerate, session start with package, preview-only adapter state, reload, and daemon restart.

**Risks / Notes.**
- Use fixed-clock and fixed-id factories in the integration test to keep snapshots stable.
- The manual checklist depends on a real UI build — schedule a brief human session for the smoke.
- Document any deviations between the spec and reality immediately in the final notes file rather than letting them drift.

**Suggested model:** Sonnet 4.6 for integration test + Human for manual proof + GPT 5.5 for final scope/non-goal review.

---

## Task Dependency Graph

```text
M6-000 (Baseline)
    |
    v
M6-001 (Contracts) ----------------------+
    |                                    |
    v                                    |
M6-002 (Migration) ----------------------+
    |                                    |
    v                                    |
M6-003 (Projections)                     |
    |                                    |
    +--> M6-004 (Use case + fake) -------+
    |        |
    |        v
    |    M6-005 (Reconciliation)
    |        |
    v        v
M6-006 (Input builder + fingerprint + tail-isolation)
    |
    v
M6-007 (Selection rules — pure)
    |
    v
M6-008 (Deterministic assembler + renderer)
    |
    v
M6-009 (HTTP routes)
    |
    v
M6-010 (Session create link) **FULL-SUITE GATE**
    |
    v
M6-011 (Adapter delivery)
    |
    +--> M6-012 (Desktop API wrappers)
    |        |
    |        v
    |    M6-013 (New-session context controls)
    |        |
    |        v
    |    M6-014 (Preview / status / retry / live refresh)
    |        |
    |        v
    |    M6-015 (Session badge + restart UI)
    |        |
    +--------+
             |
             v
         M6-016 (Proof loop + final regression) **FULL-SUITE GATE + HUMAN ACCEPTANCE**
```

### Parallelizable tasks

- M6-001 (Contracts) is the only task with no upstream; nothing else can run before it.
- M6-002 and M6-003 are sequential — projection helpers need the migrated schema.
- M6-007 (selection) and parts of M6-008 (renderer) can be drafted in parallel once M6-006 lands, but M6-008's assembler depends on M6-007 selection.
- M6-012 (Desktop API wrappers) can begin as soon as M6-009 ships and proceed in parallel with M6-011 (adapter delivery) since they touch disjoint code.
- M6-013, M6-014, M6-015 are sequential UI tasks (each depends on the previous component state).

### Blocking tasks

- M6-002 blocks M6-003 and everything downstream (no schema → no projection → no usecase).
- M6-006 blocks M6-007 and M6-008 (no bounded input → no real selection → no real assembler).
- M6-009 blocks M6-012 (no daemon route → nothing for wrapper to call).
- M6-010 blocks M6-011 (delivery dispatch requires session-create context awareness).
- M6-011 blocks the meaningful parts of M6-015 (preview-only state).

### Persistence gates

- **Persistence Gate A — M6-005 complete:** projections, atomic transactions, fake-assembled lifecycle, and reconciliation all verified before HTTP routes ship.
- **Persistence Gate B — M6-010 complete:** session link, full-suite typecheck and test green; ready to wire adapter delivery.

### Adapter-delivery gate

- **Adapter Gate — M6-011 complete:** no rendered context bytes in argv/env/logs; `0600` files for `context_file`; `preview_only` fallback verified for any adapter without a documented safe surface.

### Integration gates

- **Integration Gate — M6-014 complete:** desktop preview/status/retry wired to daemon API; live refresh against `context.*` events.

### Full-suite gates

- **Full-Suite Gate 1 — end of M6-010:** `pnpm -r typecheck && pnpm -r test`.
- **Full-Suite Gate 2 — end of M6-016:** `pnpm -r typecheck && pnpm -r test`.

---

## Suggested Model Assignment

| Task | Suggested model | Rationale |
|---|---|---|
| M6-000 | Human + Sonnet 4.6 | Verification + recording |
| M6-001 | Codex | Bounded schema work, low ambiguity |
| M6-002 | Codex | SQLite migration, explicit columns/indexes |
| M6-003 | Sonnet 4.6 | Projection helpers with transaction discipline |
| M6-004 | Sonnet 4.6 | Use-case orchestration + atomic events |
| M6-005 | Sonnet 4.6 | Boot reconciliation + ordering with M4/M5 reconcilers |
| M6-006 | Sonnet 4.6 | Bounded reads + fingerprint + tail-isolation |
| M6-007 | GPT 5.4 | Pure deterministic selection functions |
| M6-008 | Sonnet 4.6 | Role-aware assembler + renderer (medium complexity) |
| M6-009 | Sonnet 4.6 | HTTP routes + status mapping |
| M6-010 | Sonnet 4.6 | Session-create extension; preserves M4 behavior |
| M6-011 | Sonnet 4.6 | Adapter delivery + privacy invariants |
| M6-012 | Codex | Bounded API wrappers |
| M6-013 | Sonnet 4.6 | UI wiring on existing modal |
| M6-014 | Sonnet 4.6 | Preview/status/retry + live refresh |
| M6-015 | Sonnet 4.6 | Session badge + restart UI |
| M6-016 | Sonnet 4.6 (test) + Human (smoke) + GPT 5.5 (final review) | Full proof loop, manual smoke, scope/non-goal review |

Use Opus 4.7 only to resolve genuine architectural ambiguity that arises during execution (e.g., unexpected adapter surface decisions). Use GPT 5.5 specifically at review gates to detect overengineering and scope drift.

---

## Recommended Review Gates

### Gate 1 — After M6-002

- Reviewer: GPT 5.5 (or principal human reviewer).
- Verify:
  - Contracts cover all enums, row shapes, request/response shapes, and event payload shapes per the M6 plan.
  - Contracts reject content/text on event payloads.
  - Migration covers both new tables, the session column, indexes, and FK rules.
  - Upgrade path from the M5 fixture DB succeeds.
- Outcome: green before any daemon use-case code is written.

### Gate 2 — After M6-005

- Reviewer: Principal human or GPT 5.5.
- Verify:
  - Projection helpers preserve all fields including JSON arrays on file-backed restart.
  - Use case commits package, assembly, and events atomically.
  - Events are content-free; payload schemas reject rendered/raw fields.
  - Active-fingerprint idempotency holds; failed rows are excluded from active idempotency.
  - Boot reconciliation marks stale rows `failed/daemon_restart` before HTTP listens.
- Outcome: green before deterministic input/selection/assembler work begins.

### Gate 3 — After M6-008

- Reviewer: GPT 5.5 + Sonnet 4.6 (test author).
- Verify:
  - Input builder uses only bounded projection reads.
  - Tail-isolation check passes.
  - Selection is pure, deterministic, and confirmation-required-decision-pinned.
  - Assembler/renderer enforces caps, redaction, `truncated`, `sparse`, and `output_too_large` failure correctly.
  - Source refs map 1:1 to markers.
- Outcome: green before HTTP routes are exposed.

### Gate 4 — After M6-010

- Reviewer: Principal human + GPT 5.5.
- Verify:
  - Full-suite `pnpm -r typecheck && pnpm -r test` is green.
  - Routes return documented status codes and idempotent shapes.
  - `POST /v1/sessions` preserves M4 behavior in the no-context path.
  - Mismatched package/adapter/workspace rejected with structured 4xx codes.
  - Privacy invariants (events content-free, logger denylist) hold under integration tests.
  - No regression in M1–M5 anchors.
- Outcome: green before adapter delivery touches process startup.

### Gate 5 — After M6-011

- Reviewer: Security-attentive human + Sonnet 4.6.
- Verify:
  - No rendered context bytes in argv/env/logs.
  - `0600` permissions on context files where supported.
  - `preview_only` fallback documented per adapter; no invented CLI flags.
  - Cleanup on terminal-state and boot sweep behave as specified.
  - Defensive argv/env equality check fires when misconfigured.
- Outcome: green before desktop UI promises auto-delivery to the user.

### Gate 6 — After M6-015

- Reviewer: Human (UX smoke) + Sonnet 4.6.
- Manual smoke:
  - Refined Goal; attached workspace; M5 memory/decisions/session summaries seeded.
  - Prepare context; observe preview, source counts, warnings.
  - Trigger retry on a forced failure.
  - Regenerate (with `replacePackageId`); observe new package; old package remains.
  - Start session with `preview_only` adapter; verify badge state.
  - Start session with `initial_input` adapter (shell/manual); verify visible context in PTY.
  - Reload the desktop; observe state restoration.
  - Restart the daemon; observe `failed/daemon_restart` reconciliation if any assembly was in flight; observe `succeeded` packages persist.
- Outcome: green before final regression and acceptance.

### Gate 7 — After M6-016

- Reviewer: Human (acceptance) + GPT 5.5 (final scope/non-goal review).
- Verify:
  - All M6 Definition-of-Done items in `docs/milestones/6.md` §18 are checked.
  - Final docs (`docs/implementation-plans/notes/milestone-6-final.md`) reflect actual SHAs, validation, and any operational caveats.
  - No non-goal scope was introduced (recommendations, tasks, workflows, conflict detection, supervised execution, autonomy, cross-Goal memory, embeddings, provider config, prompt platform, package history/diff/editor UI).
- Outcome: M6 complete; ready for M7 to consume `context_packages` as a reader.

---

## Closing Notes

- The single biggest source of M6 regression risk is **the M4 session create path**. Every task that touches sessions (M6-010, M6-011, M6-015) must run M4 session regression locally before merging.
- The single biggest source of M6 privacy risk is **rendered context leaking into events, logs, argv, or env**. Tests must assert this at multiple layers (contracts in M6-001, use case in M6-004, adapter delivery in M6-011, integration in M6-016).
- The single biggest source of M6 scope creep is the temptation to start consuming context for recommendations or to wire AI providers. Both are out of scope. Keep the deterministic loop honest.
- Source attribution is intentionally stored as JSON on `context_packages` and not in a separate table. A future milestone may add `context_package_sources` when source reverse-lookup becomes a real product need.
- When an adapter's safe startup surface for `context_file` is uncertain, choose `preview_only`. The cost of a missed auto-delivery in M6 is small; the cost of a misformed CLI invocation that leaks context or breaks the agent is large.
