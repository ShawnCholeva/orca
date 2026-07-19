# Version-Aware Metrics A-ii — Lineage, Change-Markers & Scope Toggles (Design)

**Date:** 2026-07-19
**Status:** Design — brainstormed, pending spec review
**Scope:** Completes Phase A (the umbrella `2026-07-19-metrics-health-console-design.md`). A-i shipped the current-shape node filter; A-ii adds **cross-version node lineage** (change-markers + a per-node history strip) and the **scope toggles** (`Current shape` / `Latest only` / `All versions`). Nothing deferred.

---

## 1. Context & the key finding

A-i scoped both panels to the current template shape (fixing the double-appearance). A-ii surfaces *why* a node's history looks the way it does, and lets the user widen the window when the current shape is underpowered.

**The identity question is fully resolved by the data — no heuristic needed.** Every version's full template graph is persisted in `workflow_runs.template_snapshot_json` (populated for all versions), and **Orca renames a node in place: the node `id` is stable across a rename.** So a node's entire lineage — type changes, renames, presence — is **provable by id** from the snapshots. There is no unresolvable cross-version-identity problem.

**Corrected lineage for `orca/adaptive-delivery`** (from the snapshots; this corrects an error in the interactive mockup, which mislabeled Verify):

| Node id | v8–v11 | v12 | v13 (current) | A-ii marker |
|---|---|---|---|---|
| `critique` | **step** "Critique" | **gate** "Critique" | gate "Critique" | **was a step** (type change @ v12) |
| `review` | gate "Release Readiness" | gate "Release Readiness" | gate **"Verify"** | **renamed from "Release Readiness"** (@ v13) |
| `verify` | step "Verify" | step "Verify" | *(removed)* | — (retired node; A-i drops it) |

So **Critique** is the genuine type-change; **Verify** (`review`) was *always* a gate and was *renamed*; the old `verify` **step** was a *separate* node that was deleted. The markers must reflect this (Critique = "was a step"; Verify = "renamed from 'Release Readiness'" — **not** "was a step").

### `agent-harness.pdf` alignment
- §3.5.1 (p.33): signals "replayed and compared **across harness versions**" — version-boundary awareness is a first-class telemetry concern.
- The scope toggles mirror the industry pattern (Datadog compare-to-previous-deploy, Honeycomb break-down-by-version) already researched for the umbrella spec; significance-gating (`n=`) already lives in Orca.

---

## 2. Goals & non-goals

### Goals
- **Scope toggles:** `current` (default) / `latest` / `all`, threaded from the desktop through the metrics route to aggregation.
- **Id-keyed lineage** computed from `template_snapshot_json`: per current node, its type-history and name-history across the window's versions.
- **Change-markers** (provable only): **type change** ("was a {priorType}") and **rename** ("renamed from '{priorName}'").
- **History strip:** per-node eras (type + version range + run count), never averaging across a type-change boundary.

### Non-goals
- No heuristic rename-matching across *different* ids (Orca renames in place, so this never arises; a genuinely new id is a new node, correctly).
- No change to scoring, bands, calibration, or the completion/policy gateways.
- No inference of "conceptual" lineage beyond what the snapshots prove.

---

## 3. Design

### 3.1 Scope toggles (daemon)

Add a `scope: "current" | "latest" | "all"` argument to `getTemplateMetricsDetail` (default `"current"`), surfaced as a query param on the metrics route and echoed in the response so the desktop can render the active toggle.

- **`current`** (default): A-i behavior — filter step/gate lists to the current node set (`stepNames` / `gateNodeNames`).
- **`latest`**: `current` **plus** restrict contributing runs to `templateVersion === latestVersion` (strict single-version; the underpowered-but-pure mode — `n=` gating already communicates thin data).
- **`all`**: **disable** the current-node filter — show every id in the window, including fossils and prior-era nodes (today's pre-A-i behavior, for archaeology).

Implementation: the A-i filters (`inCurrentShape` in `aggregate.ts`, the `currentGates` guard in `gate-metrics.ts`) become conditional on `scope !== "all"`; a `latest` filter drops runs whose `templateVersion !== latestVersion` before aggregation (in `fetch` or at the top of the compute functions).

### 3.2 Node lineage from snapshots (daemon)

New helper (e.g. `node-lineage.ts`): `computeNodeLineage(db, templateId, versionsInWindow): Map<nodeId, NodeLineage>`.
- Read `SELECT DISTINCT template_version, template_snapshot_json FROM workflow_runs WHERE template_id = ? AND started_at ∈ window` (one snapshot per version; ~≤10 rows, on-read, not a hot path).
- Parse each snapshot's `graph.nodes`; for each node id, record `{ version, type, name }`.
- Derive per current node id:
  - `changedFrom?: "step" | "gate"` — set when the node's `type` in an earlier in-window version differs from its current type.
  - `renamedFrom?: string` — set when an earlier in-window `name` differs from the current name (most recent prior distinct name).
  - `eras: { type: "step" | "gate"; fromVersion: number; toVersion: number; runs: number }[]` — contiguous same-type spans with run counts (runs joined from the window).

### 3.3 Contract (additive, optional)

Add an **optional** `versionHistory` to `StepMetrics` and `GateMetrics`:
```
versionHistory: z.object({
  changedFrom: z.enum(["step","gate"]).optional(),
  renamedFrom: z.string().optional(),
  eras: z.array(z.object({ type: z.enum(["step","gate"]), fromVersion: z.number().int(), toVersion: z.number().int(), runs: z.number().int().nonnegative() })),
}).optional()
```
**Optional** → no required-field ripple; present only when there's lineage to show. Also add the active `scope` to the detail response summary (echo), and the `scope` param on the route/api.

### 3.4 Desktop

- **Scope bar** (from the mockup): `Current shape` (default) / `Latest only` / `All versions` toggle, wired to re-fetch with the `scope` param; show "window spans v8–v13".
- **Change-marker chip** on step/gate rows: `⤳ was a step` (from `changedFrom`) or `⤳ renamed from 'Release Readiness'` (from `renamedFrom`), with a tooltip.
- **History strip** in the drawer: render `eras` (hatched step-era vs tinted gate-era) split by a labelled boundary; the honest note that a step-era's score and a gate-era's health aren't averaged.

### 3.5 Backward-compat
Recompute-on-read; no migration. `versionHistory` optional; scope defaults to `current` so existing callers are unchanged.

---

## 4. Testing & verification

- **Daemon unit (`node-lineage`):** from synthetic snapshots — a node that is a step then a gate → `changedFrom: "step"` + two eras; a gate whose name changed → `renamedFrom`; a stable node → no `versionHistory`. Boundary run-counts correct.
- **Daemon unit (scope):** `current` filters to the node set; `latest` additionally drops non-latest-version runs; `all` shows fossils. Verify a fossil id appears only under `all`.
- **Contract:** `versionHistory` parses; optional (fixtures without it still valid).
- **Desktop:** scope toggle re-fetches; marker chip renders `was a step` for a `changedFrom` node and `renamed from X` for a `renamedFrom` node; history strip renders eras; `no-jargon` passes.
- **Live (needs daemon restart):** on Adaptive Delivery — Critique shows **"was a step"**, Verify shows **"renamed from 'Release Readiness'"** (NOT "was a step"); the scope toggle flips Current/Latest/All and the row set changes (fossils appear under All).

> **Contract note:** `versionHistory` is OPTIONAL to avoid the required-field ripple. The scope param does add a route/api arg — thread it with a default so no call site breaks.

---

## 5. Open items for the implementation plan
- Exact place to apply the `latest` run-filter (in `fetch` vs top of compute) and how `scope` reaches `gate-metrics`/`aggregate`.
- Snapshot parse resilience (a malformed/absent snapshot for a version → skip that version's lineage, don't throw).
- Whether `eras[].runs` counts step-runs or scored completions (pick scored completions, matching the headline).
- Desktop: does changing scope reset the open step/gate, and the exact toggle placement in the scope bar.
