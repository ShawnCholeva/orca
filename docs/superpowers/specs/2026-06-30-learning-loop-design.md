# Learning Loop — Design (Sub-project B of Phase 5)

**Date:** 2026-06-30
**Status:** Designing (user-approved section-by-section 2026-06-30), pending implementation plan
**Builds on:** `2026-06-30-metrics-read-surface-design.md` (sub-project A — the read surface / "Collect" stage). A is the evidence substrate; B is the Evolution Agent downstream.
**Phase item:** FUTURE_WORK 5.2 — "Close the learning loop from captured evidence."

---

## 1. Context & scope

Orca *captures* the evidence to learn from and drops it: `step_revision_signals` is populated (`workflows/revision-signals/store.ts`, written at `service.ts:986-1014`) but only read back per-step-run; `scoreStepResult` (`workflows/orchestrator/step-result-scoring.ts:42`) records per-step quality scores that nothing mines. Sub-project A made the **read surface** real (per-template, version-aware metrics) but deliberately left the **learning half** — proposals, the learning log, auto-apply — as a deferred rail labelled *"Learning loop not yet enabled."*

This sub-project (**B**) fills that rail. It is a **reflective optimizer** — the paper's **Evolution Agent** (§3.5.2) — that mines a template's own accumulated revision signals + step scores + A's metrics and **proposes (never silently applies)** edits to *that template's* step `instructions`, gated by human confirmation. It is the direct analog of the paper's **GEPA** row (Table 8, p.34): *"Reflective prompt evolution — Scores, feedback, critiques → Prompts and instructions."*

### Decomposition position

| # | Sub-project | Phase | Status |
|---|---|---|---|
| A | Scoring read surface — real Metrics page | Inspectable axis | **done, merged** |
| **B** | **Learning loop (this spec)** | 5.2 | **designing** |
| C | Scoring integrity (risk-gated adversarial refute before approve) | 5.4 | deferred |
| D | Autonomy crossing (LLM gate-evaluator) | 5.3 | deferred |
| E | Composition (`workflow`/delegate seam) | 5.1 | deferred |

### Non-goals (B)

- **Pre-promotion isolated evaluation** (re-running or counterfactually replaying the edit before it is applied). B uses **forward version-comparison + rollback** (canary) as the falsifier instead. See §3 and §9 — this is the deliberate, documented gap vs the paper's ideal stage 4, with the two deferral paths named.
- **Cross-goal / global learning** — per-template only (FUTURE_WORK 5.2 non-negotiable; FUTURE_ARCH owner-wall).
- **Scheduled / autonomous analysis** — analysis is manual and opt-in; no background mutation.
- **Editing anything other than step `instructions`** — not `outputSchema`, `agentPreference`, `completionPolicy`, or guardrails. (FUTURE_WORK 5.2 scopes the loop to step instructions.)
- **A second-model refute of the proposal** — that is sub-project C's deliverable; B's proposals will inherit C's refute when it lands.
- **Catalog-upgrade ⟷ learned-edit conflict resolution** — flagged as a known future interaction (§8); restore-to-default is the manual mitigation.

---

## 2. Decisions (with rationale)

| Decision | Choice | Rationale |
|---|---|---|
| Editable scope | **In-place privileged learning on locked built-ins + restore-to-default** (not fork) | User decision (2026-06-30). The lock stays on for *manual* edits; the learning loop is a distinct privileged, governed mutator (§3.5.3). Restore-to-default is the immutability escape hatch. |
| Evaluation / falsifier | **Forward version-comparison + deterministic regression-alarm + rollback** (Option A) | Instructions drive a non-deterministic LLM agent — there is no cheap deterministic pre-promotion replay. Canary + rollback is a paper-named mechanism (§5.2.3). Keeps B control-plane-pure and the human authoritative. |
| Pipeline shape | **Deterministic diagnosis + single LLM proposal call** (Approach 1) | Honors deterministic-core (constraint #6): the engine diagnoses/routes/gates/persists; the LLM only *fills* the proposal text. Cheapest, most auditable, reuses A's substrate verbatim. |
| Trigger | **Manual, opt-in ("Analyze this template")** | Propose-and-confirm; no autonomous self-evolution (FUTURE_WORK 5.2, paper §3.5.3). |
| Persistence | **Two additive tables** (`template_instruction_proposals`, `learning_template_baselines`) | B is the "learning half" — it legitimately adds state (A added none). Proposals table doubles as the audit ledger. |
| Broker | **New `OrchestrationDecisionKind: "propose_instruction_revision"`, one_shot transport, anchored to a representative evidence transition** | Reuses the existing `broker.propose` plumbing (as `scoreStepResult` does). No reshape of the run-scoped `OrchestrationRequest`. B is human-gated downstream, so no escalation to the runtime `human_review` queue. |
| History | **Forward-only** — rollback and restore *bump* version with prior content, never delete a version | Matches Orca's append-only `harness_transitions` stance; auditable, never rewrites history. |
| Client | **Thin (F4)** — change-contract content, watched-dimension deltas, and `regressionDetected` arrive computed from the server | Future web/CLI clients reuse the endpoints with no duplicated logic. |

### Paper alignment (`agent-harness.pdf`) — audited per binding constraint

1. **AHE five-stage loop (Fig. 9, §3.5.2):** observe (A's metrics + signals) → diagnose (deterministic attribution to a step + failure mode, §3) → propose (one broker call, §4) → **evaluate** (forward version-comparison, §3 — *gap vs the paper's pre-promotion stage 4, documented §9*) → promote (human confirm → privileged apply, §3). 
2. **Change contract (§5.2.3):** every proposal carries which component (`step_instructions`), which failure mode (`targetedFailureMode`), predicted improvement, invariants preserved, the falsifier (`version_comparison`), and rollback (`revert_to_before`). Persisted as fields — a proposal *is* its contract (§2 contract→field map).
3. **Governed Harness Mutation (§3.5.3):** the privileged write is route-gated behind a confirmed proposal; risky mutation (touching a locked built-in) is exactly what requires the HITL confirm; auditable rationale on every transition (the proposals ledger).
4. **Evidence-carrying, comparative diagnosis (§3.5.1):** proposals are grounded in A's version-aware metrics + concrete `sampleTransitionIds` (drill-through) + the user's own revision feedback — replayable and comparable across versions, never anecdotal.
5. **No self-evolution without guards (§5.2.3):** propose-and-confirm (never silent), in-distribution bound (sample-threshold gate + per-template scope), safety invariants named in the contract and watched via `safetyCompliance`, regression guard via canary + rollback.
6. **Deterministic core, selective AI (constraint #6):** the engine diagnoses, routes, persists, gates, and applies; the LLM only fills `{proposedInstructions, predictedImprovement, invariantsPreserved, rationale}`. The human is authoritative on whether to apply.

### FUTURE_ARCHITECTURE alignment

- **Control-plane pure.** B reads the control-plane projection (A's metrics) + control-plane tables (revision signals, templates) and writes a control-plane table (proposals) + the template. It **never touches the execution plane** (sessions/pty/tmux/adapters) — that is precisely why Option A (not replay) was chosen. When the control/execution split becomes a network boundary, B rides along unchanged.
- **Per-template, owner-walled by construction.** A template has one owner; per-template learning is already inside the Layer-2 owner wall. Owner-scoping lands additively later (a predicate on the same fetches).
- **Additive public-spine API.** `/v1/learning/*` routes + `@orca/contracts learning/` schemas are additive; no existing response is reshaped.

---

## 3. The pipeline (observe → diagnose → propose → evaluate → promote)

### 3.1 Observe + diagnose (deterministic — the engine, not the LLM)

Runs on `POST /v1/learning/templates/:id/analyze?period=`. Reads A's `TemplateMetricsDetail` (same period the user is viewing) + the qualifying steps' `revision_signals`.

**Candidate gate (overfitting / in-distribution guard, constraint #5):** a step is eligible only if `confidence === "ok"` and `sampleSize >= SAMPLE_MIN` (A's threshold = 5). Never propose off noise.

**Trigger rules (deterministic, enumerable):**
- **R1 — Underperforming step:** A's `score` status is `degraded` or `watch`.
- **R2 — Dominant instruction-addressable failure cluster:** a `failureCluster` with `count >= K`, **filtered to failure codes an instruction edit can plausibly fix**:
  - *Instruction-addressable (eligible):* `invalid_output`, `output_unavailable`, `source_truncated`, `evidence_veto`, `guardrail_denied`.
  - *Infra / lifecycle (excluded):* `timeout`, `session_not_terminal`, `goal_archived`, `session_archived`, `daemon_restart`, `provider_error`, `internal_error`.
- **R3 — Revision-signal density:** the step accumulated `>= M` revision signals with non-null `feedbackText` (the user re-steered it). Inherently instruction-related → eligible regardless of failure code. Highest-signal input (the human's own corrections).
- **R4 — False confidence:** A's I4a insight present (high `verdictPassRate`, low `oracleSufficientRate`) → candidate for an edit demanding stronger self-verification.

`K` and `M` are fixed constants set in the plan (suggested `K = 3`, `M = 3`); document the values, log when a rule is suppressed by the sample gate.

**Cap:** the worst **top-3** eligible steps per analyze (ranked by A's `score` ascending). Logged — never a silent truncation.

**Diagnosis bundle (per qualifying step):**
```
{ stepTemplateId, currentInstructions,
  targetedFailureMode: { rule: "R1|R2|R3|R4", failureCode?, clusterCount?, signalCount? },
  evidence: { sampleTransitionIds[], revisionFeedbackTexts[],
              metricSnapshot: { score, verdictPassRate, oracleSufficientRate, versionDelta } } }
```
All fields are lifted from A's read-model + the revision-signal store — no new metric computation; every claim drills back to a concrete transition.

### 3.2 Propose (one LLM call per qualifying step — see §4)

The LLM fills only `{ proposedInstructions, predictedImprovement, invariantsPreserved, rationale }`. The engine assembles the full change-contract record (§2 contract).

**Dedupe:** if a step already has a `pending` proposal, analyze skips it and returns the existing one.

### 3.3 Evaluate — forward version-comparison (the falsifier; Option A)

There is **no synchronous pre-promotion evaluation**. The change contract's falsifier is A's `versionComparison` over the applied (new) version, computed on read:

- After apply, the proposal carries `appliedAsVersion`. The rail derives a **canary watch** from A's existing `versionComparison` for that version.
- **Regression alarm (deterministic, on-read):** once the new version has `sampleSize >= SAMPLE_MIN`, if `versionComparison.byDimension[d] < -REGRESSION_THRESHOLD` for any `d ∈ invariantsPreserved`, the proposal surfaces `regressionDetected: true`. Below sample-min the state is "applied — awaiting runs" (no premature alarm).
- No cron, no new persisted state — reuses A's always-rederivable projection (never drifts).

`REGRESSION_THRESHOLD` is a fixed constant set in the plan.

### 3.4 Promote — privileged apply + lifecycle (governance, §3.5.3)

All mutating actions are **governed**: route-gated behind a confirmed proposal or an explicit user action, recording `decidedBy`/`decidedAt`.

**Apply (`POST /v1/learning/proposals/:id/apply`)**, body optional `editedInstructions`:
1. Proposal must be `pending`.
2. **Staleness guard:** if the live template version ≠ `templateVersionAtProposal`, mark `superseded` and reject — the human re-analyzes against current state.
3. If target is a **built-in with no baseline row** → capture pristine `steps_json` into `learning_template_baselines` (first learned edit only).
4. **Privileged write** `applyLearnedInstructionEdit(db, proposal)`: writes the new `instructions` onto the step in `steps_json`, bumps `version`, updates `updated_at`, fires the existing `workflow.template.updated` event. **Bypasses the `is_locked`/`is_built_in` guard** — reachable *only* via this learning route behind a confirmed proposal. The generic `PATCH /v1/workflow-templates/:id` stays locked.
5. If `editedInstructions` present, it replaces the LLM text and `humanEdited = true` is recorded (honest provenance).
6. Record `status=applied`, `appliedAsVersion=newVersion`, `decidedAt`, `decidedBy`.
7. Mark any other `pending` proposals for the same `(templateId, stepTemplateId)` as `superseded` — one live edit per step.

**Dismiss (`POST .../dismiss`):** `status=dismissed`, `decidedAt/By`. No template change. Auditable rejection.

**Rollback (`POST .../rollback`):** for an `applied` proposal (typically when the alarm fires; available anytime). Privileged write restores `beforeInstructions`, **bumps version forward** (new version with old content — append-only, never a delete). `status=rolled_back`.

**Restore-to-default (`POST /v1/learning/templates/:id/restore-default`):** built-ins with a baseline only. Privileged write restores `baseline_steps_json`, bumps version, sets `learning_template_baselines.restored_at`, marks all `applied` proposals for the template `superseded`. The "wipe all learning" escape hatch.

**Derived marker:** "Customized by learning · Restore default" shows whenever a built-in's current steps differ from its captured baseline.

---

## 4. Broker integration & the proposal prompt

Reuses `broker.propose(request, { validateProposal })` exactly as `scoreStepResult` does.

- **`kind: "propose_instruction_revision"`** (new `OrchestrationDecisionKind` value).
- **Anchor:** the request's run-scoped `goalId/workflowRunId/stepRunId` are set from the **most recent qualifying evidence transition** (it carries valid ids and *is* the grounding). No reshape of the shared `OrchestrationRequest`.
- **`providerId/modelId`:** from the orchestrator model config (same source as `score_step_result`).
- **`payload`** (≤65536 bytes) — the **compacted** diagnosis bundle (context-compaction, never raw logs): `currentInstructions`, `targetedFailureMode` + counts, a few representative `revisionFeedbackTexts` (highest signal), and the `metricSnapshot`.
- **Prompt discipline:** produce a **minimal, targeted** edit that addresses the named failure mode while preserving the listed invariants — *"fix the diagnosed failure; do not rewrite what already works"* (bounded correction, FUTURE_WORK 5.3 discipline).
- **`validateProposal`:** parse `ProposeInstructionRevisionProposal`; **reject** (→ broker retries) if `proposedInstructions` is empty, exceeds 8192 bytes, is **identical to current** (no-op), or if `invariantsPreserved` contains a value outside the six `DimensionKey`s (so the canary lookup is always well-defined).
- **Transport:** **one_shot** only. A generation failure surfaces as *"couldn't draft a proposal for step X"* on that step — no escalation to the runtime `human_review` queue (B is human-gated downstream).
- **Cost:** ≤3 calls per analyze (top-3 cap).

---

## 5. Contracts (`@orca/contracts` new module `learning/`)

**What the LLM fills (broker-validated):**
```ts
// The six A/paper dimension keys — invariants must be drawn from these so the
// canary regression-alarm (§3.3) has a well-defined byDimension lookup.
DimensionKey = "trajectoryEfficiency" | "verificationStrength" | "recovery"
             | "stateConsistency" | "safetyCompliance" | "replayability"

ProposeInstructionRevisionProposal {
  proposedInstructions: string       // ≤8192 bytes (the field's own cap)
  predictedImprovement: string
  invariantsPreserved: DimensionKey[] // constrained enum — NOT free text
  rationale: string                   // ≤2000
}
```

**The persisted change-contract record:**
```ts
TemplateInstructionProposal {
  id: string
  templateId: string
  templateVersionAtProposal: number
  stepTemplateId: string
  component: "step_instructions"                       // §5.2.3 which component
  beforeInstructions: string                           // diff + rollback source
  afterInstructions: string                            // the proposed edit
  targetedFailureMode: { rule: "R1"|"R2"|"R3"|"R4",
                         failureCode: string | null,
                         clusterCount: number | null,
                         signalCount: number | null }   // §5.2.3 which failure mode
  predictedImprovement: string                         // §5.2.3 predicted improvement
  invariantsPreserved: DimensionKey[]                  // §5.2.3 invariants (constrained enum)
  falsifier: "version_comparison"                      // §5.2.3 falsifying evaluation
  rollbackPlan: "revert_to_before"                     // §5.2.3 rollback
  evidence: { sampleTransitionIds: string[],
              revisionSignalIds: string[],
              metricSnapshot: { score: number, verdictPassRate: number,
                                oracleSufficientRate: number, versionDelta: number | null } }
  rationale: string
  humanEdited: boolean
  status: "pending"|"applied"|"dismissed"|"rolled_back"|"superseded"
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
  appliedAsVersion: number | null
  // server-enriched on GET (not stored); F4:
  regressionDetected?: boolean
  watchedDeltas?: Record<string, number | null>
}
```
New fields are additive/optional on the public spine. `OrchestrationDecisionKind` gains `"propose_instruction_revision"` (additive enum value).

---

## 6. Persistence (one additive migration)

```sql
-- The change-contract records; doubles as the audit ledger.
CREATE TABLE template_instruction_proposals (
  id                          TEXT PRIMARY KEY,
  template_id                 TEXT NOT NULL,
  template_version_at_proposal INTEGER NOT NULL,
  step_template_id            TEXT NOT NULL,
  before_instructions         TEXT NOT NULL,
  after_instructions          TEXT NOT NULL,
  targeted_failure_mode_json  TEXT NOT NULL,
  predicted_improvement       TEXT NOT NULL,
  invariants_preserved_json   TEXT NOT NULL,
  evidence_json               TEXT NOT NULL,
  rationale                   TEXT NOT NULL,
  human_edited                INTEGER NOT NULL DEFAULT 0,
  status                      TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  decided_at                  TEXT,
  decided_by                  TEXT,
  applied_as_version          INTEGER
);
CREATE INDEX idx_proposals_template ON template_instruction_proposals (template_id, status);

-- Pristine baseline per built-in that has been learned on; powers restore-to-default.
CREATE TABLE learning_template_baselines (
  template_id        TEXT PRIMARY KEY,
  baseline_steps_json TEXT NOT NULL,
  captured_at        TEXT NOT NULL,
  restored_at        TEXT
);
```
`falsifier`, `rollbackPlan`, and `component` are constants in B and need not be columns (reconstructed on read); store them only if a later sub-project varies them.

---

## 7. Routes (register in `server.ts` beside the metrics routes)

| Route | Purpose | Errors |
|---|---|---|
| `POST /v1/learning/templates/:id/analyze?period=` | diagnose + propose → `{ proposals }` | 404 unknown template, 400 bad period |
| `GET /v1/learning/templates/:id/proposals` | all proposals (pending cards + activity log), server-enriched with `regressionDetected`/`watchedDeltas` | 404 unknown template |
| `POST /v1/learning/proposals/:id/apply` | body optional `editedInstructions` → privileged apply | 404 unknown, 409 stale version, 409 not pending |
| `POST /v1/learning/proposals/:id/dismiss` | auditable rejection | 404, 409 not pending |
| `POST /v1/learning/proposals/:id/rollback` | revert an applied edit (forward version) | 404, 409 not applied |
| `POST /v1/learning/templates/:id/restore-default` | wipe all learning → baseline | 404, 409 no baseline |

**Daemon module `apps/daemon/src/learning/`:** `diagnose.ts` (deterministic), `propose.ts` (broker call + validation), `apply.ts` (privileged write, baseline, rollback, restore), `usecases.ts` (orchestration + on-read regression enrichment), `routes.ts`.

---

## 8. Desktop wiring

`SelfImprovement.tsx` replaces the deferred placeholder; new `api.ts` client fns (`analyzeTemplate`, `listProposals`, `applyProposal`, `dismissProposal`, `rollbackProposal`, `restoreDefault`). Thin-client (F4): every number/flag/delta arrives computed; text-diff display is presentation.

**Rail states:**
1. **Idle** — "N steps underperforming" header + **"Analyze this template"**. Empty-eligible → "Nothing to propose — steps are healthy or below sample threshold."
2. **Analyzing** — "Reviewing N runs across M versions…"
3. **Pending proposal cards** — step + targeted failure mode, evidence drill-through (reuse A's transition→provenance/replay links), **instruction diff** (before→after), predicted improvement, invariants, rationale → **Apply · Edit & Apply · Dismiss**.
4. **Applied — watching** — "Applied as v{N} · watching" + watched-dimension deltas ("awaiting runs" until sample threshold).
5. **Regression detected** — alarm state + **Rollback**.
6. **Activity log** — chronological proposals + decisions (who/when) — the auditable ledger.
7. **Restore default** — on a learned built-in, "Customized by learning · Restore default" + confirm dialog.

---

## 9. The documented gap vs the paper (binding-constraint #1 honesty)

The paper's Evolution-Agent loop puts **evaluate before promote** — "on held-out tasks or replayed traces using deterministic sensors and regression tests" (§3.5.2), "compared against fixed regression suites" before activation (§3.5.3). **B has no pre-promotion isolated evaluation.** It substitutes **canary + rollback** — itself a paper-named mechanism (§5.2.3: "canary deployment, rollback semantics") — because a step's `instructions` drive a non-deterministic LLM agent, so there is no cheap deterministic replay, and synchronous re-running would force this control-plane feature into the execution plane (a FUTURE_ARCH boundary violation).

Two deferral paths are named on the record:
- **Counterfactual LLM judge** (cheap pre-promotion signal: replay the step's *past outputs* and judge whether previously-solved cases still pass / targeted failures improve). Deferred to **after sub-project C**, because it is LLM-judging-LLM (the self-report risk A downranked) and C builds exactly that adversarial-refute plumbing and hardens self-report first.
- **Replay re-run** (re-run affected steps against past goals via the execution plane; gate on no-regression — the paper-ideal stage 4). Large enough to be its own sub-project; needs the execution-plane seam.

This omission is documented rather than hidden, per the binding design constraints.

---

## 10. Testing (TDD — tests before implementation)

- **`diagnose`:** each trigger rule (R1–R4) fires on its trigger and stays silent otherwise; the sample-threshold gate suppresses sub-threshold steps; the instruction-addressable filter excludes the infra failure codes; top-3 cap; bundle + evidence assembly from A's read-model + signals.
- **`propose` / `validateProposal`:** rejects empty / >8192-byte / identical-to-current proposals; accepts a valid one; broker request carries `kind` + compacted payload + the evidence anchor.
- **`apply`:** privileged write bypasses the lock; baseline captured on the first built-in edit (and not overwritten on the second); version bump; `editedInstructions` path sets `humanEdited`; **staleness guard** (version mismatch → `superseded`, no write); supersedes competing `pending` for the same step.
- **`rollback`:** restores `beforeInstructions`, bumps version forward, `status=rolled_back`.
- **`restore-default`:** restores baseline, bumps version, sets `restored_at`, supersedes applied; 409 when no baseline.
- **canary / regression:** `regressionDetected` true when a watched invariant dimension regresses past threshold *above* sample-min; false/absent below sample-min and when no invariant regresses.
- **contracts:** zod round-trip for both new schemas + the new `OrchestrationDecisionKind` value.
- **routes:** 200 shapes; 404 unknown template; 400 bad period; 409 stale/not-pending/not-applied/no-baseline; apply/dismiss/rollback/restore happy paths.
- **broker integration:** mock broker — assert request kind, payload compaction, validation wiring, one_shot transport.
- **desktop:** client fns hit the right URLs; rail renders every state + apply/edit/dismiss/rollback/restore wiring + diff + activity log + empty/analyzing.

---

## 11. Doc updates shipped with B

- **ORCA.md** — learning-loop / Evolution Agent entry: the per-template reflective optimizer, the Inspectable→Governed crossing, the privileged-write governance.
- **FUTURE_WORK.md 5.2** — mark the propose/promote half landed; record the **pre-promotion replay deferral** (counterfactual-judge-after-C, replay-re-run) explicitly.
- **FUTURE_ARCHITECTURE.md** — the learning loop is now partially realized and control-plane-pure; owner-scoping remains the additive tenancy step.

---

## 12. Exit criteria

1. From the Metrics tab, "Analyze this template" runs deterministic diagnosis + ≤3 LLM proposal calls and surfaces `pending` change-contract proposals grounded in A's evidence + revision signals.
2. Each proposal carries the full change contract (component, failure mode, predicted improvement, invariants, falsifier, rollback) and drills through to concrete transitions.
3. The human can Apply / Edit & Apply / Dismiss; apply performs a route-gated **privileged in-place write** even on locked built-ins, capturing a pristine baseline on first edit; the generic template PATCH stays locked.
4. Applied edits enter a **canary watch** (A's `versionComparison`); a deterministic **regression alarm** flags watched-invariant regressions above sample-min and offers **rollback** (forward version).
5. **Restore-to-default** wipes all learning on a built-in back to its captured baseline.
6. Every proposal + decision is an auditable row (what / evidence / who / when); the rail renders the activity log.
7. B touches **no execution-plane code**; all new state is two additive control-plane tables; the desktop performs **zero metric arithmetic**; `/v1/learning/*` contracts are additive.
8. The pre-promotion-evaluation gap vs the paper is **documented** (§9), not hidden.
