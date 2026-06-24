# Applying *Code as Agent Harness* to Orca

Distilled from the 102-page survey *Code as Agent Harness* (arXiv 2605.18747; body
is pp.1-66, the rest is bibliography), mapped onto Orca's actual architecture
(`ORCA.md`, `apps/daemon/src`). Each item: **what the paper says → where Orca
already does it → the gap / recommendation** with code pointers.

This is a direction document, not a backlog. The code is the source of truth.

---

## 0. The framing already matches

The paper's central claim is that agent reliability is a property of the *harness*,
not the model: harness mechanisms are "coordinated control surfaces that turn model
decisions into bounded, observable, and revisable changes in an executable
environment" (p.16). It splits an agentic system three ways:

1. **Model judgment** — decompose, select actions, interpret feedback, decide when to revise.
2. **Mutable state** — repository evidence, working context, traces, validation results, memory.
3. **Governed infrastructure** — tools, execution substrate, state persistence/compaction, permission tiers, feedback routing, verification.

Orca's "deterministic core, selective AI" (`ORCA.md` §3) is exactly this split:
the engine owns lifecycle/state/transitions, the LLM supplies judgment only where
needed. **Orca is already on-thesis.** What follows is where the paper is more
built-out than Orca is.

## 1. The four-property scorecard (p.61, p.66)

The paper's summary test: the best future systems are **Executable, Inspectable,
Stateful, Governed.** Scoring Orca:

| Property | Definition (paper) | Orca today | Grade |
|---|---|---|---|
| **Executable** | Decisions grounded in code/tools/tests/environments | `validation_required` guardrail on the execution step; agents run in real adapters. But most steps are judged by LLM + schema, not by running anything. | **Partial** |
| **Inspectable** | Plans, state, provenance, failure causes exposed | Event-sourced append-only spine + projections; first-class Decisions with reasoning/alternatives; raw transcript surfaced in chat. Strong. | **Strong** |
| **Stateful** | Task-relevant info preserved across long trajectories & agents | Goal-scoped typed memory with lifecycle; bounded context envelope. But no action-level read/write sets, no belief-divergence tracking. | **Partial** |
| **Governed** | Autonomy constrained by permissions, verification, accountability | Autonomy levels + single mark-done gate. But **no permission tiers, no sandbox, no action risk-classification** (`ORCA.md` §9 — deferred). | **Weak** |

**Governed is the weakest axis and the highest-leverage place to invest.**

---

## 2. What Orca already nails (paper validates these)

- **Hooks over stdout parsing** (`CLAUDE.md` hard rule; `agent-hooks/`, `shadow-hooks/`)
  ↔ paper's pre/post-use tool hooks that "turn raw model-selected actions into
  monitored transitions" (p.26-28). Orca's hardest project rule is a named paper pattern.
- **Hybrid-gated step completion** (agent proposes structured output → engine
  validates `outputSchema` deterministically → orchestrator-LLM judges; `ORCA.md` §5)
  ↔ paper's "critique interprets sensors, never replaces them" and "verification by
  deterministic sensors + human-review gates" (p.31). Orca keeps the LLM judge
  *subordinate* to a deterministic check — exactly the paper's prescription.
- **Selective context assembly** (always/conditional/excluded tiers, ~64 KiB
  envelope, truncate-oldest-first; `context/`, `ORCA.md` §10) ↔ "construct a
  task-specific working view, don't just stuff the prompt" (p.50) and "control
  contents, not expand the window" (L2MAC Control Unit, p.43).
- **Template-declarative agent selection** (`agentPreference[]`, cheap models for
  interview/QA, heavy for synthesis; `ORCA.md` §5) ↔ role specialization + "match
  model weight to workload" (p.35-38).
- **Bounded iteration** (revise cap N=3, retry cap 3, idle timeout; `ORCA.md` §5)
  ↔ "bound iteration loops with an explicit budget" (AgentCoder 5, Self-Collab 4; p.39,46).
- **First-class Decisions recording *why*** (`decisions/`) ↔ "planning as contract
  formation" + auditable rationale (p.30).
- **Append-only events + projections** (`ORCA.md` §3) ↔ the inspectability/replay
  substrate the paper says self-improvement requires (p.32-33). Orca has the
  substrate; §5 below is about *using* it.
- **Structure-aware retrieval with iterative rewrite** (paper-RAG PRF expansion;
  `CLAUDE.md`) ↔ "semantic memory as structured evidence layer; iterative query
  rewriting" (p.23).

---

## 3. Gap A — Governance: permission tiers, risk classification, sandbox (HIGHEST LEVERAGE)

**Paper (pp.30, 64-65):** Safety must be *harness-enforced, not prompt-enforced*.
A multi-tier, **argument- and context-aware** permission model:
- **Read-only** — browse, retrieve, static inspect, log analysis.
- **Sandbox-edit** — local patching, test execution, temp deps in an isolated workspace.
- **Full-access** — network, credentials, deployment, publishing, destructive FS, git-history mutation → **mandatory HITL gate**.

"The same command is safe in a disposable sandbox but unsafe in production;
permissions should depend on tool identity *and* arguments, environment state, data
sensitivity, and expected side effects" (p.65). The harness must "classify proposed
actions by risk... deny actions violating hard constraints, and require human
approval for irreversible/externally-consequential transitions — overriding the
base model" (p.64).

**Orca today:** `ORCA.md` §9 — "no permissions/sandbox — all deferred." Autonomy
*levels* exist (§1) but there is no per-action risk class, no permission tier on
adapter spawns (`adapters/`), no sandbox isolation. Worker sessions run with full
host access via tmux.

**Recommendation:** Before Level 4 (supervised execution), the autonomy levels need
a permission spine under them. Concretely:
1. Add a **risk classifier** for agent-proposed actions (a deterministic rule layer
   keyed on adapter/command/args), mirroring the three tiers. This fits Orca's
   "deterministic core" stance — it's rules, not an LLM call.
2. Map each autonomy level to a permission ceiling (L3 = read-only + sandbox-edit
   auto, full-access always gated; L4 = full-access at explicit gates only).
3. Make the mark-done gate (`ORCA.md` §5) the first instance of a *general* gate
   abstraction, not a one-off. Today it's the single yield point; the paper wants a
   gate wherever an action crosses a risk boundary.
This is the single biggest divergence from the paper and the prerequisite for
raising autonomy safely.

## 4. Gap B — Verification: evidence bundles, not binary done/not-done

**Paper (pp.31, 62-63):** Replace a single pass/fail gate with a *composed
verification stack* where each check "declares what it verifies, what it cannot, and
what confidence it gives." Every accepted action carries an **evidence bundle**:
checks run, assumptions preserved, untested regions, remaining risks. Order sensors
**cheapest-first** (compile/static → runtime → tests; p.31). And beware the
**oracle-adequacy trap**: a harness becomes "overconfident precisely because it has
executable feedback" — a green test ≠ a satisfied spec (p.62).

**Orca today:** Step completion = schema-valid + LLM judge; the execution step's
`validation_required` guardrail is binary (`validation.ran && validation.passed`,
`ORCA.md` §5). A passing step is treated as done.

**Recommendation:**
1. Enrich the step artifact schema from `{ran, passed}` toward an **evidence
   bundle** (what ran, coverage/scope, untested regions, residual risk). This makes
   "confirmed decisions" carry provenance the paper says verification needs.
2. Adopt **cheapest-first sensor ordering** in the execution/QA steps — typecheck/
   lint before the full test run — to fail fast and cheap.
3. Treat the LLM judge's "approve" as *conditional on* the evidence bundle, not a
   substitute for it (Orca mostly does this; the gap is the bundle's richness).

## 5. Gap C — Agentic Harness Engineering: Orca has the substrate, doesn't use it

**Paper (§3.5, pp.32-33, 63):** Treat the harness *itself* as the object of
measurement and revision. Many failures are **harness failures, not model failures**
(missing context, brittle tools, weak validators, bad retry policy, mismatched
permissions). Mechanism:
- **Deep telemetry** — log the full decision process: prompts+retrieved context,
  token cost per stage, tool args, permission requests, edited files, test results,
  branch decisions, *rejected alternatives*, human interventions, outcome.
- **Evolution Agent** — a meta-agent that edits *later agents' operating conditions*
  (prompts, retrieval policy, tool schemas, validators, retry limits), via a 5-stage
  loop: **Observe → Diagnose → Propose → Evaluate (on held-out/replayed traces) →
  Promote**.
- **Change contract** for every harness edit (p.63): which component, which failure
  mode it targets, predicted improvement, invariants preserved, the test that can
  falsify it, rollback. "The goal is not a harness that changes often, but one that
  changes only when it can justify the change."

**Orca today:** Event-sourcing + replay (`ORCA.md` §3) is the *exact substrate* this
needs. The Recommendations engine (`recommendations/`, rule-based + feedback loop)
is the closest analog but it recommends *task* actions, not *harness* changes.
Telemetry today is event-level, not cost/decision-trace level.

**Recommendation:** This is Orca's biggest *latent* opportunity — it already has the
replayable event store everyone else has to build.
1. Add **harness-level metrics** over runs (the paper's six dimensions, §6 below):
   trajectory efficiency, verification strength, recovery, state consistency, safety
   compliance, replayability. Build these as projections over existing events.
2. Use **failure attribution** across runs (cluster: which step, which adapter,
   which guardrail keeps triggering revises) to point tuning at components.
3. Defer the autonomous Evolution Agent (it's L5 territory), but its **governed
   mutation discipline** — change contracts, regression suites, canary — should
   govern how *humans* change Orca's workflow templates today.

## 6. Gap D — Transactional shared state & semantic conflict (multi-session)

**Paper (pp.42, 44, 64):** Syncing artifacts isn't enough — "mechanisms sync
artifacts but not *assumptions*." Each agent action should declare its **read set,
write set, assumptions, version dependencies, verifier obligations, conflict
policy.** Conflicts must be detected at the level of *plans, tests, retrieved
evidence, permissions, memory entries, latent requirements* — not just file diffs.
SyncMind formalizes belief state Bₖ vs ground truth Sₖ and the divergence between
them (p.44). "Concurrent edits can silently invalidate assumptions held by other
agents" (p.52).

**Orca today:** Partial match — `conflicts/` does overlap/contradiction detection,
and memory is Goal-scoped to maintain a shared view. But conflict detection is at
the *memory* level, not the *action* level; sessions don't declare read/write sets.

**Recommendation:** When Orca runs multiple concurrent sessions on one Goal (the
multi-agent future in `ORCA.md` §1 L4+), extend the `conflicts/` engine from
memory-overlap toward **action-level assumption tracking** — flag when one session's
output invalidates a premise another session is mid-flight on. This is a Level-4
concern; note it before parallel execution lands, since retrofitting read/write-set
discipline is hard.

## 7. Gap E — HITL as durable harness state ("executable accountability")

**Paper (p.65):** Human control shouldn't be an ephemeral prompt interruption — it
should become **durable harness state.** Each approval/rejection/exception should
*update* permission rules, escalation policy, verification criteria, and future
memory retrieval. High-stakes approvals are auditable transitions recording: action
proposed, evidence shown, risks surfaced, who decided, what responsibility boundary
changed.

**Orca today:** The mark-done confirm and first-class Decisions are good raw
material, but an approval doesn't currently *reshape future gates* — it resolves one
run.

**Recommendation:** When the permission spine (Gap A) lands, route approvals back
into it: a user's repeated approval of a class of action should be promotable into a
relaxed gate (and a rejection into a tightened one), recorded as a Decision. This
closes the loop between Orca's existing Decision entity and its (future) permission
tiers — and it's the mechanism by which the human "teaches" at Level 3 (`ORCA.md` §1).

---

## 8. Smaller, concrete transfers

- **Convergence criteria (pp.45-47):** The paper names six (test-gated, security,
  performance, score, consensus, *implicit*) and calls **implicit convergence**
  (iteration budget, no objective oracle) the biggest gap. Orca's revise-cap N=3 is
  exactly implicit convergence for non-execution steps. *Where a step can carry an
  objective oracle, give it one* rather than relying on the LLM judge + cap.
- **Verification independence / mode-collapse (pp.37-38):** "Generate tests
  independently of code." Orca's `review` step is a separate agent (good); confirm
  `qa` is sourced independently of `execution` so it can't rubber-stamp its own work.
- **Type-routed feedback (p.63):** Route signals by type — compiler error → local
  repair, test failure → behavioral diagnosis, coverage gap → test generation.
  Orca paraphrases all agent output uniformly through the orchestrator-LLM; a
  deterministic pre-router could classify before the LLM sees it.
- **Plan-as-contract fields (p.30):** A robust plan declares relevant files,
  invariants, validation commands, rollback points, risky operations. Orca's steps
  carry `instructions + outputSchema`; enriching task/step contracts with explicit
  invariants + rollback points is a cheap inspectability win.
- **State rollback / checkpointing (p.43):** QualityFlow never overwrites the
  initial artifact, enabling rollback when a trajectory degrades. Orca advances
  forward (revise/retry) but doesn't checkpoint-and-revert. Worth considering for
  the execution step.
- **Experiential memory / skill library (pp.24, 56):** Reusable cross-task
  experience as re-executable units. This is a deliberate Orca non-goal today (no
  cross-goal memory, `ORCA.md` §13) — but note the natural path: a *successful
  workflow run* is a candidate to promote into a reusable `workflows/templates/`
  entry. That's experiential memory within Orca's existing abstractions.

---

## 9. If you do three things

1. **Build the permission spine** (Gap A) — risk-classify actions into the paper's
   three tiers, map autonomy levels to ceilings, generalize the mark-done gate. It's
   the weakest scorecard axis and the gate to safe Level 4.
2. **Turn step verification into evidence bundles** (Gap B) — richer than `{ran,
   passed}`, cheapest-sensor-first. Cheap, high inspectability payoff.
3. **Mine your own event store for harness metrics** (Gap C) — you already have the
   replayable substrate the paper says self-improvement needs; build the six
   harness-level metrics as projections and do failure attribution across runs.
