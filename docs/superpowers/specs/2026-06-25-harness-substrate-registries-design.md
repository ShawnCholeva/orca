# Harness Substrate Registries (Phase 0.1) — Design

**Date:** 2026-06-25
**Phase:** FUTURE_WORK Phase 0.1 — "Harness substrate factory: facet / boundary / sensor registries"
**Status:** Approved design, pre-implementation

## Goal

Consolidate the now-stable harness substrate behind three self-registering registries so generated/edited code can't structurally drift. The substrate vocabulary (facets, boundaries, sensors) is currently **hand-synced across many parallel lists**; this replaces that with a single source per concept plus a **conformance guard** that fails loud when the sources disagree. Delivers the Phase 0 "runtime-enumerable" exit criterion via a `GET /v1/harness/registry` route.

**Naming:** `defineFacet` / `defineBoundary` / `defineSensor` (idiomatic-TS spelling of the doc's `def*` shorthand).

## Governing constraint (from FUTURE_WORK)

**Registry-derived runtime wiring + a load-time/test conformance guard — NOT mapped-type contract generation** (rejected as too clever, ORCA.md §11). Concretely:

- The contract types (`HarnessTransition`, `HarnessTransitionBoundary`, `WorkflowSensorKind`) stay **hand-written and readable**.
- The registries are the single source for **runtime wiring** (projection serialize/parse loops, typed emitters, sensor detection).
- A **conformance guard** asserts the registry, the contract, and the projection stay in lockstep — at daemon load (throws) and as a unit test.

## Behavior-change posture

Phase 0 is "no behavior change / pure consolidation," with **two deliberate, user-approved exceptions** carved into 0.1 itself:

1. **Validate-on-write** (fixes the read-validates/write-doesn't gap) — new check; **throws on invalid facet**.
2. **Fire the dormant `mark_done` boundary** from the completion flow — adds one new transition row per mark-done.

Everything else is behavior-preserving and leans on the existing test suites as the guard.

---

## Current-state map (verified 2026-06-24 working tree)

### Facets — `packages/contracts/src/harness/index.ts`
- `HarnessTransition` (lines 188–202): envelope fields `id, goalId, workflowRunId, workflowStepRunId, boundary, createdAt` + four nullable facet fields.
- Four facets (`key` → schema): `risk`→`RiskFacet` (62–88), `evidence`→`EvidenceFacet` (34–48), `stateDeps`→`StateDepsFacet` (176–184), `telemetry`→`TelemetryFacet` (113–135). All `.strict()`.

### Facet hand-sync sites (what the registry collapses)
- `apps/daemon/src/harness-transitions/usecases.ts`: import list (5–10), `RecordTransitionInput` (24–33), row build (56–67).
- `apps/daemon/src/harness-transitions/projection.ts`: `TransitionRow` (4–15), `COLS` (17–18), `INSERT` (30–35), `rowToTransition` parse-back (55–68, **validates** via `HarnessTransition.parse` at 56), `insertTransition` serialize args (72–83). Camel↔snake rename: `stateDeps` ↔ `state_deps_json`.

### Write path — `usecases.ts` `recordHarnessTransition` (48–98)
Builds an in-memory `HarnessTransition` row, persists, and `return row` at **line 97 unvalidated**. No `.parse` on the write path. (Gap confirmed.)

### Boundaries — enum at `harness/index.ts:3–9`: `step_launch, step_complete, tool_gate, mark_done`.
Emit call sites (all verified):
| Site | Boundary | Facets |
|---|---|---|
| `permission-gate.ts:34` | `tool_gate` | risk |
| `service.ts:1767` | `step_complete` | evidence, stateDeps, telemetry |
| `service.ts:1846` | `step_complete` | stateDeps |
| `service.ts:2498` | `step_complete` | stateDeps, telemetry |
| `service.ts:3352` (via `recordStepLaunchTransition`, def 3319–3372, called 3303) | `step_launch` | stateDeps |

`mark_done` is **declared but never emitted** (dormant). NOTE: `completeWorkflowRun` (`workflows/runs/usecases.ts:238`) is **dead code** (exported, zero non-test callers). The real human-authoritative completion is the **accept side-effect of a `complete_workflow_run` recommendation**: `applyWorkflowAcceptSideEffectsInTx` case `'complete_workflow_run'` (`recommendations/usecases.ts:417`), driven inside the `db.transaction()` at `recommendations/usecases.ts:495` within `recordTerminalFeedback` (478). That is where a human accepts the `mark_run_complete` recommendation and the run flips to `completed`.

### Sensors — `apps/daemon/src/harness-sensors/detect.ts`
- `WorkflowSensorKind` enum (`harness/index.ts:11–19`): `typecheck, lint, unit, integration, build, static` (6 kinds).
- `LABEL_TO_SCRIPT` (14–19): only `typecheck, lint, unit, build` (4 entries). Consumed by `detectSensors` (31–40, filters) and `runner.ts` gap-loop (53–55).
- `integration` and `static` are **declared-but-unimplemented drift** (no entry, no detector).

### Directory layout
- `packages/contracts/src/harness/index.ts` — single file, all schemas. Natural home for `defineFacet` + facet registry and `defineBoundary` + boundary-facet declarations.
- `apps/daemon/src/harness-transitions/` — `projection.ts`, `usecases.ts`, `routes.ts` (no barrel). Home for the emit factory wiring + conformance guard.
- `apps/daemon/src/harness-sensors/` — `detect.ts`, `runner.ts` (no barrel). Home for `defineSensor` + sensor registry.

---

## Design

### 1. `defineFacet` registry (contracts)

A facet spec: `{ key, column, schema }` — e.g. `{ key: "stateDeps", column: "state_deps_json", schema: StateDepsFacet }`. Registry = the 4 specs, defined in `packages/contracts/src/harness/`.

**Derived (replaces hand-synced lists):**
- `projection.ts`: `COLS`, `INSERT` placeholder count, `insertTransition` serialize args, and the `parseFacet` block in `rowToTransition` become **loops over the registry**.
- `usecases.ts`: the `row` facet assignment (`risk: input.risk ?? null` ×4) becomes a registry loop; `RecordTransitionInput` facet fields stay explicit (covered by the guard).

**Stays hand-written:** the `HarnessTransition` Zod object (per the no-codegen rule).

**Conformance guard** `assertFacetConformance()`: introspects `HarnessTransition.shape` at runtime and asserts `registry keys === facet-typed fields in the contract === projection columns (camel↔snake mapped via spec.column)`. Runs at daemon load (throws loud) **and** as a unit test. Adding a facet = one registry entry + one migration column; the guard fails until both land.

### 2. `defineBoundary` emit factory (contracts decl + daemon emitters)

Each boundary declares the facets it *may* carry:
```
defineBoundary({ key: "step_complete", facets: ["evidence", "stateDeps", "telemetry"] })
defineBoundary({ key: "step_launch",   facets: ["stateDeps"] })
defineBoundary({ key: "tool_gate",     facets: ["risk"] })
defineBoundary({ key: "mark_done",     facets: ["telemetry"] })
```
The factory generates **one typed emitter per boundary** that:
1. type-accepts only its declared facets (a site may fill a subset; the rest serialize null),
2. delegates to the now-internal `recordHarnessTransition`.

**Validate-on-write** lives at the single write choke point — inside `recordHarnessTransition` itself (`HarnessTransition.parse(row)` before `return`), not in each emitter — so every write validates and throws on invalid regardless of caller, and the check can't be bypassed by a future direct call.

These emitters are the **only sanctioned write path**. Replace the 5 string-literal sites:
- `permission-gate.ts:34` → `emitToolGate`
- `service.ts:1767 / 1846 / 2498` → `emitStepComplete`
- `service.ts:3352` (inside `recordStepLaunchTransition`) → `emitStepLaunch`

This is the same slice as 0.2's "transition emit" seam — done once, here.

**Throw semantics note:** the existing 5 sites wrap emits in `try/catch` that `console.error` and continue, so a throw degrades to logged-not-fatal in prod while being loud in tests. The new `mark_done` site (below) must adopt the same swallow-and-log wrapper to preserve completion-flow robustness.

### 3. Fire `mark_done` (user-approved behavior change)

Emit `mark_done` carrying a **minimal `TelemetryFacet`** when a human accepts a `complete_workflow_run` recommendation. It's the harness ledger's terminal boundary (today the spine has none), and the telemetry facet makes it an **outcome label** rather than a bare timestamp:

```ts
const telemetry: TelemetryFacet = {
  cost: null, latency_ms: null, model: null,
  provider_id: null, provider_version: null,
  prompt_ref: null, raw_output_ref: null,
  rejected_alternatives: [],
  human_interventions: [{ kind: "mark_done_approval", ref: rec.id }],
  outcome: { status: "succeeded", failure_code: null },
};
```
`outcome.status="succeeded"` is the run's terminal label (vs the `escalated`/`failed`/`denied` other terminals produce); `human_interventions` records the human sign-off (`ref` = the accepted recommendation id). cost/latency/model stay null — the accept path has no worker session to source them from.

**Site & transaction constraint.** The completion side-effect runs *inside* a `db.transaction()` (`recordTerminalFeedback` → `applyWorkflowAcceptSideEffectsInTx`, `recommendations/usecases.ts:495`). `recordHarnessTransition` opens its **own** `db.transaction()`, and better-sqlite3 forbids nested transactions. So the emit must happen **after the outer transaction commits**, not inside the `InTx` helper. Concretely: in `recordTerminalFeedback`, after the `db.transaction()(...)` block, guard on `action === 'accept' && rec.proposedAction.kind === 'complete_workflow_run'` and call `emitMarkDone(ctx, { goalId: rec.goalId, workflowRunId: rec.proposedAction.workflowRunId, telemetry })`. `ctx` (`db`/`bus`/`now`/`idFactory`) matches `HarnessTransitionCtx`. Wrapped in swallow-and-log so a transition failure never breaks completion.

### 4. `defineSensor` registry (daemon)

Replaces `LABEL_TO_SCRIPT` with a registry keyed by `WorkflowSensorKind`:
```
defineSensor({ kind: "typecheck", label: "typecheck",  script: "typecheck" })
defineSensor({ kind: "lint",      label: "lint",       script: "lint" })
defineSensor({ kind: "unit",      label: "unit_tests", script: "test" })
defineSensor({ kind: "build",     label: "build",      script: "build" })
```
Both consumers (`detect.ts` filter, `runner.ts` gap-loop) import from the registry. `integration` and `static` become **explicit `unimplemented` declarations** (a sibling set or `status: "unimplemented"` entries).

**Conformance guard** `assertSensorConformance()`: asserts every `WorkflowSensorKind` enum value is either registered or explicitly unimplemented — so adding a kind forces a decision and the `integration`/`static` drift is closed.

### 5. `GET /v1/harness/registry` introspection route

Read-only route in `apps/daemon/src/harness-transitions/routes.ts` (or a new `harness/routes.ts`) returning JSON:
- `boundaries`: `[{ key, facets: [...] }]`
- `facets`: `[{ key, column }]`
- `sensors`: `[{ kind, label, script, status }]`

This is the concrete "runtime-enumerable" deliverable. Full Zod→JSON-Schema export of facet schemas is **out of scope** for this pass (keys/columns/declared-facets suffice); note as an optional follow-up.

---

## Testing strategy

Behavior-preservation rests on existing suites: `harness-transitions/usecases.test.ts`, `projection` round-trip, `harness-sensors/detect.test.ts` + `runner.test.ts`, and the orchestrator suite (`service.*.test.ts`).

New tests (TDD — conformance tests written first):
- `assertFacetConformance` — passes today; fails when registry/contract/projection diverge (add a stray column / drop a registry entry in the test).
- `assertSensorConformance` — passes; fails when an enum kind is neither registered nor unimplemented.
- Validate-on-write — an emitter rejects an invalid facet payload (throws).
- `mark_done` fires once on `completeWorkflowRun` (one transition row, boundary `mark_done`, null facets).
- `GET /v1/harness/registry` returns the three registries.

## Sequencing (4 reviewable commits)

1. **`defineFacet`** + projection/usecases rewrite + `assertFacetConformance` (proves the pattern before replication).
2. **`defineBoundary`** emit factory + validate-on-write + replace the 5 sites + fire `mark_done`.
3. **`defineSensor`** + detect/runner rewrite + `assertSensorConformance` (closes `integration`/`static` drift).
4. **`GET /v1/harness/registry`** route.

## Out of scope (this pass)

- Zod→JSON-Schema export of facet schemas in the route.
- New sensor *kinds* / implementations (Phase 3 — they register via `defineSensor` then).
- The rest of 0.2's `OrchestratorService` decomposition (only the transition-emit slice is here).
- `RecordTransitionInput` derivation via mapped types (stays explicit, guard-covered).
- **`mark_done` roll-up enrichments** — cumulative write-set + Goal-total cost. Deferred to FUTURE_WORK **2.7** (new aggregation capabilities, not consolidation; cost roll-up also blocked on Phase 3 telemetry reliability). The `mark_done` emit site gets a code comment pointing at 2.7.
