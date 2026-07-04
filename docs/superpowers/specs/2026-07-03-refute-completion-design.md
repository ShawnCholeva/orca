# Refute-Completion — Design (Sub-project C of Phase 5 / FUTURE_WORK 5.4)

**Date:** 2026-07-03
**Status:** Designing (user-approved direction 2026-07-03), pending implementation plan
**Phase item:** FUTURE_WORK 5.4 — "Verify both halves — independent/adversarial check on self-reported scoring."
**Unblocks:** FUTURE_WORK 5.2's deferred **counterfactual LLM judge** (which was deferred *until after C* precisely because C builds this refute plumbing and hardens self-report).
**Builds on:** 5.3's ShadowAsk-backed evaluator pattern (`gate-evaluation.ts`) — same shape, same invariants.

---

## 1. Context & the gap

Step completion is hybrid-gated: deterministic schema validation → deterministic sensor/evidence gate (for execution steps) → the orchestrator-LLM's `approve_step_complete`. But the **scoring block** on that approval (`outputCompleteness/outputCorrectness/instructionAdherence/downstreamReadiness/riskLevel`, `orchestrator-llm/prompts.ts:95`) is **self-reported by the same orchestrator-LLM that approves the step** (`step-result-builder.ts:54-59` documents this). For steps a deterministic oracle can't verify — a no-sensor analysis/reasoning step, or a code step whose sensors passed but didn't cover the requirement — a green deterministic skeleton wrapped around garbage LLM output is still a failure, and nothing catches it.

**This sub-project adds a risk/coverage-gated, independent adversarial *refute* pass** that runs *after* the deterministic gates pass and *before* the completion commits. It is the paper's PEV "Verify" refute lane (§3.4) done as an *advisor that informs the deterministic gate* — never a new node that advances the flow.

### Paper alignment (agent-harness.pdf), audited

- **p.47 — "integrate both: linguistic reasoning as the fast path, execution as the verification oracle only for the failure modes that require it."** The refute runs *after* the deterministic sensor gate (execution is the oracle for crashes/boundary/perf); the refute is the linguistic check for the **semantic correctness sensors structurally cannot verify**. Ordering is paper-optimal, not incidental.
- **p.37 — independent verification / anti-circularity (AgentCoder's independent Test Designer; the mode-collapse principle).** The refute must be **independent of the approving orchestrator** — a distinct, context-isolated shadow turn, adversarially framed. (§4.4)
- **p.62 — oracle adequacy is "a central bottleneck."** The gate fires when the deterministic oracle is absent or has coverage gaps — exactly where the self-report is the only signal. (§3)
- **p.31/p.65 — treat feedback as calibrated evidence, not a binary; HITL preserves accountability at a safety boundary.** The verdict is tri-state `{upheld|refuted|uncertain}`; `uncertain` (and refute-unavailable) escalate to a human, they do not auto-approve or burn a revise. (§3.3)
- **p.33 — deep telemetry → comparative diagnosis.** Every refute outcome is recorded as an inspectable facet on the `step_complete` transition, so refutes are auditable, measurable ("does the refute improve reliability?"), and consumable by 5.2's learning loop. (§5)
- **p.47 also cautions against over-investing in LLM-on-LLM voting** → a **single** refuter (not an N-vote panel); the deterministic sensor gate is the execution oracle. (§9 records N-vote as a future critical-tier option.)

### Non-goals (C)

- **N-vote / panel refute** — single refuter for v1 (p.47). Tier-scaled majority vote is a documented future option (§9).
- **A distinct/cheaper refute *model*** — reuse the existing ShadowAsk seam (goal's orchestrator adapter) with an adversarial prompt; independence comes from **task framing + session isolation**, not model diversity. Distinct-model config is a future option (§9).
- **5.2's counterfactual-instruction-edit judge** — C ships the reusable refute contract/module; 5.2 consumes it later.
- **Changing the deterministic gates** (sensors, 2.8 claim verification, state-conflict) — the refute composes with them, never duplicates them.

---

## 2. Where it fires (the seam)

All in `apps/daemon/src/workflows/orchestrator/service.ts`, `applyOrchestratorAction` → `case "approve_step_complete"` (`:1041-1363`). The existing deterministic pre-commit gates, in order: interview open-questions (`:1044`), 2.8 fabrication (`:1075`), state-conflict facet (`:1128`), **sensor/evidence gate** (`:1189-1284`, vetoes → `reviseStep`), then `finishedAt` (`:1286`), then the **human-review/handoff/conflict pause** branch (`:1288-1331`, early return), then **automated commit** (`completeStepWithLedger :1334` → `advanceToNextStep :1351`).

The refute slots **after the evidence gate passes** and is computed **once**, then consumed by both the pause branch (L4 advisory) and the automated path (L5 gate):

```
// after finishedAt (:1286), before the pause branch (:1288):
const refuteOutcome = await this.maybeRefute(db, now, ctx, block, action.scoring, evidence, sessionId, options);
//   returns { ran: false } | { ran: true, verdict: RefuteOutcome }
//   RefuteOutcome = RefuteVerdict ("upheld"|"refuted"|"uncertain", from the LLM) PLUS "unavailable"
//   (engine-added when refuteStepCompletion() returns null — ask threw / unparseable after retry-once)

const pausing = conflictPause || goalRequiresHumanReview(...) || ctx.stepTpl.completionPolicy === "handoff";

// L5 automated gate (only when NOT pausing):
if (!pausing && refuteOutcome.ran) {
  if (refuteOutcome.verdict === "refuted")
    return this.reviseStep(db, now, ctx, sessionId, formatRefuteFeedback(refuteOutcome), options);   // bounded issue list
  if (refuteOutcome.verdict === "uncertain" || refuteOutcome.verdict === "unavailable") {
    // high-risk / unverified step we could not independently clear -> escalate, do not auto-approve
    escalateToPause = true;
  }
  // "upheld" -> fall through to commit
}

if (pausing || escalateToPause) {
  // stash pending_completion_json WITH the refute verdict for the L4 advisory card, then pauseForConfirmation
  ...
  return { postedChatReply: false };
}
// automated commit (unchanged) ...
```

`evidence` is the sensor result already computed at the evidence gate (thread it down; do not re-run sensors). For non-execution steps `evidence` is null.

---

## 3. The gate — refute *unless already adequately verified*

`maybeRefute` runs the refute only when the step is **risky OR under-verified**, and skips it for the common well-verified case. Deterministic; independent of the self-reported `quality.riskLevel`.

```
shouldRefute(db, ctx, evidence) =
     stepToolRiskClass(db, ctx.stepRun.id) >= "high"          // consequential by action
  OR evidence == null                                          // no deterministic oracle ran (non-exec step, or sensors couldn't run)
  OR (evidence.oracleAdequacy.gaps.length > 0)                 // oracle ran but under-covered the requirement (p.62)
```

- **`stepToolRiskClass(db, stepRunId)`** — new helper: aggregate the step's `tool_gate` harness-transitions (`SELECT risk_json FROM harness_transitions WHERE workflow_step_run_id=? AND type='tool_gate'`), parse `risk_class`, return the max via a `RiskClass` ordinal (`{low:0,medium:1,high:2,critical:3}`, new small comparator in `harness-risk/`). No `tool_gate` rows → the step took no consequential actions → `low`.
- The excluded case (no refute): an execution step whose sensors passed **and** covered the requirement (`gaps` empty) **and** tool-risk `< high` — execution was an adequate oracle (p.47). This is the common code-step happy path, so the refute is **not universal**.
- **Cost note (honest):** vs. a tool-risk-only gate, this also fires on every no/weak-oracle step (analysis/reasoning steps). That is deliberate — those steps have *no other check* (p.31/p.62) — but it is one shadow call per such completion. Bounded per step (single call, retry-once); no fan-out.

---

## 4. The refute pass (independent, adversarial)

### 4.1 Module `refute-completion.ts` (sibling of `gate-evaluation.ts`)

```ts
export async function refuteStepCompletion(
  deps: ShadowAsk,
  input: { refuteSessionKey: string; adapterId: ShadowAdapterId; request: RefuteCompletionRequest; timeoutMs: number }
): Promise<RefuteCompletionProposal | null>   // null = ask threw / non-JSON / invalid after retry-once
```
Mirrors `evaluateGate`: compose prompt → `deps.ask(refuteSessionKey, {...})` → `JSON.parse` → `RefuteCompletionProposal.safeParse` → retry once → `null`. Captures the failure reason and logs one `[refute]` line before returning `null` (the observability pattern added to `evaluateGate`).

### 4.2 Independence (p.37)

- **Session isolation.** `deps.ask` is keyed by its first arg and the shadow session is *conversational* (accumulates context). Passing the real `goalId` would run the refute **inside the approving orchestrator's own session** — not independent. So the refute uses a **distinct, dedicated session key** `refuteSessionKey = \`${goalId}::refute\`` → a separate shadow session that carries **none** of the approver's context. Reused per goal (spawn-on-demand, cheap after first), and **torn down with the goal** (add `${goalId}::refute` to the shadow-session teardown at goal-end alongside the existing `terminate(goalId)` in `server.ts`).
- **Adversarial framing.** The prompt tells it to actively **find a concrete reason the output does NOT satisfy the step**, grounded in evidence — not to re-affirm.

### 4.3 Oracle-scoped prompt (p.47 integrate-both)

The prompt is scoped by what the deterministic oracle already covered, so the refute targets the **unverified** surface, not what execution already proved:
- execution step: "Deterministic sensors already verified: {sensorsRun/verdict}. They did NOT cover: {oracleAdequacy.gaps}. Find a concrete reason the output fails the step's instructions on the *unverified* scope (semantic correctness, instruction adherence, downstream readiness). Do not re-litigate what the sensors already verified."
- no-oracle step: "No deterministic verification ran for this step — you are the only check. Judge whether the output actually satisfies the instructions toward the goal."
- Calibration: "If you cannot find a concrete, evidence-grounded reason to refute, respond `upheld`. If the output is plausible but you genuinely cannot tell, respond `uncertain` — do not guess `refuted`." (tri-state, p.31 calibrated evidence.)

### 4.4 Contracts (`@orca/contracts`, new `refute` module or `workflows/`)

```ts
RefuteVerdict = "upheld" | "refuted" | "uncertain"

RefuteCompletionProposal {           // what the second model fills (validated)
  verdict: RefuteVerdict
  reason: string                     // <=1024
  issueRefs: string[]                // enumerated, addressable — reuses 5.3's "fix only these" discipline; [] when upheld
  inputsConsidered: string[]         // evidence it used (grounding, p.33)
}

RefuteCompletionRequest {            // the engine assembles this (LLM never sees raw logs)
  step: { name, instructions }       // ctx.stepTpl
  goal: { id, description }
  stepOutput: Record<string,unknown> // the orca:step-complete block
  selfReportedScoring: <the quality block from action.scoring> | null   // what to scrutinize
  oracle: { ran: boolean, verdict?: "passed"|"partial"|"failed", sensorsRun?: {kind,summary}[], gaps?: string[] }  // scope (p.47)
}   // superRefine size-bound to ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES, like GateEvaluationRequest
```
`issueRefs` are routed to the failing step via `reviseStep` feedback (bounded correction, 5.3 discipline; N=3 `REVISE_CAP` still applies).

---

## 5. Inspectable telemetry — the `RefuteFacet` (p.33)

Every refute that **runs** (any verdict, incl. `unavailable`) records a facet on the step's `step_complete` transition, mirroring how the evidence gate records `EvidenceFacet` + `failure_code`.

```ts
RefuteFacet {
  verdict: "upheld"|"refuted"|"uncertain"|"unavailable"      // the 4-state engine RefuteOutcome (§2); "unavailable" = refute call returned null
  triggered_by: ("high_risk"|"no_oracle"|"weak_oracle")[]   // why the gate fired
  risk_class: RiskClass
  reason: string | null
  issue_refs: string[]
}
```
- Registered via `defineFacet({ key:"refute", column:"refute_json", schema: RefuteFacet })` (`contracts/harness/index.ts`); one additive migration adds `harness_transitions.refute_json`.
- Threaded to the `step_complete` emit like `stateDeps`/`evidence` (a `refute` param on `emitStepComplete`). On a **refuted** veto in L5, the transition's `failure_code` is `"refute_veto"` (new `ProviderFailureCode`/telemetry failure-code value, sibling of `evidence_veto`), so a refuted completion is a first-class inspectable failure.
- **This facet is the evidence 5.2's counterfactual judge consumes** — refute outcomes become queryable, comparable harness telemetry (the AHE substrate, p.33/§3.5.1).

Emit discipline: exactly one `step_complete` transition per step (the existing rule). For execution steps the evidence gate already emits at `:1227` — thread the refute facet onto **that** emit rather than emitting a second time; for no-oracle steps the refute emits at the pause/commit site (where the state-pause path already emits at `:1305`). The plan pins the exact single-emit wiring.

---

## 6. L4 advisory (human_review / handoff / conflict pause)

When the step pauses for a human, the refute verdict rides the confirmation card so the human sees an independent second opinion (the paper's "advisor before the reviewer"), while the **human stays authoritative** (no auto-divert):
- `pending_completion_json` (`service.ts:1296`) gains a `refute: { verdict, reason, issueRefs } | null` field.
- The confirmation summary (`confirmation-summary.ts` / `scoring-summary.ts`) prepends an advisory lead when `verdict !== "upheld"` — e.g. *"⚠️ Independent review disputes this completion: {reason}"* / *"⚠️ Independent review is uncertain: {reason}"*.
- The human-confirmation **resume** path (`service.ts:~1746`) commits as today — the refute already informed the human; it does not re-gate on resume.
- **Desktop:** the completion/confirmation card renders the advisory (verdict chip + reason + issue list). Thin-client — the verdict arrives computed.

---

## 7. Files

- **New:** `apps/daemon/src/workflows/orchestrator/refute-completion.ts` (+ test) — `refuteStepCompletion`, prompt, tri-state parse, retry-once, `[refute]` log.
- **New:** `apps/daemon/src/harness-risk/rank.ts` (or extend `classify.ts`) — `RiskClass` ordinal + `riskClassAtLeast(a,b)`; **new** `stepToolRiskClass(db, stepRunId)` (in `harness-risk/` or a small orchestrator query helper) — aggregate `tool_gate` risk for a step.
- **Edit:** `service.ts` — `maybeRefute(...)` private method (gate + isolated refute call + facet emit), wired into the approve handler; L5 tri-state branch; L4 advisory stash; `formatRefuteFeedback`.
- **Edit:** `@orca/contracts` — `RefuteCompletionRequest`/`RefuteCompletionProposal`/`RefuteVerdict`, `RefuteFacet` + `defineFacet`, `refute` field on the pending-completion contract, `refute_veto` failure-code value.
- **New migration:** `harness_transitions.refute_json` column.
- **Edit:** `emit.ts` (`emitStepComplete` gains an optional `refute` facet param); `confirmation-summary.ts`/`scoring-summary.ts` (advisory lead); `server.ts` (refute-session teardown at goal-end).
- **Edit (desktop):** completion/confirmation card renders the refute advisory.
- **Reuse:** `ShadowAsk` (`recover-step-scoring.ts:9`), `reviseStep` + `REVISE_CAP`, `resolveShadowAdapterId`, `readGoal`, `emitStepComplete`, `runSensors`/`EvidenceFacet.oracleAdequacy`, `SHADOW_LLM_TIMEOUT_MS`, `pauseForConfirmation`, `pending_completion_json`.
- **Docs:** ORCA.md (the refute/Verify lane, risk+oracle gate, RefuteFacet); FUTURE_WORK.md (5.4 landed; **5.2's counterfactual judge now unblocked** — points at the RefuteFacet + refute module); FUTURE_ARCHITECTURE.md (Inspectable axis gains the refute telemetry channel).

---

## 8. Testing (TDD — tests before implementation)

**`refute-completion.ts` (unit):** parses each verdict; preserves `issueRefs` on `refuted`; `uncertain` respected (not coerced to refuted); ask-throws/non-JSON/invalid → `null` (+ one `[refute]` log, mocked); retry-once then succeed; prompt embeds the oracle scope + step instructions.

**gate helper:** `stepToolRiskClass` returns max over `tool_gate` rows (low when none); `shouldRefute` true on high-risk, on null-evidence, on `gaps.length>0`; false on adequately-verified low/medium-risk execution step.

**service (mirror `service.gate-routing.test.ts` fakes — fake `ShadowAsk` + `operating_mode`):**
- L5 high-risk, `refuted` → `reviseStep` (not committed); issueRefs in feedback; `RefuteFacet` on the transition with `failure_code refute_veto`.
- L5 `upheld` → commits; `RefuteFacet` verdict `upheld`, no veto.
- L5 `uncertain` → human confirmation pause (not committed, not revised).
- L5 refute-**unavailable** (ask throws) → human confirmation pause (fail-safe, not auto-approved).
- **Gate:** adequately-verified low-risk execution step → refute **not called** (fake ask asserts 0 calls); no-oracle step → refute called.
- L4 human_review high-risk `refuted` → still pauses for the human; `pending_completion_json.refute` carries the verdict; confirmation lead shows the advisory; human confirm still commits (authoritative).
- **Independence:** the refute `ask` is called with the `${goalId}::refute` key, never the bare `goalId` (assert the key).
- **Composition:** a step already vetoed by the deterministic evidence gate never reaches the refute (order preserved).

**contracts:** zod round-trip for the two schemas + `RefuteFacet`; registry conformance for the new facet; migration applies (`refute_json` present).

**desktop:** card renders each advisory verdict; upheld shows no advisory.

---

## 9. Documented gaps / future options (honesty)

- **Single refuter, same adapter.** Independence is task-framing + session-isolation, not model diversity. Future: (a) tier-scaled **N-vote majority** for the `critical` tier (CANDOR, p.46) — deferred per p.47's caution against over-investing in LLM voting; (b) a **distinct/cheaper refute model** config for stronger anti-circularity.
- **Refute session context.** The `::refute` session is isolated from the *approver* but still accumulates across a goal's own refutes; a fully fresh turn per refute (spawn+teardown each call) trades latency for maximal independence — not chosen for cost.
- **This C is the enabler 5.2 waited for:** the `RefuteFacet` + `refuteStepCompletion` module are exactly the "adversarial-refute plumbing + hardened self-report" 5.2's counterfactual-judge deferral named.

---

## 10. Exit criteria

1. On an otherwise-approvable completion of a **high-risk OR under-verified** step, an **independent** (context-isolated), adversarial second-model refute runs *after* the deterministic gates and *before* commit.
2. **L5:** `refuted` → the step is routed back to revise with an enumerated issue list (bounded, N=3 cap); `uncertain`/unavailable → escalates to a human; `upheld` → commits. The deterministic core owns every branch; the LLM only fills the verdict + issues.
3. **L4:** the refute verdict rides the human confirmation card as an advisory; the human stays authoritative.
4. The refute is **skipped** for a low/medium-risk execution step the sensors already adequately verified (not universal).
5. Every refute that runs is an **inspectable `RefuteFacet`** on the `step_complete` transition (`refute_veto` failure-code on veto) — auditable, comparable, and consumable by 5.2.
6. Human-authoritative completion (L4) and the deterministic gates (sensors/2.8/conflict) are unchanged; the refute composes with, never duplicates, them.
7. `@orca/contracts` additions are additive; one additive migration (`refute_json`); no execution-plane code.
