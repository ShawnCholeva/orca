# Milestone 1 Review Remediation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven findings from the M1 implementation review before M2 work begins, so M2's plugin/skill foundation lands on a tightened M1 baseline.

**Architecture:**
- Findings 1–4, 6 are code fixes in the existing daemon (`apps/daemon`) and desktop shell (`apps/desktop`). Each is implemented test-first, in isolation, with one commit per finding.
- Findings 5 and 7 are forward-looking constraints that the review itself prescribes documenting (not implementing). They are recorded as scope-guard amendments in `docs/implementation-plans/milestone-2.md` so M2 inherits the decisions.

**Tech Stack:** Fastify 4 + `@fastify/websocket`, better-sqlite3, Vitest, Tauri v2 (Rust), Zod via `@orca/contracts`.

**Source review:** Seven findings against M1 (one immediate, three soon, three MVP-acceptable). The plan addresses every finding; findings 5 and 7 are addressed as documented constraints, matching their own remediation guidance.

**Severity / order summary:**

| # | Task | Severity | Type |
|---|------|----------|------|
| 1 | HTTP bearer auth | immediate | code + tests |
| 2 | Event-before-projection in update/archive | soon | code + tests |
| 3 | Lifecycle guard on archived goals | soon | code + tests |
| 6 | Parse projection rows through `Goal` schema | soon | code + tests |
| 5 | DaemonContext seam — deferred to M2 with documented shape | MVP-acceptable | docs only |
| 4 | Tighten Tauri CSP | soon | code + manual verify |
| 7 | Sidecar surface freeze for M2 | MVP-acceptable | docs only |

Execution order below follows this list. Tasks 1–3 and 6 share `apps/daemon/src/goals.ts` and `apps/daemon/src/server.ts`; do them sequentially. Task 4 (Tauri) is independent. Tasks 5 and 7 are doc-only and can land last.

---

## Task 1: Enforce bearer auth on HTTP routes (Finding 1)

**Why:** The daemon already mints a per-launch token and the WS route validates `?token=`, but HTTP routes accept any caller. Any local process can create/list/update/archive goals or replay events. This must be closed before PTY/session endpoints land.

**Decision:** Reject HTTP requests that lack a matching `Authorization: Bearer <token>` header. `GET /v1/health` stays unauthenticated (matches local-first liveness probes). WS upgrade requests skip the bearer check — they continue to validate `?token=` inside the WS handler (only one auth path per route).

**Files:**
- Modify: `apps/daemon/src/server.ts` (add `onRequest` auth hook)
- Modify: `apps/daemon/src/server.test.ts` (assertions for auth boundary + update existing HTTP injects to send `Authorization`)

### Steps

- [ ] **Step 1: Add failing auth tests**

Append to `apps/daemon/src/server.test.ts` inside the existing `describe('server routes', ...)` block:

```ts
it('GET /v1/health is unauthenticated and returns 200', async () => {
  const response = await server.inject({ method: 'GET', url: '/v1/health' });
  expect(response.statusCode).toBe(200);
});

it('POST /v1/goals without Authorization returns 401', async () => {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/goals',
    headers: { 'content-type': 'application/json' },
    payload: { title: 'noauth' }
  });
  expect(response.statusCode).toBe(401);
  const body = JSON.parse(response.body) as { error?: string };
  expect(body.error).toBe('unauthorized');
});

it('POST /v1/goals with wrong bearer returns 401', async () => {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/goals',
    headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
    payload: { title: 'badauth' }
  });
  expect(response.statusCode).toBe(401);
});

it('GET /v1/goals without Authorization returns 401', async () => {
  const response = await server.inject({ method: 'GET', url: '/v1/goals' });
  expect(response.statusCode).toBe(401);
});

it('PATCH /v1/goals/:id without Authorization returns 401', async () => {
  const response = await server.inject({
    method: 'PATCH',
    url: '/v1/goals/any-id',
    headers: { 'content-type': 'application/json' },
    payload: { title: 'x' }
  });
  expect(response.statusCode).toBe(401);
});

it('POST /v1/goals/:id/archive without Authorization returns 401', async () => {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/goals/any-id/archive'
  });
  expect(response.statusCode).toBe(401);
});

it('GET /v1/events (replay) without Authorization returns 401', async () => {
  const response = await server.inject({ method: 'GET', url: '/v1/events?sinceSeq=0' });
  expect(response.statusCode).toBe(401);
});
```

- [ ] **Step 2: Run new tests and confirm they fail**

Run: `pnpm --filter @orca/daemon test -- server.test`

Expected: the six 401-asserting tests fail (current behavior returns 201/200). The health test passes already. Many existing tests will now be at risk because they don't send Authorization — that's expected and addressed in Step 4.

- [ ] **Step 3: Implement the auth hook**

Edit `apps/daemon/src/server.ts`. After `server.register(websocket);` and before the route declarations, add:

```ts
server.addHook('onRequest', async (request, reply) => {
  const pathname = request.url.split('?')[0];

  // Health is the only unauthenticated HTTP route.
  if (request.method === 'GET' && pathname === '/v1/health') return;

  // WS upgrade keeps the existing ?token= path (validated inside wsHandler).
  if (request.headers.upgrade?.toLowerCase() === 'websocket') return;

  const expected = `Bearer ${config.getAuthToken()}`;
  if (request.headers.authorization !== expected) {
    reply.code(401).send({ error: 'unauthorized' });
  }
});
```

- [ ] **Step 4: Update all existing HTTP `server.inject` calls to send Authorization**

In `apps/daemon/src/server.test.ts`, add a helper near the top of the file:

```ts
const AUTH_HEADERS = { authorization: 'Bearer test-token' } as const;
```

Then, in every `server.inject({ method: 'POST' | 'PATCH' | 'GET', url: ... })` call **except** the new unauthenticated tests added in Step 1 and the health-check test, merge `AUTH_HEADERS` into `headers`. Concretely, update:

- `'returns 200 with conformant HealthResponse'` → leave as-is (already unauthenticated).
- `'POST /v1/goals returns 201 with a valid Goal payload'`: `headers: { 'content-type': 'application/json', ...AUTH_HEADERS }`.
- `'POST /v1/goals returns 400 for invalid payload'`: same pattern.
- `'PATCH /v1/goals/:id updates the goal and returns 200'`: both the inner POST and the outer PATCH need `...AUTH_HEADERS`.
- `'PATCH /v1/goals/:id returns 404 for unknown id'`: add `...AUTH_HEADERS`.
- `'PATCH /v1/goals/:id returns 400 for empty patch'`: both inner POST and outer PATCH.
- `'POST /v1/goals/:id/archive archives and removes from default list'`: inner POST, outer archive POST, and the trailing `GET /v1/goals` all need `headers: { ...AUTH_HEADERS }`.
- `'POST /v1/goals/:id/archive returns 404 for unknown id'`: add `headers: AUTH_HEADERS`.
- `'GET /v1/goals returns a created Goal'`: inner POST and outer GET.
- Inside the `describe('GET /v1/events (replay)', ...)` block, `createGoalForTest` POST and every replay GET need `headers: AUTH_HEADERS`.

WS tests in `describe('WebSocket /v1/events', ...)` already authenticate via `?token=test-token`; the daemon POST inside those tests that triggers an event also needs `headers: AUTH_HEADERS` since it goes through the new hook.

- [ ] **Step 5: Run the full server test suite**

Run: `pnpm --filter @orca/daemon test -- server.test`

Expected: all tests pass, including the new 401 assertions and `GET /v1/health` staying public.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.test.ts
git commit -m "fix(daemon): enforce bearer auth on HTTP routes

Adds an onRequest hook that rejects HTTP requests without a matching
Authorization: Bearer <token>. /v1/health remains public; WS upgrades
keep their existing ?token= validation."
```

---

## Task 2: Append event before mutating projection in update/archive (Finding 2)

**Why:** `createGoal` follows event-then-projection (events.ts:104 → goals.ts:106). `updateGoal` and `archiveGoal` invert that order. The transaction is still atomic, but the inverted order teaches the wrong invariant for memory/recommendation/replay subsystems that will treat events as the source of truth.

**Decision:** Reorder so the domain event is always appended first, then the projection is updated, all in the same transaction. Existence check moves to a `SELECT` (or relies on the projection-update changes count after the event is appended — but then the event already exists when the not-found is detected, which is wrong). Use a pre-check `SELECT` to fail fast before any write.

**Files:**
- Modify: `apps/daemon/src/goals.ts`
- Modify: `apps/daemon/src/goals.test.ts`

### Steps

- [ ] **Step 1: Write failing test that enforces event-before-projection in `updateGoal`**

Add to `apps/daemon/src/goals.test.ts` inside `describe('updateGoal', ...)`:

```ts
it('appends goal.updated event before updating the goals projection', () => {
  const db = setup();
  const created = createGoal({ title: 'OrderProof' });

  // BEFORE UPDATE trigger that aborts unless a matching goal.updated event
  // already exists. If the projection write fires before the event insert,
  // the trigger raises and the transaction rolls back.
  db.exec(`
    CREATE TRIGGER enforce_update_event_first
    BEFORE UPDATE ON goals
    FOR EACH ROW
    WHEN OLD.archived_at IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'projection_updated_before_event')
      WHERE NOT EXISTS (
        SELECT 1 FROM events
        WHERE goal_id = NEW.id
          AND type = 'goal.updated'
          AND created_at = NEW.updated_at
      );
    END;
  `);

  expect(() => updateGoal(created.id, { title: 'After' })).not.toThrow();
});
```

- [ ] **Step 2: Write failing test for `archiveGoal` ordering**

Add to `apps/daemon/src/goals.test.ts` inside `describe('archiveGoal', ...)`:

```ts
it('appends goal.archived event before updating the goals projection', () => {
  const db = setup();
  const created = createGoal({ title: 'ArchiveOrderProof' });

  db.exec(`
    CREATE TRIGGER enforce_archive_event_first
    BEFORE UPDATE ON goals
    FOR EACH ROW
    WHEN NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'archive_projection_updated_before_event')
      WHERE NOT EXISTS (
        SELECT 1 FROM events
        WHERE goal_id = NEW.id
          AND type = 'goal.archived'
          AND created_at = NEW.archived_at
      );
    END;
  `);

  expect(() => archiveGoal(created.id)).not.toThrow();
});
```

- [ ] **Step 3: Run tests and confirm both fail with the abort messages**

Run: `pnpm --filter @orca/daemon test -- goals.test`

Expected: both new tests fail with SQLite abort errors (`projection_updated_before_event`, `archive_projection_updated_before_event`).

- [ ] **Step 4: Reorder `updateGoal`**

Replace the transaction block in `apps/daemon/src/goals.ts` `updateGoal` (currently lines 147–160) with:

```ts
db.transaction(() => {
  const existing = stmts.selectGoalById.get(id) as GoalRow | undefined;
  if (!existing) {
    throw new NotFoundError(id);
  }

  const result = stmts.insertEvent.run(eventId, "goal.updated", id, payload, now);
  seq = Number(result.lastInsertRowid);

  stmts.updateGoal.run(
    patch.title ?? null,
    patch.description ?? null,
    now,
    id
  );
  updatedRow = stmts.selectGoalById.get(id) as GoalRow;
})();
```

- [ ] **Step 5: Reorder `archiveGoal`**

Replace the transaction block in `apps/daemon/src/goals.ts` `archiveGoal` (currently lines 182–190) with:

```ts
db.transaction(() => {
  const existing = stmts.selectGoalById.get(id) as GoalRow | undefined;
  if (!existing) {
    throw new NotFoundError(id);
  }

  const result = stmts.insertEvent.run(eventId, "goal.archived", id, "{}", now);
  seq = Number(result.lastInsertRowid);

  stmts.archiveGoal.run(now, now, id);
  updatedRow = stmts.selectGoalById.get(id) as GoalRow;
})();
```

- [ ] **Step 6: Run the full goals test suite**

Run: `pnpm --filter @orca/daemon test -- goals.test`

Expected: all tests pass, including the existing rollback/publish tests and the two new ordering tests.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/goals.ts apps/daemon/src/goals.test.ts
git commit -m "refactor(daemon): append event before mutating projection in update/archive

Aligns updateGoal and archiveGoal with createGoal's event-then-projection
order so memory, replay, and recommendation systems can rely on events as
the source of truth."
```

---

## Task 3: Lifecycle guard on archived goals (Finding 3)

**Why:** Currently `updateGoal` succeeds against archived goals and `archiveGoal` emits a duplicate `goal.archived` event when called twice. M1 does not need a full status machine, but it does model active vs archived, and orchestration needs a coherent event history.

**Decision:** Reject updates and re-archives of already-archived goals with `NotFoundError` (returned as `404` at the HTTP layer). Rationale: from the active-set perspective, archived goals are not addressable — same semantics as a deleted id. No new `409 Conflict` shape is added, keeping the M1 surface minimal.

**Files:**
- Modify: `apps/daemon/src/goals.ts` (use the existing `selectGoalById` check that already lives in Task 2's reordered transactions, but require `archived_at IS NULL`)
- Modify: `apps/daemon/src/goals.test.ts`
- Modify: `apps/daemon/src/server.test.ts`

### Steps

- [ ] **Step 1: Add failing tests for update of archived goal**

Append to `describe('updateGoal', ...)` in `apps/daemon/src/goals.test.ts`:

```ts
it('throws NotFoundError when updating an archived goal', () => {
  setup();
  const created = createGoal({ title: 'X' });
  archiveGoal(created.id);

  expect(() => updateGoal(created.id, { title: 'Y' })).toThrow(NotFoundError);
});

it('does not append a goal.updated event when target is archived', () => {
  const db = setup();
  const created = createGoal({ title: 'X' });
  archiveGoal(created.id);

  expect(() => updateGoal(created.id, { title: 'Y' })).toThrow(NotFoundError);

  const updatedCount = (
    db.prepare("SELECT count(*) AS c FROM events WHERE goal_id = ? AND type = 'goal.updated'")
      .get(created.id) as { c: number }
  ).c;
  expect(updatedCount).toBe(0);
});
```

- [ ] **Step 2: Add failing tests for re-archive**

Append to `describe('archiveGoal', ...)` in `apps/daemon/src/goals.test.ts`:

```ts
it('throws NotFoundError when archiving an already-archived goal', () => {
  setup();
  const created = createGoal({ title: 'X' });
  archiveGoal(created.id);

  expect(() => archiveGoal(created.id)).toThrow(NotFoundError);
});

it('emits exactly one goal.archived event across two archive calls', () => {
  const db = setup();
  const created = createGoal({ title: 'X' });
  archiveGoal(created.id);
  expect(() => archiveGoal(created.id)).toThrow(NotFoundError);

  const count = (
    db.prepare("SELECT count(*) AS c FROM events WHERE goal_id = ? AND type = 'goal.archived'")
      .get(created.id) as { c: number }
  ).c;
  expect(count).toBe(1);
});
```

- [ ] **Step 3: Add failing HTTP test that PATCH on archived goal returns 404**

In `apps/daemon/src/server.test.ts` inside `describe('server routes', ...)`, append:

```ts
it('PATCH /v1/goals/:id returns 404 for an archived goal', async () => {
  const created = CreateGoalResponse.parse(
    JSON.parse(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/goals',
          headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
          payload: { title: 'will-archive' }
        })
      ).body
    )
  );

  await server.inject({
    method: 'POST',
    url: `/v1/goals/${created.goal.id}/archive`,
    headers: AUTH_HEADERS
  });

  const response = await server.inject({
    method: 'PATCH',
    url: `/v1/goals/${created.goal.id}`,
    headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
    payload: { title: 'late-edit' }
  });

  expect(response.statusCode).toBe(404);
});
```

- [ ] **Step 4: Run tests and confirm they fail**

Run: `pnpm --filter @orca/daemon test`

Expected: the four new tests fail (update succeeds against archived goal; second archive succeeds and writes a second event).

- [ ] **Step 5: Tighten existence pre-check in `updateGoal` and `archiveGoal`**

In the `db.transaction(() => { ... })` blocks added by Task 2, change the existence check from `existing` truthy to `existing && existing.archived_at == null`. Concretely, in `apps/daemon/src/goals.ts`:

For `updateGoal`:

```ts
const existing = stmts.selectGoalById.get(id) as GoalRow | undefined;
if (!existing || existing.archived_at !== null) {
  throw new NotFoundError(id);
}
```

For `archiveGoal`, identical replacement of its existence check.

- [ ] **Step 6: Run the full daemon test suite**

Run: `pnpm --filter @orca/daemon test`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/goals.ts apps/daemon/src/goals.test.ts apps/daemon/src/server.test.ts
git commit -m "fix(daemon): reject update/archive against already-archived goals

Treat archived goals as not-found for mutating routes so the event log
stops accumulating goal.updated/goal.archived events that contradict the
goal's archived state."
```

---

## Task 4: Parse projection rows through the `Goal` schema (Finding 6)

**Why:** `rowToGoal` casts `row.status` to `Goal["status"]` without parsing. The contracts package is the wire/projection contract; trusting raw SQLite contents lets corrupted rows escape via the API. Parse at the projection boundary.

**Files:**
- Modify: `apps/daemon/src/goals.ts`
- Modify: `apps/daemon/src/goals.test.ts`

### Steps

- [ ] **Step 1: Write a failing test for invalid projection state**

Append to `apps/daemon/src/goals.test.ts`:

```ts
describe('projection schema parsing', () => {
  it('throws when a goal row in the projection has an invalid status', () => {
    const db = setup();
    const created = createGoal({ title: 'X' });

    db.prepare("UPDATE goals SET status = 'bogus' WHERE id = ?").run(created.id);

    expect(() => listGoals()).toThrow();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @orca/daemon test -- goals.test`

Expected: `listGoals()` returns a Goal with `status: 'bogus'` because `rowToGoal` casts without validating.

- [ ] **Step 3: Replace the cast with `Goal.parse`**

In `apps/daemon/src/goals.ts`, update the import to include `Goal` as a schema, not only a type:

```ts
import {
  CreateGoalRequest,
  Goal,
  UpdateGoalRequest,
  type DomainEvent,
} from "@orca/contracts";
```

Replace `rowToGoal` (currently lines 37–48):

```ts
function rowToGoal(row: GoalRow): Goal {
  return Goal.parse({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    autonomyLevel: row.autonomy_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  });
}
```

The existing `import type { Goal }` line is replaced by the value import above; the type usage in the return annotation continues to resolve.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @orca/daemon test`

Expected: all tests pass, including the new corruption-detection test.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/goals.ts apps/daemon/src/goals.test.ts
git commit -m "fix(daemon): parse projection rows through Goal schema

rowToGoal now validates rows with Goal.parse instead of casting status,
so invalid projection state cannot leak through the API as M1's event
model continues to expand."
```

---

## Task 5: Tighten Tauri CSP (Finding 4)

**Why:** `tauri.conf.json` ships `"csp": null`. A renderer XSS once we render agent output / terminal logs could exfiltrate the per-launch daemon token. Tighten before PTY/session UI lands, not after.

**Decision:** Apply a restrictive CSP that supports:
- Loading the bundled Vite renderer from the Tauri origin (`'self'`).
- Vite's CSS injection (`style-src 'self' 'unsafe-inline'`).
- Tauri v2 IPC (`ipc: http://ipc.localhost` in `connect-src`).
- The local daemon at `http://127.0.0.1:*` / `ws://127.0.0.1:*`.
- Vite dev server / HMR at `http://localhost:*` / `ws://localhost:*` (loose by intent; only matters in dev where the renderer origin already is `localhost:5173`).

Disallow remote origins, inline scripts, eval, framing.

This task does not introduce a unit test (the renderer integration runs under Tauri and is not exercised by Vitest); verification is via `pnpm tauri dev` and a manual run through the existing Goal flow.

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`

### Steps

- [ ] **Step 1: Replace the disabled CSP**

In `apps/desktop/src-tauri/tauri.conf.json`, replace lines 21–23 (`security` block) with:

```json
    "security": {
      "csp": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    }
```

- [ ] **Step 2: Run the dev shell and verify no CSP violations on the existing M1 flow**

Run (from a separate terminal): `pnpm tauri dev`

In the launched window:
1. Open the renderer devtools console.
2. Confirm no `Refused to ... because it violates the following Content Security Policy directive` errors appear during initial load.
3. Create a Goal through the UI. Confirm:
   - The `POST /v1/goals` request is allowed and returns 201.
   - The WebSocket `/v1/events?token=...` connects and the new goal appears live.
   - No CSP violations are logged at any point.
4. Reload the window with `Ctrl+R` (or platform equivalent) and confirm Vite HMR still works (no `ws://localhost:5173` block).

If any directive blocks expected traffic, narrow the offending source rather than re-disabling the policy.

- [ ] **Step 3: Confirm the production build still parses the config**

Run: `pnpm --filter desktop tauri build --debug --no-bundle` (or the closest available build smoke command for this repo — fall back to `cargo check` on `apps/desktop/src-tauri` if a full build is too slow). The intent is to confirm `tauri.conf.json` validates against the v2 schema.

Expected: build proceeds past config parsing without schema errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/tauri.conf.json
git commit -m "fix(desktop): apply restrictive CSP to Tauri renderer

Replaces csp: null with a same-origin policy that allows Tauri v2 IPC,
local daemon HTTP/WS, and Vite dev/HMR while blocking remote origins,
inline scripts, eval, and framing — closing a token-exfil path before
PTY/session UI lands."
```

---

## Task 6: Document the DaemonContext seam decision for M2 (Finding 5)

**Why:** Finding 5's own remediation is: "Do not introduce a broad DI framework. When M2 touches createGoal, introduce the smallest explicit context seam needed for `db`, `bus`, `now`, and skill invocation." That is a *constraint on M2*, not a code change in M1. Capture it in the M2 plan so it is not lost.

**Files:**
- Modify: `docs/implementation-plans/milestone-2.md` (add a constraint under the existing scope-guard area)

### Steps

- [ ] **Step 1: Add the constraint to the M2 plan**

In `docs/implementation-plans/milestone-2.md`, locate the bullet that begins `**Scope guard:**` near the top of the file. Immediately after that paragraph, add a new section:

```markdown
### Inherited constraint from M1 review — DaemonContext seam

When M2 modifies `apps/daemon/src/goals.ts::createGoal` to invoke the Quick Goal skill and emit `skill.invoked` + `goal.created` in one transaction:

- Introduce a single explicit `DaemonContext` parameter type on the use-case (e.g. `{ db: Database.Database; bus: EventBus; now: () => string; invokeSkill: (...) => ... }`) so dependencies are visible at the call site.
- Source it from a small factory in `apps/daemon/src/index.ts` / tests; do not add a DI framework, container, or decorator metadata.
- Keep `eventBus` and `getDatabase()` module singletons as the production seam wiring; the test seam constructs an explicit context per case.
- Apply the same parameter to `updateGoal` and `archiveGoal` only if M2 modifies them; otherwise leave them on the singletons until a later milestone gives them a real reason to move.

Reason: M1 review flagged the hidden coupling on `_db`, `eventBus`, and the module-global prepared statements as acceptable for M1 but fragile for M2's atomic-transaction work. This constraint records the minimum-viable seam.
```

- [ ] **Step 2: Commit**

```bash
git add docs/implementation-plans/milestone-2.md
git commit -m "docs(m2): record DaemonContext seam constraint from M1 review

Captures finding 5's prescription: smallest-viable explicit context
seam at the createGoal entry point in M2, no DI framework. Prevents
the decision from being lost between M1 remediation and M2 execution."
```

---

## Task 7: Freeze sidecar surface for M2 (Finding 7)

**Why:** M1-022's sidecar bundle (`apps/daemon/scripts/build-sidecar.mjs`, `apps/daemon/src/sidecar-bootstrap.ts`, the Rust spawn path in `apps/desktop/src-tauri/src/lib.rs`) is the highest-complexity M1 surface area. Finding 7's remediation is: "Do not expand sidecar lifecycle during M2." Capture that as an explicit M2 scope guard.

**Files:**
- Modify: `docs/implementation-plans/milestone-2.md` (extend the scope-guard area)

### Steps

- [ ] **Step 1: Add the sidecar-freeze constraint**

In `docs/implementation-plans/milestone-2.md`, immediately after the section added in Task 6, append:

```markdown
### Inherited constraint from M1 review — Sidecar surface freeze

For the duration of M2, treat the production sidecar as operational substrate, not a feature surface:

- Do not modify `apps/daemon/scripts/build-sidecar.mjs`, `apps/daemon/src/sidecar-bootstrap.ts`, or the desktop spawn paths in `apps/desktop/src-tauri/src/lib.rs` unless a defect in M1-022 is found by M2 testing.
- New plugin/skill work must be validated by running the daemon standalone (`pnpm --filter @orca/daemon dev`) and against the existing Tauri dev path; do not introduce M2 logic that depends on changes to the SEA bundle, runtime resource layout, or platform launcher behavior.
- If M2 work uncovers a real sidecar defect, file it as a separate M1-follow-up task with its own review checkpoint before patching.

Reason: M1 review flagged sidecar packaging as a magnet for architectural attention during M2, especially around native better-sqlite3 binding handling and platform-specific launch behavior. Freezing the surface preserves M2's focus on the plugin/skill foundation.
```

- [ ] **Step 2: Commit**

```bash
git add docs/implementation-plans/milestone-2.md
git commit -m "docs(m2): freeze sidecar surface per M1 review finding 7

Records the M1-022 sidecar bundle as out-of-scope for M2 modifications.
Plugin/skill work must be validated against standalone daemon + Tauri
dev path until a real defect demands change."
```

---

## Final Verification

After Task 7:

- [ ] **Run the full daemon test suite**

Run: `pnpm --filter @orca/daemon test`

Expected: all tests pass.

- [ ] **Run the daemon integration test**

Run: `pnpm --filter @orca/daemon test -- m1-017.integration`

Expected: passes.

- [ ] **Run typecheck across the workspace**

Run: `pnpm -r typecheck` (or the equivalent project-wide TypeScript check the repo uses; fall back to `pnpm --filter @orca/daemon build` and `pnpm --filter desktop build`).

Expected: no type errors.

- [ ] **Manual M1 smoke**

Run `pnpm tauri dev`. Create a goal, observe the WS event update the list, archive it, restart the daemon (kill the sidecar process), confirm the goal survives, confirm the renderer's devtools console shows no CSP violations.

- [ ] **Optional: regenerate the operation-flow review**

If `docs/operation-flow/5-implementation-review.md` is the source of these findings, append a section noting each finding is now closed by commit hash, or move the file to `docs/operation-flow/5-implementation-review.closed.md`. Leave at the team's discretion — not required for plan completion.
