# Harness Axes — Design Spec

**Date:** 2026-06-23
**Status:** Draft for review
**Scope:** Close the gap between Orca's harness and the four reliability properties from *Code as Agent Harness* (arXiv 2605.18747) — **Executable, Governed, Stateful, Inspectable** — via one shared core model with a facet per axis.
**Horizon:** L4-ready (design the full mechanism; ship in dependency-ordered phases).

> This spec is grounded in a code audit of `apps/daemon/src` and `packages/contracts/src`, **not** ORCA.md prose. ORCA.md was found materially stale on several points (see Appendix A); correcting it is a deliverable.

---

## 1. Why (the paper, in one paragraph)

The paper's thesis is that agent reliability is a property of the *harness*, not the model: harness mechanisms are "coordinated control surfaces that turn model decisions into bounded, observable, and revisable changes in an executable environment" (p.16). Its closing scorecard (p.61, p.66) names four properties of reliable harnesses — **Executable** (decisions grounded in code/tools/tests), **Inspectable** (plans, state, provenance, failure causes exposed), **Stateful** (task-relevant info preserved across trajectories and agents), **Governed** (autonomy bounded by permissions, verification, accountability). Orca is already on-thesis ("deterministic core, selective AI"), so this spec targets the *specific* mechanisms the paper builds out that Orca has deferred or left dormant.

## 2. Grounded evaluation (current state)

Scorecard from the audit (file:line pointers in each axis section):

| Axis | What's actually in the code | Grade |
|---|---|---|
| **Executable** | Only deterministic completion oracle is "is this well-typed JSON." Nothing runs tests/typecheck/lint. The `validation_rule` guardrail is **dead** (`skip_validation` action never constructed; `required:[…]` never consumed); `workflow.validation.passed` is declared but **never emitted**. All "validation" is agent-authored free text. | **Weak** |
| **Governed** | The five autonomy levels **do not exist** in code — `autonomyLevel` is hardcoded to `1` and gates nothing. Real governance is two binary toggles (`SupervisionMode` global, `worker_permission_mode` per-goal). `risk_rule`/`riskLabels` exist but are **never populated**. The per-action approval gate is real and reusable but **binary**. **Zero OS containment** — agents run in the real repo with inherited credentials; the hook gate is cooperative. `antigravity` adapter spawns ungated. | **Weak** |
| **Stateful** | Solid: strict goal-scoping (cascade delete), deterministic confidence-gated promotion, content-hash dedup, hard **32 KiB** context envelope, role-aware selection, static transcript isolation, idempotent extraction. Missing: action-level read/write sets, structured assumptions, belief-divergence tracking, semantic (vs lexical Jaccard) conflicts, experiential/cross-task memory. | **Partial** |
| **Inspectable** | Strong control-plane provenance (decisions + alternatives, operator selection, guardrail evals, single-hop FK lineage). But **not event-sourced, no replay**, **no cost field anywhere**, **no worker-agent token telemetry** (`workflow_llm_calls` captures only the orchestrator decision-LLM), **no cross-run aggregation**, and the recommendation feedback loop is **collected but never read**. | **Partial** |

**Cross-cutting insight:** roughly half the gap is *dormant seams*, not greenfield — `risk_rule`/`riskLabels`, the `validation_rule` guardrail, ledger `updates_json`, recommendation `recentFeedback`, the `SessionMemoryExtractor` LLM seam, and the `autonomyLevel` field all exist and are wired partway, then go unread. Closing those is *activation + completion*.

## 3. Core model — the `HarnessTransition`

### 3.1 Problem
Consequential decisions are scattered across disjoint tables (`workflow_guardrail_evaluations`, `workflow_llm_calls`, `workflow_decisions`, `step_result_json`) joined only loosely, plus an extraction-provenance chain (`source_session_id`/`source_extraction_id`/byte offsets) that never connects to the orchestrator-decision influence graph (`influenced_by_json`). The audit flagged these two provenance models as "disjoint and ununified."

### 3.2 The record
Introduce one thin spine entity — **`HarnessTransition`** — emitted by the **engine (never the orchestrator-LLM)** at each consequential boundary, carrying four typed facets that are exactly the four axes:

```
HarnessTransition {
  id, goal_id, workflow_step_run_id?, boundary: enum,
  risk:      RiskFacet       // Governed
  evidence:  EvidenceFacet   // Executable
  stateDeps: StateDepsFacet  // Stateful
  telemetry: TelemetryFacet  // Inspectable
  created_at
}
```

### 3.3 Emission boundaries (all already exist in code)
| Boundary | Existing site |
|---|---|
| Step launch | `workflows/orchestrator/service.ts:2938` (guardrail chokepoint) |
| Step completion judged | `workflows/orchestrator/judgement.ts` → `service.ts:1543` `approve_step_complete` |
| Tool-permission gate | `server.ts:1491` `onPermissionRequest` + `workflows/orchestrator/permission-approvals.ts` |
| Mark-done | `templates/catalog.ts:39` / `service.ts:3292` |

### 3.4 Design invariants
1. **Engine-owned.** Transitions are written by deterministic code, preserving "deterministic core, selective AI." The LLM never writes a transition.
2. **A real object, not a join key** (this is what makes it Approach A). The append-only, fully-faceted transition log is *replayable*: replaying transitions reconstructs "what the harness decided and why" — a scoped slice of control-plane event-sourcing, **without** event-sourcing all of Orca's state.
3. **Facets are independently phaseable.** Each axis section below specs its facet schema + populating code + enforcement, and each can ship alone.
4. **Additive migration.** Existing facet tables are *linked* (FK) to the transition, not dropped.

### 3.5 Implementation
- New table `harness_transitions` + per-facet tables (some new, some existing-linked), keyed by `transition_id`.
- Facets implemented as linked per-concern tables (the surgical mechanism of "Approach B") with the transition record as the spine that unifies them.
- Provenance recorded immutably on the transition (fixes the current `ON DELETE SET NULL` severing).

---

## 4. Axis specs (facets)

### 4.1 Executable — `EvidenceFacet`

**Problem (grounded).** Completion gating today (`judgement.ts:41` → `validateStepOutput`, `packages/contracts/src/workflows/output-schema.ts:103`) is a structural/type check only; on schema pass the LLM mediator's `approve_step_complete` (`orchestrator-llm/mediator.ts:53`) is sufficient to advance (`service.ts:1606`). No step runs a real test/typecheck/lint/build (grep for `child_process|vitest|tsc` returns only the tmux worker spawn). The `validation_rule` guardrail (`workflows/guardrails/evaluator.ts:154`) only fires on a `skip_validation` candidate action that is **never constructed**, and its `required:["unit_tests","typecheck"]` config is parsed (`evaluator.ts:60`) but **never consumed**. `workflow.validation.passed` (`workflows/events.ts:39`) is **never emitted**.

**Design.**

1. **Deterministic sensor runner (✦ net-new).** A daemon-side component that *itself* executes verification commands in the workspace `cwd` after a code-touching step — the trust-boundary fix. **Decision: the daemon runs the ladder** (not the agent self-reporting). Sensors run cheapest-first, fail-fast: `typecheck/lint → unit → integration/build`. The dormant `validation_rule.required` labels become the sensor selectors. Mitigate cost via per-step opt-in (only `execution`/`validate_build`-type steps) and fail-fast short-circuit.

2. **`EvidenceFacet` schema.**
```
EvidenceFacet {
  sensors_run: [{ kind: typecheck|lint|unit|integration|build|static,
                  command, exit_code, duration_ms,
                  result: passed|failed|skipped,
                  summary, artifact_ref }]          // full output offloaded; summary in context
  verdict: passed|failed|partial
  untested_regions: string[]
  residual_risk:    string[]
  oracle_adequacy:  { sufficient: bool, gaps: string[] }
}
```

3. **Completion becomes hybrid-with-deterministic-veto.** For steps flagged `requires_execution`: engine runs the ladder → builds `EvidenceFacet` → **the LLM `approve_step_complete` is vetoed if `verdict == failed`** (paper p.31: "critique interprets sensors, never replaces them"). A discrepancy between the agent's self-reported `validation[]` (`templates/catalog.ts:159`) and the daemon's sensors becomes automatic revise feedback. This activates the dead guardrail and finally emits `workflow.validation.passed`.

4. **Oracle-adequacy guard (paper p.62, "green test ≠ done").** Deterministic check that the sensors that ran map to the step's `required` checks; missing coverage → `oracle_adequacy.sufficient = false` → require_approval or revise.

5. **Artifact offload (paper p.28).** Full sensor output capped-and-stored with `artifact_ref` (same pattern as the session output tail, `ORCA_SESSION_OUTPUT_TAIL_BYTES`); only parsed summaries enter context, respecting the hard 32 KiB envelope.

**Phasing.** P1: typecheck + unit sensors on code-touching steps, facet recorded, `verdict==failed` veto (activates the dead guardrail, emits the dead event). P2: full ladder + lint/static + oracle-adequacy + artifact offload. P3: sensors as per-workspace declarative config + route-by-type feedback.

---

### 4.2 Governed — `RiskFacet` + two-mode operating model

**Problem (grounded).** Five autonomy levels don't exist (`autonomyLevel` = `z.number().int().default(1)`, `packages/contracts/src/index.ts:36`; always written `1` at `goals.ts:105,306`; never read to gate). Real control is two binary toggles: global `SupervisionMode` (`index.ts:1303`, gates step-completion parking at `service.ts:1563`) and per-goal `worker_permission_mode` (`ask|auto`, `migrations/0023`). `risk_rule`/`GuardrailContext.riskLabels` (`evaluator.ts:200`) are **never populated**. The approval gate is real and reusable (`permission-approvals.ts` `PermissionApprovalStore`, held-open hook, fail-closed offline) but binary. No OS containment — adapters return `args:[]`, `cwd: workspacePath`, inherit real `HOME`/credentials (`adapters/*.ts:48-50`, `types.ts:69-81`); tmux/PTY is the only isolation. `antigravity` adapter has no permission gate.

**Target operating model (replaces the 5-level ladder).**
- The system **always executes** (no "suggest-only" states). The vestigial `autonomyLevel` integer is **retired**.
- A **per-goal mode toggle**: **Human Review** ⟷ **Automated**, built by elevating `SupervisionMode` and making it per-goal.
- Mode is a **gate-threshold over the `RiskFacet`**:
  - **Human Review** → gate fires for consequential actions (`permission_tier ≥ sandbox_edit`).
  - **Automated** → gate fires only for exceptions (`risk_class == critical`, hard-constraint violations, or unresolvable conflicts).
- **Mode-independent safety floor (hard invariant):** critical/irreversible actions (credentials, deploy, destructive FS, git-history mutation) **always** gate, in every mode, enforced deterministically, non-disableable. This is the paper's L5 = "exception-based oversight," not "no oversight."

**Design (mostly ⚡ activation).**

1. **Risk classifier (⚡ activates `riskLabels`).** A deterministic, **argument-aware** function mapping a proposed action (tool + args, or workflow action) to `risk_class` + `permission_tier`:
   - `read_only` — browse, retrieve, static inspect, log analysis.
   - `sandbox_edit` — file edits, test execution, temp deps in the workspace.
   - `full_access` — network, credentials, deploy, publish, destructive FS, git-history, writes outside workspace.
   Argument-aware escalation (e.g. `rm -rf`, `git push`, external `curl`). Populates `GuardrailContext.riskLabels`, making the existing `risk_rule` guardrail live.

2. **Permission tiers replace the binary gate (backward-compatible).** `worker_permission_mode` shifts from `{ask, auto}` to a **tier ceiling** under the mode: actions at/under the ceiling auto-allow, above route to the existing `PermissionApprovalStore` gate. (Legacy `auto` ≡ ceiling `full_access`; `ask` ≡ ceiling `read_only`.)

3. **`RiskFacet` schema + executable accountability (paper p.65).**
```
RiskFacet {
  risk_class: low|medium|high|critical
  permission_tier: read_only|sandbox_edit|full_access
  classification_reasons: string[]
  gate_decision: allow|deny|require_approval
  hard_constraint_violations: string[]      // deny reasons that OVERRIDE the model
  mode: human_review|automated               // the mode in effect at decision time
  approval?: { approval_id, approved_by, shown_evidence_ref, decided_at,
               policy_delta? }               // a repeated approval can RELAX a future gate
}
```
The `policy_delta` closes the loop the audit found missing: a repeated approval of an action class can be promoted into a relaxed gate (rejection → tightened), recorded as a `GoalDecision`. This *is* how the human "teaches" the harness.

4. **Containment via a documented seam (✦).** Spec the **policy layer fully now**; define a `SpawnSandbox` interface around adapter spawn (`adapters/`) as a reserved seam — like Orca's storage-provider and plugin-interface seams — to be filled by a later milestone (OS sandbox: macOS sandbox-exec / Linux namespaces+seccomp / Windows). The policy layer (classification, tiers, gates, accountability) is cooperative and app-level; containment is physical and out of scope for this spec.

5. **Near-term fix (⚡):** close the `antigravity` ungated-spawn gap (add the permission hook wired for claude-code/codex).

**Phasing.** P1: risk classifier populates `riskLabels`, activates `risk_rule`, tier ceiling replaces binary mode (backward-compat endpoints), `antigravity` gate. P2: two-mode toggle (Human Review/Automated) + exception floor + `RiskFacet` at all boundaries + accountability `policy_delta`. P3: `SpawnSandbox` seam (+ later, a real implementation).

---

### 4.3 Stateful — `StateDepsFacet`

**Problem (grounded).** Memory is solid (`memory/`, lifecycle `candidate→promoted→archived` at `usecases.ts:185`, deterministic auto-promotion `promotion-rules.ts:9`, dedup, goal-scoped). Context assembly is solid (`context/deterministic-assembler.ts:287`, hard 32 KiB `index.ts:1619`, role-aware `selection.ts`, transcript isolation `input.ts:18`). But coordination is thin: conflict detection is **lexical only** (Jaccard + negation over decision titles, `conflicts/detectors.ts:342-381`); no read/write sets (`grep read_set` = 0); assumptions are a free-text memory *type*, not structured; no belief-divergence; multi-session overlap is detected post-hoc (`detectWorkspaceOverlap`), never prevented. State is projection-based.

**Design.**

1. **`StateDepsFacet` schema (paper p.64 transactional-state primitive).**
```
StateDepsFacet {
  read_set:    [{ kind: file|memory_item|decision|task|workspace_version, ref, version }]
  write_set:   [{ kind, ref, intended_change }]
  assumptions: [{ statement, source_ref, verified: bool }]   // structured, replacing free-text
  version_deps:[{ ref, observed_version }]
  conflict_policy: auto | escalate
}
```

2. **`read_set` is largely derivable (⚡).** At step launch the engine already builds `context_packages` + a `sourceFingerprint` hashing exactly the memory/decision IDs + timestamps that went into context (`context/input.ts:184-215`). `read_set` ≈ those inputs. `write_set` + structured `assumptions` come from the agent's step output (the `execution` step already carries free-text `assumptions[]` to upgrade). `version_deps` from the existing lazy/bounded git inspection.

3. **Belief-divergence detection (SyncMind Bₖ vs Sₖ, p.44 — deterministic).** When a transition's `read_set`/`version_deps` reference a memory item or workspace version that has since changed, the action was built on a stale belief. The engine compares recorded vs current versions (extends the existing `sourceFingerprint` staleness signal from "package stale" to "action built on superseded state") → trigger re-verification or revise.

4. **Conflict engine: lexical → semantic, broader granularity.**
   - **Deterministic first:** read/write-set *overlap* between concurrent transitions is a hard conflict signal (two sessions writing the same ref; one reading what another rewrites) — across plans, memory, permissions, not just decision titles.
   - **Semantic second, only when needed:** activate the existing `SessionMemoryExtractor` LLM seam (`extractions/runner.ts` `RunnerDeps.extractor`; current impl is regex `deterministic-extractor.ts`) as an LLM conflict-judge, **gated behind** the cheap deterministic overlap signal — preserving the selective-AI cost stance.
   - `conflict_policy` decides auto-resolve vs escalate.

5. **Concurrency model: optimistic (declare + detect + escalate).** No locks — sessions run freely; the engine detects overlap/staleness and raises a conflict (auto-resolve or escalate per policy). Matches Orca's event-driven detect-don't-prevent pattern. (Pessimistic locking and single-writer serialization were considered and rejected as too heavy / throughput-limiting for L4 multi-session.)

6. **Experiential memory (L5 horizon, via existing abstractions).** Promote a successful workflow run into a reusable `workflows/templates/` entry — cross-task reuse that respects the current no-cross-goal-memory non-goal. No vector store; reuse the template mechanism. Phased last.

**Phasing.** P1: `read_set` derived from the context fingerprint; `StateDepsFacet` recorded. P2: structured `write_set`/`assumptions`; optimistic conflict detection + belief-divergence; semantic conflict via the LLM seam. P3: experiential-memory template promotion.

---

### 4.4 Inspectable — `TelemetryFacet` + harness metrics

**Problem (grounded).** Strong control-plane provenance (`workflow_decisions.alternatives_considered_json` `0010`; `influenced_by_json` 8 kinds; guardrail evals `workflow_guardrail_evaluations`; single-hop FK lineage). But: events are append-only **audit/notification only** — no reducer/fold, no replay (the only reader is `listEventsSince()` at `events.ts:63` feeding the SSE tail); **no cost field anywhere**; **worker-agent token usage absent** (`workflow_llm_calls`, `0010`, is written only by the operator-selector decision-LLM at `operators/selector.ts:493`); no cross-run aggregation (no `/stats` route); recommendation `recentFeedback` is assembled into `RecommendationInput` (`input.ts:381`) but **read by nothing** and excluded from the regeneration fingerprint.

**Design.**

1. **`TelemetryFacet` schema.**
```
TelemetryFacet {
  cost: { tokens_in, tokens_out, usd }          // NEW: token→$ via a model price map
  latency_ms, model, provider_id, provider_version,
  prompt_ref, raw_output_ref,                    // offloaded artifacts (refs, not inline)
  rejected_alternatives: [{ option, reason }],   // from workflow_decisions.alternatives
  human_interventions: [{ kind, ref }],          // approvals, revises, escalations
  outcome: { status, failure_code? }             // CATEGORICAL
}
```

2. **Close the worker-token gap (✦).** Capture worker agent (Claude Code/Codex) usage via the existing agent hook endpoints (Stop/response-done payloads) — honoring the "prefer hooks over parsing" rule. `usd` from a small model price map.

3. **Categorical failure codes (⚡).** Extractions already carry a `failure_code` enum (`migrations/0005_memory.sql:15`); workflow steps carry only free-text `reason`. Add the same categorical code to transition outcomes → enables clustering.

4. **Harness-level metrics as projections over the transition log (paper's six dimensions, p.62).**
   | Metric | Derived from |
   |---|---|
   | Trajectory efficiency | transition count, tokens, revises, duration / run |
   | Verification strength | `EvidenceFacet` coverage + oracle_adequacy across steps |
   | Recovery | crash/revise recovered vs escalated |
   | State consistency | `StateDepsFacet` conflicts detected/resolved |
   | Safety compliance | `RiskFacet` gate decisions honored vs denied |
   | Replayability | % transitions with complete facets |
   Delivered as a `/v1/goals/:id/harness-metrics` projection — the `/stats` route the audit found missing.

5. **Failure attribution + unified provenance + control-plane replay.** Categorical codes + facets let you cluster which step/adapter/guardrail/sensor recurs in failures — the read-side substrate for the paper's Evolution Agent (the autonomous Evolution Agent itself is an explicit **L5 non-goal**; the seam is noted). The transition record unifies the two disjoint provenance models into multi-hop lineage. Replaying transitions reconstructs the control-plane trajectory (the scoped Approach-C slice). Reviving the dead recommendation-feedback loop: feedback becomes a `human_intervention` signal feeding attribution.

**Phasing.** P1: worker-token capture + cost map + categorical failure codes (cheap activation). P2: `/harness-metrics` projection + unified provenance. P3: failure attribution + control-plane replay; revive recommendation feedback.

---

## 5. Roadmap (dependency-ordered)

⚡ = activate dormant seam · ✦ = net-new

| Order | Phase | Rationale | Key items |
|---|---|---|---|
| 1 | `HarnessTransition` spine (§3) | Everything hangs off it | ✦ record + emission at 4 boundaries; link facet tables |
| 2 | Executable / `EvidenceFacet` (§4.1) | Foundation of trust — can't autonomate when "done" = valid JSON | ✦ daemon sensor runner; ⚡ activate `validation_rule`; emit `workflow.validation.passed`; veto; oracle-adequacy |
| 3 | Governed / `RiskFacet` + two-mode (§4.2) | Makes Human Review a real, safe mode | ⚡ risk classifier → `riskLabels`; tiers replace binary gate; ✦ Human Review/Automated + exception floor; `policy_delta`; ⚡ `antigravity` gate; ✦ `SpawnSandbox` seam |
| 4 | Inspectable / `TelemetryFacet` (§4.4) | Trust + audit Automated; cheap activation wins | ✦ worker tokens via hooks; ✦ cost map; ⚡ failure codes; ✦ `/harness-metrics`; unify provenance + replay; ⚡ revive feedback |
| 5 | Stateful / `StateDepsFacet` (§4.3) | Matters most under concurrency | ⚡ read_set from fingerprint; ✦ write_set + assumptions; ✦ optimistic conflict + belief-divergence; semantic conflict via LLM seam |
| 6 | Experiential memory (§4.3 tail) | L5 horizon | ✦ promote successful run → template |

**Throughline:** phases 1–3 make **Human Review** trustworthy (real verification + real gates); phases 4–5 make **Automated** auditable and safe-under-concurrency; phase 6 is the L5 reach.

## 6. Non-goals (explicit)

- OS-level containment / sandbox implementation (reserved behind the `SpawnSandbox` seam).
- Autonomous Evolution Agent / self-modifying harness (L5; only the read-side failure-attribution substrate is in scope).
- Cross-goal / global memory (experiential memory stays within the per-goal template mechanism).
- Full event-sourcing of all Orca state (only the control-plane transition log is replayable).
- Pessimistic locking / single-writer concurrency (optimistic detect-and-escalate chosen).

## 7. Resolved decisions

- **Mode default:** new goals default to **Human Review**.
- **Sensor declaration:** **auto-detect from `package.json` scripts** in P1 (`typecheck`/`lint`/`test`/`build` → sensor kinds); a missing script is skipped and recorded as an `oracle_adequacy` gap, not a failure. An optional **explicit per-workspace override** field is available for non-standard/non-JS repos. The detector is a **pluggable resolver** so other ecosystems (Makefile, `cargo`, `pytest`, …) are additive (P2+).
- **`policy_delta` auto-relax:** the safety floor (critical/irreversible) is **never** auto-relaxable. For non-floor actions, the system *proposes* relaxing a gate only after **3 consecutive approvals of the same action class with zero rejections**, and the relaxation **requires explicit human confirmation** (never silent). A single rejection resets the counter and may tighten. Relaxations are **per-goal**, recorded as a `GoalDecision` (auditable, reversible). Threshold of 3 mirrors the existing revise/retry caps.
- **Price map:** the token→USD model price map lives as a **static table in code** (P1), updated by edit; revisit a config source only if it churns.

### Still open
- None blocking Phase 1–2. Per-ecosystem sensor resolvers and any config source for the price map are deferred, additive concerns.

---

## Appendix A — ORCA.md staleness corrections (deliverable)

The audit found ORCA.md materially stale; correcting it is part of this work:

| ORCA.md claims | Reality (code) |
|---|---|
| Five autonomy levels are "the product's spine" | `autonomyLevel` is a dormant integer, always `1`, never gates. Governance is `SupervisionMode` + `worker_permission_mode`. |
| Default template is `orca/engineering`, 8 steps `intake→…→done` | Real built-in is `orca/adaptive-delivery`, a 12-node graph (`templates/catalog.ts:701`). |
| Orchestrator context envelope ~64 KiB | `CONTEXT_PACKAGE_MAX_RENDERED_BYTES = 32 * 1024` (`index.ts:1619`); overflow is a hard failure, not truncation. |
| Memory lifecycle `observed→extracted→promoted→canonical` | Actual: `candidate→promoted→archived` (`memory/usecases.ts:185`). No "canonical" tier. |
| "Reconstructing a Goal's history means replaying its events" | Events are an append-only audit/notification stream; state is read from mutable projections. No replay exists. |
| "Exactly two agent adapters: claude-code and codex" | A third adapter, `antigravity`, exists (and currently spawns ungated). |
| Memory extraction implied LLM-driven | Wired extractor is deterministic/regex (`deterministic-extractor.ts`); an LLM seam exists but is unused. |
