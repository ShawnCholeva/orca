# Metrics Health Console — Redesign (Design)

**Date:** 2026-07-19
**Status:** Design — brainstormed via interactive mockup, pending spec review
**Mockup:** `https://claude.ai/code/artifact/1111abeb-8d5c-4cb1-9775-de1c036d49f7` (local source: `scratchpad/metrics-redesign.html`)
**Scope:** The full Metrics-tab redesign, sliced into independently-shippable phases (A → B1 → B2 → B3 → B4). Each phase gets its own implementation plan when built; **Phase A is a correctness prerequisite and lands first.**

---

## 1. Vision & the user's job

> *"As a user building workflows I come to the Metrics tab to experience the health of each step and gate — see plainly what's doing well and what isn't — so I can find the weak spots and improve them."* (user, verbatim intent)

The tab is a **per-unit health console**. The unit of attention is the individual **step** or **gate**; the flow is **triage → understand → go improve**. Workflow-level KPIs and the self-improvement rail are supporting cast, not the lead. Today's tab fails this: five encodings per row with no legend, two different scores that look identical (step score vs gate health), the pipeline structure invisible (steps and gates in separate panels), the newest governance signals as dead one-liners, and — most damaging — a verification vocabulary that only makes sense for code steps.

## 2. Principles (and `agent-harness.pdf` anchors)

1. **Diagnosis-led, not a bare number.** Each unit leads with a plain-language verdict + its single limiting cause, then the paper's three telemetry channels inline. *§3.5.1 (p.33): telemetry "turns anecdotal debugging into comparative diagnosis"; §3.5.2: diagnosis "attributes failures to specific harness components."*
2. **Three channels, in the user's words.** `How it's doing` (evaluators) · `How we check it` (verification, step-appropriate) · `Anything wrong` (failure clusters). *§3.5.1: "evaluators expose regressions, tracing exposes causes, policy gateways expose boundary violations."*
3. **Judge each unit at the bar that fits its kind of work** (Phase B1). A step with no code can't be "executed" — holding it to that bar is the current bug. *§5.2.2: epistemically-aware feedback; §5.2.1: verification strength is relative to what's achievable.*
4. **Version-aware** (Phase A). A node's identity is stable across versions; the window is partitioned by version, never blindly pooled. *Industry precedent: Datadog deploy tracking / Change Overlays, Honeycomb break-down-by-version, Buildkite stable-test identity; A/B significance-gating (Statsig/Eppo/LaunchDarkly) — Orca already does the last via `n=`.*
5. **Linked to concrete artifacts** (Phase B4). Every count drills to the real failing completions. *§3.5.1: signals "linked to concrete artifacts … replayed and compared"; p.65: "each action carries a grounded reference to the evidence."*
6. **Self-teaching, low chrome.** Labels say what they mean; depth lives in hover tooltips, not standing legends/keys.

**ORCA.md alignment:** lives in the `harness-metrics/` subsystem; the pipeline uses the real graph node types (`step`/`gate`/`splitter`/`delegate`); templates are already independently versioned. **FUTURE_ARCHITECTURE.md:** advances **inspectability** (plans, state, provenance, failure causes) — a north-star property; no conflict with the control-plane/execution-plane split.

---

## 3. Phase A — Version-aware metrics *(prerequisite correctness fix)*

**Problem (confirmed against the live DB).** The metrics window pools runs across template versions with **no version filter** (`fetch.ts` `listTransitionsByTemplate` returns the whole window). On `orca/adaptive-delivery`, the review points `critique`/`verify` were **steps in v8–v11** and **gates in v12–v13**; the pooled window therefore shows them as *both* a step (Step panel) and a gate (Gates panel). Fossils (`validate_build`, `designgate`) linger from retired versions. The contract computes `versionBoundaries`/`versionScoreDelta` but nothing **scopes** by version.

**Design.**
- **Stable node identity.** A node is keyed by its graph node id, independent of name/type across versions (Buildkite/Datadog pattern). `critique`-the-gate is one identity with one continuous history.
- **Partition by version; default to "current shape."** Keep the wide window for sample size, but scope each node's headline health to its **current definition/type**. Runs from versions where the node had the *same* type (detectable via the `__gate__:` prefix + the current template's node types) contribute; **runs from a different type era are shown as annotated history, never averaged in** — because a step's verification *score* and a gate's *health* are different measurements.
- **Change markers.** Where a node changed type across the window, badge it (`⤳ was a step · v12`) and show a per-node cross-version history strip (step-era vs gate-era, split by a labelled boundary).
- **Significance-gating stays.** Underpowered current slices keep the existing honest-null / `n=` treatment (do not borrow strength across a definition change; say so).
- **Scope toggles.** `Current shape` (default) · `Latest only` (strict) · `All versions` (pooled, today's behavior).

**Touchpoints:** `apps/daemon/src/metrics/fetch.ts` (version-scoped queries), `usecases.ts` / `aggregate.ts` / `gate-metrics.ts` (partition + identity), a small contract addition for the scope selector + change-marker metadata; desktop scope bar. Recompute-on-read, no migration.

**Live check:** on Adaptive Delivery, `critique`/`verify` appear **once** (as gates), Step count drops 8→6, and the fossils are gone/annotated.

---

## 4. Phase B1 — Step-type-aware verification *(daemon model change)*

**Problem.** The band/score model treats every step as if execution were the goal, so any no-code step is structurally capped at "grounding" = **weakly verified** — a Triage step scoring 95 reads amber/"Checked, not run," which is nonsensical ("executed" is meaningless for triage).

**Design.** Use the signal Orca already computes — `stepRequiresExecution(guardrails, stepTemplateId)` (`requires-execution.ts`) — to set each step's **achievable verification ceiling**:
- **Execution-requiring step** (has a `validation_rule`): ceiling is execution; *not tested* is a genuine weakness (keep today's behavior).
- **No-code step** (returns `null`): ceiling is **grounding + review**; a grounded, reviewed step is **healthy**, not weak. Reserve the concern state for: *failing its checks* (e.g. `invalid_output`), a *low score*, *only self-reported* (under its ceiling), or *not checked yet*.

This changes the band derivation (the `verification.band` from Phase 2c-i) to be relative to the step's ceiling, and the desktop stripe/pill color follows. **This is the model root-cause fix B2's copy depends on.**

**Touchpoints:** `aggregate.ts` band derivation + `composed-score.ts`/`verification.ts` (thread `stepRequiresExecution` or an equivalent per-step "executable-in-principle" flag), contract `band` semantics. Recompute-on-read.

---

## 5. Phase B2 — Plain diagnosis cards *(contract labels + desktop + no-jargon)*

**Design.** Retire the jargon labels for step-appropriate, self-teaching ones:

| Situation | Pill (replaces) | Colour |
|---|---|---|
| Executed & tested | **Run & tested** (`Strongly verified`) | good |
| No-code, grounded + reviewed | **Reviewed & solid** (`Weakly verified` when at ceiling) | good |
| Output check failing | **Failing checks** | bad |
| Only self-reported (under ceiling) | **Only self-reported** | warn |
| Nothing checked yet | **Not checked yet** (`Needs more evidence`) | info |

Three channels renamed to plain questions: **`How it's doing` · `How we check it` · `Anything wrong`** (retire `Did it work`/`Was it vetoed` — and "vetoed" is already `no-jargon`-banned). Each unit leads with a one-line verdict + limiting cause. **Depth in hover tooltips; no standing legend/key.** `How we check it` explicitly states when there's no code to run and why review is the right bar.

**Note (scope honesty):** these relabel the **shipped Phase 2c-i band labels** (`Strongly/Weakly verified / Needs more evidence`) and are guarded by `no-jargon.test.tsx` — so this touches daemon band labels + desktop render + those tests. Not free, but the labels must teach themselves.

**Touchpoints:** contract label strings, `apps/desktop/src/metrics/StepPerformance.tsx` + `metrics-data.ts`, `no-jargon.test.tsx`.

---

## 6. Phase B3 — Fused pipeline *(desktop)*

**Design.** Merge the Step and Gate panels into **one "Pipeline" panel**, steps and gates in **graph/flow order** (from `graph_json`), gates rendered inline at the transition they guard (`Critique` guards Proposal→Execution; `Verify` guards Execution→Done). Gates get a distinct-but-connected treatment: round `◈` badge (vs numbered square step badge), a `GATE` chip, a faint wash, and a plain `guards X → Y` caption. Gates use the same three-channel language, adapted (`How it's doing` = approval/overturn/loops; `How we check it` = groundedness + coverage; `Anything wrong` = failure modes). Governance (completion gate, tool-safety) promoted to first-class drillable cards below.

**Open item — the `splitter` node.** The real graph has a `Route` splitter after Triage (branches to clarify/research/proposal) and may contain `delegate` nodes. The plan must decide: render branches as parallel lanes, or flatten with a branch marker. Default recommendation: **flatten with a small branch annotation** for v1; parallel lanes later.

**Touchpoints:** desktop `MetricsPage.tsx` + `GatePerformance.tsx` (fold into the pipeline), needs graph order from the template (contract/daemon may need to expose per-node `order` + `type` + `guards`).

---

## 7. Phase B4 — Sample drill-through *(contract + daemon + desktop)*

**Problem.** "invalid_output 3×" is a dead end. The step drawer renders `failureModes` (`{label,count,pct}`, **no ids**), while `failureClusters` (which **carries `sampleTransitionIds`**) is computed but unused; and no transition/session detail view exists in the desktop.

**Design.** Render the drawer's "Anything wrong" from **`failureClusters`** so sample IDs survive, and add a **sample peek** ("both" treatment): the first failing sample diagnosed inline (run id + time + version, the **failed check + why**, the **actual output excerpt** with the offending field flagged — from `evidence_json`/`telemetry_json`/`step_result_json`), the rest collapsed to one-liners, each with **`open full run →`** to the session/run in the Orchestrator. Closes the loop: number → concrete failures → why → the drafted fix.

**Touchpoints:** desktop step drawer (render `failureClusters`), a new sample-detail surface, a daemon/route to resolve a `sampleTransitionId` → completion detail (output + failed check + session link). Contract may need a sample-detail shape.

---

## 8. Rollout order & risks

**Order: A → B1 → B2 → B3 → B4.** A is pure correctness and must precede the visual work (so the console never shows two eras of a node). B1 is the model fix B2's copy depends on. B3/B4 are UI/data on top.

**Risks / watch-items:**
- **Required-field ripple** (the recurring lesson): any new required contract field (scope metadata, per-node order/type, sample shape) hits every `TemplateMetricsDetail` fixture across contracts/daemon/desktop — enumerate them per plan.
- **Recompute-on-read everywhere** — no migrations; scores/bands recompute from persisted `harness_transitions` on read, so A and B1 are retroactive and safe.
- **B2 relabel touches shipped 2c-i copy + `no-jargon`** — update the guard tests deliberately, don't dodge them.
- **Sample size after A** — defaulting to current-shape may drop confidence; the `n=` gating must carry the honesty (don't fabricate a point verdict on `n=1`).
- **Splitter/delegate rendering** (B3) — flatten-with-marker for v1; don't block the pipeline on full branch layout.

---

## 9. Open items for the implementation plans
- Phase A: exact identity key (graph node id) + how "same type era" is detected (prefix vs template-snapshot); the scope-toggle contract shape.
- B1: whether the ceiling flag lives on the step metric or is derived at render; how `needs_evidence` vs `only-self-reported` are distinguished for no-code steps.
- B3: graph-order/`guards` exposure from the template; splitter treatment.
- B4: the sample-detail route + contract; how far the peek reads (inline excerpt vs full transcript).
