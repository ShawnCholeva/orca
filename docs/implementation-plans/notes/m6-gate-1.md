# M6 Gate 1 — After M6-003

Date: 2026-05-20
Reviewer: Codex (M6-001/M6-002), Sonnet 4.6 (M6-003 extension)
Baseline note: `docs/implementation-plans/notes/m6-000-baseline.md`
Baseline SHA: `31f24cd8a3c05511f486a5e9bac9d02860398bbf`
M6-001 SHA: `b362766`
M6-002 SHA: `8bbb629`
M6-003 SHA: (committed this session)

## Scope

Gate 1 verifies the M6-001 contract surface, M6-002 SQLite migration surface, and M6-003 context
projection helpers before daemon context use-case implementation begins.

## Validation Runs

### M6-001 and M6-002 (original gate — after 8bbb629)
- `pnpm --filter @orca/contracts test` → exit 0 (1 file, 36 tests)
- `pnpm --filter @orca/contracts typecheck` → exit 0
- `pnpm --filter @orca/daemon test -- migrations-0006` → exit 0 (1 file, 5 tests)
- `pnpm --filter @orca/daemon typecheck` → exit 0

### M6-003 extension
- `pnpm --filter @orca/contracts build` → exit 0 (rebuild after M6-001 source change)
- `pnpm --filter @orca/daemon test -- context-projection` → exit 0 (1 file, 17 tests)
- `pnpm --filter @orca/daemon typecheck` → exit 0
- `pnpm --filter @orca/daemon test` → exit 0 (54 files: 50 passed, 4 skipped; 587 tests: 582 passed, 5 skipped)
- All M1–M5 integration anchors included in full daemon suite pass

## Gate Checks

### Contracts (M6-001)
- Contracts cover the planned M6 enums, row shapes, request/response shapes, event payload shapes,
  session `contextPackageId` extension, and internal assembler I/O schemas.
- M6 event payload schemas are strict and tests reject forbidden content/text fields such as
  rendered context, objective, and assembler input.
- `CreateSessionRequest` accepts optional `contextPackageId`; `SessionSummary`/`SessionDetail`
  expose `contextPackageId` as `string | null | undefined`.

### Migration (M6-002)
- `0006_context.sql` creates `context_packages`, `context_assemblies`,
  `sessions.context_package_id`, and required indexes including the active request fingerprint
  partial unique index.
- Migration registration applies `0006_context.sql` after `0005_memory.sql`.
- Migration tests cover fresh DB creation, M5 upgrade without data loss, active fingerprint
  uniqueness, nullable session FK with `ON DELETE SET NULL`, and role/status CHECK constraints.
- No `context_package_sources` table created.

### Projection helpers (M6-003)
- `insertContextPackage` / `insertContextAssembly` serialize sources/warnings as JSON; read back
  with zod validation; `truncated`/`sparse` INTEGER ↔ boolean roundtrip verified.
- Closing and reopening the file-backed DB returns identical rows.
- `listContextPackagesByGoal` orders by `created_at DESC`, respects `limit`, returns assemblies
  for the same Goal, and filters correctly by `adapterId` and `sessionId`.
- `getActiveAssemblyByFingerprint` returns `pending`/`running`/`succeeded` rows and excludes
  `failed` rows, enabling retry.
- `getAssembliesByStatus` covers the reconciliation read path.
- `setSessionContextPackageId` updates `sessions.context_package_id`; `getSessionDetail` returns
  the updated `contextPackageId`.
- `ContextProjectionError` thrown on corrupted `sources_json` or `warnings_json`.
- Sessions projection extended: `context_package_id` included in `SESSION_COLS`;
  `rowToSummary`/`rowToDetail` map to `contextPackageId`.
- Note: contracts dist was rebuilt (`pnpm --filter @orca/contracts build`) to include M6-001
  additions before daemon tests could run against them.

## Outcome

Gate 1 is green. M6-004 use-case + fake assembler work may begin.

## Notes

- Pre-existing dirty path observed and left untouched: `docs/operation-flow/4-do-implementation-plan.md`.
- Contracts `dist/` must be kept in sync with source; downstream packages import the compiled output.
