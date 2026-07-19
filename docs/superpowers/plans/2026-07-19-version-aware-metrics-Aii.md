# Version-Aware Metrics A-ii — Lineage, Change-Markers & Scope Toggles (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase A — add scope toggles (`current`/`latest`/`all`), id-keyed cross-version node lineage from snapshots, provable change-markers (type-change + rename), and a per-node history strip.

**Architecture:** A `scope` param threads from the desktop through the metrics route into aggregation, making A-i's current-node filters conditional. A new daemon helper reads per-version `template_snapshot_json`, keys lineage by node id, and derives an optional `versionHistory` (markers + eras) attached to each step/gate metric. Recompute-on-read; no migration.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo (`packages/contracts`, `apps/daemon`, `apps/desktop`).

**Design spec:** `docs/superpowers/specs/2026-07-19-version-aware-metrics-Aii-design.md`. **Mockup (desktop reference):** `scratchpad/metrics-redesign.html` (scope bar, `⤳` marker chips, history strip).

## Global Constraints

- **Scope semantics:** `current` (default) = A-i filters ON; `latest` = A-i filters ON **plus** only `templateVersion === latestVersion` runs; `all` = A-i filters OFF (show fossils/all eras).
- **Lineage identity = node id** (Orca renames in place). Provable markers only: `changedFrom` (type differs in an earlier in-window version) and `renamedFrom` (name differs). No heuristic cross-id matching.
- **Corrected lineage** (verify against snapshots, do NOT hardcode): `critique` = step→gate @v12 (`changedFrom: "step"`); `review` = always gate, renamed "Release Readiness"→"Verify" @v13 (`renamedFrom: "Release Readiness"`); `verify` step retired (A-i drops it, no marker).
- `versionHistory` is **OPTIONAL** on `StepMetrics`/`GateMetrics` (no required-field ripple); present only when there is lineage.
- Snapshot parse must be resilient: a missing/malformed snapshot for a version → skip that version, never throw.
- No change to scoring, bands, calibration, completion/policy gateways.

---

### Task 1: Scope param + conditional filters (contract + daemon)

**Files:**
- Modify: `packages/contracts/src/metrics/index.ts` (add `MetricScope` enum; add `scope` to the detail summary echo)
- Modify: `apps/daemon/src/metrics/routes.ts` (parse `scope` query param, default `current`)
- Modify: `apps/daemon/src/metrics/usecases.ts` (`getTemplateMetricsDetail` takes `scope`; thread to compute + latest-filter)
- Modify: `apps/daemon/src/metrics/aggregate.ts` (`inCurrentShape` conditional on scope) + `gate-metrics.ts` (`currentGates` guard conditional on scope)
- Test: `apps/daemon/src/metrics/usecases.gate.test.ts` (or a new `usecases.scope.test.ts`)

**Interfaces:**
- Produces: `MetricScope = z.enum(["current","latest","all"])`; `getTemplateMetricsDetail(db, templateId, period, nowIso?, scope: MetricScope = "current")`.

- [ ] **Step 1: Add the contract enum + summary echo**

In `packages/contracts/src/metrics/index.ts`, next to `MetricPeriod` (~:6):
```ts
export const MetricScope = z.enum(["current", "latest", "all"]);
export type MetricScope = z.infer<typeof MetricScope>;
```
Add `scope: MetricScope` to the `TemplateMetricsSummary` (echo the active scope). Update the summary fixtures that break (contract `index.test.ts` + the daemon/desktop summary fixtures — enumerate via `grep "buildSummary\|TemplateMetricsSummary"`).

- [ ] **Step 2: Write the failing daemon test**

Add a test asserting scope behavior (build a template with a current step `a`, a fossil step `z` not in `steps_json`, and runs across two versions):
```ts
it("scope=current filters fossils; scope=all shows them; scope=latest drops non-latest runs", () => {
  // seed a template (steps_json ["a"]) + runs for step "a" (v1,v2) and fossil "z" (v1)
  // getTemplateMetricsDetail(db, id, "30d", now, "current") → steps = ["a"]
  // ... "all") → steps include "z"
  // ... "latest") → only v2 runs contribute (assert "a" run count = v2 count)
});
```
(Use the test DB seeding pattern already in `usecases.gate.test.ts`; assert on `detail.steps.map(s=>s.stepTemplateId)` and a run-count for the latest case.)

- [ ] **Step 3: Run it to verify it fails** — `pnpm --filter @orca/daemon test -- usecases` (fails: scope not yet honored).

- [ ] **Step 4: Implement**

- `routes.ts`: parse `scope` like `period` (`MetricScope.safeParse((query).scope)`, default `"current"` when absent/invalid), pass to `getTemplateMetricsDetail`.
- `usecases.ts`: add `scope` arg (default `"current"`); when `scope === "latest"`, filter `transitions`/`stepRuns`/`gateDecisions` to `templateVersion === info.latestVersion` before aggregation; pass a `scope` flag to `computeStepMetrics` and `buildGateMetrics`.
- `aggregate.ts`: `inCurrentShape` becomes `scope === "all" ? () => true : (id) => currentSteps.size === 0 || currentSteps.has(id)`.
- `gate-metrics.ts`: the `currentGates` guard skips filtering when `scope === "all"`.
- Echo `scope` into the summary.

- [ ] **Step 5: Run tests to verify they pass** — `pnpm --filter @orca/daemon test -- usecases`, then `pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/daemon typecheck`. Fix summary fixtures for the new required `scope` field. Green.

- [ ] **Step 6: Commit** — `git commit -m "feat(metrics): scope toggle (current/latest/all) for version-aware aggregation"`

---

### Task 2: Snapshot lineage + change-markers (contract + daemon)

**Files:**
- Create: `apps/daemon/src/metrics/node-lineage.ts`
- Modify: `packages/contracts/src/metrics/index.ts` (optional `versionHistory` on `StepMetrics` + `GateMetrics`)
- Modify: `apps/daemon/src/metrics/aggregate.ts` (attach `versionHistory` to step metrics) + `gate-metrics.ts` (to gate metrics) + `usecases.ts` (compute lineage once, pass in)
- Test: `apps/daemon/src/metrics/node-lineage.test.ts`

**Interfaces:**
- Produces: `computeNodeLineage(db, templateId, sinceIso, untilIso): Map<string, NodeLineage>` where `NodeLineage = { changedFrom?: "step"|"gate"; renamedFrom?: string; eras: { type; fromVersion; toVersion; runs }[] }`. Consumed by `computeStepMetrics`/`buildGateMetrics` as an optional `lineage` input, keyed by node id (step id / gate node id).

- [ ] **Step 1: Add the contract field**

```ts
export const NodeVersionHistory = z.object({
  changedFrom: z.enum(["step", "gate"]).optional(),
  renamedFrom: z.string().optional(),
  eras: z.array(z.object({ type: z.enum(["step", "gate"]), fromVersion: z.number().int(), toVersion: z.number().int(), runs: z.number().int().nonnegative() })),
}).strict();
```
Add `versionHistory: NodeVersionHistory.optional()` to `StepMetrics` and `GateMetrics`. Optional → no fixture ripple.

- [ ] **Step 2: Write the failing lineage test**

`node-lineage.test.ts` — seed `workflow_runs` rows with `template_snapshot_json` for 3 versions (v1: node `x` type step name "X"; v2: `x` type gate name "X"; v3: `x` type gate name "X2") + runs per version, then:
```ts
const lin = computeNodeLineage(db, "tpl", since, until).get("x");
expect(lin.changedFrom).toBe("step");          // step in v1, gate now
expect(lin.renamedFrom).toBe("X");             // name changed X → X2
expect(lin.eras).toEqual([
  { type: "step", fromVersion: 1, toVersion: 1, runs: /* v1 runs */ },
  { type: "gate", fromVersion: 2, toVersion: 3, runs: /* v2+v3 runs */ },
]);
```
Also: a stable node → `computeNodeLineage` returns no entry (or an entry with no `changedFrom`/`renamedFrom` and a single era); a version with a malformed snapshot is skipped without throwing.

- [ ] **Step 3: Run it to verify it fails** — `pnpm --filter @orca/daemon test -- node-lineage`.

- [ ] **Step 4: Implement `node-lineage.ts`**

Query `SELECT DISTINCT template_version, template_snapshot_json FROM workflow_runs WHERE template_id = ? AND started_at >= ? AND started_at < ? ORDER BY template_version`. For each row: `try { JSON.parse } catch { continue }`; read `snapshot.graph.nodes` → per node id record `{ version, type, name }`. Also count runs per version (reuse `versionsInWindow` data or a per-version run count). Build the map keyed by id: sort observations by version; `changedFrom` = the type in the earliest in-window version if it differs from the latest; `renamedFrom` = the most-recent prior name that differs from the current name; `eras` = contiguous same-type spans with summed run counts. Attach in `usecases.ts` (compute once) and pass into `computeStepMetrics`/`buildGateMetrics`, which set `versionHistory` on the matching step/gate by id (omit when the node is stable and single-era).

- [ ] **Step 5: Run tests to verify they pass** — `pnpm --filter @orca/daemon test -- node-lineage`, then full contracts+daemon+typecheck green.

- [ ] **Step 6: Commit** — `git commit -m "feat(metrics): id-keyed node lineage from snapshots (change-markers + eras)"`

---

### Task 3: Desktop — scope bar, marker chips, history strip

**Files:**
- Modify: `apps/desktop/src/api.ts` (`getTemplateMetricsDetail` takes `scope`, appends `&scope=`)
- Modify: `apps/desktop/src/metrics/MetricsPage.tsx` (scope state + bar; re-fetch on change)
- Modify: `apps/desktop/src/metrics/StepPerformance.tsx` + `GatePerformance.tsx` (marker chip + history strip from `versionHistory`)
- Modify: `apps/desktop/src/metrics/metrics-data.ts` if a helper is needed
- Test: `apps/desktop/src/metrics/MetricsPage.test.tsx`, `no-jargon.test.tsx`; update `api.metrics.test.ts` / `App.test.tsx` fixtures for `scope`

**Interfaces:** Consumes `TemplateMetricsDetail.summary.scope` + `steps[]/gates[].versionHistory` from Tasks 1–2. Visual reference: the mockup's scope bar, `.vchip` marker, and `.hist` history strip.

- [ ] **Step 1: Thread scope through the api + page**

`api.ts:991`: `getTemplateMetricsDetail(templateId, period, scope: MetricScope = "current")` → `...?period=${period}&scope=${scope}`. `MetricsPage.tsx`: add `scope` state (default `"current"`), pass to the fetch, re-fetch on change.

- [ ] **Step 2: Scope bar + marker chips + history strip (write a render test first)**

Add a `MetricsPage.test.tsx` render assertion: a mocked detail with a step whose `versionHistory.changedFrom === "step"` renders a `was a step` chip; a gate with `renamedFrom` renders `renamed from 'Release Readiness'`; the scope bar renders the three options with `Current shape` active. Then implement: a scope toggle in the header (three buttons), the `⤳` chip on rows from `versionHistory`, and the history strip (eras) in the drawer — following the mockup's markup/classes. Run `no-jargon` to confirm the copy passes.

- [ ] **Step 3: Fixtures** — add `scope: "current"` to every `TemplateMetricsSummary` mock (`api.metrics.test.ts`, `App.test.tsx`, `MetricsPage.test.tsx`); `versionHistory` is optional so existing step/gate fixtures need no change.

- [ ] **Step 4: Run desktop suite + typecheck** — `pnpm --filter @orca/desktop test && pnpm --filter @orca/desktop typecheck`. Green.

- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): metrics scope toggle + version change-markers + history strip"`

---

### Task 4: Verify — full workspace, whole-branch review, live check

- [ ] **Step 1:** `pnpm -w typecheck && pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test` — all green.
- [ ] **Step 2:** Whole-branch review (base = commit before Task 1 .. HEAD). Verify: scope semantics correct (current/latest/all), lineage keyed by id and provable-only, `versionHistory` optional, snapshot parse resilient, no scoring/gateway change, the required-field ripple (new required `scope` on summary) covered in all fixtures. Feed the ledger's Minor list.
- [ ] **Step 3:** Live check (needs daemon restart — ask user). On Adaptive Delivery: **Critique** shows `⤳ was a step`; **Verify** shows `⤳ renamed from 'Release Readiness'` (NOT "was a step"); the scope toggle flips Current/Latest/All and the row set changes (fossils appear only under All). Screenshot.
- [ ] **Step 4:** Mark Phase A complete in the ledger + update `metrics-health-console-redesign.md`. Next: Phase B1.

---

## Self-Review

**Spec coverage:** scope toggles (Task 1), id-keyed lineage + provable markers + eras (Task 2), desktop bar/chips/strip (Task 3), live confirmation of the corrected Critique-vs-Verify markers (Task 4). All spec §3 items map to a task.

**Placeholder scan:** the daemon lineage + scope code is fully specified; the two test bodies name concrete expected values (`changedFrom:"step"`, `renamedFrom:"X"`, era arrays). Desktop rendering references the committed mockup for exact markup (acceptable — it's the approved visual source). The DB-seeding test steps say to reuse the existing `usecases.gate.test.ts` seeding pattern rather than reprinting it.

**Type consistency:** `MetricScope` enum shared across route/usecases/api; `NodeVersionHistory` shape identical in contract + `computeNodeLineage` return; `versionHistory` optional on both `StepMetrics` and `GateMetrics`; lineage keyed by node id (step id / gate node id) matching the filter keys from A-i.
