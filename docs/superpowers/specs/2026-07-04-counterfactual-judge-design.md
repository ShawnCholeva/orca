# Counterfactual LLM Judge — Design (Sub-project of Phase 5 / FUTURE_WORK 5.2)

**Date:** 2026-07-04
**Status:** Designing (user-approved section-by-section 2026-07-04), pending implementation plan
**Phase item:** FUTURE_WORK 5.2 — closes the remaining half of the deferred pre-promotion evaluation (§9 of the learning-loop design).
**Builds on:** `2026-06-30-learning-loop-design.md` (5.2 propose/promote half — the pipeline this evaluate-stage slots into) and `2026-07-03-refute-completion-design.md` (5.4 — the independent-adversarial-shadow pattern, `RefuteFacet` ground truth, and `ShadowAsk` seam this reuses).
**Unblocked by:** 5.4 landed (2026-07-04). Its `RefuteFacet` is the independently-verified per-output ground truth this judge buckets on; its `refuteStepCompletion` is the LLM-judging-LLM-done-safely pattern this mirrors. That sequencing is exactly why this was deferred until after 5.4.

---

## 1. Context & the gap

5.2's learning loop proposes edits to a template's step `instructions` and promotes them behind a human confirm, using **forward version-comparison + rollback** (canary) as the *after-the-fact* falsifier (`learning/canary.ts`). The paper's Evolution-Agent loop (Fig. 9, p.31; §3.5.2, p.33) puts a distinct **evaluate** stage **before** promote — "evaluates the revised harness on held-out tasks or replayed traces … promotes only changes that improve reliability … **without regressing previously solved cases**." 5.2 §9 named this the **counterfactual LLM judge** and deferred it until 5.4 built the adversarial-refute plumbing and hardened self-report.

This sub-project fills that stage: a **cheap, pre-promotion, control-plane** signal that reasons over the step's **own persisted past outputs** and judges whether the proposed instruction edit would (a) keep previously-solved cases solved and (b) plausibly improve the targeted failure mode — **before** the human promotes it, complementing (not replacing) the after-the-fact canary. It is "imagined execution" (paper p.33 replay; the QualityFlow / p.37 independent-verification lineage) done as an **advisor that informs the human's governed promotion — never a gate that overrides it**.

### Paper alignment (`agent-harness.pdf`), audited per binding constraint

1. **Evaluate is its own stage between propose and promote (Fig. 9 / §3.5.2).** "Proposed changes must be executed, verified, and made auditable before adoption." → the judge is a discrete `evaluate` step (its own route), downstream of propose, upstream of the governed apply — **not** folded into either.
2. **The promotion criterion is spelled out (§3.5.2):** "improve reliability … without regressing previously solved cases." → the two-bucket corpus: a **regression check** over previously-solved outputs and an **improvement check** over the targeted-failure outputs.
3. **Independent verification / anti-circularity (p.37; the AgentCoder Test-Designer / mode-collapse principle).** The judge runs in a **context-isolated** shadow session, adversarially framed to find regressions — never the approving orchestrator's session.
4. **Calibrated evidence, not a binary (p.31/p.65).** Tri-state calibrated verdict (`pass`/`regression_risk`/`uncertain`) plus engine-added `unavailable`/`insufficient_evidence`; the human stays authoritative.
5. **Deep telemetry → comparative diagnosis (p.33).** The judgment is grounded in concrete past outputs bucketed by their persisted `RefuteFacet`/`EvidenceFacet` verdicts, and is itself persisted as an auditable record on the proposal ledger.
6. **Governed Harness Mutation (§3.5.3).** The judge *precedes and informs* the HITL-gated, privileged apply; it never activates a change itself.
7. **Deterministic core, selective AI (constraint #6).** The engine builds the corpus, buckets it, calls the shadow, wraps + persists the verdict, and renders it; the LLM only fills `{verdict, regressionRisk, addressesFailureMode, regressionCases, reason, inputsConsidered}`. The human decides whether to apply.

### FUTURE_ARCHITECTURE alignment

- **Control-plane pure.** Reads control-plane tables (`workflow_artifacts`, `harness_transitions`, `template_instruction_proposals`, `goals`) and calls the **`ShadowAsk` seam** — explicitly deemed control-plane-pure for exactly this reason (FUTURE_ARCHITECTURE line 83: the refute "rides the existing `ShadowAsk` seam, no execution-plane access … exactly the adversarial-verification signal 5.2's deferred counterfactual judge needed"). Writes one control-plane column. **No execution-plane code** — this is *imagined* execution over persisted outputs, not re-running steps (real replay-re-run stays deferred; §9).
- **Per-template, owner-walled by construction.** Same owner-wall as the rest of 5.2; owner-scoping lands additively later on the same fetches.
- **Additive public spine.** One new `/v1/learning/proposals/:id/judge` route + one additive contract module + one additive nullable column. No existing response reshaped.

### Non-goals

- **Real replay / re-run** of steps against past goals (the paper-ideal isolated-environment stage 4) — needs the execution-plane seam; stays deferred as its own future sub-project (5.2 §9).
- **Gating the apply route.** The judge is advisory-only; apply is untouched. (Task invariant: informs, never overrides.)
- **Auto-running the judge at analyze/propose time** — evaluate is a distinct, human-triggered stage (paper Fig. 9). Cheap by construction: only judged when the human is seriously weighing a promotion.
- **N-vote / panel judge** — single judgment (p.47's caution against over-investing in LLM-on-LLM voting; mirrors 5.4's single-refuter). Tier-scaled voting is a documented future option (§10).
- **A distinct/cheaper judge model** — reuse the goal's orchestrator adapter via the shadow seam; independence is task-framing + session-isolation, not model diversity (mirrors 5.4).
- **Cross-goal / global corpus** — per-template only.

---

## 2. Where it fires — the `evaluate` stage (Option A)

A new discrete stage between propose and promote, human-triggered on a specific pending proposal:

```
analyze ─▶ [pending proposal card]
                   │  human clicks "Evaluate this edit"
                   ▼
   POST /v1/learning/proposals/:id/judge      ← isolated ${templateId}::judge shadow
                   │  judgment persisted on the proposal + shown on the card
                   ▼
   human reads verdict ─▶ Apply / Edit&Apply / Dismiss
        (apply route UNCHANGED — never reads the judgment, never gated)
```

- Runs **only** on a `pending` proposal (409 otherwise — a decided proposal has no promotion left to inform).
- Re-judgeable: a second call re-runs and overwrites the persisted judgment (the human may re-evaluate after editing the corpus window or the instructions). Idempotent-by-overwrite; no accumulation.
- **The apply route (`apply.ts` / `POST .../apply`) is not modified.** The verdict is a surfaced signal the human weighs; the deterministic apply guards (staleness, pending, baseline) are unchanged.

---

## 3. The corpus (observe → bucket — deterministic, the engine)

`buildJudgeCorpus(db, proposal, period)` in a new `learning/corpus.ts`. Sources the step's real past outputs and buckets them by **independently-verified ground truth**.

### 3.1 Source — full historical join (not the diagnose sample)

The full output payload is persisted as `workflow_artifacts` rows (`type='step_output'`, JSON in `body`) — `service.ts:408-434` (write), `queries.ts:67-87` `readStepOutputAsRecord` (read pattern), table `migrations/0010_workflows.sql`. Join per `(templateId, stepTemplateId)` via the proven template joins in `metrics/fetch.ts:45-89` (`listStepRunsByTemplate` gives the `(workflowRunId, stepRunId, stepTemplateId, status)` set; `listTransitionsByTemplate` surfaces the `step_complete` facet rows):

```sql
SELECT wa.body, wsr.id AS step_run_id, wr.template_version, wa.created_at
FROM workflow_artifacts wa
JOIN workflow_step_runs wsr ON wsr.id = wa.step_run_id
JOIN workflow_runs wr       ON wr.id  = wsr.workflow_run_id
WHERE wr.template_id = ? AND wsr.step_template_id = ?
  AND wa.type = 'step_output'
  AND wa.created_at >= ? AND wa.created_at < ?
ORDER BY wa.created_at ASC;
```

Each output's `step_complete` transition (same `workflow_step_run_id`) carries `evidence_json`/`refute_json`/`failure_code` for bucketing.

### 3.2 Bucketing — `RefuteFacet`-primary, `EvidenceFacet`-fallback

- **Solved bucket (regression check):** outputs whose `step_complete` transition has `RefuteFacet.verdict === "upheld"`, OR (no refute ran) `EvidenceFacet.verdict === "passed"`, AND the step run reached a terminal success status. These are the previously-solved cases the edit must not break.
- **Failure bucket (improvement check):** resolve the proposal's **own** `evidence.sampleTransitionIds` and `evidence.revisionSignalIds` (already the diagnosed failure set — no re-diagnosis) to their step outputs. For a revision-signal case, prefer the **superseded (pre-revision) attempt** — the earlier `workflow_artifacts` row for that `step_run_id` — since that is the output the edit aims to fix. These are the targeted-failure cases.
- **Bounds & compaction:** most-recent **K=5** per bucket; each output truncated to a per-item budget; failure ⊄ solved (exclude any overlap from the solved bucket). The assembled request is `superRefine` size-bounded to `ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES`, exactly like `RefuteCompletionRequest`.
- **Honest degradation (paper p.62 oracle-adequacy):** record `solvedSampleSize`/`failureSampleSize`. If **either** bucket falls below its minimum the engine reports `verdict: "insufficient_evidence"` and does **not** call the shadow, rather than fabricating confidence — mirroring `diagnose.ts`'s sample-gate discipline. The solved bucket is empty for a young or always-failing step; the failure bucket can be thin for R1/R4 diagnoses (which don't always yield `sampleTransitionIds`). `SOLVED_MIN`/`FAILURE_MIN` are fixed constants set in the plan (suggest ≥1 each for a meaningful judgment).

---

## 4. The judge pass (independent, adversarial) — `learning/judge.ts`

Mirrors `refute-completion.ts`: compose an adversarial, corpus-scoped prompt → isolated shadow ask → `JSON.parse` → `JudgeInstructionEditProposal.safeParse` → retry-once → `null` (+ one `[judge]` log line naming the failure reason).

```ts
export function composeJudgePrompt(request: JudgeInstructionEditRequest): { systemPrompt: string; userPrompt: string };

export async function judgeInstructionEdit(
  deps: ShadowAsk,
  input: { judgeSessionKey: string; adapterId: ShadowAdapterId; request: JudgeInstructionEditRequest; timeoutMs: number },
): Promise<JudgeInstructionEditProposal | null>;   // null = ask threw / non-JSON / invalid after retry-once
```

### 4.1 Independence (p.37) — spawn + teardown per judgment

- **Isolated session key** `judgeSessionKey = \`${templateId}::judge\`` — a dedicated shadow session carrying **none** of any goal-orchestrator's context.
- **Spawn-on-demand + teardown-after-call.** Unlike refute's per-goal reuse, each judgment gets a **fresh isolated turn** (spawn → ask → terminate). This is refute §9's "maximal independence" option — justified here because judging is manual and infrequent (latency is fine), and it sidesteps any template-session-lifecycle question (there is no goal-end to hang teardown on).
- **Adversarial framing.** The prompt tells it to actively find a concrete way a previously-solved case would now regress under the proposed instructions; default to `uncertain` over a guessed `regression_risk`.

### 4.2 Prompt (corpus-scoped)

Given `currentInstructions`, `proposedInstructions`, the compacted **solved** cases (labeled "previously PASSED — must not regress"), the compacted **failure** cases (labeled "targeted failure mode — should improve"), and the `targetedFailureMode`:
- "For each previously-passing case, would the PROPOSED instructions still produce a passing output? Name any that would now regress (`regressionCases`)."
- "For the targeted-failure cases, would the PROPOSED instructions plausibly fix the failure?"
- "Return `pass` only if you find no concrete regression AND the edit addresses the failure mode; `regression_risk` if a previously-solved case would concretely break; `uncertain` if plausible but you genuinely cannot tell — do NOT guess. List in `inputsConsidered` exactly which cases you used."

### 4.3 Adapter & shadow wiring

- The learning route resolves the adapter from the anchor goal's orchestrator provider — reuse `orchestratorModelForGoal`/`anchorForStep` (`usecases.ts:35-45,18-23`) then `adapterIdForProvider(providerId)` (`orchestrator-chat/usecases.ts:186-188`). No real goal is needed for the *session* (the key is synthetic per-template); the goal only supplies the provider→adapter mapping.
- **New wiring seam:** `server.ts` injects the existing `shadowAsk` closure (`server.ts:2156-2159`) into `registerLearningRoutes` deps (the manager already exists; learning routes just don't receive it yet). The judge's spawn+teardown uses the same `ShadowSessionManager`.

---

## 5. Contracts (`@orca/contracts` `learning/` module — additive)

**What the shadow fills (validated):**
```ts
JudgeVerdict = "pass" | "regression_risk" | "uncertain"

JudgeInstructionEditProposal {
  verdict: JudgeVerdict
  regressionRisk: "none" | "possible" | "likely"          // over the solved bucket
  addressesFailureMode: "yes" | "partial" | "no" | "unclear" // over the failure bucket
  regressionCases: string[]        // enumerated previously-solved cases that would break; [] otherwise
  reason: string                   // <=1024
  inputsConsidered: string[]
}

JudgeInstructionEditRequest {      // the engine assembles this (LLM never sees raw logs)
  step: { name, currentInstructions, proposedInstructions }
  targetedFailureMode: TargetedFailureMode
  solvedCases: { stepRunId: string; output: string }[]     // compacted, K<=5
  failureCases: { stepRunId: string; output: string }[]    // compacted, K<=5
}  // superRefine size-bound to ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES
```

**The persisted judgment (engine-wrapped; server enrichment on the proposal):**
```ts
JudgeOutcome = JudgeVerdict | "unavailable" | "insufficient_evidence"

CounterfactualJudgment {
  verdict: JudgeOutcome
  regressionRisk: "none" | "possible" | "likely" | null
  addressesFailureMode: "yes" | "partial" | "no" | "unclear" | null
  regressionCases: string[]
  reason: string | null
  solvedSampleSize: number
  failureSampleSize: number
  judgedAt: string
  judgedAgainstVersion: number     // templateVersionAtProposal at judge time (staleness honesty)
}
```
`TemplateInstructionProposal` gains an optional `judgment?: CounterfactualJudgment | null` field (additive/optional on the public spine).

---

## 6. Persistence (one additive migration)

Next sequential migration (confirm the number against `apps/daemon/migrations/` at implementation time — 5.4 landed `0052`):
```sql
-- The pre-promotion counterfactual judgment, persisted on the proposal ledger.
ALTER TABLE template_instruction_proposals ADD COLUMN judge_json TEXT;
```
Persisted when the judge runs (not derived-on-read like `regressionDetected` — it costs a real LLM call). `store.ts` gains a `setProposalJudgment(db, proposalId, judgment)` writer and hydrates `judgment` from `judge_json` in the existing proposal readers.

---

## 7. Routes

| Route | Purpose | Errors |
|---|---|---|
| `POST /v1/learning/proposals/:id/judge?period=` | build corpus → isolated judge → persist + return `{ proposal }` (judgment attached) | 404 unknown proposal, 409 not pending, 400 bad period |

- Registered in `registerLearningRoutes` (`learning/routes.ts`) beside the existing proposal routes; deps gain `shadowAsk`.
- `learning/usecases.ts` gains `judgeProposal(deps, db, proposalId, period, nowIso?)`: load proposal → 409 if not pending → resolve adapter → `buildJudgeCorpus` → (either bucket below its MIN short-circuits to `insufficient_evidence`, no shadow call) → `judgeInstructionEdit` → wrap into `CounterfactualJudgment` (`unavailable` on null) → `setProposalJudgment` → return the hydrated proposal.

---

## 8. Desktop wiring

`SelfImprovement.tsx` proposal card gains an **"Evaluate this edit"** action and a judgment display; new `api.ts` client fn `judgeProposal`. Thin-client (F4): verdict/reason/regressionCases/sample-sizes all arrive computed.

**Card judgment states:**
1. **Not yet judged** — "Evaluate this edit" button (pre-promotion, opt-in).
2. **Evaluating** — pending spinner on the card.
3. **Judged** — verdict chip (`pass` ✓ / `regression_risk` ⚠ / `uncertain` ? / `insufficient_evidence` — / `unavailable` —), `reason`, the `regressionCases` list, and `"judged N solved · M failure cases"` for evidence honesty. The Apply / Edit&Apply / Dismiss buttons are **unchanged and unblocked** — the verdict sits beside them as advice.

---

## 9. The documented approximation (honesty)

The paper's ideal stage-4 evaluates on **replayed traces in an isolated environment** with deterministic sensors/regression tests (§3.5.2/§3.5.3). This judge substitutes **imagined execution over persisted past outputs** — it does not re-run the step, so it cannot observe true new behavior under the edit; it reasons about *likely* behavior from the recorded outputs. That substitution is deliberate and bounded:
- **Real replay-re-run stays deferred** (5.2 §9) — it needs the execution-plane split; forcing re-execution here would violate the FUTURE_ARCH control/execution boundary.
- The judge is therefore an **advisory pre-promotion signal**, and the **after-the-fact canary** (`canary.ts` forward version-comparison + rollback) remains the *executed* falsifier once the edit is live. The two compose: imagined-execution before promote, real version-comparison after.
This omission is documented, not hidden, per the binding design constraints.

---

## 10. Documented gaps / future options

- **Single judgment, same adapter.** Independence is task-framing + session-isolation, not model diversity. Future: tier-scaled N-vote for high-impact templates; a distinct/cheaper judge model.
- **Imagined, not executed.** Superseded by the deferred replay-re-run sub-project when the execution plane lands.
- **Corpus is a K=5 recent sample per bucket**, not exhaustive — logged sample sizes make the bound honest (no silent truncation).

---

## 11. Testing (TDD — tests before implementation)

- **`corpus.ts`:** the template join returns the step's `step_output` bodies; solved bucket keyed `RefuteFacet.upheld` primary / `EvidenceFacet.passed` fallback; failure bucket resolves the proposal's `sampleTransitionIds`/`revisionSignalIds` (superseded attempt preferred for revision cases); K-cap per bucket; failure ⊄ solved; empty solved bucket flagged; size-bound compaction.
- **`judge.ts`:** parses each verdict; `uncertain` respected (not coerced); preserves `regressionCases` on `regression_risk`; ask-throws/non-JSON/invalid → `null` + one `[judge]` log (mocked); retry-once then succeed; prompt embeds current+proposed instructions and both labeled buckets; asks the `${templateId}::judge` key (never a bare goalId); spawn+teardown per call (asserted via the fake session manager).
- **`usecases.judgeProposal`:** happy path persists a `CounterfactualJudgment` and returns the hydrated proposal; 409 on a non-pending proposal (no shadow call); empty solved bucket short-circuits to `insufficient_evidence` (no shadow call); null shadow → `unavailable`; **apply route unaffected** (a judged proposal applies exactly as an unjudged one — assert apply reads nothing from `judge_json`).
- **contracts:** zod round-trip for `JudgeInstructionEditProposal`, `JudgeInstructionEditRequest`, `CounterfactualJudgment`; the optional `judgment` field on `TemplateInstructionProposal`.
- **routes:** 200 shape (judgment attached); 404 unknown proposal; 409 not pending; 400 bad period.
- **desktop:** card renders each verdict chip + reason + regressionCases + sample sizes; Apply/Dismiss present and enabled regardless of verdict (informs, never overrides).

---

## 12. Files

- **New:** `apps/daemon/src/learning/corpus.ts` (+ test) — the `workflow_artifacts` join + facet bucketing + compaction.
- **New:** `apps/daemon/src/learning/judge.ts` (+ test) — `composeJudgePrompt`, `judgeInstructionEdit`, tri-state parse, retry-once, `[judge]` log (mirrors `refute-completion.ts`).
- **Edit:** `apps/daemon/src/learning/usecases.ts` — `judgeProposal`; `apps/daemon/src/learning/routes.ts` — the `judge` route + `shadowAsk` dep; `apps/daemon/src/learning/store.ts` — `setProposalJudgment` + hydrate `judgment`.
- **Edit:** `apps/daemon/src/server.ts` — inject the existing `shadowAsk` closure into `registerLearningRoutes` deps.
- **Edit:** `@orca/contracts` `learning/` — `JudgeVerdict`, `JudgeInstructionEditProposal`, `JudgeInstructionEditRequest`, `JudgeOutcome`, `CounterfactualJudgment`, optional `judgment` on `TemplateInstructionProposal`.
- **New migration:** `template_instruction_proposals.judge_json` column.
- **Edit (desktop):** `SelfImprovement.tsx` + `api.ts` — "Evaluate this edit" action + judgment display.
- **Reuse:** `ShadowAsk` (`recover-step-scoring.ts:9-19`), the `shadowAsk` closure + `ShadowSessionManager` (`server.ts:2156-2159`), `adapterIdForProvider` (`orchestrator-chat/usecases.ts:186-188`), `orchestratorModelForGoal`/`anchorForStep` (`usecases.ts`), `readStepOutputAsRecord` pattern (`queries.ts:67-87`), `listStepRunsByTemplate`/`listTransitionsByTemplate` (`metrics/fetch.ts:45-89`), `EvidenceFacet`/`RefuteFacet` (`contracts/harness`), `SHADOW_LLM_TIMEOUT_MS`, `ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES`.
- **Docs:** ORCA.md (the evaluate-stage / counterfactual judge, imagined-execution approximation, the `${templateId}::judge` isolation); FUTURE_WORK.md 5.2 (counterfactual judge **landed**; replay-re-run remains the sole deferred path); FUTURE_ARCHITECTURE.md (learning loop's evaluate stage now realized, control-plane-pure).

---

## 13. Exit criteria

1. On a **pending** proposal, "Evaluate this edit" runs a deterministic corpus build (real past `step_output`s, bucketed by persisted `RefuteFacet`/`EvidenceFacet` verdict) + **one** isolated, adversarial shadow judgment, and surfaces a calibrated `CounterfactualJudgment` on the card **before** the human promotes.
2. The judgment reports regression risk over previously-solved cases and whether the edit addresses the targeted failure mode, grounded in concrete `regressionCases`, with honest `solvedSampleSize`/`failureSampleSize` (and `insufficient_evidence` when the solved bucket is empty; `unavailable` when the shadow call fails).
3. The judge runs in a **context-isolated** `${templateId}::judge` session (spawn + teardown per call), never the approving orchestrator's session.
4. The judgment is an **auditable row** (persisted `judge_json` on the proposal ledger) and rendered on the card.
5. **The apply route is unchanged** — the verdict informs, never gates: Apply / Edit&Apply / Dismiss stay enabled for every verdict; the deterministic apply guards are untouched.
6. The judge touches **no execution-plane code** (imagined execution over persisted outputs via the `ShadowAsk` seam); one additive contract module, one additive nullable column, one additive route.
7. The imagined-vs-real-replay approximation and the still-deferred replay-re-run path are **documented** (§9), not hidden.
