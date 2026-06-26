# Per-adapter hook-readiness contract check — design

**FUTURE_WORK Phase 0.3.** The last item before Phase 0 exits. No behavior change to orchestration; this *adds* a thin readiness/contract check that converts a silent third-party-hook drift into a loud, enumerable signal.

- Date: 2026-06-26
- Status: approved (design), pre-implementation
- Related: `FUTURE_WORK.md` §0.3, `ORCA.md` §6/§7/§14, `FUTURE_ARCHITECTURE.md` (Runner Protocol), 0.1 harness registries (`docs/superpowers/specs/2026-06-25-harness-substrate-registries-design.md`)

---

## 1. Problem & purpose

Orca's whole orchestration depends on third-party CLI hooks firing back to the daemon — Claude's `Stop`/`PermissionRequest`, Codex's `Stop`/`StopFailure`/`PermissionRequest`, antigravity's `Stop`. Those hook surfaces are **undocumented and can change in any CLI update**: an event gets renamed, a payload field changes, the firing context shifts (the verified "Codex hooks fire only in the interactive TUI, never `codex exec`" is exactly this class of fragile, undocumented fact; the assumed 600s hook-timeout default is still unverified).

When a hook surface drifts, **the hook silently stops firing and the goal hangs forever with no error** — this is the `ECONNREFUSED`-on-Stop-hook / silently-stuck-goal failure the daemon-addressing arc already had to fix once. It is the worst failure class: invisible.

`workerHookConfig()` + `supportsPermissionPersistence` localize the blast radius, but the *dependence* cannot be abstracted away. **Purpose of 0.3: convert that invisible failure into a loud, enumerable signal**, with three concrete payoffs:

1. An Orca engineer edits an adapter and breaks the hook wiring → **daemon fails to boot** instead of shipping a silently-broken orchestrator (self-conformance).
2. A user upgrades their Claude/Codex CLI to a version Orca hasn't verified → a **`degraded` / "re-verify" readiness state** on a route, pointing a human at the exact assumption to re-check — instead of mystery hangs (version-pin).
3. The known gaps (antigravity's 4 worker-permission unknowns) are **explicitly enumerated as `unverified`** rather than masquerading as working.

This is the item that lets **Phase 0 exit**: 0.1 made facets/boundaries/sensors runtime-enumerable; 0.3 makes the third-party-hook dependence (named in FUTURE_WORK as "the deepest structural risk") enumerable and tripwired too.

### Alignment

- **Code as Agent Harness paper:** a boot-time self-conformance guard is a *deterministic sensor* firing at a boundary (daemon startup), the same shape as 0.1's load-time conformance guards; the route is the "inspectable" surface. Verification through deterministic sensors, not live exercise.
- **FUTURE_ARCHITECTURE:** the declared hook contract is an execution-plane capability surface — the in-process precursor to a Runner advertising "here is the hook contract I depend on" across the network boundary. The introspection route makes it runtime-enumerable, which is the literal Phase 0 exit criterion.

---

## 2. Approach (decided)

**Declared per-(provider × surface × event) assumption entries + boot self-conformance hard-fail + on-demand version-drift/unverified surfacing via an introspection route.** No live third-party process is ever spawned.

Two rejected alternatives:

- **Live behavioral probe** (spawn each CLI, assert a hook fires) — the only thing that truly proves a hook fires, but slow, flaky, requires every CLI installed+authed (antigravity often isn't), can't run in CI, and is the opposite of "thin." Rejected.
- **Runtime watchdog only** (detect an expected hook that never fired within a window, fail the running goal) — catches real upstream drift but only *reactively*, after the goal is mid-run; per-spawn and more invasive than a readiness check. Kept as a documented *optional future* complement, out of scope here.

### Honest limitation (documented, accepted)

Version-pin is a **proxy, not proof**. A *silent semantic rename at the same CLI version* is undetectable by this check. We accept two imperfections on purpose:

- **False positive (a nag):** a version bump that didn't touch hooks still shows `degraded`. Cheap and visible — a human glances and bumps the verified-against version.
- **False negative (the residual gap):** a same-version semantic rename is invisible. The only real mitigation is the optional future runtime watchdog.

We bias toward the false nag because the failure being guarded — a silent, invisible, goal-hangs-forever drift — is catastrophic, while the nag costs a glance.

---

## 3. Architecture

```
ShadowProvider.hookContract(): HookAssumption[]      ← declared in claude.ts / codex.ts / antigravity.ts
        │
        ├─ assertHookContractConformance()   → called at index.ts boot, throws → process.exit(1)
        │     (self-conformance: declared entry vs regenerated hookConfig/workerHookConfig output)
        │
        └─ checkHookContracts({ versions })  → GET /v1/harness/hook-contracts  (surface-only)
              (self-conformance status + version-pin drift + unverified, per entry)
```

- The **declaration lives on the provider** so an engineer editing `codex.ts` sees the contract inches away — it cannot silently drift from the code it describes.
- The **checker is a separate leaf module** so the boot path and the route share one implementation.
- Mirrors the existing `assertHarnessRegistryConformance(db)` boot guard (`index.ts:85`, aggregated in `harness-transitions/conformance.ts`) and the `/v1/harness/registry` enumeration route exactly — the same two-surface pattern (boot-throw + introspection route).

---

## 4. Data model

```ts
export type HookSurface = "orchestrator" | "worker"; // hookConfig vs workerHookConfig

export interface HookAssumption {
  provider: ShadowAdapterId;              // "claude-code" | "codex" | "antigravity"
  surface: HookSurface;
  event: string | null;                   // "Stop" | "PermissionRequest" | … ; null = unknown (agy worker)
  file: string | null;                    // relPath the hook is wired into; null = unknown
  payloadFields: string[];                // fields the wiring consumes; asserted present in emitted config
  assertSpawnArg: string | null;          // optional flag asserted in spawnArgs (e.g. "--dangerously-bypass-hook-trust")
  firingContext: string;                  // doc only: "interactive-tui-only" | "unattended" | "unknown"
  verifiedAgainstVersion: string | null;  // CLI version last human-verified; drives version-pin
  verified: boolean;                      // false = honest unknown → never green, skipped by self-conformance
  note: string;                           // provenance ("verified codex-cli 0.136.0", or the 4 unknowns)
}
```

- **Asserted-structural fields** (checked against regenerated config): `event`, `file`, `payloadFields`, `assertSpawnArg`.
- **Documentation fields:** `firingContext`, `note`.
- **Status-driving fields:** `verified`, `verifiedAgainstVersion`.
- A `verified: false` entry (antigravity worker surface) carries unknowns as `null` and is **skipped by the structural assert but enumerated as a known gap**.

The route returns a plain object (no zod envelope), matching how `/v1/harness/registry` returns plain objects today. **No `packages/contracts` change for v1**; desktop rendering is a Phase 4 surface concern.

---

## 5. Data flow

### Boot path (hard-fail tier)

1. `index.ts` startup calls `assertHookContractConformance()` immediately after `assertHarnessRegistryConformance(db)`, same `try/catch → console.error → process.exit(1)` shape.
2. For each provider, for each `verified: true` entry: regenerate that surface's config — `provider.hookConfig({ goalId, resolverCommand })` or `provider.workerHookConfig({ …synthetic args })` — and assert:
   - `entry.file` appears as an emitted `relPath`;
   - `entry.event` and each `payloadFields[]` string appear in that file's `contents`;
   - `entry.assertSpawnArg` (if non-null) appears in `spawnArgs`.
3. Any mismatch → throw with a precise message, e.g. `hook contract drift: codex/worker/PermissionRequest — declared field 'tool_input' not found in emitted hooks.json`. `verified: false` entries are skipped here.

This is the runtime, declaration-driven form of what `worker-hook-config.test.ts` asserts today.

### On-demand path (surface-only tier) — `GET /v1/harness/hook-contracts`

1. Read last-known installed versions from persisted readiness (`listAgents(db)` → `version`, backed by the `readiness_version` column) — **no new subprocess**.
2. Re-run self-conformance per entry, then layer version-pin, producing one status per entry:

| Status | Condition |
|---|---|
| `ok` | verified, conformant, installed version matches `verifiedAgainstVersion` at minor/major |
| `degraded` | verified + conformant, but installed minor/major ≠ verified-against → `detail: "verified against 0.136, running 0.140 — re-verify"` |
| `unverified` | `verified: false` (agy worker) → `detail` carries the `note` |
| `unknown` | no persisted version / unparseable → can't assess drift |
| `nonconformant` | self-conformance failed (shouldn't occur post-boot; reported defensively rather than throwing on the route) |

3. Return:

```jsonc
{ "contracts": [
  { "provider": "codex", "surface": "worker", "event": "PermissionRequest",
    "file": "hooks.json", "firingContext": "interactive-tui-only",
    "verified": true, "verifiedAgainstVersion": "0.136.0",
    "installedVersion": "0.140.0", "status": "degraded",
    "detail": "verified against 0.136, running 0.140 — re-verify" }
] }
```

### Version comparison policy

Hook surfaces almost never change in patch releases, so **flag on minor/major difference, ignore patch** (`0.136.0 → 0.136.1` stays `ok`; `0.136 → 0.140` → `degraded`). Reuses `parseVersion` (`readiness/version.ts`). This is a deliberate decision, called out here rather than buried.

---

## 6. Error handling

- The **boot guard is the only throw site.** The route never throws on drift — drift is data, not an exception.
- Version parse reuses `parseVersion`; missing/unparseable → `unknown`, never a crash.
- Patch-only diff → stays `ok` (the locked minor/major policy).

---

## 7. File plan

| File | Change |
|---|---|
| `apps/daemon/src/orchestrator-llm/providers/types.ts` | Add `HookSurface` + `HookAssumption` + `hookContract(): HookAssumption[]` to `ShadowProvider`. |
| `apps/daemon/src/orchestrator-llm/providers/claude.ts` | Implement `hookContract()` — orchestrator `Stop` + worker `Stop`/`StopFailure`/`PermissionRequest`, all `verified: true` with verified-against version from existing comments. |
| `apps/daemon/src/orchestrator-llm/providers/codex.ts` | Implement `hookContract()` — orchestrator `Stop`/`StopFailure`; worker `Stop`/`StopFailure`/`PermissionRequest` + `assertSpawnArg: "--dangerously-bypass-hook-trust"`, `firingContext: "interactive-tui-only"`, `verifiedAgainstVersion: "0.136.0"`. |
| `apps/daemon/src/orchestrator-llm/providers/antigravity.ts` | Implement `hookContract()` — orchestrator `Stop` (`verified: true`); worker permission entry `verified: false` with the 4 unknowns as `null`s + the FUTURE_WORK Phase 1 note. |
| `apps/daemon/src/orchestrator-llm/providers/hook-contract.ts` *(new)* | `checkHookContracts({ versions })` → report; `assertHookContractConformance()` → boot guard; shared self-conformance logic (synthetic-arg regeneration + structural assert); minor/major version compare. |
| `apps/daemon/src/index.ts` | Call `assertHookContractConformance()` after `assertHarnessRegistryConformance(db)`, same try/catch→exit(1). |
| `apps/daemon/src/harness-transitions/routes.ts` | Add `GET /v1/harness/hook-contracts` (reads `listAgents(db)` versions, calls `checkHookContracts`). |

No `packages/contracts` change. No migration. No DB schema change.

---

## 8. Testing

`hook-contract.test.ts` + a route test:

1. **Real-provider conformance** — all three providers' declared contracts conform to their actual emitted config. The meaningful regression guard (the runtime form of `worker-hook-config.test.ts`); green by construction.
2. **Self-conformance fails loud** — a fixture provider with a deliberately-wrong declared `event`/`file`/`payloadField` → `assertHookContractConformance` throws with the precise message.
3. **agy honesty** — antigravity's `verified: false` worker entry is skipped by the structural assert and surfaces as `unverified`; its orchestrator `Stop` surfaces `ok`/`degraded` (same provider, two statuses).
4. **Version-pin** — match → `ok`; minor/major drift → `degraded`; patch-only → `ok`; missing/unparseable version → `unknown`.
5. **Route test** — `GET /v1/harness/hook-contracts` returns the enumerated entries with statuses (mirrors the existing harness-registry route test).
6. **Conformance-guard wiring** — the boot aggregator path invokes the new guard (add to/alongside the existing conformance test).

`worker-hook-config.test.ts` stays as-is (surgical changes — not this task's to refactor); it overlaps but validates exact emitted values, still useful.

---

## 9. Out of scope

- Live behavioral probing of any CLI.
- The runtime "expected-hook-never-fired" watchdog (optional future complement).
- Any `packages/contracts` schema or desktop UI rendering (Phase 4 surface work).
- Wiring antigravity's worker permission gate (Phase 1, blocked on the 4 unknowns) — 0.3 only *declares the gap honestly*, it does not close it.
- Persisting contract-check results to the DB — the report is computed on-demand from declared entries + persisted readiness versions; stateless.
