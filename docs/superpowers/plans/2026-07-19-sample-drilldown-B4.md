# Sample Drill-Through B4 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a step's failure count into the concrete failing samples — render from `failureClusters` (IDs survive), a lazy sample peek showing each failed check + its reason, and an "open full run" link to the Orchestrator.

**Architecture:** A daemon route resolves a `sampleTransitionId` to a `SampleDetail` (failed checks + why + goal/run). The desktop drawer renders `failureClusters` with a "view N samples" toggle that lazily fetches and shows the peek; "open full run" calls an `onOpenGoal` callback threaded from `App`. Read-only; recompute-on-read.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo (`packages/contracts`, `apps/daemon`, `apps/desktop`).

**Design spec:** `docs/superpowers/specs/2026-07-19-sample-drilldown-B4-design.md`. **Mockup reference:** `scratchpad/metrics-redesign.html` (the sample peek).

## Global Constraints

- `failureClusters` already exists on `StepMetrics` (no ripple). `SampleDetail` + the route + `onOpenGoal` are additive; `onOpenGoal` optional.
- Peek depth = **failed check + `detail` (why) + open-full-run** — NO output excerpt (no transition→step_result resolution).
- `checks` = the FAILED evidence entries only (grounding checks with `result !== "passed"/"skipped"`, plus failed `sensorsRun`).
- "open full run" navigates to the sample's **goal** in the Orchestrator (goal-scoped run view).
- Resilient: unknown transition → 404 (daemon) / handled error (desktop); a transition with no evidence → `checks: []`, no throw.
- Jargon-free (`no-jargon` passes). No scoring/model/pipeline change.

---

### Task 1: Daemon — `SampleDetail` + sample route (contract + daemon)

**Files:**
- Modify: `packages/contracts/src/metrics/index.ts` (`SampleDetail` type)
- Create: `apps/daemon/src/metrics/sample-detail.ts` (`getSampleDetail`)
- Modify: `apps/daemon/src/metrics/routes.ts` (`GET /v1/metrics/samples/:transitionId`)
- Test: `apps/daemon/src/metrics/sample-detail.test.ts`

**Interfaces:**
- Produces: `SampleDetail`; `getSampleDetail(db, transitionId): SampleDetail | null`; route returning `{ sample }` or 404.

- [ ] **Step 1: Contract**

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

- [ ] **Step 2: Write the failing daemon test**

`sample-detail.test.ts` — seed a `harness_transitions` row (an in-memory db like the other metrics tests) with `evidence_json` = `{ grounding: { verdict:"failed", checks:[{rule:"member_of",field:"chosen_approach",mode:"enforce",result:"failed",detail:"value X not allowed"},{rule:"paths_exist",field:"known_files",mode:"enforce",result:"passed"}] } }`, `telemetry_json` = `{ outcome:{status:"failed",failure_code:"evidence_veto"} }`, `goal_id="g1"`, `workflow_run_id="r1"`, plus a `workflow_runs` row (`id="r1", template_version=11`). Assert:
```ts
const s = getSampleDetail(db, "t1")!;
expect(s.goalId).toBe("g1"); expect(s.workflowRunId).toBe("r1");
expect(s.failureCode).toBe("evidence_veto"); expect(s.status).toBe("failed");
expect(s.templateVersion).toBe(11);
expect(s.checks).toEqual([{ label: "member_of on chosen_approach", detail: "value X not allowed", result: "failed" }]); // passed check excluded
expect(getSampleDetail(db, "nope")).toBeNull();
```
Plus: a transition with `evidence_json` null → `checks: []`, no throw.

- [ ] **Step 3: Run to verify it fails** — `pnpm --filter @orca/daemon test -- sample-detail`.

- [ ] **Step 4: Implement `getSampleDetail`**

```ts
import type Database from "better-sqlite3";
import type { SampleDetail } from "@orca/contracts";

export function getSampleDetail(db: Database.Database, transitionId: string): SampleDetail | null {
  const row = db.prepare(
    `SELECT ht.id, ht.goal_id, ht.workflow_run_id, ht.created_at, ht.evidence_json, ht.telemetry_json, wr.template_version
     FROM harness_transitions ht LEFT JOIN workflow_runs wr ON wr.id = ht.workflow_run_id
     WHERE ht.id = ?`
  ).get(transitionId) as { id: string; goal_id: string; workflow_run_id: string | null; created_at: string; evidence_json: string | null; telemetry_json: string | null; template_version: number | null } | undefined;
  if (!row) return null;
  const parse = (s: string | null): any => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
  const ev = parse(row.evidence_json); const tel = parse(row.telemetry_json);
  const checks: { label: string; detail: string | null; result: string }[] = [];
  for (const c of ev?.grounding?.checks ?? []) {
    if (c?.result && c.result !== "passed" && c.result !== "skipped")
      checks.push({ label: c.field ? `${c.rule} on ${c.field}` : String(c.rule ?? "check"), detail: c.detail ?? null, result: c.result });
  }
  for (const s of ev?.sensorsRun ?? []) {
    if (s?.result && s.result !== "passed")
      checks.push({ label: String(s.kind ?? "sensor"), detail: s.detail ?? null, result: s.result });
  }
  return {
    transitionId: row.id, goalId: row.goal_id, workflowRunId: row.workflow_run_id ?? null,
    createdAt: row.created_at, templateVersion: row.template_version ?? null,
    failureCode: tel?.outcome?.failure_code ?? null, status: tel?.outcome?.status ?? "unknown", checks,
  };
}
```

- [ ] **Step 5: Add the route** (`routes.ts`)

```ts
  server.get("/v1/metrics/samples/:transitionId", async (request, reply) => {
    const { transitionId } = request.params as { transitionId: string };
    const sample = getSampleDetail(db, transitionId);
    if (!sample) { reply.status(404); return { error: { code: "not_found", message: "sample not found" } }; }
    return { sample };
  });
```
(import `getSampleDetail` from `./sample-detail.js`.)

- [ ] **Step 6: Run tests + full daemon/contracts green** — `pnpm --filter @orca/daemon test -- sample-detail`, then `pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/contracts typecheck`.

- [ ] **Step 7: Commit** — `git commit -m "feat(metrics): sample-detail route — resolve a failing sample to its failed checks + run"`

---

### Task 2: Desktop — cluster render + lazy sample peek + open-full-run

**Files:**
- Modify: `apps/desktop/src/api.ts` (`getSampleDetail`)
- Modify: `apps/desktop/src/metrics/StepPerformance.tsx` (drawer: render `failureClusters` + "view N samples" + `SamplePeek`)
- Modify: `apps/desktop/src/metrics/MetricsPage.tsx` (accept + thread `onOpenGoal`)
- Modify: `apps/desktop/src/App.tsx` (pass `onOpenGoal` to `MetricsPage`)
- Modify: the panel components if they must thread `onOpenGoal` (`StepPerformancePanel`, `FusedPipelinePanel`) to `StepRow`
- Test: `apps/desktop/src/metrics/StepPerformance.test.tsx` (+ `no-jargon.test.tsx`)

**Interfaces:**
- Consumes: `SampleDetail` + the route (Task 1); `step.failureClusters`; `labelForFailure` from `@orca/contracts`.
- Produces: `getSampleDetail(transitionId): Promise<SampleDetail>`; `onOpenGoal?: (goalId: string) => void` threaded `App → MetricsPage → panel → StepRow → drawer → SamplePeek`.

- [ ] **Step 1: `api.ts`** — `export async function getSampleDetail(transitionId: string): Promise<SampleDetail>` → `GET ${baseUrl}/v1/metrics/samples/${encodeURIComponent(transitionId)}` (mirror the existing metrics fetchers), returns `res.sample`.

- [ ] **Step 2: Write the failing render test**

In `StepPerformance.test.tsx`, mock `api.getSampleDetail` and render a `StepRow` (open) whose `failureClusters` = `[{failureCode:"evidence_veto", boundary:"step_complete", count:3, sampleTransitionIds:["t1","t2"]}]`. Assert: the drawer shows the cluster label + count + a "view 2 samples" control; clicking it fetches and renders the sample's failed check label + detail (from the mocked `SampleDetail`) and an "open full run" control; clicking "open full run" calls the passed `onOpenGoal` with the sample's `goalId`. (Reuse the file's step fixture builder; pass `onOpenGoal` via the StepRow props.)

- [ ] **Step 3: Implement the drawer + `SamplePeek`**

- Drawer (`StepPerformance.tsx:139-148` area): replace the `step.failureModes.map` render with `step.failureClusters.map` — each cluster: `labelForFailure(c.failureCode)` + `{c.count}×` + a toggle "view {c.sampleTransitionIds.length} samples" (hidden if no ids). Keep the "No problems detected this period." empty state.
- `SamplePeek({ transitionIds, onOpenGoal })`: on mount/expand, `getSampleDetail` each id (parallel, ≤3), tracking loading/error per id; render each: `run {id.slice(0,6)} · {relativeTime(createdAt)} · v{templateVersion}` + the `checks` (`{label}` → `{detail}`) + `failureCode` + a button "open full run →" (`onClick={() => sample.goalId && onOpenGoal?.(sample.goalId)}`, hidden if no `onOpenGoal`). Loading spinner; "couldn't load this sample" on error.
- Thread `onOpenGoal` into `StepRow` props and down to the drawer.

- [ ] **Step 4: Thread `onOpenGoal` through the panels + App**

- `StepRow` gains `onOpenGoal?: (goalId: string) => void`; `StepPerformancePanel` + `FusedPipelinePanel` pass it through; `MetricsPage` gains `onOpenGoal?` prop and passes it to the panel(s).
- `App.tsx`: render `<MetricsPage onOpenGoal={(goalId) => { setSelectedOrchestratorGoalId(goalId); setActiveTab("orchestrator"); }} />` (reuse the existing pattern at App.tsx:192-193).

- [ ] **Step 5: Run desktop tests + typecheck + no-jargon** — `pnpm --filter @orca/desktop test && pnpm --filter @orca/desktop typecheck`. Green.

- [ ] **Step 6: Commit** — `git commit -m "feat(desktop): sample drill-through peek + open full run"`

---

### Task 3: Verify — full workspace, whole-branch review, live check

- [ ] **Step 1:** `pnpm -w typecheck && pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test` — all green.
- [ ] **Step 2:** Whole-branch review (base = commit before Task 1 .. HEAD). Verify: `getSampleDetail` returns failed checks only (passed/skipped excluded), resilient parse, 404 for unknown; route shape; desktop renders `failureClusters` (IDs survive) + lazy peek + open-full-run calling `onOpenGoal(goalId)`; `onOpenGoal` optional/threaded; no scoring/model change; `no-jargon` passes. Feed the ledger's Minor list.
- [ ] **Step 3:** Live check (needs daemon restart — ask user). On a workflow/period WITH a real failure cluster: expand a step's drawer → "view N samples" → the concrete failed check + its reason per sample; "open full run" switches to the Orchestrator on that goal. (If Adaptive Delivery's current window has no cluster, use another workflow/period or note the empty state.) Screenshot.
- [ ] **Step 4:** Mark B4 complete + Phase B / the whole redesign complete in the ledger; update `metrics-health-console-redesign.md`.

---

## Self-Review

**Spec coverage:** `SampleDetail` + route + resolver (Task 1) with failed-checks-only + goal/run; desktop `failureClusters` render + lazy peek + open-full-run + `onOpenGoal` threading + App wiring (Task 2); live drill confirmation (Task 3). All spec §3 items map to a task.

**Placeholder scan:** `getSampleDetail` + the route + the drawer/peek rules are complete; the daemon test names concrete expected values (checks array, goalId, failureCode, null for unknown). The desktop test mocks `api.getSampleDetail` and asserts the drill + the `onOpenGoal` callback.

**Type consistency:** `SampleDetail` shape identical in contract + resolver + api; `checks[].{label,detail,result}` consistent; `onOpenGoal?: (goalId: string) => void` optional through the whole prop chain; `failureClusters` already on `StepMetrics`.
