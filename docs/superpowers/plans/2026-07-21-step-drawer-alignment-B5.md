# Step Drawer Alignment (B5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the metrics step drawer health-adaptive — a healthy step's drawer is one line; a struggling step's drawer shows the failure drill and an inline drafted-fix card. Drop the dense mechanical sections.

**Architecture:** Desktop-only (no daemon, no contract change). Task 1 trims the drawer JSX + its tests. Task 2 lifts the learning-proposals fetch + review-modal state from `SelfImprovementRail` up to `MetricsPage` and extracts a shared `ProposalReviewModal` (behavior-preserving). Task 3 threads a per-step proposal + a review callback to `StepRow` and renders the inline drafted-fix card.

**Tech Stack:** React + TypeScript (Vite), Vitest + @testing-library/react. Package: `apps/desktop`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-21-step-drawer-alignment-B5-design.md`. Follow §3 exactly.
- **No contract change.** `@orca/contracts` (`SampleDetail`, `TemplateMetricsDetail`, `StepMetrics`) untouched. Output excerpt is DESCOPED (§3.4) — the sample peek keeps its current depth.
- **No daemon change.** Recompute-on-read; no migration.
- **Health-adaptive is data-driven:** "struggling" ≡ `step.failureClusters.length > 0`. No new field, no flag.
- **New `StepRow` props are optional** (`proposalForStep?`, `onReviewProposal?`) — absent ⇒ no card, no crash.
- **No jargon** in user-facing copy: the strings `oracle`, `sensor`, `verdict`, `refute`, `veto` must not appear in rendered drawer text. `src/metrics/no-jargon.test.tsx` must pass.
- **Surgical:** only touch what the change requires; remove only imports/helpers THIS change orphans; match existing style.
- Run desktop tests from `apps/desktop` with `pnpm test <file>` (vitest).

---

## Task 1: Trim the step drawer to the health-adaptive shape

**Files:**
- Modify: `apps/desktop/src/metrics/StepPerformance.tsx` (the `open && (...)` drawer block, ~L203–302, plus imports L1–8)
- Test: `apps/desktop/src/metrics/StepPerformance.test.tsx`

**Interfaces:**
- Consumes: `StepMetrics` (unchanged). The drawer already has `SamplePeek` (L49), `labelForFailure`, `SectionLabel`, `VersionHistoryStrip`, `openClusterIdx` state.
- Produces: a trimmed `StepRow` drawer. No signature change in this task.

**What the drawer becomes** (replace the entire current `open && ( ... )` body, L203–302, with this — keeping the outer `{open && (` / `)}` and the `<div style={{ padding: "2px 16px 16px 60px" }}>` wrapper + inner card `<div>`):

```tsx
{open && (
  <div style={{ padding: "2px 16px 16px 60px" }}>
    <div style={{ background: "var(--panel-2)", border: "1px solid var(--hairline)", borderRadius: 10, padding: 12 }}>
      <SectionLabel style={{ paddingTop: 0 }}>What's going wrong</SectionLabel>
      {step.failureClusters.length === 0 && <div style={{ fontSize: 12, color: "var(--run)" }}>No problems detected this period.</div>}
      {step.failureClusters.map((c, i) => (
        <div key={i}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: "var(--text-2)", padding: "3px 0" }}>
            <span>{labelForFailure(c.failureCode)}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{c.count}×</span>
              {c.sampleTransitionIds.length > 0 && (
                <button type="button" onClick={() => setOpenClusterIdx((o) => (o === i ? null : i))}
                  style={{ background: "transparent", border: "none", color: "var(--accent)", fontSize: 11, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                  {openClusterIdx === i ? "hide samples" : `view ${c.sampleTransitionIds.length} samples`}
                </button>
              )}
            </span>
          </div>
          {openClusterIdx === i && c.sampleTransitionIds.length > 0 && (
            <SamplePeek transitionIds={c.sampleTransitionIds} onOpenGoal={onOpenGoal} />
          )}
        </div>
      ))}
      <VersionHistoryStrip history={step.versionHistory} />
    </div>
  </div>
)}
```

**Deleted from the old drawer:** the `OutcomeBar` + `runs · latency` line, the band-strength bars IIFE, `Checks run` artifacts list, the `How this score was reached` (`scoreBreakdown`) block, the `Chips` "What we couldn't check" / "Remaining risks", the `risk.approvals` line, the `insights` block, the `reconciliation` block, and the `recentReasons` block. `VersionHistoryStrip` stays.

**Orphaned-import cleanup (verify each is now unused in the file before removing from the L1–8 imports):**
- `OutcomeBar` (was only in the drawer) — remove from the `./metrics-charts` import.
- `Sparkle` (was only in the insights block) — remove from `./metrics-icons` import.
- `latencyLabel` (was only in the `runs · latency` line) — remove from `./metrics-data` import **iff** unused elsewhere in the file.
- The `Chips` component definition (in this file, ~L129) — remove **iff** it is used nowhere else in the file.
- Keep `SectionLabel`, `Sparkline` (collapsed-row trend), `VersionHistoryStrip`, `VersionMarkerChips`, `labelForFailure`.

- [ ] **Step 1: Update the tests to the new drawer contract (write them failing first)**

Edit `apps/desktop/src/metrics/StepPerformance.test.tsx`:

(a) In `describe("StepPerformancePanel")` → the "expands to show scope + clusters + insights" test: rename to "expands to show the What's-going-wrong drill" and replace the removed assertions. Keep the cluster assertion; drop the untested-region + insight assertions:

```tsx
it("expands to show the What's-going-wrong failure drill", () => {
  render(<StepPerformancePanel detail={detail} loading={false} openStep="Verify Proposal" onToggleStep={() => {}} />);
  expect(screen.getByText("Verify Proposal")).toBeInTheDocument();
  expect(screen.getByText("61")).toBeInTheDocument();
  expect(screen.getByText(/What's going wrong/i)).toBeInTheDocument();
  expect(screen.getAllByText(/invalid_output/).length).toBeGreaterThan(0);
  // removed sections must be gone
  expect(screen.queryByText(/Checks run/i)).toBeNull();
  expect(screen.queryByText(/how this score was reached/i)).toBeNull();
  expect(screen.queryByText(/proration edge/)).toBeNull();
  expect(screen.queryByText(/Loops between failed strategies/)).toBeNull();
});
```

(b) In `describe("StepRow expanded")`:
- Replace the "renders plain-language sections and no jargon" test body to assert the healthy one-liner + no jargon (this `reconciledStep` has `failureClusters: []`):

```tsx
it("renders a healthy expanded drawer as one line, no mechanical sections, no jargon", () => {
  render(<StepRow step={reconciledStep} index={1} isLast open onToggle={() => {}} />);
  expect(screen.getByText(/What's going wrong/i)).toBeInTheDocument();
  expect(screen.getByText(/No problems detected this period/i)).toBeInTheDocument();
  expect(screen.queryByText(/Checks run/i)).toBeNull();
  expect(screen.queryByText(/a second model reviewed/i)).toBeNull();
  expect(document.body.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
});
```

- **Delete** the "renders a plain-language 'how this score was reached' line from scoreBreakdown" test (that section is removed).
- **Delete** the "renders the reviewer's reason when a claim was overturned" test (reconciliation removed).
- Keep "renders 'needs a check' for a null score…" and "renders the epistemic band pill…" (collapsed-row behaviour, unchanged).

(c) In `describe("diagnosis card")`:
- **Delete** the "moves the OutcomeBar into the drawer, reachable once expanded" test (OutcomeBar removed from the drawer).
- Keep "does not render the OutcomeBar in the collapsed row" (still true — assert `queryByTestId("outcome-bar")` is null with `open`, update it):

```tsx
it("does not render the OutcomeBar anywhere on the step row", () => {
  render(<StepRow step={step} index={0} isLast={false} open onToggle={() => {}} />);
  expect(screen.queryByTestId("outcome-bar")).not.toBeInTheDocument();
});
```
- Keep the healthy / failing / not-checked-yet verdict tests (collapsed row).

(d) Keep the entire `describe("sample drill-through")` block unchanged — clusters + peek are retained.

- [ ] **Step 2: Run the tests to confirm they fail against the current drawer**

Run: `pnpm --filter @orca/desktop test src/metrics/StepPerformance.test.tsx`
Expected: FAIL — the new "no Checks run / one-line healthy / no OutcomeBar in drawer" assertions fail because the old drawer still renders those.

- [ ] **Step 3: Replace the drawer JSX in `StepPerformance.tsx`**

Replace L203–302 (`{open && ( ... )}`) with the trimmed drawer JSX above. Then remove orphaned imports/helpers per the cleanup list (only those now unused — grep the file for each identifier first).

- [ ] **Step 4: Run the step tests + the no-jargon test**

Run: `pnpm --filter @orca/desktop test src/metrics/StepPerformance.test.tsx src/metrics/no-jargon.test.tsx`
Expected: PASS. If `no-jargon.test.tsx` references removed sections, it should still pass (fewer strings to check); if it asserts a removed section's presence, update it to the new drawer.

- [ ] **Step 5: Typecheck + full metrics test sweep**

Run: `pnpm --filter @orca/desktop test src/metrics` and `pnpm --filter @orca/desktop exec tsc --noEmit`
Expected: PASS, no unused-import errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/metrics/StepPerformance.tsx apps/desktop/src/metrics/StepPerformance.test.tsx apps/desktop/src/metrics/no-jargon.test.tsx
git commit -m "feat(metrics): health-adaptive step drawer — drop mechanical sections, lead with What's going wrong"
```

---

## Task 2: Extract `ProposalReviewModal` + lift proposals/review state to `MetricsPage`

**Files:**
- Create: `apps/desktop/src/metrics/ProposalReviewModal.tsx`
- Modify: `apps/desktop/src/metrics/SelfImprovement.tsx` (rail becomes controlled)
- Modify: `apps/desktop/src/metrics/MetricsPage.tsx` (owns proposals + `reviewingProposalId`, renders the modal)
- Test: `apps/desktop/src/metrics/MetricsPage.test.tsx` (rail still renders a pending proposal + opening the modal)

**Interfaces:**
- Produces:
  - `ProposalReviewModal` — `export function ProposalReviewModal({ proposal, stepName, onApply, onDismiss, onClose }: { proposal: TemplateInstructionProposal; stepName: string; onApply: (edited: string) => void; onDismiss: () => void; onClose: () => void }): JSX.Element` — owns its own edited-text state (init `proposal.afterInstructions`), renders the same modal chrome currently at `SelfImprovement.tsx:197–235` (header, `DiffBlock` from a `diffLines(proposal.before, proposal.after)` computed inside, optional `ChipRow`, textarea, footer Dismiss/Apply). Move `DiffBlock`, `ChipRow`, and reuse `diffLines`/`schemaChips` from `./proposal-diff`.
  - `SelfImprovementRail` new prop shape: add `proposals: TemplateInstructionProposal[]`, `onReview: (id: string) => void`, `refetchProposals: () => Promise<void>`; REMOVE the internal `listProposals` fetch, the `proposals` state, the `reviewing` state, and the inline modal JSX. Keep `events`/`analyze`/`judge` local. Its inline `Review change` button calls `onReview(p.id)`. Its `refresh()` calls `await refetchProposals()` (for proposals) then refetches events locally. `onApply`/`onDismiss`/`onRollback` call the api then `await refetchProposals()` (+ `onMutated()` where they already do).
  - `MetricsPage` owns: `proposals`, `reviewingProposalId`, a `refetchProposals` callback, and a `proposalsByStep` map.
- Consumes: `listProposals`, `applyProposal`, `dismissProposal` from `../api`; `TemplateInstructionProposal` from `@orca/contracts`.

- [ ] **Step 1: Write a failing test for the modal-via-page path**

In `apps/desktop/src/metrics/MetricsPage.test.tsx` add a test that, given a mocked `listProposals` returning one pending proposal, the rail renders its `predictedImprovement` and clicking "Review change" opens a dialog (`role="dialog"`). (Mock `getTemplateMetricsSummaries`/`getTemplateMetricsDetail`/`listProposals`/`listLearningEvents`.) Assert `screen.getByRole("dialog")` appears after clicking "Review change".

Run: `pnpm --filter @orca/desktop test src/metrics/MetricsPage.test.tsx` → FAIL (page doesn't own the modal yet).

- [ ] **Step 2: Create `ProposalReviewModal.tsx`**

Move the modal chrome (`SelfImprovement.tsx:198–234`) into the new component. It computes `diff = diffLines(proposal.beforeInstructions, proposal.afterInstructions)` and `chips = proposal.component === "step_output_schema" ? schemaChips(...) : []` internally; owns `const [edited, setEdited] = useState(proposal.afterInstructions)`; footer Apply calls `onApply(edited)`, Dismiss calls `onDismiss()`, close calls `onClose()`. Move `DiffBlock` + `ChipRow` here (or into `./proposal-diff` if cleaner) and import where still needed.

- [ ] **Step 3: Make `SelfImprovementRail` controlled**

Remove `proposals` state + its `listProposals` effect + `reviewing` state + the inline modal JSX. Add props `proposals`, `onReview`, `refetchProposals`. `pending`/`applied` derive from the `proposals` prop. `Review change` button → `onClick={() => onReview(p.id)}`. `refresh()` → `await refetchProposals(); <refetch events locally>`. Keep `editing` only if still used by a card button; the card `Apply` now applies unedited (`applyProposal(p.id)`), matching the modal-owns-edit design (note in the diff).

- [ ] **Step 4: Lift state into `MetricsPage`**

Add:
```tsx
const [proposals, setProposals] = useState<TemplateInstructionProposal[]>([]);
const [reviewingProposalId, setReviewingProposalId] = useState<string | null>(null);
useEffect(() => {
  let live = true;
  if (!wfId) { setProposals([]); return; }
  listProposals(wfId, period).then((p) => { if (live) setProposals(p); }).catch(() => {});
  return () => { live = false; };
}, [wfId, period, reloadKey]);
const refetchProposals = async () => { if (wfId) { try { setProposals(await listProposals(wfId, period)); } catch {} } };
const proposalsByStep = new Map<string, TemplateInstructionProposal>();
for (const p of proposals) if (p.status === "pending" && !proposalsByStep.has(p.stepTemplateId)) proposalsByStep.set(p.stepTemplateId, p);
const reviewingProposal = proposals.find((p) => p.id === reviewingProposalId) ?? null;
```
Pass to `SelfImprovementRail`: `proposals`, `onReview={setReviewingProposalId}`, `refetchProposals`, plus existing props. Render once, after the grid:
```tsx
{reviewingProposal && (
  <ProposalReviewModal
    proposal={reviewingProposal}
    stepName={detail?.steps.find((s) => s.stepTemplateId === reviewingProposal.stepTemplateId)?.name ?? reviewingProposal.stepTemplateId}
    onApply={async (edited) => { await applyProposal(reviewingProposal.id, edited); setReviewingProposalId(null); await refetchProposals(); setReloadKey((k) => k + 1); }}
    onDismiss={async () => { await dismissProposal(reviewingProposal.id); setReviewingProposalId(null); await refetchProposals(); }}
    onClose={() => setReviewingProposalId(null)}
  />
)}
```
Reset `setReviewingProposalId(null)` in the existing `[wfId, period, scope, reloadKey]` effect (alongside `setOpenStep(null)`).

- [ ] **Step 5: Run the page + rail tests**

Run: `pnpm --filter @orca/desktop test src/metrics/MetricsPage.test.tsx`
Expected: PASS — rail renders the proposal from props; "Review change" opens the dialog rendered by the page.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @orca/desktop exec tsc --noEmit`
```bash
git add apps/desktop/src/metrics/ProposalReviewModal.tsx apps/desktop/src/metrics/SelfImprovement.tsx apps/desktop/src/metrics/MetricsPage.tsx apps/desktop/src/metrics/MetricsPage.test.tsx
git commit -m "refactor(metrics): lift learning proposals + review modal to MetricsPage (shared by rail + drawer)"
```

---

## Task 3: Inline drafted-fix card in the struggling-step drawer

**Files:**
- Modify: `apps/desktop/src/metrics/StepPerformance.tsx` (`StepRow` + `StepPerformancePanel` props)
- Modify: `apps/desktop/src/metrics/GatePerformance.tsx` (`FusedPipelinePanel` threads the new props to `StepRow`)
- Modify: `apps/desktop/src/metrics/MetricsPage.tsx` (pass `proposalsByStep` + `onReviewProposal` to the panels)
- Test: `apps/desktop/src/metrics/StepPerformance.test.tsx`

**Interfaces:**
- Consumes: `TemplateInstructionProposal`, `proposalsByStep` map + `setReviewingProposalId` from Task 2.
- Produces: `StepRow` gains optional props `proposalForStep?: TemplateInstructionProposal` and `onReviewProposal?: (id: string) => void`. `StepPerformancePanel` + `FusedPipelinePanel` gain optional `proposalsByStep?: Map<string, TemplateInstructionProposal>` + `onReviewProposal?`.

- [ ] **Step 1: Write the failing test**

Add to `describe("StepRow expanded")` in `StepPerformance.test.tsx`:

```tsx
it("shows an inline drafted-fix card on a struggling step with a matching proposal", () => {
  const proposal = { id: "p1", stepTemplateId: "verify", status: "pending",
    predictedImprovement: "Require evidence_refs so a reviewer can check the work.",
  } as unknown as import("@orca/contracts").TemplateInstructionProposal;
  const onReviewProposal = vi.fn();
  render(<StepRow step={step} index={0} isLast open onToggle={() => {}} proposalForStep={proposal} onReviewProposal={onReviewProposal} />);
  expect(screen.getByText(/Orca drafted a fix/i)).toBeInTheDocument();
  expect(screen.getByText(/Require evidence_refs/i)).toBeInTheDocument();
  fireEvent.click(screen.getByText(/Review change/i));
  expect(onReviewProposal).toHaveBeenCalledWith("p1");
});

it("shows no drafted-fix card on a healthy step (no clusters)", () => {
  const proposal = { id: "p1", stepTemplateId: "s", status: "pending", predictedImprovement: "x" } as unknown as import("@orca/contracts").TemplateInstructionProposal;
  render(<StepRow step={reconciledStep} index={0} isLast open onToggle={() => {}} proposalForStep={proposal} onReviewProposal={() => {}} />);
  expect(screen.queryByText(/Orca drafted a fix/i)).toBeNull();
});
```
(`step` has a `failureClusters` entry ⇒ struggling; `reconciledStep` has `failureClusters: []` ⇒ healthy.)

Run: `pnpm --filter @orca/desktop test src/metrics/StepPerformance.test.tsx` → FAIL (card not rendered; props not accepted).

- [ ] **Step 2: Add the card to `StepRow`**

Extend the `StepRow` prop type with `proposalForStep?: TemplateInstructionProposal; onReviewProposal?: (id: string) => void;` (import the type from `@orca/contracts`). After the `failureClusters.map(...)` block and before `<VersionHistoryStrip .../>`, add:

```tsx
{step.failureClusters.length > 0 && proposalForStep && (
  <div style={{ display: "flex", alignItems: "center", gap: 11, marginTop: 14, padding: "11px 12px", border: "1px solid var(--accent-2-line)", background: "var(--accent-2-soft)", borderRadius: 9 }}>
    <Sparkle size={15} color="var(--accent-2)" style={{ flexShrink: 0 }} />
    <div style={{ flex: 1, fontSize: 12, color: "var(--text-2)" }}>
      <b style={{ color: "var(--text)" }}>Orca drafted a fix:</b> {proposalForStep.predictedImprovement}
    </div>
    {onReviewProposal && (
      <button type="button" onClick={() => onReviewProposal(proposalForStep.id)}
        style={{ background: "transparent", border: "1px solid var(--accent-2-line)", color: "var(--accent-2)", borderRadius: 7, padding: "6px 11px", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit" }}>
        Review change →
      </button>
    )}
  </div>
)}
```
(Re-add the `Sparkle` import from `./metrics-icons` — Task 1 removed it; it's used again here. Verify the `--accent-2-line` / `--accent-2-soft` tokens exist; if not, use `var(--accent-line)`/`var(--accent-soft)`.)

- [ ] **Step 3: Thread the props through the panels**

- `StepPerformancePanel`: add `proposalsByStep?: Map<...>; onReviewProposal?: (id: string) => void;` to its props and pass `proposalForStep={proposalsByStep?.get(s.stepTemplateId)}` + `onReviewProposal` into each `<StepRow>`.
- `FusedPipelinePanel` (`GatePerformance.tsx`): same — accept `proposalsByStep` + `onReviewProposal`, pass into the `StepRow` render (the `node.type === "step"` branch).
- `MetricsPage`: pass `proposalsByStep={proposalsByStep}` + `onReviewProposal={setReviewingProposalId}` to both the `FusedPipelinePanel` and the fallback `StepPerformancePanel`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @orca/desktop test src/metrics/StepPerformance.test.tsx src/metrics/MetricsPage.test.tsx`
Expected: PASS (card shows on struggling+proposal; hidden on healthy; `Review change` calls back).

- [ ] **Step 5: Typecheck + full metrics sweep + commit**

Run: `pnpm --filter @orca/desktop exec tsc --noEmit && pnpm --filter @orca/desktop test src/metrics`
```bash
git add apps/desktop/src/metrics/StepPerformance.tsx apps/desktop/src/metrics/GatePerformance.tsx apps/desktop/src/metrics/MetricsPage.tsx apps/desktop/src/metrics/StepPerformance.test.tsx
git commit -m "feat(metrics): inline drafted-fix card on struggling steps, reusing the review modal"
```

---

## Self-Review notes
- Spec coverage: §3.1 (Task 1), §3.5 (Tasks 2–3), §3.2 orphan cleanup (Task 1 Step 3). §3.4 excerpt is descoped — no task. `VersionHistoryStrip` retained (Task 1 JSX).
- Type consistency: `proposalForStep?: TemplateInstructionProposal` and `onReviewProposal?: (id: string) => void` used identically across `StepRow`, `StepPerformancePanel`, `FusedPipelinePanel`, `MetricsPage`. `proposalsByStep` is `Map<string, TemplateInstructionProposal>` everywhere.
- Risk: the `no-jargon.test.tsx` may assert a now-removed section — if so, update it (Task 1 Step 4). Token names `--accent-2-line/soft` — fall back to `--accent-line/soft` if absent.
