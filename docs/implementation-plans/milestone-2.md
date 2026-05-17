# Orca — Milestone 2 Implementation Plan

**Source milestone:** `docs/milestones/2.md`
**Builds on:** `docs/implementation-plans/milestone-1.md` (M1 must be complete and green)
**Status:** Ready for AI-assisted execution
**Scope guard:** Tasks below MUST NOT introduce dynamic plugin loading, JSON manifests, permissions, sandboxing, storage-provider abstractions, generic skill invocation endpoints, PTY/session runtime, memory, recommendations, workflows, or AI reasoning. Any task that requires such code is out of scope for M2.

### Inherited constraint from M1 review — DaemonContext seam

When M2 modifies `apps/daemon/src/goals.ts::createGoal` to invoke the Quick Goal skill and emit `skill.invoked` + `goal.created` in one transaction:

- Introduce a single explicit `DaemonContext` parameter type on the use-case (e.g. `{ db: Database.Database; bus: EventBus; now: () => string; invokeSkill: (...) => ... }`) so dependencies are visible at the call site.
- Source it from a small factory in `apps/daemon/src/index.ts` / tests; do not add a DI framework, container, or decorator metadata.
- Keep `eventBus` and `getDatabase()` module singletons as the production seam wiring; the test seam constructs an explicit context per case.
- Apply the same parameter to `updateGoal` and `archiveGoal` only if M2 modifies them; otherwise leave them on the singletons until a later milestone gives them a real reason to move.

Reason: M1 review flagged the hidden coupling on `_db`, `eventBus`, and the module-global prepared statements as acceptable for M1 but fragile for M2's atomic-transaction work. This constraint records the minimum-viable seam.

### Inherited constraint from M1 review — Sidecar surface freeze

For the duration of M2, treat the production sidecar as operational substrate, not a feature surface:

- Do not modify `apps/daemon/scripts/build-sidecar.mjs`, `apps/daemon/src/sidecar-bootstrap.ts`, or the desktop spawn paths in `apps/desktop/src-tauri/src/lib.rs` unless a defect in M1-022 is found by M2 testing.
- New plugin/skill work must be validated by running the daemon standalone (`pnpm --filter @orca/daemon dev`) and against the existing Tauri dev path; do not introduce M2 logic that depends on changes to the SEA bundle, runtime resource layout, or platform launcher behavior.
- If M2 work uncovers a real sidecar defect, file it as a separate M1-follow-up task with its own review checkpoint before patching.

Reason: M1 review flagged sidecar packaging as a magnet for architectural attention during M2, especially around native better-sqlite3 binding handling and platform-specific launch behavior. Freezing the surface preserves M2's focus on the plugin/skill foundation.

This document decomposes Milestone 2 (Plugin and Skill Foundation) into bounded executable tasks. Each task is sized for a single AI session, has explicit acceptance criteria, and is reviewable in isolation.

The single proof point for M2 is:

```text
Daemon boot
  -> registers internal plugin descriptors (orca.sqlite, orca.default-skills, orca.shell-manual)
  -> registers internal Quick Goal skill (extension point: goal.create)
  -> existing POST /v1/goals path invokes Quick Goal
  -> daemon persists skill.invoked + goal.created in one SQLite transaction (skill.invoked first)
  -> GET /v1/plugins, GET /v1/skills expose registered descriptors
  -> desktop renders a read-only runtime diagnostics view
  -> M1 baseline (create/list/restart) still passes
```

---

## Conventions

- **Task ID:** `M2-NNN` (zero-padded, sequenced for default execution order).
- **Affected Areas:** Paths are relative to repo root.
- **Validation Steps:** Every task lists at least one deterministic command or scenario.
- **Stretch tasks** are marked `[STRETCH]` and MUST NOT block Definition of Done.
- **No task may exceed its declared scope** even if adjacent work seems easy — additive scope belongs in a follow-up task.
- **Existing M1 wire shapes are frozen.** `POST /v1/goals` request body and `goal.created` event payload stay identical. New behavior is internal.

---

## Tasks

---

### M2-001 — Baseline Verification of M1 Loop

**Purpose**
Confirm M1 is healthy before touching architecture. Establishes the regression baseline so any failure introduced by M2 is unambiguously attributable to M2 work.

**Scope**
- IS: run existing M1 typecheck/test/build commands; manual create + list + restart loop; capture green output as the reference snapshot.
- IS NOT: any code changes, dependency upgrades, or new tests.

**Requirements**
- Run, from a clean working tree:
  - `pnpm install --frozen-lockfile`
  - `pnpm -r typecheck`
  - `pnpm -r test`
  - `pnpm --filter @orca/daemon build`
  - `pnpm --filter @orca/desktop build`
- Manual: launch desktop app, create one Goal, restart daemon, confirm the Goal is still listed.
- Record a one-line baseline statement in the M2 working PR description / session memory (e.g. "M1 baseline green on commit `<sha>` at `<date>`").

**Affected Areas**
- None (verification only).

**Dependencies**
- M1 Definition of Done (see `docs/implementation-plans/milestone-1.md`).

**Acceptance Criteria**
- All commands above exit 0.
- Manual create/list/restart loop succeeds.
- Baseline statement recorded.

**Validation Steps**
- The acceptance commands themselves.
- `git status` is clean before and after.

**Risks / Notes**
- If any baseline step fails, STOP M2 work and triage M1 first. M2 must not be built on a broken M1.

---

### M2-002 — Contracts: Add `skill.invoked` and Registry Summary Schemas

**Purpose**
Extend the single shared wire-contract package so daemon and desktop can refer to one source of truth for the new event type and the new read-only endpoints. Keeps M1's contract-first discipline intact.

**Scope**
- IS: extend `DomainEventType` to include `'skill.invoked'`; add `PluginCapability`, `PluginSummary`, `SkillExtensionPoint`, `SkillSummary`, `ListPluginsResponse`, `ListSkillsResponse`; extend `HealthResponse` with an optional `registries` block.
- IS NOT: skill detail schemas, adapter schemas, generic invocation schemas, JSON-schema-derived skill input/output, skill failure events.

**Requirements**
- In `packages/contracts/src/index.ts`:
  - Add `'skill.invoked'` to the `DomainEventType` zod enum.
  - Add `PluginCapability` as a zod enum: `'storage' | 'skill.provider' | 'agent.adapter'` (closed set in M2; do not add catch-all).
  - Add `PluginSummary`: `{ id: string; name: string; version: string; capabilities: PluginCapability[] }`.
  - Add `SkillExtensionPoint` as a zod enum with a single member: `'goal.create'`.
  - Add `SkillSummary`: `{ id: string; pluginId: string; extensionPoint: SkillExtensionPoint; title: string; description: string }`.
  - Add `ListPluginsResponse`: `{ plugins: PluginSummary[] }`.
  - Add `ListSkillsResponse`: `{ skills: SkillSummary[] }`.
  - Extend `HealthResponse` with an optional `registries: { plugins: number; skills: number }` field (optional preserves M1 callers).
  - Export the inferred TS types via `z.infer`.
- Do not add `SkillInvokedEventPayload` as its own export; existing `payload: z.record(z.unknown())` on `DomainEvent` already accepts it. The shape is enforced inside the daemon (M2-009).
- No runtime side effects on import; ESM, tree-shakeable.

**Affected Areas**
- `packages/contracts/src/index.ts`
- `packages/contracts/package.json` (only if a version bump is your convention; otherwise unchanged)

**Dependencies**
- M2-001

**Acceptance Criteria**
- `pnpm --filter @orca/contracts build` produces fresh `dist/index.{js,d.ts}`.
- `pnpm --filter @orca/contracts typecheck` exits 0.
- `pnpm -r typecheck` exits 0 (no consumer break).
- Importing `PluginSummary`, `SkillSummary`, `ListPluginsResponse`, `ListSkillsResponse` from `@orca/contracts` in a sibling package compiles.
- `DomainEvent` whose `type` is `'skill.invoked'` parses successfully under `DomainEvent.parse(...)`.

**Validation Steps**
- `pnpm --filter @orca/contracts build && pnpm -r typecheck`
- Write a 5-line scratch script that `DomainEvent.parse({ seq: 1, id: 'x', type: 'skill.invoked', goalId: 'g', payload: { skillId: 'quick-goal', extensionPoint: 'goal.create', durationMs: 3 }, createdAt: new Date().toISOString() })` succeeds.

**Risks / Notes**
- Keep the `registries` field optional on `HealthResponse` so the desktop M1 status header keeps working before M2-011 lands.
- Resist adding skill detail or adapter contracts here; they are explicitly deferred per `docs/milestones/2.md` §8.

---

### M2-003 — Daemon: Registry Type Definitions

**Purpose**
Introduce the internal type vocabulary for plugins and skills inside the daemon. This is the smallest seam that lets later tasks (registries, bootstrap, quick-goal, usecase wiring) compose against a single source of truth — without yet extracting a public `@orca/plugin-api` package.

**Scope**
- IS: a single types module under `apps/daemon/src/registry/types.ts` defining `PluginCapability`, `PluginDescriptor`, `SkillExtensionPoint`, `SkillDescriptor`, and a narrow `SkillContext` passed at invocation time.
- IS NOT: registry classes, runtime behavior, dispose lifecycles, event-subscriber interfaces, factory functions, sandbox or permission types.

**Requirements**
- Create `apps/daemon/src/registry/` directory.
- Create `apps/daemon/src/registry/types.ts` exporting:
  - `type PluginCapability = 'storage' | 'skill.provider' | 'agent.adapter';` (mirrors `@orca/contracts`; re-declared locally to avoid coupling internal types to wire schema parsing at hot paths).
  - `interface PluginDescriptor { id: string; name: string; version: string; capabilities: PluginCapability[]; }` — descriptors are plain data; no methods, no lifecycle.
  - `type SkillExtensionPoint = 'goal.create';`
  - `interface SkillDescriptor<TInput = unknown, TOutput = unknown> { id: string; pluginId: string; extensionPoint: SkillExtensionPoint; title: string; description: string; invoke(input: TInput, ctx: SkillContext): TOutput; }`
  - `interface SkillContext { now(): string; /* ISO timestamp source; injected for testability */ }`
- All exports are pure types/interfaces or const-only; the module must have no runtime side effects.
- No imports from `@orca/contracts` in this file (keep internal vocabulary independent from wire schemas to avoid coupling private types to public parsing).

**Affected Areas**
- `apps/daemon/src/registry/types.ts`

**Dependencies**
- M2-002 (for capability/extension-point name alignment; no import dependency)

**Acceptance Criteria**
- `pnpm --filter @orca/daemon typecheck` exits 0.
- The file exports the five names listed above and nothing else.

**Validation Steps**
- `pnpm --filter @orca/daemon typecheck`
- `grep -E "^export" apps/daemon/src/registry/types.ts` lists only the prescribed exports.

**Risks / Notes**
- Resist generalizing `SkillDescriptor.invoke` to async in M2. Quick Goal is synchronous; async plumbing is a future-shaped abstraction with no current consumer.
- Resist adding a `dispose()` method to `PluginDescriptor`. Descriptors are data, not lifecycle owners (per `docs/milestones/2.md` §3).

---

### M2-004 — Daemon: PluginRegistry

**Purpose**
Provide the static in-process plugin registry that the bootstrap (M2-007) populates and the read-only endpoint (M2-009) lists. Establishes the "register at boot, freeze, never mutate" invariant that protects the rest of the system from runtime surprises.

**Scope**
- IS: `apps/daemon/src/registry/plugin-registry.ts` exporting a `PluginRegistry` class with `register`, `freeze`, `list`, `byId`, `byCapability` and a module-level singleton instance.
- IS NOT: persistence, enable/disable state, version compatibility checks, dispose, hot reload.

**Requirements**
- Class `PluginRegistry`:
  - Private `Map<string, PluginDescriptor>` keyed by `id`.
  - Private `frozen: boolean = false`.
  - `register(descriptor: PluginDescriptor): void` — throws `Error('PluginRegistry is frozen')` if `frozen`; throws `Error('Duplicate plugin id: <id>')` if `id` already present.
  - `freeze(): void` — idempotent; flips `frozen` to true.
  - `list(): PluginDescriptor[]` — returns descriptors sorted by `id` (stable for tests/UI).
  - `byId(id: string): PluginDescriptor | undefined`.
  - `byCapability(cap: PluginCapability): PluginDescriptor[]` — sorted by `id`.
- Export a module-level `pluginRegistry = new PluginRegistry()` for daemon-internal use.
- Unit tests in `apps/daemon/src/registry/plugin-registry.test.ts` covering:
  - Successful registration of two plugins; `list()` returns them sorted by id.
  - Duplicate id throws with the offending id in the message.
  - `register` after `freeze` throws with the expected message.
  - `byCapability('storage')` returns only matching plugins.
  - `byId` returns the right descriptor / `undefined` for unknown.

**Affected Areas**
- `apps/daemon/src/registry/plugin-registry.ts`
- `apps/daemon/src/registry/plugin-registry.test.ts`

**Dependencies**
- M2-003

**Acceptance Criteria**
- `pnpm --filter @orca/daemon test -- plugin-registry` passes all five tests above.
- `pnpm --filter @orca/daemon typecheck` exits 0.

**Validation Steps**
- `pnpm --filter @orca/daemon test`
- Confirm the singleton instance is exported and can be imported in another test file.

**Risks / Notes**
- The singleton makes test isolation slightly trickier. Each test should construct a fresh `PluginRegistry()` rather than reusing the singleton, except in the daemon-boot integration test (M2-014).
- Keep error messages prefixed with `PluginRegistry` so registry failures are grep-friendly in logs.

---

### M2-005 — Daemon: SkillRegistry

**Purpose**
Provide the static in-process skill registry with the same boot/freeze discipline as plugins. Required by the Goal-creation usecase wiring (M2-008) and the read-only endpoint (M2-010).

**Scope**
- IS: `apps/daemon/src/registry/skill-registry.ts` exporting a `SkillRegistry` class with `register`, `freeze`, `list`, `byId`, `byExtensionPoint` and a module-level singleton.
- IS NOT: invocation runtime (the usecase invokes the skill directly), permissions, status taxonomy, schemas-over-the-wire.

**Requirements**
- Class `SkillRegistry`:
  - Private `Map<string, SkillDescriptor>` keyed by `id`.
  - Private `frozen: boolean = false`.
  - `register(skill: SkillDescriptor): void` — throws `Error('SkillRegistry is frozen')` if `frozen`; throws `Error('Duplicate skill id: <id>')` if `id` already present.
  - `freeze(): void` — idempotent.
  - `list(): SkillDescriptor[]` — sorted by `id`.
  - `byId(id: string): SkillDescriptor | undefined`.
  - `byExtensionPoint(ep: SkillExtensionPoint): SkillDescriptor[]` — sorted by `id`.
- Export `skillRegistry = new SkillRegistry()`.
- Unit tests in `apps/daemon/src/registry/skill-registry.test.ts` mirroring the PluginRegistry coverage:
  - register/list/sorted-by-id
  - duplicate id throws with offending id
  - register-after-freeze throws
  - `byExtensionPoint('goal.create')` filters correctly
  - `byId` happy + unknown paths

**Affected Areas**
- `apps/daemon/src/registry/skill-registry.ts`
- `apps/daemon/src/registry/skill-registry.test.ts`

**Dependencies**
- M2-003

**Acceptance Criteria**
- `pnpm --filter @orca/daemon test -- skill-registry` passes all five tests above.
- `pnpm --filter @orca/daemon typecheck` exits 0.

**Validation Steps**
- `pnpm --filter @orca/daemon test`

**Risks / Notes**
- Keep this file structurally symmetric to `plugin-registry.ts` so a future maintainer can fold them into a small generic if a third registry shows up. Do not unify them prematurely in M2 (two consumers is not yet two requirements).

---

### M2-006 — Daemon: Quick Goal Skill

**Purpose**
Implement the single deterministic skill for `goal.create`. This is what the Goal-creation usecase will route through. It must contain ONLY validation/normalization — no AI, no I/O, no event writes — so the loop M2 proves is observable and reproducible.

**Scope**
- IS: `apps/daemon/src/skills/quick-goal.ts` exporting a `quickGoalSkill: SkillDescriptor` whose `invoke` returns a normalized `{ title, description }`.
- IS NOT: writing to the DB, emitting events, calling the bus, talking to AI, persisting any artifacts, or doing anything async.

**Requirements**
- Create `apps/daemon/src/skills/` directory.
- Define and export `quickGoalSkill: SkillDescriptor<{ title: string; description?: string }, { title: string; description: string }>`:
  - `id: 'quick-goal'`
  - `pluginId: 'orca.default-skills'`
  - `extensionPoint: 'goal.create'`
  - `title: 'Quick Goal'`
  - `description: 'Deterministic normalization of Goal creation input. No AI.'`
  - `invoke(input, _ctx)`:
    1. If `input` is not an object, or `typeof input.title !== 'string'`, throw `ValidationError` (reuse the existing `ValidationError` class from `apps/daemon/src/goals.ts` — import it; do not introduce a second `ValidationError`).
    2. Compute `title = input.title.trim()`.
    3. Compute `description = (input.description ?? '').trim()`.
    4. If `title.length < 1` or `title.length > 200`, throw `ValidationError` with an issues array shape compatible with the M1 zod issue shape (e.g. `[{ path: ['title'], message: 'title must be 1..200 chars after trim' }]`).
    5. If `description.length > 4000`, throw `ValidationError` similarly for `description`.
    6. Return `{ title, description }`.
- Unit tests in `apps/daemon/src/skills/quick-goal.test.ts`:
  - Trims leading/trailing whitespace on title and description.
  - Defaults missing description to `''`.
  - Rejects empty / whitespace-only title.
  - Rejects title longer than 200 chars (post-trim).
  - Rejects description longer than 4000 chars (post-trim).
  - Returns same shape on happy path; no side effects (mock the bus would not be hit; assert no DB file is created in a tmp dir if you instantiate the skill in isolation).
  - The thrown error is an instance of `ValidationError`.

**Affected Areas**
- `apps/daemon/src/skills/quick-goal.ts`
- `apps/daemon/src/skills/quick-goal.test.ts`

**Dependencies**
- M2-003 (types)
- existing `apps/daemon/src/goals.ts` (re-uses `ValidationError`)

**Acceptance Criteria**
- `pnpm --filter @orca/daemon test -- quick-goal` passes all listed tests.
- `pnpm --filter @orca/daemon typecheck` exits 0.

**Validation Steps**
- `pnpm --filter @orca/daemon test`
- Confirm `quick-goal.ts` has no `import` from `db.ts`, `events.ts`, `server.ts`, or any I/O API (`fs`, `node:fs`, `better-sqlite3`).

**Risks / Notes**
- The HTTP error shape MUST remain compatible with the M1 behavior of `POST /v1/goals` returning `{ error: 'validation_failed', issues: [...] }`. This is why we reuse `ValidationError` and shape `issues` like zod's.
- Do not register the skill here — registration happens in M2-007.

---

### M2-007 — Daemon: Registry Bootstrap

**Purpose**
Statically register the three built-in plugin descriptors and the single skill at daemon boot, then freeze the registries. This is the operational moment that turns the registry types and Quick Goal skill into real, observable runtime state.

**Scope**
- IS: `apps/daemon/src/registry/bootstrap.ts` exporting `bootstrapRegistries()`; wiring into `apps/daemon/src/index.ts` so boot order is `loadConfig → openDatabase → runMigrations → bootstrapRegistries → createServer → listen → registerShutdown`.
- IS NOT: filesystem discovery, manifest parsing, dynamic loading, per-plugin lifecycle, enable/disable persistence.

**Requirements**
- `apps/daemon/src/registry/bootstrap.ts`:
  - Reads daemon `version` from `apps/daemon/package.json` (same import path the health route uses).
  - Exports `bootstrapRegistries(): void` that:
    1. Calls `pluginRegistry.register({ id: 'orca.sqlite',         name: 'Orca SQLite',         version, capabilities: ['storage'] })`.
    2. Calls `pluginRegistry.register({ id: 'orca.default-skills', name: 'Orca Default Skills', version, capabilities: ['skill.provider'] })`.
    3. Calls `pluginRegistry.register({ id: 'orca.shell-manual',   name: 'Shell (Manual)',      version, capabilities: ['agent.adapter'] })`.
    4. Calls `skillRegistry.register(quickGoalSkill)`.
    5. Calls `pluginRegistry.freeze()` and `skillRegistry.freeze()`.
  - On any registration error, rethrows after logging via pino at `error` level with the offending id; the caller (daemon `index.ts`) treats this as a fatal boot failure.
- `apps/daemon/src/index.ts`:
  - Imports and calls `bootstrapRegistries()` immediately after `runMigrations(...)` and before `createServer(config)`.
  - On bootstrap throw, logs and exits with non-zero code (do not start the HTTP server).
- Unit test in `apps/daemon/src/registry/bootstrap.test.ts`:
  - Calls `bootstrapRegistries()` against fresh local registry instances (refactor: accept optional `{ plugins, skills }` parameter to allow injecting fresh registries in tests; default to the module singletons in production).
  - Asserts three plugins are present with correct ids and capabilities.
  - Asserts one skill is present with id `quick-goal` and extension point `goal.create`.
  - Asserts both registries are frozen after the call (a subsequent `register` throws).

**Affected Areas**
- `apps/daemon/src/registry/bootstrap.ts`
- `apps/daemon/src/registry/bootstrap.test.ts`
- `apps/daemon/src/index.ts`

**Dependencies**
- M2-004, M2-005, M2-006

**Acceptance Criteria**
- `pnpm --filter @orca/daemon test -- bootstrap` passes.
- `pnpm --filter @orca/daemon dev` boots and logs that registries are populated (one pino info line listing counts is acceptable; e.g. `registries.bootstrap.ok plugins=3 skills=1`).
- Simulating duplicate registration (e.g. by calling `bootstrapRegistries()` twice in a test against the same registry pair) fails fast with a clear message containing the duplicate id.

**Validation Steps**
- `pnpm --filter @orca/daemon test`
- `pnpm --filter @orca/daemon dev` then `curl http://127.0.0.1:8787/v1/health` (will be extended in M2-011 to show counts — for now confirm health still returns 200).

**Risks / Notes**
- Boot order is correctness-critical: bootstrap must run AFTER migrations (DB ready) and BEFORE `createServer` (so the read-only routes see populated registries). Reviewers must verify this ordering by reading `index.ts`.
- Do not import `quick-goal.ts` from `server.ts`; the skill enters the world via the registry, not via direct module wiring.

---

### M2-008 — Daemon: Route Goal Creation Through Quick Goal (Atomic `skill.invoked` + `goal.created`)

**Purpose**
This is the M2 fitness function in code. The existing `createGoal` usecase must invoke `quick-goal` for validation/normalization, then persist `skill.invoked` and `goal.created` in the SAME SQLite transaction, in that order, and broadcast both events only after commit.

**Scope**
- IS: smallest possible change to `apps/daemon/src/goals.ts` to (1) resolve `quick-goal` from `skillRegistry`, (2) call its `invoke`, (3) extend the existing transaction to insert `skill.invoked` BEFORE `goal.created`, (4) publish both events post-commit in seq order.
- IS NOT: changing the public `POST /v1/goals` request shape, changing the `goal.created` event payload, adding edit/archive skill wiring, introducing a `SkillRuntime` abstraction, adding failure events.

**Requirements**
- In `apps/daemon/src/goals.ts`, replace the body of `createGoal(input)` with the following flow (keeping `ValidationError` semantics and the return shape identical):
  1. Resolve the skill: `const skill = skillRegistry.byId('quick-goal');` — if `undefined`, throw a non-`ValidationError` runtime error (this represents a boot misconfiguration, not user error) and let it surface as 500 via existing Fastify error handling.
  2. Capture `const startedAt = performance.now();`.
  3. Call `const normalized = skill.invoke(input, { now: () => new Date().toISOString() });` — if this throws `ValidationError`, rethrow so the existing route handler maps it to HTTP 400 with the same `{ error: 'validation_failed', issues }` shape. No event rows must be written in this case.
  4. Compute `const durationMs = Math.round(performance.now() - startedAt);`.
  5. Generate `goalId`, `skillEventId`, `goalEventId` (three UUIDs), and `now = new Date().toISOString()`.
  6. Add a prepared `insertEvent` statement reuse (the same statement used today for `goal.created`); no new prepared statement is required because the schema is identical.
  7. Inside ONE `db.transaction(() => { ... })()`:
     - Insert `skill.invoked` event: `(skillEventId, 'skill.invoked', goalId, JSON.stringify({ skillId: 'quick-goal', extensionPoint: 'goal.create', durationMs }), now)`. Capture `skillSeq = Number(result.lastInsertRowid);`.
     - Insert `goal.created` event (unchanged payload `{ title, description }`): capture `goalSeq`.
     - Insert into `goals` projection (unchanged columns/values).
  8. After commit, publish to `eventBus` IN SEQ ORDER:
     - `eventBus.publish({ seq: skillSeq, id: skillEventId, type: 'skill.invoked', goalId, payload: { skillId: 'quick-goal', extensionPoint: 'goal.create', durationMs }, createdAt: now });`
     - `eventBus.publish({ seq: goalSeq,  id: goalEventId,  type: 'goal.created', goalId, payload: { title: normalized.title, description: normalized.description }, createdAt: now });`
  9. Return the persisted `Goal` (identical shape to M1).
- DO NOT change `updateGoal` or `archiveGoal` in this task. Those paths remain on the M1 transactional pattern.
- DO NOT change the `POST /v1/goals` route handler in `server.ts`.
- DO NOT introduce an `invokeGoalCreateSkill` helper module — keep the call inline inside `createGoal` per the spec's "smallest change" rule. A helper can be extracted when a second extension point exists.

**Affected Areas**
- `apps/daemon/src/goals.ts`

**Dependencies**
- M2-005, M2-006, M2-007

**Acceptance Criteria**
- Unit test (temp DB) in `apps/daemon/src/goals.test.ts` (add new cases; do not delete existing ones):
  - On successful create, `events` table contains exactly two new rows: a `skill.invoked` with `goal_id` matching the new Goal AND a `goal.created`. The `skill.invoked` row has the strictly smaller `seq`.
  - The persisted `skill.invoked` payload is `{ skillId: 'quick-goal', extensionPoint: 'goal.create', durationMs: <number ≥ 0> }` (parse JSON, assert keys; `durationMs` is a non-negative integer).
  - The persisted `goal.created` payload is `{ title, description }` (UNCHANGED from M1).
  - `goals` projection has exactly one row matching the new Goal id.
  - Forcing the projection insert to throw rolls back BOTH event rows; `eventBus.publish` is NOT called.
  - Invalid input (blank title) throws `ValidationError`; no rows added; bus not called.
- All pre-existing `goals.test.ts` cases for `createGoal` still pass (M1 contract preserved).
- The `POST /v1/goals` integration test (existing) still returns 201 with the same response shape.

**Validation Steps**
- `pnpm --filter @orca/daemon test`
- `pnpm --filter @orca/daemon dev` then:
  - `curl -X POST localhost:8787/v1/goals -H 'content-type: application/json' -d '{"title":"M2 loop","description":""}'`
  - `sqlite3 ~/.orca/orca.db "SELECT seq, type FROM events ORDER BY seq DESC LIMIT 2;"` — confirm a `skill.invoked` row appears immediately before the `goal.created` row.

**Risks / Notes**
- This is the most consequential M2 task. Human review of the diff REQUIRED before merging.
- The temptation to publish events INSIDE the transaction must be resisted — bus publish stays after commit.
- The temptation to introduce a generic skill runtime must be resisted — `docs/milestones/2.md` §3 explicitly defers it.
- If `performance.now()` is unavailable in your Node version, fall back to `Date.now()`; do not introduce a dependency for timing.

---

### M2-009 — Daemon: `GET /v1/plugins`

**Purpose**
Make plugin registration observable through the existing HTTP surface so the desktop diagnostics view (M2-013) has data to render and integration tests have a deterministic assertion target.

**Scope**
- IS: a read-only route in `apps/daemon/src/server.ts` returning the registered plugin descriptors as `ListPluginsResponse`.
- IS NOT: detail endpoint (`/v1/plugins/:id`), filter query params, enable/disable, health-per-plugin, adapter-specific endpoints.

**Requirements**
- In `apps/daemon/src/server.ts`, register `GET /v1/plugins`:
  - Reads from the module-singleton `pluginRegistry.list()`.
  - Maps internal `PluginDescriptor` → wire `PluginSummary` (drop nothing; the shapes are identical structurally — types just live in different packages).
  - Responds 200 with `{ plugins: PluginSummary[] }`.
  - Respects the existing local-auth middleware (same Authorization header behavior as `POST /v1/goals`).
- Integration test in `apps/daemon/src/server.test.ts`:
  - Boot the server with registries populated by `bootstrapRegistries()`.
  - `GET /v1/plugins` returns 200 with exactly the three built-in ids in sorted order: `orca.default-skills`, `orca.shell-manual`, `orca.sqlite`.
  - The response body parses cleanly via `ListPluginsResponse.parse(...)`.
  - Without auth (if token configured), returns the same status code as other M1 routes for unauthorized requests.

**Affected Areas**
- `apps/daemon/src/server.ts`
- `apps/daemon/src/server.test.ts`

**Dependencies**
- M2-002, M2-004, M2-007

**Acceptance Criteria**
- Tests above pass.
- `curl http://127.0.0.1:8787/v1/plugins` (with the right Authorization header in dev) returns the three plugins as a stable, sorted JSON list.

**Validation Steps**
- `pnpm --filter @orca/daemon test`
- Manual `curl` smoke against a running dev daemon.

**Risks / Notes**
- Keep the response body small and stable — desktop will refetch on no schedule, and the shape becomes a soft contract.

---

### M2-010 — Daemon: `GET /v1/skills`

**Purpose**
Same observability rationale as M2-009 for the skill registry. Lets the desktop verify that `quick-goal` is registered and lets integration tests assert the M2 fitness function from a black-box client perspective.

**Scope**
- IS: a read-only route in `apps/daemon/src/server.ts` returning `ListSkillsResponse`.
- IS NOT: skill detail, skill schemas, generic invocation endpoint, picker semantics.

**Requirements**
- In `apps/daemon/src/server.ts`, register `GET /v1/skills`:
  - Reads from the singleton `skillRegistry.list()`.
  - Maps each `SkillDescriptor` → `SkillSummary` by extracting `{ id, pluginId, extensionPoint, title, description }`. The `invoke` function MUST NOT leak into the wire response.
  - Responds 200 with `{ skills: SkillSummary[] }`.
  - Same local-auth behavior as `/v1/plugins`.
- Integration test in `apps/daemon/src/server.test.ts`:
  - `GET /v1/skills` returns 200 with exactly one entry: `{ id: 'quick-goal', pluginId: 'orca.default-skills', extensionPoint: 'goal.create', title: 'Quick Goal', description: '...' }`.
  - Response parses through `ListSkillsResponse.parse(...)`.
  - Unauthorized behavior matches `/v1/plugins`.

**Affected Areas**
- `apps/daemon/src/server.ts`
- `apps/daemon/src/server.test.ts`

**Dependencies**
- M2-002, M2-005, M2-007

**Acceptance Criteria**
- Tests above pass.
- `curl http://127.0.0.1:8787/v1/skills` returns one entry with the correct extension point.

**Validation Steps**
- `pnpm --filter @orca/daemon test`
- Manual `curl` smoke.

**Risks / Notes**
- Use an explicit object literal in the mapper — do not spread the entire `SkillDescriptor` (would leak `invoke`).

---

### M2-011 — Daemon: Extend `GET /v1/health` with Registry Counts

**Purpose**
Surface registry size at the same diagnostic surface the desktop already polls. Lets the connection-status indicator double as a sanity check that M2 bootstrap ran.

**Scope**
- IS: extend the existing `/v1/health` handler to include the optional `registries: { plugins, skills }` field on the response.
- IS NOT: per-plugin health, per-skill health, structured boot timing, latency metrics.

**Requirements**
- In `apps/daemon/src/server.ts`, the `/v1/health` handler now returns:
  ```ts
  {
    status: 'ok',
    version,
    startedAt,
    registries: { plugins: pluginRegistry.list().length, skills: skillRegistry.list().length }
  }
  ```
- Response continues to parse cleanly through `HealthResponse` (which is M2-002's optional `registries`).
- Existing M1 test for `/v1/health` passes with the new optional field present.
- New assertion in `server.test.ts`: after `bootstrapRegistries()`, health response has `registries: { plugins: 3, skills: 1 }`.

**Affected Areas**
- `apps/daemon/src/server.ts`
- `apps/daemon/src/server.test.ts`

**Dependencies**
- M2-002, M2-007

**Acceptance Criteria**
- Both new and existing health tests pass.
- `curl http://127.0.0.1:8787/v1/health` shows the `registries` field.

**Validation Steps**
- `pnpm --filter @orca/daemon test`
- Manual `curl`.

**Risks / Notes**
- Do not break the M1 desktop polling: `HealthResponse` keeps `registries` optional, so an older desktop client just ignores the extra field.

---

### M2-012 — Desktop: API Client — `listPlugins` and `listSkills`

**Purpose**
Add the renderer-side typed client wrappers for the two new read-only endpoints. Done in isolation from UI so the API layer can be reviewed and tested without dragging in component changes.

**Scope**
- IS: extend `apps/desktop/src/api.ts` with `listPlugins()` and `listSkills()` returning typed promises.
- IS NOT: any UI changes, state management additions, polling, caching.

**Requirements**
- Add two functions to `apps/desktop/src/api.ts`:
  - `async function listPlugins(): Promise<PluginSummary[]>` — `GET /v1/plugins`, validates response via `ListPluginsResponse.parse(...)`, returns `.plugins`.
  - `async function listSkills(): Promise<SkillSummary[]>` — `GET /v1/skills`, validates via `ListSkillsResponse.parse(...)`, returns `.skills`.
  - Both send the existing `Authorization` header (reuse the same helper used by `listGoals`).
  - Both throw the existing typed `ApiError` on non-2xx or zod parse failure.
- No reconnect/retry; mirror the simple style of `listGoals`.

**Affected Areas**
- `apps/desktop/src/api.ts`

**Dependencies**
- M2-002, M2-009, M2-010 (so a manual smoke test is possible)

**Acceptance Criteria**
- `pnpm --filter @orca/desktop typecheck` exits 0.
- Manual: from the renderer devtools console (with daemon running), `(await import('./api')).listPlugins()` returns the three built-ins; same for `listSkills()`.

**Validation Steps**
- Run `pnpm --filter @orca/desktop tauri:dev` and exercise the two functions from devtools.

**Risks / Notes**
- Keep these as plain async functions. Do not introduce TanStack Query, SWR, or any cache layer — the M1 style is intentionally minimal.

---

### M2-013 — Desktop: Read-Only Runtime Diagnostics Section

**Purpose**
The user-visible proof of M2: a small section in the existing single-screen app that lists registered plugins and skills. Keeps the create-Goal form unchanged so M1 muscle memory survives.

**Scope**
- IS: a new collapsible-or-trailing section in `App.tsx` titled "Runtime Diagnostics" that lists plugins (id, capabilities) and skills (id, extension point), fetched once on mount and refetched on a manual "Refresh" button.
- IS NOT: settings page, routing, tabs, plugin enable/disable controls, skill picker on the create form, real-time WS updates of plugin state.

**Requirements**
- In `apps/desktop/src/App.tsx`:
  - On mount, call `listPlugins()` and `listSkills()` in parallel; store in local component state.
  - Render a section below the existing Goal list:
    - Heading: `Runtime Diagnostics`.
    - Subheading `Plugins (N)` followed by an unordered list of `id — capabilities.join(', ')`.
    - Subheading `Skills (N)` followed by an unordered list of `id — extensionPoint (title)`.
    - A "Refresh" button that re-runs both fetches.
  - Optional, NOT required: a single read-only line in the create form area: `Goal creation uses Quick Goal`.
- The existing create-Goal form, Goal list, and connection status indicator are NOT modified.
- The section is purely diagnostic: no error toasts, no spinner library; an inline `<p>` for "Loading…" and an inline error string are sufficient.
- Add minimal CSS in `styles.css` for spacing (no theme/system colors).

**Affected Areas**
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/styles.css`

**Dependencies**
- M2-012

**Acceptance Criteria**
- Manual: launch desktop with running daemon. The diagnostics section shows three plugin ids and one skill id with `goal.create`.
- Manual: clicking Refresh re-fetches (DevTools network panel shows two new requests).
- Manual: existing M1 create/list loop is unchanged — submit a Goal, see it appear in the list within 1s via the existing WS-driven refresh path.
- `pnpm --filter @orca/desktop typecheck` exits 0.
- `pnpm --filter @orca/desktop build` succeeds.

**Validation Steps**
- Run the three manual scenarios above.

**Risks / Notes**
- Keep the section visually subordinate to the Goal list. The point of M2 is that Goals still feel like M1; diagnostics are secondary.
- Do not subscribe the diagnostics section to the WS stream. Plugins/skills do not change at runtime in M2.

---

### M2-014 — Daemon: Integration Tests — End-to-End M2 Loop

**Purpose**
Lock in the M2 fitness function with deterministic regression coverage so the loop cannot regress silently in M3+.

**Scope**
- IS: a vitest integration suite that boots a real Fastify + better-sqlite3 + populated registries in a temp data dir and exercises the M2 loop end-to-end through HTTP and WS.
- IS NOT: UI tests, cross-process Tauri tests, fuzzing, perf tests.

**Requirements**
- Add tests to `apps/daemon/src/server.test.ts` (or a new `apps/daemon/src/m2-loop.test.ts`):
  1. **Boot:** `bootstrapRegistries()` succeeds; `GET /v1/health` returns `registries: { plugins: 3, skills: 1 }`.
  2. **Registry endpoints:** `GET /v1/plugins` and `GET /v1/skills` return the expected built-ins with the exact ids listed in M2-007.
  3. **Create + event ordering:** `POST /v1/goals` with `{ title: 'X' }` returns 201; querying the `events` table directly, the two new rows are `skill.invoked` (smaller `seq`) followed by `goal.created` (larger `seq`), both with the same `goal_id`.
  4. **Atomic rollback:** monkey-patch `insertGoal.run` (or the projection step) to throw on the next call; `POST /v1/goals` returns 5xx; the `events` table has NO `skill.invoked` and NO `goal.created` row for the would-be goalId.
  5. **WS delivery order:** open a WS client to `/v1/events`; `POST /v1/goals`; assert that the next two received messages are `skill.invoked` then `goal.created`, with the same `goalId`, and that `skill.invoked.seq < goal.created.seq`.
  6. **Invalid input no-write:** `POST /v1/goals` with `{ title: '  ' }` returns 400; no new `events` rows; no WS messages received during a short window.
  7. **Restart persistence:** stop the server, reopen the DB, `GET /v1/goals` returns the previously created Goal AND querying the `events` table still shows the `skill.invoked` row immediately preceding its `goal.created`.
- All M1 integration tests still pass unchanged.

**Affected Areas**
- `apps/daemon/src/server.test.ts` (or new `m2-loop.test.ts`)

**Dependencies**
- M2-008, M2-009, M2-010, M2-011

**Acceptance Criteria**
- `pnpm --filter @orca/daemon test` exits 0 with all seven scenarios passing.
- Tests are deterministic across 5 sequential local runs.

**Validation Steps**
- `for i in 1 2 3 4 5; do pnpm --filter @orca/daemon test || break; done`

**Risks / Notes**
- Scenario 5 (WS ordering) requires a real `ws` client. Reuse the M1 test pattern from `apps/daemon/src/server.test.ts`.
- Scenario 4 (rollback) is the easiest to write incorrectly — verify by reading the test diff that the throw is injected AFTER the `skill.invoked` insert but DURING the projection insert, so the rollback covers both event rows.

---

### M2-015 — Documentation: Dev Note for Internal Plugins and Skills

**Purpose**
Make the M2 boundary explicit and reproducible in the repo, so the next contributor (human or agent) does not accidentally introduce dynamic loading, manifests, or a public plugin SDK before the milestones that need them.

**Scope**
- IS: a short section appended to the existing `README.md` (or a new `docs/dev/internal-plugins-and-skills.md` linked from README) describing (a) how to add an internal `PluginDescriptor`, (b) how to add an internal `SkillDescriptor` for a new extension point, (c) what is INTENTIONALLY deferred.
- IS NOT: architecture deep-dive, public plugin SDK design, migration guide.

**Requirements**
- The note must contain:
  - A 3–6 line recipe for adding a plugin descriptor (`registry/bootstrap.ts` + capability choice).
  - A 3–6 line recipe for adding a skill (`apps/daemon/src/skills/<id>.ts` exporting a `SkillDescriptor`, then `skillRegistry.register(...)` in `bootstrap.ts`).
  - An explicit "Intentionally deferred" bullet list mirroring `docs/milestones/2.md` §3 keywords: no external plugin API package, no dynamic loading, no JSON manifests, no permissions/sandbox, no `StorageProvider`, no `SkillRuntime`, no generic invoke endpoint, no skill detail endpoint, no adapter spawn, no `EventSubscriber` extension point, no failure events.
  - A pointer back to `docs/milestones/2.md` and this implementation plan.

**Affected Areas**
- `README.md` (preferred) — or `docs/dev/internal-plugins-and-skills.md` plus a one-line link from README.

**Dependencies**
- M2-008 through M2-014 (so the documented surface actually exists)

**Acceptance Criteria**
- A new contributor can read the note in under 3 minutes and correctly add a no-op plugin descriptor that appears in `GET /v1/plugins` without touching anything outside `bootstrap.ts`.
- The "Intentionally deferred" list is complete enough to refuse a future PR that tries to add any of the listed items without a new milestone.

**Validation Steps**
- Dry-run the recipe: add a throwaway descriptor `orca.test.noop`, boot the daemon, see it appear in `GET /v1/plugins`, then revert.

**Risks / Notes**
- Keep this note SHORT. A long doc invites mission creep.

---

### M2-016 — [STRETCH] Registry Hardening Tests

**Purpose**
Pin down the "freeze + duplicate id" invariants from `bootstrap.ts` and the registries with explicit negative tests so a future refactor cannot accidentally loosen them.

**Scope**
- IS: a small `registry-hardening.test.ts` that asserts: register-after-freeze throws across both registries; duplicate built-in id during bootstrap fails fast with the offending id in the message; an attempted re-bootstrap on the same registry pair throws.
- IS NOT: fuzzing, property-based testing, performance assertions.

**Requirements**
- Test cases:
  - Construct fresh `PluginRegistry`/`SkillRegistry`, register one item each, freeze both, attempt one more register on each — both throw.
  - Call `bootstrapRegistries({ plugins, skills })` once on fresh registries (succeeds), then call it again on the same pair (throws on the first duplicate id; assert message contains the id).
- No production code changes (the seam to inject registries already exists from M2-007).

**Affected Areas**
- `apps/daemon/src/registry/registry-hardening.test.ts`

**Dependencies**
- M2-007

**Acceptance Criteria**
- `pnpm --filter @orca/daemon test -- registry-hardening` passes.

**Validation Steps**
- `pnpm --filter @orca/daemon test`

**Risks / Notes**
- Stretch only — must not block Definition of Done.

---

## Task Dependency Graph

```text
M2-001 (baseline)
  └── M2-002 (contracts: skill.invoked + summaries)
        ├── M2-003 (registry types)
        │     ├── M2-004 (PluginRegistry)
        │     ├── M2-005 (SkillRegistry)
        │     └── M2-006 (quick-goal skill)
        │           └── M2-007 (bootstrap + boot wiring)
        │                 ├── M2-008 (createGoal: skill.invoked + goal.created atomic)
        │                 │     └── M2-014 (integration tests: M2 loop)
        │                 ├── M2-009 (GET /v1/plugins)
        │                 ├── M2-010 (GET /v1/skills)
        │                 └── M2-011 (GET /v1/health registry counts)
        │                       └── M2-016 [STRETCH] (registry hardening)
        └── M2-012 (desktop api: listPlugins/listSkills)
              └── M2-013 (desktop Runtime Diagnostics section)

M2-008, M2-009, M2-010, M2-011, M2-013, M2-014 ──> M2-015 (dev note)
```

### Parallelizable Branches

After M2-002 lands, two streams run in parallel:
- **Daemon registry/skill substrate:** M2-003 → (M2-004 ∥ M2-005 ∥ M2-006) → M2-007 → (M2-008 ∥ M2-009 ∥ M2-010 ∥ M2-011) → M2-014.
- **Desktop diagnostics:** M2-012 → M2-013. M2-012 can start as soon as M2-002 is merged (it only needs the new contract types); the manual smoke for M2-013 needs M2-009 + M2-010 live.

### Hard Blockers

- **M2-007 (bootstrap) gates almost everything operational.** Until registries are populated at boot, the endpoints and the createGoal change have nothing to bind to.
- **M2-008 (atomic skill.invoked + goal.created) is the M2 fitness function.** It must not regress the M1 create path. Human review of the diff is required.
- **M2-014 (integration tests) is the lock on the loop.** Do not consider M2 done until it passes deterministically.

---

## Suggested Model Assignment

| Task | Recommended Model | Reasoning |
|---|---|---|
| M2-001 | Human | Baseline verification belongs to a human; capture the green snapshot before any AI work begins. |
| M2-002 | Codex | Pure schema additions; mechanical and well-bounded. |
| M2-003 | Codex | Type-only module; deterministic. |
| M2-004 | Codex | Small class + tests; established pattern. |
| M2-005 | Codex | Symmetric to M2-004. |
| M2-006 | Sonnet | Validation/normalization with error-shape compatibility — needs judgment to reuse the M1 `ValidationError` correctly. |
| M2-007 | Sonnet | Boot ordering and fail-fast semantics need care. |
| M2-008 | **Sonnet** | **Critical transactional change; reuses M1 invariants and adds the new event in-band.** Highest risk in the milestone. |
| M2-009 | Codex | Route + mapper; trivial. |
| M2-010 | Codex | Route + mapper; trivial. Must explicitly drop `invoke` from the response. |
| M2-011 | Codex | Small handler extension. |
| M2-012 | Codex | Two more API client wrappers in the M1 style. |
| M2-013 | Sonnet | UI wiring + minimal layout; medium feature. |
| M2-014 | Sonnet | Integration test design (especially WS ordering + rollback injection) benefits from judgment. |
| M2-015 | Sonnet | Documentation pass; small judgment calls about scope. |
| M2-016 | Codex | Mechanical negative tests. |

Opus is not assigned: architectural decomposition is done in this document; no remaining M2 work warrants Opus reasoning.

---

## Recommended Review Gates

| Gate | After Task | Why |
|---|---|---|
| **Gate 1 — Substrate Ready** | M2-007 | Confirm registries populate at boot, freeze invariant holds, and the daemon still serves M1 traffic. Human review of `bootstrap.ts` + `index.ts` boot order required. |
| **Gate 2 — M2 Fitness Function Met** | M2-008 | Inspect the `goals.ts` diff specifically for transaction shape and post-commit publish ordering. Human review REQUIRED. Run M2-014 scenarios 3, 4, 5 as a smoke check even before the full suite lands. |
| **Gate 3 — Observability Surface Live** | M2-010 (and M2-011) | Confirm `GET /v1/plugins` and `GET /v1/skills` return stable, sorted descriptors and that the response shapes match `@orca/contracts`. |
| **Gate 4 — End-to-End Loop Visible** | M2-013 | Launch desktop app + daemon; create a Goal through the existing form; confirm the diagnostics section shows three plugins and one skill; confirm event-ordering invariant on a live DB. |
| **Gate 5 — Definition of Done** | M2-015 | Run the full Validation Strategy table from `docs/milestones/2.md` §13 against a fresh clone. Decide whether to attempt the stretch task. |

Each gate should produce a short written checkpoint (in the task PR description or session memory) before proceeding.

---

## Execution Notes For AI Agents

- **Treat scope as a hard contract.** If a task tempts you to add adjacent work — generalize the registries, extract a skill runtime, package a plugin SDK, add a skill picker — STOP and propose a follow-up task instead. `docs/milestones/2.md` §3 and §6 enumerate exactly which adjacent surfaces are deferred.
- **Preserve the M1 wire shapes.** `POST /v1/goals` request body and `goal.created` event payload do NOT change. Adding `skill.invoked` is purely additive.
- **The transactional invariant from M1-010 is the spine of M2-008.** Event appends + projection insert in ONE transaction; bus publish ONLY after commit; `skill.invoked` strictly precedes `goal.created` in `seq`.
- **Do not introduce abstractions for absent systems.** No dynamic plugin loader, no JSON manifests, no permissions/sandbox, no storage provider, no `SkillRuntime`, no generic invoke endpoint, no failure events, no skill input/output schemas over the wire. Those arrive in later milestones with concrete requirements.
- **Run validation before claiming completion.** Each task lists deterministic commands or scenarios — execute them, paste the output, and only then mark complete.
- **Stretch (M2-016) is optional.** Do not start it until baseline (M2-001 through M2-015) is green.
