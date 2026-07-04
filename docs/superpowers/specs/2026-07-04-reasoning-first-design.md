# Reasoning-First Ordering on Structured Verdict Outputs — Design (Phase 5 / FUTURE_WORK 5.5)

**Date:** 2026-07-04
**Status:** Designing (user-approved section-by-section 2026-07-04), pending implementation plan
**Phase item:** FUTURE_WORK 5.5 — "Reasoning-first ordering on structured orchestrator outputs." The last open item of Phase 5.
**Builds on / touches:** the LLM-filled verdict schemas landed across 5.2 (`JudgeInstructionEditProposal`), 5.3 (`GateEvaluationProposal`, `SplitEvaluationProposal`), 5.4 (`RefuteCompletionProposal`), and the pre-existing `StepResultScoringProposal`.

---

## 1. Context & the gap

Every LLM-filled **verdict/score** schema in the repo emits its decision *before* its justification. An audit (2026-07-04) confirmed the pattern is systemic — no judgment schema is reasoning-first, and the prompt JSON literals mirror the schema key order everywhere, so the prompts actively reinforce verdict-first generation:

| Schema | First field | Reasoning field | Position |
|---|---|---|---|
| `StepResultScoringProposal` | `successScore` | `reason` | after `successScore` + the whole `quality` block |
| `GateEvaluationProposal` | `outcome` | `reason` | 2nd (after `outcome`) |
| `RefuteCompletionProposal` | `verdict` | `reason` | 2nd (after `verdict`) |
| `SplitEvaluationProposal` | `selectedBranch` | `reason` | 2nd (after `selectedBranch`) |
| `JudgeInstructionEditProposal` | `verdict` | `reason` | 5th (after `verdict` + 2 enums) |

Because a model generating a JSON block emits tokens in field order, **verdict-first means the model commits to the verdict, then rationalizes it** — the justification cannot condition the decision it follows. 5.5 inverts this: chain-of-thought as **schema structure** (paper §2.1 "Externalize Reasoning Logic" / §3.1 planning-as-reasoning; the reasoning trajectory of p.10), so the verdict is *generated after, and conditioned on,* the reasoning.

### Scope (decided)

Apply reasoning-first to exactly the **five judgment/verdict/score schemas** above — where a committed verdict/score is a genuine rationalize-after-the-fact hazard. **Out of scope** (deliberate, YAGNI): the orchestrator's narration/output actions (`paraphrase_agent_message`/`forward_to_agent`/`answer_user_directly`/`escalate_to_user`/`ask_user`), `SynthesisProposal` (output-only, no verdict), `ProposeInstructionRevisionProposal` (a proposal, no verdict/score), and `StepSkillProposal` — a leading reasoning field there is low-value and taxes the hot chat-narration path.

### Non-goals

- **Renaming** the existing `reason`/`rationale` fields or changing their semantics/consumers. The new field is *additive*; downstream consumers (result card, `repairContext`, advisory lead, routing audit) are untouched.
- **New primary-UI surface** for the reasoning. It is persisted for inspectability/replay/learning-loop consumption; surfacing it in the desktop is a later enhancement.
- Touching non-verdict schemas (see Scope).

---

## 2. The `reasoning` field

A new field added as the **first key** of each of the five schemas:

```ts
reasoning: z.string().min(1).max(REASONING_MAX)   // REASONING_MAX = 4000 (set in plan)
```

- **Required** (`min(1)`) — so the CoT is enforced, not optional like today's `rationale`.
- **Distinct** from the existing `reason`/verdict/score fields, which stay exactly as they are. `reasoning` is the model's pre-commitment working-out; `reason` remains the crisp, downstream-consumed conclusion. Keeping them separate is why no consumer changes and why the ≤240-char `scoring.reason` card field is not overloaded.
- **First** in the object (self-documenting contract order). The load-bearing change is the prompt (§3); the key reorder keeps schema and prompt consistent.
- **Bounded** (`max`) so it cannot blow the request/response payload caps (`ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES` etc.).

None of the five targets is a discriminated union, so there is no discriminator-ordering constraint — `reasoning` can be the literal first key.

---

## 3. The lever — prompts (reasoning-first generation)

zod ignores key order at parse time, so the behavior change is in each schema's **prompt**: the example JSON literal is reordered to show `reasoning` first, plus a one-line instruction:

> "Fill `reasoning` FIRST — work through the evidence before committing. THEN emit the verdict/scores, conditioned on that reasoning. Do not restate the verdict as the reasoning; `reason` stays a one-line conclusion."

Prompt literals to reorder (each currently mirrors the verdict-first schema):
- `orchestrator-llm/prompts.ts:95` — the `approve_step_complete` scoring literal (`StepResultScoringProposal`).
- `workflows/orchestrator/service.ts:130` — the recover-step-scoring prompt (same schema).
- `workflows/orchestrator/gate-evaluation.ts:36` — `GateEvaluationProposal`.
- `workflows/orchestrator/refute-completion.ts:31` — `RefuteCompletionProposal` (`composeRefutePrompt`).
- `learning/judge.ts` (the `composeJudgePrompt` fenced literal) — `JudgeInstructionEditProposal`.
- the broker-side `evaluate_split` prompt template — `SplitEvaluationProposal` (locate the composer; the schema is the serialized contract the broker validates).

---

## 4. Persistence — inspectable reasoning-trajectory (paper p.33)

Each proposal's `reasoning` is threaded into the record its verdict already writes, so reasoning becomes queryable/replayable telemetry (and future learning-loop input), not generation-time scratch:

| Schema | Sink | Change |
|---|---|---|
| `StepResultScoringProposal` | `workflow_step_runs.step_result_json` (serialized `WorkflowStepResult`) | **additive, no migration** — add `reasoning` to `WorkflowStepResult` (sibling of `outcome`); flows through `serializeStepResult`. Populated in `scoreStepResult`/`buildScoredStepResult`. |
| `RefuteCompletionProposal` | `RefuteFacet` → `refute_json` blob | **additive, no migration** — add `reasoning` to `RefuteFacet`; populate in `maybeRefute` from the proposal. |
| `JudgeInstructionEditProposal` | `CounterfactualJudgment` → `judge_json` blob | **additive, no migration** — add `reasoning` to `CounterfactualJudgment`; populate in `judgeProposal` from `fill.reasoning`. |
| `GateEvaluationProposal` | `workflow_gate_decisions` (typed cols) | **one new column** `reasoning TEXT` (nullable); `recordGateDecision` writes it. |
| `SplitEvaluationProposal` | `workflow_split_decisions` (typed cols) | **one new column** `reasoning TEXT` (nullable); `recordSplitDecision` writes it. |

**One additive migration** adds the two decision-table columns (nullable, so pre-existing rows are fine); the other three ride existing serialized-object JSON blobs with no migration. The `reasoning` fields on the persistence records are `.optional()`/nullable so historical records (written before this change) still parse.

---

## 5. Validation & degradation

`reasoning` is required on the five *proposal* schemas, so a model that omits it fails the existing `safeParse` and rides the **existing** per-schema fallback — no new failure path:
- Refute/Judge/Gate/Split evaluators: retry-once → `null`/`unavailable`/`needs_human_review` exactly as today.
- Orchestrator scoring: the existing scoring-recovery/degradation path.

Risk: making a new field required can raise the initial validation-retry rate (models sometimes drop a field). Mitigated by the explicit prompt instruction and the leading position (a field asked for first is rarely dropped). No behavior change beyond that — the degradation termini are unchanged.

---

## 6. Testing (TDD — tests before implementation)

Per schema (contracts + the owning daemon module):
- **Contract:** `reasoning` is required (rejects an object missing it) and round-trips; the existing verdict/`reason` fields are unchanged. (Key *order* is documentation only — zod ignores it at parse — so the ordering guarantee is carried by the prompt test below, not a schema-introspection assertion.)
- **Prompt:** the composed prompt's example literal contains `reasoning` *before* the verdict/score token (string index-of assertion), and carries the reason-first instruction. This is the load-bearing ordering test.
- **Persistence:** `reasoning` round-trips into its sink — `WorkflowStepResult`/`RefuteFacet`/`CounterfactualJudgment` serialize+hydrate it; `recordGateDecision`/`recordSplitDecision` write+read the new column; migration adds both columns.
- **Degradation (one representative, e.g. refute):** a proposal missing `reasoning` → `safeParse` fails → retry → the existing fallback (asserted no new terminus).
- **Historical-parse:** a persistence record without `reasoning` still parses (`.optional()`/nullable), so old `step_result_json`/`refute_json`/`judge_json`/decision rows are safe.

---

## 7. Files

- **Contracts (`@orca/contracts`):** add `reasoning` (required, first) to `StepResultScoringProposal`, `GateEvaluationProposal`, `RefuteCompletionProposal`, `SplitEvaluationProposal` (`workflows/index.ts`) and `JudgeInstructionEditProposal` (`learning/index.ts`); add `reasoning` (`.optional()`) to `WorkflowStepResult` (`workflows/index.ts`), `RefuteFacet` (`harness/index.ts`), `CounterfactualJudgment` (`learning/index.ts`); a `REASONING_MAX` constant.
- **Migration:** `reasoning TEXT` on `workflow_gate_decisions` + `workflow_split_decisions` (next sequential number — confirm against `apps/daemon/migrations/`).
- **Prompts:** reorder the six literals in §3 + add the reason-first instruction.
- **Wiring:** populate `reasoning` into the sink in `scoreStepResult`/`buildScoredStepResult`, `maybeRefute` (refute facet), `judgeProposal` (judgment record), `recordGateDecision` (`gates/usecases.ts`), `recordSplitDecision` (`splitters/usecases.ts`).
- **Docs:** ORCA.md (the reasoning-first discipline on verdict schemas + persisted reasoning-trajectory telemetry); FUTURE_WORK.md (mark 5.5 landed → **Phase 5 complete**); FUTURE_ARCHITECTURE.md (Inspectable axis gains the reasoning-trajectory channel).

---

## 8. Paper alignment

- **§2.1 / §3.1 — externalize reasoning, planning-as-reasoning.** Reasoning becomes a first-class structural element that precedes and conditions the verdict, rather than a trailing paragraph.
- **p.10 — reasoning trajectories.** Persisting `reasoning` makes the trajectory an auditable, replayable artifact.
- **p.33 — deep telemetry → comparative diagnosis.** The stored reasoning is exactly the kind of decision-trace signal the Evolution Agent / learning loop consumes; it lands on the same records (`RefuteFacet`, `CounterfactualJudgment`, decisions) the Inspectable axis already exposes.

---

## 9. Exit criteria

1. Each of the five judgment schemas requires a leading `reasoning` field; the existing verdict/score/`reason` fields and their downstream consumers are unchanged.
2. Each corresponding prompt instructs and exemplifies reasoning-first (example literal emits `reasoning` before the verdict/score).
3. `reasoning` is persisted onto each verdict's existing record — additively for scoring/refute/judge (no migration) and via one additive migration (two nullable columns) for gate/split — and historical records without it still parse.
4. A missing `reasoning` degrades through the existing per-schema fallback; no new failure terminus.
5. Contracts + daemon builds clean; the touched suites are green. Phase 5 is complete.
