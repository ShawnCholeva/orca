# Worker-Backed Gates + Critique-as-Gate Loop — Design

Date: 2026-07-15
Status: Design (awaiting review)
Scope: `apps/daemon` (workflow engine + Adaptive Delivery template), `packages/contracts`, `apps/desktop` (confirmation/gate card)

## Problem

In the Adaptive Delivery workflow, the **Critique** step produces a `verdict`
(`sound | needs_work`) plus `concerns`, but the graph edge `critique → verify` is
**unconditional** — the verdict routes nothing. A Critique that finds real,
load-bearing problems still advances to Verify and on toward Execution; the only
existing backward loop is the human `designgate → proposal (rejected)` after
Verify. Two consequences, both observed while dogfooding:

1. **The verdict is a wasted signal.** "Not worthy of continuing" cannot send the
   design back to be re-proposed. The paper (agent-harness.pdf p.38) calls
   critique-and-repair "the dominant interaction mode"; a verifier that gates
   nothing is the anti-pattern.
2. **"sound" under-communicates and carry-forward is advisory.** A `sound` verdict
   with several blocking concerns reads as "all good," and the concerns only flow
   into Verify via an *observe-mode* (non-vetoing) grounding check — a
   false-acceptance risk (p.62 "rate of false acceptance"; p.50 "if the verifier
   is weak, the agent will learn to optimize against the wrong signal").

Root asymmetry uncovered during design: **steps run on workers** (full agent,
tools, strong model, multi-turn) while **gates run on a shadow one-shot LLM call**
on the goal's orchestrator model (`evaluateGate` → `shadowAsk`,
`resolveShadowAdapterId`). So "make Critique a gate" today would *downgrade* it
from a deep worker critique to a light shadow eval — losing exactly the
confidence that makes Critique valuable.

## Goals

- Critique **gates routing**: when it is not worthy of continuing, loop back to
  regenerate the **Proposal** (critique → propose → critique refinement loop).
- Keep the critique **strong** — a full worker-grade adversarial review, not a
  light shadow eval (p.50 verifier strength).
- Make the verdict **honest**: blocking findings cannot coexist with "proceed."
- Reuse the **existing** loop machinery (bound, feedback, stagnation, mode) rather
  than reinventing it.

## Non-goals (YAGNI)

- **CANDOR-style multi-panelist majority-vote gates** (p.46) — a future confidence
  upgrade; the single strong worker-gate is the first cut.
- **Migrating the existing `designgate`/`review` gates to worker-backed** — they
  stay shadow-eval by default; worker-backing is opt-in per gate.
- **Auto-loop autonomy tiers beyond what the engine already does** — mode
  behavior (supervised park / automated auto-decide) is inherited, not extended.

## Locked design decisions (from brainstorm)

- **Q1:** honest verdict via the gate's `approved/rejected` + `issueRefs`
  (blocking findings) — *supersedes* a separate per-concern `severity` field. A
  gate cannot "approve while hiding blockers."
- **Q2 = C:** mode-dependent — supervised parks for the human; automated
  auto-decides. **Inherited free** from existing gate dispatch
  (`goalRequiresHumanReview` → `parkForGateApproval`, else `evaluateGate`).
- **Model X:** Critique **becomes a gate** (not a splitter, not a step-then-gate).
- **Scope A:** build **worker-backed gates** as a reusable substrate capability,
  then Critique uses it.

## Architecture

Two phases. P1 is the enabler; P2 is the feature.

### P1 — Worker-backed gate substrate

Decouple a gate's **evaluation substrate** (how the judgment is produced) from its
**role** (approve/reject routing + reject→loop + `GATE_REJECT_CAP` + stagnation +
mode-park). Today the role machinery lives in `dispatch-engine.evaluateAndParkGate`
(~L2090–2178) and is fed by `evaluateGate` (shadow). We add a second feeder:
a **worker** evaluation, selected per gate node.

**Contract (`packages/contracts` `WorkflowGraphNode`, index.ts L306–345):**
- Add optional `evalSubstrate: "shadow" | "worker"` (default `"shadow"` →
  existing behavior, zero migration for `designgate`/`review`).
- For `evalSubstrate: "worker"`, allow the gate to declare `agentPreference`
  (same `StepAgentChoice[]` shape steps use) so it can pin a strong model/agent —
  the concrete p.50 "strong verifier" lever. `instructions` (already supported on
  gate nodes) carries the evaluator prompt.

**Gate decision output contract:** a worker gate must emit the same decision shape
the shadow path already produces — reuse `GateEvaluationProposal`
(`{ reasoning, outcome: approved|rejected, reason, issueRefs[], inputsConsidered[] }`).
The worker prints it in its `orca:step-complete`-style fenced block; the engine
parses it exactly where a step's structured output is parsed, but validates it as
`GateEvaluationProposal` instead of a step `outputSchema`.

**Dispatch (`dispatch-engine.evaluateAndParkGate`):** branch on `gateNode.evalSubstrate`:
- `shadow` (default): unchanged — in supervised mode park with no eval; in
  automated mode `evaluateGate(shadowAsk, …)` then route.
- `worker`: **evaluate-always.** Spawn a worker (reusing the step worker path —
  `WorkerSessionManager` spawn + the durable deliver/park we just hardened) with
  `instructions` + `buildGateEvaluationRequest`'s evidence (committed ledger +
  source step output + goal) rendered into the worker prompt. On the worker's Stop
  hook, parse the `GateEvaluationProposal`. **Then** split on mode:
  - **automated** → route inline on `outcome` (same as shadow's automated path);
  - **supervised** → `parkForGateApproval`, **presenting the worker's recommendation**
    (`outcome` + `reasoning` + `issueRefs`) so the human confirms it or overrides.
  Both mode paths converge on the identical downstream: `recordGateDecision` →
  stagnation/`GATE_REJECT_CAP` check (L2151–2176) → route on `approved`/`rejected`
  ports.

**Why evaluate-always for worker gates:** a shadow gate today skips eval in
supervised mode because the human reviews the *upstream step's* output. A
Critique-gate has no separate critique step — **the gate is the source of the
critique**, so it must run its worker to produce the reasoning + `issueRefs` the
human reviews. The human then confirms the recommendation or overrides the route
(approve → Verify / reject → Proposal). This is the one behavioral difference from
shadow gates, and it is intrinsic to a gate that *produces* rather than *checks*
content.

**Isolation:** P1 is a self-contained capability — a gate node with
`evalSubstrate:"worker"` and an `instructions` prompt behaves like any gate to the
rest of the engine (same ports, same loop, same records). It can be unit-tested by
declaring a trivial worker-backed gate in a test template and asserting it
records a decision and routes.

### P2 — Critique-as-worker-gate + the loop

**Template (`ADAPTIVE_GRAPH`, catalog.ts):**
- Remove the `critique` **step** node + its step definition (outputSchema,
  grounding `implies` rule).
- Add a `critique` **gate** node: `type:"gate"`, `evalSubstrate:"worker"`,
  `agentPreference` pinned to a strong agent, `instructions` = the existing
  rigorous adversarial critique prompt ("challenge the chosen approach in a fresh
  context, treat prior step output as untrusted evidence; pressure-test isolation,
  interfaces, second-order risks; state whether it is sound enough to proceed; on
  reject, enumerate the specific blocking failures to fix and do not rewrite what
  is correct").
- Edges: `proposal → critique`; `critique → verify` (port `approved`);
  `critique → proposal` (port `rejected`). The reject edge is the loop; it re-runs
  **only Proposal**, not Research.
- Bump template version (v11 → v12); update node `positions`.

**Feedback threading (free):** the gate's `issueRefs` (the blocking concerns) are
already surfaced to the re-Proposal as "fix only these; do not rewrite what is
correct." `GATE_REJECT_CAP=3` bounds the loop; `issueRefsEqual` blocks it as
non-converging when the same issues recur.

**Downstream cleanup:**
- **Verify** (catalog.ts) currently has an observe-mode `covers_prior` grounding
  rule referencing `critique.concerns`. Critique no longer produces `concerns`;
  repoint that rule to the gate's `issueRefs`, or drop it — a strong Critique-gate
  only `approved`s once blockers are resolved, so Verify no longer needs to prove
  it "addressed critique concerns." Decision: **drop** the rule (the gate now
  enforces what it advised).
- Any UI/label reading `verdict` from a Critique *step* result moves to reading
  the gate decision.

**Card UX (`apps/desktop`):** the Critique gate must render the worker's **full
adversarial `reasoning` + the `issueRefs`** prominently (so we keep visibility and
confidence — not a bare "rejected"). In supervised mode it presents the human the
gate decision to confirm/override, consistent with the existing gate card; the
primary action communicates the routing consequence (approve → Verify; the
human's reject/override sends it back to Proposal).

**Compose with human review:** the human `designgate` (after Verify) stays — two
composed verifiers: the automated worker critique (fail-fast) + the human design
approval (p.62 "compose … model-based critiques, and human review").

## Data flow (P2, one loop iteration)

```
proposal (worker step) ──▶ critique (worker gate)
                              │  evidence: committed ledger + proposal output + goal
                              │  judgment: GateEvaluationProposal {outcome, issueRefs, reasoning}
                              ├── approved ─▶ verify ─▶ designgate(human) ─▶ …
                              └── rejected ─▶ proposal   [issueRefs fed as "fix only these"]
                                             (bounded: GATE_REJECT_CAP; stagnation → block)
```

Supervised: the gate parks; the human sees reasoning+issueRefs and confirms the
route. Automated: the worker evaluates and routes inline, bounded as above.

## Error handling / edge cases

- **Worker eval fails / unparseable** → same terminus as a failed shadow eval:
  `parkForGateApproval` (escalate to human). Never silently proceed.
- **Non-convergence** → existing `GATE_REJECT_CAP` / `issueRefsEqual` block the run
  with the enumerated unresolved issues on the reason.
- **Delivery** to the gate worker reuses the durable park + placeholder-tolerant
  deliver fixed earlier this session (commit `03f80e9`).

## Testing (TDD)

P1:
- Worker-backed gate records a decision and routes on `approved`/`rejected`
  (deterministic worker stub emitting a `GateEvaluationProposal`).
- `rejected` loops to the configured port; `GATE_REJECT_CAP` blocks on the Nth;
  `issueRefsEqual` blocks on stagnation.
- Unparseable/failed worker output → human park (no silent advance).
- `evalSubstrate:"shadow"` path unchanged (regression).

P2:
- `ADAPTIVE_GRAPH` graph validation passes with the critique gate + backward edge.
- Rejected critique re-enters `proposal`, not `research`; `issueRefs` reach the
  re-Proposal prompt.
- Approved critique advances to `verify`.
- Verify no longer references `critique.concerns`.
- Desktop: gate card renders reasoning + issueRefs; supervised confirm/route.

## Alignment

- **FUTURE_ARCHITECTURE:** routing/decision/loop stay in the deterministic
  control-plane; the *judgment* is produced by an execution-plane worker — a
  cleaner control/execution seam than shadow-eval gates (which embed evaluation in
  the orchestrator). Moves toward the Runner-Protocol split.
- **agent-harness.pdf:** critique-and-repair loop (p.38); strong verifier (p.50);
  compose model critique + human review (p.62); bounded, verification-governed
  termination on an objective signal (p.31/p.46 — already embodied by
  `GATE_REJECT_CAP` + stagnation).
```
