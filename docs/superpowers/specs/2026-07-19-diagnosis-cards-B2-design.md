# Diagnosis Cards (Phase B2) — Design

**Date:** 2026-07-19
**Status:** Design — brainstormed, pending spec review
**Scope:** Phase B2 of the metrics health-console redesign (umbrella `2026-07-19-metrics-health-console-design.md` §5). Restructure each step row into a **diagnosis-led card**: an instructions-derived description, a data-driven verdict, and the three telemetry channels — built on B1's ceiling-relative band. Fused pipeline (B3) and sample drill-through (B4) are separate.

---

## 1. Context & the key finding

B1 made the band honest per step-kind. B2 makes the whole step **card** diagnosis-led, in plain language, per the paper's three telemetry channels (§3.5.1). The mockup's charming per-step verdicts ("turns the research into a plan") looked un-achievable — Orca has no per-step *description* on `StepMetrics`. **But it does have the raw material:** every step template carries `instructions`, `completionPolicy`, and `outputSchema` (`steps_json`). So the narrative is derivable from data authors already wrote — no hand-authoring, no LLM.

- `instructions` → a short **description** via its **first sentence** (deterministic, length-capped). E.g. Triage → *"Assess the goal without interviewing the user or changing any code."*
- `completionPolicy` (`reasoning` / `interview` / execution) → the step-**kind** signal for the "How we check it" framing.

### `agent-harness.pdf` alignment
- §3.5.1 (p.33): the three complementary telemetry channels (evaluators / tracing / policy gateways) → *How it's doing · Anything wrong · (verification)*.
- §5.2.2: epistemically-aware, plain "strong enough to act on / weak / needs evidence" — carried by B1's band, now explained in the card.

---

## 2. Goals & non-goals

### Goals
- Each step row shows: **name + band pill** (B1), an **instructions-derived description** (what the step does), a **data-driven verdict** (how it's doing + limiting cause), and a **three-channel scorecard** (`How it's doing` · `How we check it` · `Anything wrong`).
- All copy generated from existing signals; the description/kind come from the template.
- Retire the `OutcomeBar` from the collapsed row in favor of the scorecard (outcome split moves to a tooltip/drawer).

### Non-goals
- No fused pipeline (B3), no sample drill-through peek (B4).
- No change to scoring, calibration, or the band model (B1 owns it).
- No LLM summarization; no hand-authored descriptions (derive from `instructions`).
- No new per-step narrative beyond the instruction's first sentence.

---

## 3. Design

### 3.1 Daemon — surface description + kind (small, optional)

`StepMetrics` gains two **optional** fields (optional ⇒ no required-field ripple):
```
description: z.string().optional(),      // first sentence of the step's instructions, length-capped
completionPolicy: z.string().optional(), // "reasoning" | "interview" | "execution" | … (the raw policy)
```
Derived in `usecases.ts` where `steps_json` is already read (`stepNames`): for each current step, take `instructions`, cut at the first sentence boundary (first `. ` or end), trim to ≤140 chars at a word boundary with an ellipsis if truncated; read `completionPolicy` verbatim. Attach by step id. Pure; recompute-on-read.

### 3.2 Desktop — the diagnosis card (`StepPerformance.tsx`)

**Collapsed row** becomes:
```
[ord] Name  [band pill]  [n=]            [sparkline] [score /100 grade]
      <description — instructions first sentence, muted>
      <verdict — data-driven health line>
      ┌ How it's doing ─┬─ How we check it ─┬─ Anything wrong ─┐
      │  …              │  …                │  …               │
      └─────────────────┴───────────────────┴──────────────────┘
```

- **Description** (muted subtitle): `step.description` (fallback: omit the line if absent).
- **Verdict** (one line): `[health] — [limiting cause]`, derived:
  - health: band `needs_evidence` → "Not checked yet"; else score-driven — `score == null` → "Not scored yet"; `failureModes.length || score < 60` → "Needs attention"; `score < 70` → "Holding, with gaps"; else "Healthy".
  - limiting cause: top `failureModes[0].label` if any; else `quality.limitingDimension`; else `score < 70 ? "low score (${score})"` ; else "nothing failing this period".
- **Three channels** (each: micro-label + a status dot + one line):
  - **How it's doing** — score + trend + runs: `"${strongword} · ${score} across ${runs} runs"` (+ "falling/rising" from `trend`), or "No score yet — needs more runs" when null. Dot: good/warn/bad by score band.
  - **How we check it** — from band label + `completionPolicy` + `verifierMix`:
    - `Run & tested` → "Ran the tests and they passed."
    - `Reviewed` → "Its claims are checked; no code to run, so review is the right bar." (reasoning/interview kinds)
    - `Not tested` → "Reviewed but not run — a step like this can be tested; it wasn't."
    - `Only self-reported` → "Nothing independent checked it — add a grounding check or a reviewer."
    - `Not checked yet` → "No check has run yet."
    Dot follows the band level (good for strong, warn for weak, info for needs_evidence).
  - **Anything wrong** — `failureModes[0]` (`"${label} ${count}× · ${pct}%"`) or "Nothing this period". Dot good if none, bad if present.

**Drawer** (expanded): keep today's richer detail (clusters, "what we can't be sure of" chips, insights, reconciliation, recent reasons) — light touch; the `OutcomeBar` (passed/recovered/failed) moves here or into a "How it's doing" tooltip.

- **Jargon-free**: all new copy must pass `no-jargon.test.tsx`.

### 3.3 Backward-compat
Recompute-on-read; `description`/`completionPolicy` optional so existing fixtures/consumers are unaffected.

---

## 4. Testing & verification

- **Daemon:** `description` = first sentence of `instructions`, capped; `completionPolicy` surfaced; a step whose instructions lack a period → whole string capped; a step with no template row → fields absent. (unit in `usecases`/aggregate tests)
- **Contract:** the two optional fields parse; fixtures without them still valid.
- **Desktop:** the row renders description + verdict + three channels; the verdict health word + limiting cause derive correctly for (a) healthy grounded step, (b) failing step with a cluster, (c) null-score step; `How we check it` copy matches the band label; `no-jargon` passes. `OutcomeBar` no longer in the collapsed row.
- **Live (needs daemon restart):** on Adaptive Delivery — Triage shows its instructions-derived description + "Healthy — nothing failing" + the three channels; Research shows "Needs attention — invalid output ×3"; the cards read like something a human understands, close to the mockup.

> **Contract note:** both new fields are OPTIONAL — no required-field ripple. The daemon always emits `description`/`completionPolicy` when the template has them.

---

## 5. Open items for the implementation plan
- The exact first-sentence cut (regex on `. ` vs a sentence splitter) + the length cap value.
- Whether the description also renders on the gate rows (gates have instructions too) — default: steps only for B2; gates in B3's fused treatment.
- Where the retired `OutcomeBar` lands (drawer vs tooltip).
- Whether `completionPolicy` should be a contract enum or stay a free string (free string keeps it forward-compatible with new policies).
