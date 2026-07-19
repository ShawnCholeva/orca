# Sample Drill-Through (Phase B4) — Design

**Date:** 2026-07-19
**Status:** Design — brainstormed, pending spec review
**Scope:** Phase B4 (final slice of the metrics health-console redesign, umbrella §7). Turn a step's failure count into the concrete failing samples — render from `failureClusters` (so the sample IDs survive), a lazy sample peek showing the failed check + its human-readable reason, and an "open full run" link to the Orchestrator.

---

## 1. Context & the data

Today a step's "Anything wrong" is a dead end: the drawer renders `failureModes` (`{label,count,pct}`, no IDs), while `failureClusters` — which carries `failureCode` + `sampleTransitionIds` (≤3) — is computed but unused, and no per-sample detail view exists. The drill from **count → concrete failures → why** is the paper's *"signals linked to concrete artifacts"* (§3.5.1) and the missing piece of "understand it well enough to fix it."

**The data is rich and resolvable** (confirmed against the live DB):
- A failed `step_complete` transition's `evidence_json.grounding.checks` = `[{rule, field, mode, result:"failed", detail:"chosen_approach value 'Minimal…' is not a member of…"}]` — the failed check **with a human-readable `detail` that quotes the offending value**. Sensor failures live in `evidence_json.sensorsRun`.
- `telemetry_json.outcome` = `{status, failure_code}`; `harness_transitions` carries `goal_id` + `workflow_run_id`; the version comes from the run.
- The Orchestrator run view (`ActivityThread`) is goal-scoped; `App.tsx` navigates via `setSelectedOrchestratorGoalId(goalId) + setActiveTab("orchestrator")`.

---

## 2. Goals & non-goals

### Goals
- Render the step drawer's failure section from **`failureClusters`** (IDs survive) with a per-cluster "view N samples" affordance.
- A **lazy sample peek**: on expand, fetch each `sampleTransitionId`'s detail and show the **failed check(s) + `detail`** (the concrete why), the failure code, run time/version, and an **"open full run →"** link.
- "open full run" navigates to the sample's **goal** in the Orchestrator.

### Non-goals
- No output excerpt (v1 relies on the check `detail`, which already quotes the offending value — resolving transition→step_result is a later enhancement).
- No new Orchestrator run-detail view (link to the existing goal-scoped one).
- No change to scoring/model/pipeline.

---

## 3. Design

### 3.1 Daemon — a lazy sample-detail route (contract + route)

New contract type:
```ts
export const SampleDetail = z.object({
  transitionId: z.string(),
  goalId: z.string(),
  workflowRunId: z.string().nullable(),
  createdAt: z.string(),
  templateVersion: z.number().int().nullable(),
  failureCode: z.string().nullable(),
  status: z.string(),
  checks: z.array(z.object({ label: z.string(), detail: z.string().nullable(), result: z.string() }).strict()),
}).strict();
export type SampleDetail = z.infer<typeof SampleDetail>;
```
New route `GET /v1/metrics/samples/:transitionId` (`routes.ts`): `SELECT goal_id, workflow_run_id, created_at, evidence_json, telemetry_json FROM harness_transitions WHERE id = ?` (+ the run's `template_version`). Build `checks` from the FAILED entries: grounding `checks` where `result !== "passed"` → `{ label: "${rule} on ${field}" (or the rule), detail, result }`, plus failed `sensorsRun` → `{ label: kind, detail, result }`. 404 when the transition isn't found. Pure read; no migration.

### 3.2 Desktop — cluster render + sample peek

- **Drawer failure section** (`StepPerformance.tsx` drawer): render from `step.failureClusters` (not `failureModes`) — each cluster shows `labelForFailure(failureCode)` + count + a **"view {n} samples"** toggle (n = `sampleTransitionIds.length`). (Keep the collapsed-row "Anything wrong" channel as-is from B2 — it stays a summary; the drawer is where drill happens.)
- **Sample peek** (new component): on expand, lazily `getSampleDetail(id)` for each `sampleTransitionId`; render per sample: `run {short id} · {relative time} · v{version}` + the **failed checks** (`{label}` → `{detail}`) + the failure code + an **"open full run →"** button.
- **`getSampleDetail(transitionId)`** in `api.ts`.
- **"open full run"** → `onOpenGoal(goalId)` — a new optional prop threaded `App → MetricsPage → StepRow → peek`; `App` supplies `(goalId) => { setSelectedOrchestratorGoalId(goalId); setActiveTab("orchestrator"); }`.
- Loading/empty/error states for the lazy fetch (spinner; "couldn't load this sample").
- Jargon-free (`no-jargon` passes).

### 3.3 Backward-compat
Recompute-on-read; `failureClusters` already exists in the contract (no ripple). `SampleDetail`/route are additive. `onOpenGoal` optional (absent → the link is hidden/disabled). No migration.

---

## 4. Testing & verification

- **Daemon (route):** a seeded failed transition (grounding check `result:"failed"` with a `detail`) → `getSampleDetail` returns `goalId`, `workflowRunId`, `failureCode`, and `checks` = the failed check(s) with `detail`; a passed check is excluded; an unknown id → 404; a transition with no evidence → `checks: []` (no throw).
- **Contract:** `SampleDetail` parses.
- **Desktop:** the drawer renders clusters from `failureClusters` with "view N samples"; expanding fetches + renders each sample's failed check + detail + "open full run"; "open full run" calls `onOpenGoal(goalId)`; loading/error states render; `no-jargon` passes.
- **Live (needs daemon restart):** on a workflow with a real failure cluster, expand a step's drawer → "view N samples" → the concrete failed check + its reason for each sample; "open full run" switches to the Orchestrator on that goal. Screenshot. (Adaptive Delivery's current window may have no failure cluster — use a workflow/period that does, or note the empty state.)

> **Contract note:** `failureClusters` already exists (no ripple). `SampleDetail` + the route + `onOpenGoal` are additive; `onOpenGoal` optional.

---

## 5. Open items for the implementation plan
- The exact `checks` label format (`"${rule} on ${field}"` vs the rule alone) and how sensor failures fold in.
- Whether the peek fetches samples in parallel (≤3) and its loading UX.
- `onOpenGoal` threading depth (App → MetricsPage → StepRow → drawer) — pass a single callback, don't prop-drill state.
- Relative-time formatting reuse (existing desktop helper if any).
