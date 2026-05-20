# M6 Gate 2 — After M6-005

Date: 2026-05-20
Reviewer: Codex
Baseline note: `docs/implementation-plans/notes/m6-000-baseline.md`
Baseline SHA: `31f24cd8a3c05511f486a5e9bac9d02860398bbf`
Review HEAD: `ed411c983790ffd5f76bf972132c48eab566c5cf`

## Scope

Gate 2 verifies the M6-003 through M6-005 daemon surface before bounded input,
selection, and deterministic production assembler work begins.

## Validation Runs

- `pnpm --filter @orca/contracts test` -> exit 0
  - 1 file passed, 36 tests passed
- `pnpm --filter @orca/daemon test -- context-projection context-usecases context-reconcile` -> exit 0
  - 3 files passed, 38 tests passed before gate hardening
- `pnpm --filter @orca/daemon test -- m4-011-shell-vertical-slice m5-shared-memory` -> exit 0
  - 2 files passed, 4 tests passed
- `pnpm --filter @orca/daemon typecheck` -> exit 0

After hardening M6-005 transaction/order coverage:

- `pnpm --filter @orca/daemon test -- context-reconcile context-usecases context-projection` -> exit 0
  - 3 files passed, 39 tests passed
- `pnpm --filter @orca/daemon typecheck` -> exit 0

## Gate Checks

- Projection helpers preserve package and assembly fields, including `sources` and
  `warnings` JSON arrays, across a file-backed DB close/reopen.
- Use case writes assembly, package, and event rows in one SQLite transaction for
  success and failure paths; bus publishing occurs only after the transaction returns.
- M6 event payloads remain content-free. Contract tests reject forbidden event fields,
  and daemon use-case/reconcile tests assert no rendered context, objective, memory,
  decision, summary, assembler, prompt, or response fields are published.
- Active request idempotency holds for `pending`, `running`, and `succeeded` rows.
  Failed rows are excluded from active lookup and the partial unique index permits retry.
- Fake assembler lifecycle covers success, invalid output, internal error, and
  rendered output too large paths.
- Boot reconciliation marks stale `pending`/`running` assemblies as
  `failed/daemon_restart`, appends content-free failure events, is idempotent, and is
  wired after M4/M5 reconcilers and before `server.listen`.

## Scope/Privacy Checks

- M6 context event literals in code are limited to:
  `context.assembly.requested`, `context.assembly.completed`,
  `context.assembly.failed`, and `context.package.created`.
- M6 persistence surface is limited to `context_packages`, `context_assemblies`, and
  `sessions.context_package_id`; no `context_package_sources` table exists.
- Rendered context is persisted only in `context_packages.rendered_context` for the
  M6-004 stub package path. It is not included in event payloads, process args, env,
  or daemon logs by this surface.
- No HTTP routes, adapter delivery, public context-builder endpoint, prompt system,
  provider integration, automatic retry, workspace scanning, file watching, embeddings,
  vector search, or transcript/tail reads were introduced by M6-003 through M6-005.

## Review Notes

- Gate review found one M6-005 coverage/wording gap: `reconcileStaleAssemblies` read
  stale rows before opening its transaction, and boot ordering was documented in a test
  comment instead of asserted. This pass moved the stale read inside the transaction and
  added a static boot-order assertion.
- M6-004 still uses the planned stub input and fake assembler. Real bounded source
  reads, source fingerprinting, selection, and rendering are intentionally deferred to
  M6-006 through M6-008.

## Outcome

Gate 2 is green. M6-006 bounded input work may begin.
