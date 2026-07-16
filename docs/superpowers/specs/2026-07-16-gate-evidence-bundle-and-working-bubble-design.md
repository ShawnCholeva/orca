# Gate Evidence Bundle & "Working on…" Bubble — Design

**Date:** 2026-07-16
**Status:** Approved (pending spec review)

## Problem

Two related gaps surfaced while dogfooding the Adaptive Delivery workflow (stock-trader goal):

1. **No progress feedback before a gate.** Clicking *Continue* on a step and landing on a gate (e.g. Critique) shows nothing — no *"Working on X…"* bubble like a step gets — then the approval card appears. The transition feels dead.
2. **The gate card is a wall of text.** The Critique approval card shows only a single dense prose paragraph (the critic's `reasoning`) plus Approve/Reject. It reads as "something is missing" — no structured risks, no sense of what evidence the critic looked at.

Both trace to **one root cause**: a gate has no active step run and no evidence facet — it's parked as a bare `gate_decision_pending` activity carrying only `currentText` + an optional prose recommendation. A step, by contrast, is backed by a real `workflow_step_runs` row (the run cursor, which drives the bubble) plus a rich `EvidenceFacet` projected into its confirmation card.

## Paper grounding (`agent-harness.pdf`)

- **p.64:** "high-stakes approvals should be auditable state transitions: **what action was proposed, what evidence was shown, what risks were surfaced, who approved or rejected it**… falsifiable approval evidence."
- **p.31:** "Human or agentic critiques… should **interpret sensor outputs rather than replace them.**"

Today the gate shows only the interpretation (prose), not the structured signals behind it. This design surfaces the paper's four fields (proposed action · evidence · risks · recommender) as a structured **gate evidence bundle**, mirroring the step evidence card so gates and steps read as one system.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| How to get structured gate evidence | Extend the reviewer output contract to emit structured fields (additive) — applies to **all** gates, not just Critique |
| Human/no-reviewer gates | **Always run a reviewer** — no gate parks a human blind |
| Reviewer substrate | **Per-gate, no blind parks** — keep each gate's declared substrate (`worker` for Critique/Verify, `shadow` for Verdict); eliminate only the "blind human park with no recommendation" path |
| `residualRisks` shape | Richer objects: `{ risk: string; severity: "low" \| "medium" \| "high" }` |
| "Evidence reviewed" list | Default **collapsed** |

### What "instant human checkpoint" meant
A gate that parks for a human decision immediately, with no automated reviewer running first (`parkForGateApproval` called **without** a recommendation). This design removes that path: every human gate decision is now preceded by a reviewer verdict.

---

## Part A — "Working on <gate>…" bubble

### Root cause
The bubble at `apps/desktop/src/orchestrator/OrcaChat.tsx:1192` keys off `workflowState.stepRun`, which is always `null` at a gate (`current_step_run_id` is nulled when parking at a gate — `advanceToNextStepOrGate`, `apps/daemon/src/workflows/steps/usecases.ts:375`). A worker gate already has a `__gate__:<nodeId>` surrogate step-run in `active` status while the critic runs (`spawnGateWorker`, `dispatch-engine.ts:2342`), but it is deliberately not the run cursor and its `__gate__:` id isn't in the template step list, so neither `showStepWorking` nor `activeStepName` can resolve it.

### Fix (frontend-only, no new daemon state)
The run already exposes `currentNodeKind === "gate"` and `pendingGateReview`. Render the bubble when **parked at a gate with no review surfaced yet**:

- `run.currentNodeKind === "gate"` **&&** `run.pendingGateReview == null` → show `Working on <gateName>…`.
- Gate name is reconstructed the same way the tracker already does at `OrcaChat.tsx:633` (`run.currentNodeId` → template gate node name).
- Once `pendingGateReview` is populated → hide the bubble; the evidence card renders.

Works for every substrate (worker or shadow) because, in the "no blind parks" world, every gate transits *reviewing → verdict surfaced*.

### Single-bubble invariant (hard requirement)
At most one tail "thinking" indicator at any time. The gate-working bubble must be mutually exclusive with:

1. **Step-working bubble** (`showStepWorking`, `OrcaChat.tsx:1192`) — disjoint because a gate has no active `stepRun`; gate it explicitly so a stale `stepRun` cannot overlap.
2. **`LiveActivity` tail bubble** (`ActivityThread.tsx:419`) — the gate approval card renders there once `pendingGateReview` is set; the working bubble shows only while `pendingGateReview == null`, so the handoff is exclusive by construction. Additionally confirm the `__gate__:` surrogate step-run does **not** emit its own `step_started`/active `LiveActivity` thinking row during the reviewing phase; if it does, suppress that row for `__gate__:` surrogates.
3. **Composer "Thinking…" placeholder** — verify it isn't simultaneously showing a redundant thinking state during the gate-reviewing window.

Net: exactly one indicator across the whole *reviewing → verdict → decision* transition. Exact state guards verified during implementation.

---

## Part B — Gate evidence bundle

Replace the single prose paragraph with a structured, scannable card satisfying the paper's four fields.

### B1 — Reviewer output contract (additive)
Extend `GateEvaluationProposal` (`packages/contracts/src/workflows/index.ts:890`):

```ts
GateEvaluationProposal = z.object({
  reasoning: z.string().min(1).max(REASONING_MAX),      // existing — free-form summary, kept
  outcome: z.enum(["approved", "rejected"]),            // existing
  reason: z.string().min(1).max(1024),                  // existing — one-line rationale
  residualRisks: z.array(z.object({                     // NEW
    risk: z.string().min(1).max(512),
    severity: z.enum(["low", "medium", "high"]),
  })).max(50).default([]),
  issueRefs: z.array(...).max(50).optional(),           // existing — pointer refs
  inputsConsidered: z.array(...).max(50),               // existing — becomes "evidence reviewed"
}).strict();
```

The gate-worker prompt (`apps/daemon/src/workflows/orchestrator/gate-worker.ts:3`) and the shadow eval prompt are updated to require `residualRisks` as a structured list (each with severity) rather than embedding risks in `reasoning` prose. Backward-compat: `residualRisks` defaults to `[]` so existing/parsed verdicts without it stay valid.

### B2 — Project to the run
`PendingGateReview` (`packages/contracts/src/workflows/index.ts:434`) currently drops fields. Extend it to carry everything the card needs:

```ts
PendingGateReview = z.object({
  gateNodeId: Id100,
  recommendedOutcome: z.enum(["approved", "rejected"]),
  reasoning: z.string().max(8000).nullable(),
  reason: z.string().max(1024).nullable(),              // NEW — one-line rationale
  residualRisks: z.array({ risk, severity }).max(50),   // NEW
  inputsConsidered: z.array(z.string().max(512)).max(50).default([]), // NEW — evidence reviewed
  issueRefs: z.array(z.string().max(500)).max(50),
}).strict();
```

Populated in `completeGateWorker` (`dispatch-engine.ts:2521`, supervised branch) and the shadow path from the parsed proposal. The DB stash (`pending_gate_route_json`, `parkForGateApproval` `dispatch-engine.ts:1684`) carries the same fields.

### B3 — Card UI
Rework the gate branch of `LiveActivity` (`apps/desktop/src/orchestrator/ActivityThread.tsx:493`) to render top-to-bottom:

1. **What's being approved** — the transition (e.g. *"Approve → advances past Critique"*), derived from the gate/next node.
2. **Recommendation** — existing *"Critic recommends approve"* line (kept).
3. **Summary** — `reasoning` prose, demoted/tightened (no longer the whole card).
4. **Residual risks** — `residualRisks[]` as a scannable list, each with a severity indicator (low/medium/high).
5. **Evidence reviewed** — `inputsConsidered[]`, in a **collapsed-by-default** disclosure mirroring the step card's "Scores" disclosure (`ConfirmationCard`, `ActivityThread.tsx:209`).
6. **Approve / Reject** — unchanged.

Factor the checks/disclosure rendering the step `ConfirmationCard` uses so the gate card borrows the same visual grammar rather than a parallel implementation.

### B4 — No blind parks
Guarantee every gate surfaces a `PendingGateReview` before a human is asked. The only remaining bare `parkForGateApproval` (no recommendation) is the **safety-degrade terminus** when a reviewer genuinely cannot run (adapter unavailable / delivery failure — `spawnGateWorker` `dispatch-engine.ts:2412`). That path stays, but is clearly labeled "reviewer unavailable" in the card, since fabricating a verdict would be worse than admitting none.

**Scope note:** The Bug-Triage "Verdict" gate is `shadow` substrate. "No blind parks" means the shadow eval's structured verdict is surfaced on the card just like a worker verdict — no substrate conversion required (per "per-gate" decision).

---

## Change map

**Contracts** (`packages/contracts/src/workflows/index.ts`)
- Extend `GateEvaluationProposal` with `residualRisks`.
- Extend `PendingGateReview` with `reason`, `residualRisks`, `inputsConsidered`.

**Daemon**
- `apps/daemon/src/workflows/orchestrator/gate-worker.ts` — prompt requires structured `residualRisks`; parse validates the extended proposal.
- Shadow eval prompt (`evaluateGate`) — same structured-risk requirement.
- `dispatch-engine.ts` — `completeGateWorker` (~2521) and `parkForGateApproval` (~1666, 1684) carry the new fields into `pending_gate_route_json` / `PendingGateReview`.

**Desktop**
- `apps/desktop/src/orchestrator/OrcaChat.tsx` — gate-working bubble (Part A) + single-bubble guards.
- `apps/desktop/src/orchestrator/ActivityThread.tsx` — restructured gate card (B3); factor shared disclosure with `ConfirmationCard`.
- `apps/desktop/src/orchestrator/orca-chat.css` — severity indicators + gate card layout.

## Testing / verification

- **Part A:** drive Adaptive Delivery in the browser (Playwright, per CLAUDE.md browser mode); after Continue on Proposal, confirm exactly one *"Working on Critique…"* bubble appears during review and is replaced (not joined) by the evidence card. Assert no double bubble in the *reviewing → verdict* window.
- **Part B:** confirm the card renders proposed transition, recommendation, tightened summary, a residual-risk list with severities, and a collapsed "Evidence reviewed" disclosure. Verify the shadow Verdict gate (Bug-Triage) surfaces the same structure.
- **Contract:** unit-validate `GateEvaluationProposal` / `PendingGateReview` round-trip with and without `residualRisks` (default `[]`).
- **Degrade path:** simulate reviewer-unavailable → card shows "reviewer unavailable," no fabricated verdict.

## Out of scope
- Converting any gate's substrate (worker↔shadow).
- Re-running executable sensors for gates (a critic reasons over prior evidence; it does not execute code).
- Persisted (post-decision) gate record styling beyond carrying the new fields.

## Alignment
Maps directly onto the FUTURE_ARCHITECTURE accountability spine: the gate becomes an auditable state transition with falsifiable approval evidence (proposed action · evidence reviewed · risks surfaced · recommender), rather than a prose blob.
