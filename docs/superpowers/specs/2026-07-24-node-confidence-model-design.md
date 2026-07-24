# Node Confidence Model — Evidence-Based, Calibrated, Retrospective

**Status:** Design approved (brainstorming complete). Awaiting spec review → Phase 1 implementation plan.
**Date:** 2026-07-24
**Supersedes / extends:** `phase2-scoring-evolution` (composed-score, per-source calibration), `metrics-health-console-redesign` (B-series health console, B5 drawer), SP3 display-only calibration readout.

---

## 1. Origin & problem

The Metrics tab step drawer shows **"WHAT'S GOING WRONG — No problems detected this period."** even when a step's score is < 100. Root-cause trace:

- The drawer's empty-state keys on `step.failureClusters` (`apps/desktop/src/metrics/StepPerformance.tsx:194-195`), which is populated **only** from transitions whose `outcome.status ∈ {failed, escalated, denied}` (`apps/daemon/src/metrics/aggregate.ts:419-421`).
- The **score** is a different computation entirely: verification-tier-weighted quality of *passing* completions (`composed-score.ts:13-34`), driven by **hand-asserted priors** (`source-signals.ts:7-9`: `executable 1.0 / grounding 0.7 / independent_review 0.55 / self_report 0.3`).
- A step that **passes but is weakly verified** scores low (e.g. 30) with **zero failed transitions** → drawer says "No problems detected" next to a 30.

Two deeper findings emerged:

1. **The strongest evidence in the workflow is discarded.** Worker-gate approvals (Critique, Verify) are the strongest independent verification a reasoning step can get, yet they contribute **nothing** to the gated step's score: gate outcomes are written to a separate `gate_decisions` table and gate transitions are explicitly filtered out of step scoring (`aggregate.ts:237`). The only cross-reference runs backward (gate graded *by* the step it reviewed, `gate-metrics.ts:66-72`).
2. **The numbers feel arbitrary because they are priors wearing the mask of measurements.** `0.3` was chosen, not measured. Calibration exists (`verification.ts` `computeCalibration`) but is **display-only** (SP3 lock: "the score's own coefficients stay fixed").

## 2. Core definition (locked)

> **A graph node's score is our calibrated confidence that it did its job correctly, given the evidence gathered for it — evidence weighted by how *diagnostic it is measured to be*, with no per-type ceiling, and with uncertainty carried alongside. Absence of evidence is a distinct "unknown" state, not a low score.**

The model is **uniform across all node types** (step, gate, splitter). What differs is the node's *job*, hence what "vindicated" means:

| Node | Its job | Vindicated when |
|------|---------|-----------------|
| **Step** | produce correct output | output accepted downstream without bounce |
| **Gate** | accept good work, reject bad work | its verdicts hold up (false-accept primary; false-reject secondary) |
| **Splitter** | route to the right branch | chosen branch not walked back |

## 3. Locked semantics

1. **Retrospective ground truth.** A node earns confidence when what came next *vindicated* it. Ground truth is downstream outcome, not point-in-time appearance.
2. **Evolving via recompute-on-read.** Confidence is not mutable stored state; it recomputes from `harness_transitions`, so a later read naturally sees downstream transitions that have since landed. No migrations; formula changes are retroactive-safe (respects the locked recompute invariant).
3. **Empirical-Bayes, measured not asserted — concretely a Beta posterior.** Confidence for an evidence profile is a **`Beta(α, β)`** posterior over its vindication rate: the designed prior enters as low-weight pseudo-counts `Beta(α₀, β₀)`, and each observed outcome updates it with a **soft (attenuated) count** — a vindication by a downstream of confidence `c` contributes weight `c` rather than a hard `1` (see T1). Posterior **mean = point confidence**, **credible interval = uncertainty**, effective sample size `n = (α+β) − (α₀+β₀)` drives shrinkage: early → near the prior, with data → the measured rate. (Cf. paper p.33 KnowNo, which calibrates planner uncertainty via conformal prediction; p.65: treat feedback as *calibrated evidence, not a binary success signal*.)
4. **Calibration is load-bearing** on the score (deliberately crosses the SP3 display-only lock; this is the FUTURE_WORK 5.2 "coefficient governance"). Justification: the retrospective **downstream-vindication oracle is independent of the refute pass**, so it escapes the CRUX circularity — it can calibrate evidence profiles refute could not, notably **`independent_review` / worker-gate approvals** (refute couldn't calibrate these without self-reference). Note `self_report` is *not* calibrated: under T2 it ceases to be a scored value at all (→ **unknown** until real evidence arrives), so there is no `self_report` prior to measure.
5. **First-class uncertainty.** Sample size / confidence-interval travels with every score. "92, 40 runs" and "70, provisional (2 runs)" are distinct objects. This is the antidote to "arbitrary."
6. **No per-type ceiling; ceiling-relative to verifiability** (preserves B1). Execution is not privileged because it is execution — only because a passing test is strong evidence. A reasoning step verified against *its* achievable evidence can reach 100.
7. **Deterministic core.** Confidence is computed by deterministic code over facets; the LLM only fills verdicts (respects "deterministic core, selective AI"). Confidence **informs but never gates** human completion.
8. **Vindication event (precise).** A node is *vindicated* when the immediate downstream node that consumed its output reaches an accept for the path using that output — gate `approved`, next step completed against a stable ask, or human approve. It is *bounced* when that downstream routes back to it or rejects it — gate `rejected`, human reject/redo against a stable ask. A changed ask **voids** the signal (T3). No downstream yet → **unknown**, never negative.

## 4. The four gap decisions

### T1 — Weak-verifier attenuation & confidence propagation

**Decision.** Vindication counts **in proportion to the vindicating node's own confidence.** A pass through a strongly-verified downstream is real evidence; a pass through a self-reported downstream is nearly worthless. This makes confidence **propagate backward from hard anchors** — the only two non-relative signals: a **passing executable test** and a **human sign-off**.

**Anchors are the ground-truth *labels*, not privileged verifiers.** The two anchors — a passing executable test (near-certain by nature) and a human sign-off (authoritative by the locked human-authoritative invariant) — are what every other verifier's confidence is *measured against*. A gate is **not** permanently capped below a test: if gate approvals empirically predict vindication as well as tests do, calibration lets them earn near-anchor confidence (consistent with the paper's finding, p.47, that LLM-simulated verification can rival execution). The designed prior is only the starting point.

**Attenuation and calibration are one mechanism at two timescales.** Per-instance, a vindication is weighted by the vindicator's confidence. In aggregate, those *same anchor-attenuated weights are the soft labels calibration learns from* (the fractional Beta counts of §3.3) — so a chain of weak checks contributes only fractional labels and cannot inflate a rate. This closes the reward-hacking hole (paper §5.2.2) at **both** the instance and the calibration level, not just per-instance.

- **Compute one-hop now**: a node's vindication evidence is weighted by its *immediate* downstream's already-computed confidence (single reverse-topo pass; fits recompute-on-read; produces the plain, node-named explanation the drawer needs).
- **Persist a propagation-ready substrate**: per-node confidence **+ the weighted vindication edges** (who vindicated whom, with what attenuation). The one-hop math MUST be a strict special case of full propagation.
- **Full propagation is a named future phase** that lands **with autonomy-gating** (the first product surface needing a global whole-chain trust number). Deferring is safe precisely because one-hop is the base case and the data model is pre-wired.

**Accepted consequence:** a workflow with no execution and no human sign-off has no anchor, so its confidence stays low/unknown — honest, and it correctly gates such work out of autonomy.

### T2 — No `self_report` floor; "unchecked" is a first-class unknown; guaranteed-verifier invariant

**Decision.** Remove the `0.3` `self_report` floor. A number that asserts "30% confident" about something nothing evaluated is a fabrication, just downward. The honest representation of "nothing has checked this" is **no value** — a transient **unknown** state, uniform with the "not yet known" state of freshly-fired gates/splitters. Three states, all node types: **unknown / weak / strong**.

- **Unknown ≠ zero.** It is the absence of a value (handled like the existing null-score / `needs_evidence`), excluded from means — never computed as "certainly wrong."
- **Guaranteed-verifier invariant (HARD).** Every step must declare **≥1 guaranteed verifier** — an immediate automated one (grounding / review / sensors) *or* human sign-off as the universal fallback. Retrospective vindication is **additive, never sufficient** (a terminal step has no downstream). A workflow with a verifier-less step is **malformed and rejected** by graph validation (like `validate-graph.ts` rejects structurally-broken graphs).
- **Declaration mechanism (Phase-1 open decision):** where a step declares its guaranteed verifier — *derive from existing surfaces first* (`grounding` array, `validation_rule` guardrail's `appliesToSteps`, an incoming worker-gate edge), with an explicit field only where derivation can't express it. Mirrors how `grounding` is already declared per-step. Settle at Phase-1 planning.
- **Verifier scope (refinement, paper p.65):** each verifier should eventually declare *what it verifies and what it cannot* — the paper's example: "a bounding-box detector verifies localization but not task completion." Scope feeds coverage and guards against a passing-but-irrelevant verifier (an oracle-adequacy defense). Reserve the field now; enforce scope-awareness in a later phase.
- **Unknown always names its pending resolver** — *"Not checked yet — awaiting the Verify gate"* / *"Awaiting your approval."*

**Emergent property:** autonomy becomes **proportional to machine-verifiability** — no separate autonomy rule. Steps only a human can verify require a human in the loop and gate out of full autonomy, by construction.

### T3 — Human actions as evidence (only the unambiguous ones)

**Decision.** Human interactions are **recorded as facts**, but only **unambiguous** ones move the score — a bare human action is confounded (missed consideration / change of direction / desire to control / mistake). Separate *observation* from *interpretation*.

- **Approve as-is** → positive anchor (top of the ladder; un-calibratable — nothing sits above the human; rubber-stamp risk accepted).
- **Reject / redo** → negative **only if the redo runs against a materially unchanged ask**; a reject accompanied by a changed ask is a **pivot → neutral**, not the step's fault.
- **Bare edit (accept-after-editing)** → **observe-only**: magnitude recorded as an inspectable fact, **not** folded into the score (pending future disambiguation).
- **Disambiguator = ask-stability**, read from instructions/requirements (data), never inferred from human intent. Concretely it compares the step's **inputs across attempts** — the step-template `instructions` plus the goal objective / confirmed requirements it was handed — treating a redo against a materially-identical input set as "same ask." The precise "material change" test (exact-hash vs. semantic diff of requirements) is a Phase-2 detail. **This same rule governs gate-reject loop semantics** (a Critique↔Proposal loop dings the first attempt only if the redo faced a stable ask).

### T4 — Attribution rule

**Decision.** Attribute each bounce to the **immediate rejected node** (one-hop). **No per-instance root-cause inference** — empirical multi-agent failure-attribution accuracy is 14–53% (paper p.52), so a confident root-cause claim is fabrication.

- **Provable pass-through exception:** a deterministic splitter (`branchKey`) has no judgment — it relays an upstream field, so a misroute attributes to the **upstream decision-maker** (e.g. Triage's `recommended_tier`), not the splitter. Structural fact, not inference.
- **Transitive/root-cause signal emerges statistically** through one-hop calibration over many runs: if bad Proposals systematically cause Execution bounces, Proposal's vindication weight from Execution drops and its confidence falls on its own. Credit assignment happens in aggregate, measured — never asserted per instance.

## 5. Constraints respected (from prior locked decisions)

- **Recompute-on-read** from `harness_transitions`; **no migrations**; formula changes retroactive-safe.
- **CRUX preserved:** never calibrate a source against the **refute** signal (circular). Calibration uses the **independent downstream-vindication oracle** instead.
- **`base = 1 − ∏(1−cᵢ)`** over independent passing verifiers × coverage stays the compounding shape; the change is (a) removing the `self_report` floor as a *value*, (b) making the `cᵢ` measured.
- **Bands orthogonal to grade** (2c-i); **ceiling-relative to step type** (B1).
- **Stable graph-node-id identity; partition by version; never average across a step→gate type change** (Phase A).
- **Owner-scoped calibration** (per-User / per-Org wall; today per-template).
- **Grounding is not an execution oracle** (caps at `partially_verified`, sensor-only `oracleAdequacy`).

## 6. Architecture

**Extend the existing engine in place** (a greenfield subsystem is foreclosed by the no-migration / recompute-on-read invariants and would duplicate the facet model).

- **Evidence sources** consumed by the confidence function: `executable`, `grounding`, `independent_review` (now including **worker-gate approvals**, previously discarded), **downstream-acceptance** (new retrospective), **human confirmation**, **questions-resolved**.
- **Data model additions (propagation-ready):** per evidence profile, a `Beta(α, β)` posterior (point confidence + credible interval + effective `n`); per node instance, its established confidence + the **weighted vindication edges** `{ fromNodeId, toNodeId, weight = downstream confidence, askStable: bool }`. One-hop reads only the direct successor's confidence; **full propagation later reads these same edges and iterates** — the edges are the shared substrate, which is why deferring propagation is safe.
- **Reason vocabulary:** a system-owned, enumerated catalog (extends the `failure-labels.ts` discipline), **naming real graph nodes** (*"The Critique review hasn't confirmed this yet"*), no-jargon-tested. The drawer's low-confidence line renders the score's own evidence computation through this catalog — never editorial copy.

## 7. Decomposition (four sequenced sub-projects)

Each is independently shippable and respects recompute-on-read.

| Phase | Delivers |
|-------|----------|
| **1 — Confidence engine + wire discarded evidence** | Per-node confidence shape for **steps**, consuming all immediate evidence **including gate approvals**. Remove the floor → **unknown** state. **Guaranteed-verifier invariant + hard graph-validation.** Uncertainty scaffolding. Closes the root cause: gate-approved steps stop reading 30. |
| **2 — Retrospective vindication + load-bearing calibration** | Downstream-vindication signal (double duty: evolves each node's score *and* calibrates evidence→outcome rates). **Weak-verifier attenuation (one-hop) + propagation-ready substrate.** Ask-stability disambiguation. Attribution rule. The heart. |
| **3 — Gates & splitters as scored nodes** | Stop filtering `__gate__`; populate `gateHealth` (existing stub, `aggregate.ts:162`) + new splitter health. Every node gets a confidence. Splitter is retrospective-only until `evaluate_split` is wired in production. |
| **4 — Drawer reason vocabulary** | System-owned, node-naming, no-jargon reason catalog; the bounded low-confidence line; confidence + uncertainty display for all node types. Fixes the visible symptom. |

**Phase 1 is the first implementation plan.**

## 8. Risks & open items

- **Reward-hacking / oracle adequacy (paper §5.2.2, the #1 risk):** "if the verifier is weak, the agent will learn to optimize against the wrong signal." **Mitigated by T1 attenuation** (confidence can't exceed what hard anchors support) — this is why attenuation is a *hard* Phase-2 requirement, not a nicety.
- **Attribution is approximate** by design (T4) — accepted, because precise per-instance root-cause is provably unreliable; the signal recovers in aggregate.
- **Calibration bucketing (Phase-2 decision):** the evidence profile that keys a Beta posterior — candidate key `(node-type, verifier-set)`, scoped **per owner + per template-version** (Phase A identity). Finer buckets are more faithful but sparser; pooling granularity (pool across versions within a window vs. strict per-version) trades bias vs. variance. Rare profiles stay near the prior (honestly "provisional").
- **Compose with existing `CounterfactualJudgment` / evaluate stage** (already shipped): share the calibration substrate, don't duplicate. (Spec note, not a decision.)
- **Edit disambiguation** (T3) is deferred future work.
- **Splitter live evidence:** `evaluate_split` unwired in production (FUTURE_WORK 5.5) — Phase 3 splitter confidence is retrospective-only until it's wired.

## 9. Alignment

**FUTURE_ARCHITECTURE:** moves *toward* the north star ("hostable, multi-tenant, **learning** agent-orchestration platform") — an evidence-based, deterministically-computed, owner-scoped, recompute-on-read confidence that *informs but never gates* human completion, feeding the experiential learning loop. Respects every locked invariant (§5). Crosses two locks *deliberately and named*: SP3 display-only → load-bearing calibration, and the `self_report` floor → unknown state (T2).

**agent-harness.pdf — decision-by-decision:**

| Decision | Paper prescription |
|----------|--------------------|
| Core definition + uncertainty | p.65: *"each feedback signal should expose its **scope and uncertainty**… treat feedback as **calibrated evidence, not a binary success signal** — essential for safe long-horizon autonomy."* §5.2.2: *"uncertainty-aware critics," "feedback calibration," "an evolving, inspectable contract."* |
| Empirical-Bayes / uncertainty | p.33: KnowNo *"calibrates planner uncertainty"* (conformal prediction). |
| T1 attenuation / anchors-as-labels | §5.2.2: *"if the verifier is weak, the agent will learn to optimize against the wrong signal."* p.47: LLM-simulated verification can rival execution (⇒ gates can earn near-anchor confidence). |
| T2 guaranteed-verifier + scope | p.65 / §5.2.2: *"Each artifact should declare what it verifies, what it cannot verify, and what confidence it provides."* |
| T2 emergent autonomy | p.66: **governed** — *"autonomy constrained by permissions, verification, and accountability"* — one of the four properties of the next frontier. |
| T3 human actions as evidence | p.64: approvals/rejections/corrections become *"durable harness state"* updating *"verification criteria."* p.31/p.33: deep telemetry records *"rejected alternatives, human interventions."* |
| T4 attribution (approximate) | p.52: multi-agent failure-attribution accuracy is only **14–53%** ⇒ per-instance root-cause is fabrication. |
| Propagation-ready data (future) | §3.5.2 Evolution Agent: observe → **diagnose (attribute failures to workflow components)** → propose → evaluate → **governed promotion**. Full propagation's marginal-contribution analysis is that loop's input. |

The paper is not merely compatible — §5.2.2 and p.65 read as an independent specification of this design.
