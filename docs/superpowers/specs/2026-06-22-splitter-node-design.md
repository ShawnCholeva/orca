# Splitter Node — an N-way Reasoning Router

**Date:** 2026-06-22
**Status:** Design — approved, pending implementation plan

## Summary

Introduce a third workflow node type, **`splitter`**, alongside the existing
`step` and `gate`. A splitter evaluates the current context with an LLM and
routes the run into **exactly one of N author-defined branches**. It is the
N-way generalization of the reasoning a gate already performs (a gate is a
fixed two-way `approved`/`rejected` router), built as a separate primitive so
gates keep their quality-control semantics untouched.

The splitter is validated by one concrete use case: a combined **Adaptive
Delivery** workflow template that merges today's *Brainstorm*, *Feature
Implementation*, and (lightweight) *Initiative Implementation* templates into a
single graph whose entry depth is chosen by a splitter.

## Motivation

Orca workflows currently express branching only through gates, which are
hardcoded to two ports. Several real workflows want to *reason over the goal and
pick one of several paths* — e.g. "is this goal vague enough to need a full
brainstorm, clear enough to jump to design, or obvious enough to go straight to
proposing an approach?" That is a 3+ way decision a gate cannot represent.

Critically, a gate is **already** an LLM reasoning over rich context
(`GateEvaluationRequest` feeds it the source step's output, the goal, prior gate
decisions, and the committed ledger). The only thing missing is **more than two
exits**. The splitter supplies exactly that and nothing more.

## Goals

- A `splitter` node type with 2–8 author-named branches.
- Branch selection by LLM reasoning over the source step's output + goal +
  ledger (a new `evaluate_split` decision), always automated.
- Reuse of the gate's park → evaluate → route machinery; **no change to gate
  behavior** or to existing built-in templates.
- One combined *Adaptive Delivery* template that exercises the splitter
  end-to-end and replaces three overlapping templates with one.

## Non-goals

- Human-decided splitters (a person picking the branch). Splitter decisions
  surface in the normal supervised flow for review, but there is no dedicated
  human-pick mode in v1.
- Dynamic / runtime-invented branches. Branches are authored at design time so
  edges can be drawn and validated.
- Parallel / fan-out execution. The splitter *routes* (pick one of N); it never
  *spawns* (do all of N). See **Future direction**.
- Any change to gate semantics, the gate decision history, or built-in gate
  templates.

## Background: the current model

- **Step node** (`type: "step"`): runs an agent, produces output, has exactly
  one outgoing edge (or is `terminal`).
- **Gate node** (`type: "gate"`): exactly two port-labeled outgoing edges,
  `approved` and `rejected`. Evaluated by an `evaluate_gate` LLM decision
  returning `{ outcome, reason }` (or parked for a human approve/reject), then
  routed via `resolveGateNext`.
- A `WorkflowRun` has a **single cursor** (`currentStepRunId`, `currentNodeId`,
  `currentNodeKind`). Routing always moves that one cursor; nothing runs in
  parallel.

Relevant files:
- `packages/contracts/src/workflows/index.ts` — node/edge/graph schemas,
  decision kinds, evaluation request/proposal schemas.
- `apps/daemon/src/workflows/graph/graph-routing.ts` — `Destination`,
  `resolveStepNext`, `resolveGateNext`.
- `apps/daemon/src/workflows/graph/validate-graph.ts` — structural validation.
- `apps/daemon/src/workflows/orchestrator/service.ts` — evaluate/park/route
  orchestration (gate path around lines 3186–3600).
- `apps/daemon/src/workflows/gates/usecases.ts` + `gates/projection.ts` — gate
  decision persistence.
- `apps/daemon/src/workflows/templates/catalog.ts` — built-in templates.
- `apps/desktop/src/workflows/*` — graph editor UI.

## The Splitter primitive

### Contract changes (`packages/contracts/src/workflows/index.ts`)

- `WorkflowGraphNode.type` → `z.enum(["step", "gate", "splitter"])`.
- Add to `WorkflowGraphNode`: `branches: z.array(BranchLabel).min(2).max(8).optional()`
  where `BranchLabel = z.string().min(1).max(60)`. Required (non-empty, unique)
  for splitter nodes; absent for step/gate. Splitter nodes also use the existing
  `instructions` field for routing guidance (same field gates use).
- `WorkflowGraphEdge.port` → generalize from `z.enum(["approved","rejected"])`
  to `z.string().min(1).max(60).optional()`. Semantics are enforced per node
  type in validation, not by the type. (This is the one deliberate
  type-safety/flexibility trade; it is recovered by `validateGraph`.)
- `OrchestrationDecisionKind` += `"evaluate_split"`.
- `WorkflowDecisionType` += `"evaluate_split"`.
- New `SplitEvaluationRequest` (parallels `GateEvaluationRequest`):
  - `splitter`: `{ nodeId, name, instructions, branches: string[] }`
  - `goal`: `{ id, description }`
  - `sourceStepOutput`: `record | null`
  - `priorDecisions`: array of `{ nodeId, selectedBranch, reason }` (≤50)
  - `committedLedger`: same shape/cap as the gate request (≤35)
  - serialized-size guard at `ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES`.
- New `SplitEvaluationProposal`:
  `{ selectedBranch: string, reason: string(1..1024), inputsConsidered: string[] }`.
  `selectedBranch` must be one of the declared `branches` (validated on receipt).
  No `issueRefs` — that is a quality-control concept that does not apply here.

### Validation (`validate-graph.ts`)

Add a `splitter` arm to the per-node loop, parallel to the existing gate arm:

- The node must declare `branches` with 2–8 **unique** labels.
- Exactly one outgoing edge per declared branch label.
- Every outgoing edge's `port` must equal one of the declared branch labels.
- Step edges still must carry **no** port; gate edges still must carry
  `approved`/`rejected` (unchanged).

No change is needed to reachability or terminal-reachability: the latter is
already documented as *"branch-source-agnostic — covers gate ports and (future)
step fan-out alike,"* so it covers splitter ports as-is.

### Routing (`graph-routing.ts`)

- `Destination` += `{ kind: "splitter"; nodeId: string }`.
- `classify` returns a `splitter` destination for splitter nodes.
- New `resolveSplitterNext(graph, splitterNodeId, branch)` mirroring
  `resolveGateNext`, keyed on the branch label instead of the port enum; throws
  `GraphRoutingError` if the branch has != 1 outgoing edge.

### Orchestrator (`service.ts`)

- Where `advanceToNextStepOrGate` handles `result.kind === "gate"` (around line
  3216), add a `"splitter"` case that parks the run on the splitter and triggers
  evaluation.
- New `evaluate_split` decision path mirroring `evaluate_gate`: build a
  `SplitEvaluationRequest`, run it through the existing orchestration transport,
  receive a `SplitEvaluationProposal`, reject the proposal if `selectedBranch`
  is not a declared branch, then `resolveSplitterNext` → route.
- Generalize the existing `routeGateDestination` into a branch-label-aware
  `routeBranchDestination` (or add a sibling) so a splitter destination that is
  itself a step/gate/splitter is handled in one place. A splitter is **always
  automated** — there is no human-pick park; the decision flows through the
  normal supervised review surface like any other orchestrator decision.

### Persistence

Add `workflow_split_decisions` (+ `recordSplitDecision` + a projection),
mirroring `workflow_gate_decisions` / `recordGateDecision` exactly but with a
`selected_branch` column instead of `outcome`, and no `issue_refs_json`. Kept as
a separate table so splitter branch labels never pollute the gate decision
history that gate evaluation reads back via `priorGateDecisions`.

### Desktop UI (`apps/desktop/src/workflows/*`)

Follow existing gate patterns:
- `onAddNode` gains `"splitter"`; `WorkflowFlow` renders a distinct node shape
  (not the gate diamond) with **N labeled output handles**, one per branch.
- `NodeDetailModal` gains a `SplitterBody` with a branch-label list editor
  (add / remove / rename branches; each branch maps to one output port and edge).
- `graph-sync` round-trips the `branches` array and string-valued edge ports.
- `icons.tsx` gains a splitter glyph.

## Use case: the Adaptive Delivery template

A single built-in template (provisional name **Adaptive Delivery**,
`orca/adaptive-delivery`) that merges *Brainstorm*, *Feature Implementation*,
and lightweight *Initiative Implementation*. A splitter chooses how far down a
shared design→build pipeline to start, based on what the goal already provides.

### Graph

```
Triage(step) → Route(splitter, 3 branches)

  clarify_first    → Clarify → Research → Proposal → Critique → Verify → DesignGate ─approved→ Execution → Validate Build → Review(gate) ─approved→ Done(terminal)
  ground_and_design →          Research → Proposal → Critique → Verify → DesignGate            needs_work→ Proposal           rejected→ Execution
  approach_only    →                      Proposal → Critique → Verify → DesignGate
```

- `Route` is a **splitter** (3-way, by entry depth).
- `DesignGate` and `Review` are **gates** (binary), demonstrating both
  primitives coexisting: the splitter fans forward into divergent entry depths
  and never loops; the gates are pass/fail and loop backward to remediate.

### Nodes

| Node | Type | Purpose | Key output / config |
|------|------|---------|---------------------|
| **Triage** | step (LIGHT) | Non-interactive assessment of the raw goal. Emits a **provisional readiness brief** that backfills context for whichever entry point is chosen. Never interviews. | `{ problem, success_outcome, constraints[], known_files[], risks[], recommended_tier, confidence, rationale }` |
| **Route** | splitter | Reasons over Triage's brief + goal and selects one entry depth. **On low confidence, routes shallower** (toward `clarify_first`) — under-designing is costlier than over-designing. | branches: `["clarify_first","ground_and_design","approach_only"]` |
| **Clarify** | step (LIGHT, interview) | Renamed from Brainstorm's *Frame*. Interview the user for product intent; stay in a product frame. | `{ problem, success_outcome, constraints[], open_questions[] }` |
| **Research** | step (REASONING) | Ground the confirmed (or Triage-provided) frame in the codebase before any approach. | `{ summary, files_in_scope[], risks[] }` |
| **Proposal** | step (REASONING) | 2–3 approaches + recommendation + the chosen approach, **plus an ordered `task_plan[]`** (1 item for a feature, N for an initiative). On the `approach_only` path it self-grounds with a quick targeted look (no Research step ran). | `{ summary, approaches[], recommendation, chosen_approach, task_plan[] }` |
| **Critique** | step (REASONING) | Red-team the chosen approach + plan in a fresh context, treating prior output as untrusted. | `{ summary, concerns[], verdict: sound \| needs_work }` |
| **Verify** | step (LIGHT) | Validate the design against success outcome + hard constraints; confirm acceptance signals are concrete. | `{ summary, feasible: boolean, notes[] }` |
| **DesignGate** | gate | `sound + feasible` → Execution; otherwise → back to **Proposal** to re-design. Makes Critique/Verify decision-bearing rather than advisory. | ports: `approved`→Execution, `rejected`→Proposal |
| **Execution** | step (EXECUTION) | Work through `task_plan` in order; the executing agent (Claude Code / Codex) manages sequencing and decomposition itself. If large, complete what it can and report remaining items. | `{ summary, changed_files[], validation{ran,passed,skipped}, blocked, blocked_reason }` |
| **Validate Build** | step (REASONING) | Post-code validation of the implementation against acceptance signals. Distinct from Verify (pre-code design check). | `{ summary, verdict, requirement_results[] }` |
| **Review** | gate | Quality-control gate on the build. `approved` → Done; `rejected` → back to Execution (the iteration loop). | ports: `approved`→Done, `rejected`→Execution |
| **Done** | step (terminal) | Persist the durable spec/summary and handoff. | `{ summary, delivered[], handoff }` |

### The three entry tiers (a monotonic depth ladder)

Every tier passes through **Proposal → Critique → Verify**, so the agent never
starts editing without first surfacing what it will build and the options.

- **`clarify_first` → Clarify.** Goal is vague/large; open questions remain.
  Must interview the human, then the full chain.
- **`ground_and_design` → Research.** Product intent is clear; skip the
  interview but still ground in code and design before building. The agent's
  default sweet spot — Research is the cheapest, highest-ROI step for a
  context-fresh agent and is rarely skipped.
- **`approach_only` → Proposal.** Intent and code are already understood (per
  Triage); only the approach is open. This is the **one tier that skips
  Research**, so Proposal self-grounds and **DesignGate is the backstop** if
  the change turns out deeper than triaged. There is intentionally no auto-loop
  back to Research; the gate / human handles that rare case.

### How "initiative" is absorbed (lightweight)

The old Initiative template's heavyweight *PRD → Issue Breakdown → multi-task
Execution → QA* sub-flow is **not** reproduced, because modern coding agents
decompose multi-step work well on their own. Instead:

- **Proposal emits an ordered `task_plan[]`** — the whole breakdown, as one
  output field (1 item for a single feature, N for a large initiative). Because
  it lives in Proposal's output, **Critique and Verify pressure-test the plan**
  for free.
- **Execution works through the plan**, driving sequencing itself.
- **Review's `rejected → Execution` loop** provides iteration / remediation.
- The old **PRD** node folds into Clarify (`success_outcome`, `constraints`) +
  Verify (acceptance signals); **Issue Breakdown** becomes `task_plan`; **QA**
  is covered by Validate Build + Review.

The big-vs-small distinction becomes the length of one list, decided by the
agent that is good at it — not a branch in the graph.

### Entry-step context continuity

The brainstorm-derived steps reference prior output in prose (no `{{}}` tokens),
relying on Orca's context assembly — so the validator does not block
mid-pipeline entry. The behavioral requirement is that each **entry-capable
step (Clarify, Research, Proposal)** treats **Triage's provisional brief** as
its upstream input when earlier steps were skipped. This is a one-line
instruction tweak per step plus the Triage brief carrying the union of
skipped-step keys (`problem`, `success_outcome`, `constraints`, `known_files`,
`risks`), marked provisional and superseded by the real steps when they run.

## Testing

- **Routing (unit):** `resolveSplitterNext` resolves each branch; throws on a
  branch with != 1 edge.
- **Validation (unit):** splitter well-formedness (2–8 unique branches, one edge
  per branch, ports match declared branches); rejects missing/duplicate/extra
  branch edges; gate and step edge rules still enforced; reachability and
  terminal-reachability hold across splitter branches.
- **Orchestrator:** `evaluate_split` selects a declared branch and routes;
  a proposal naming an undeclared branch is rejected and blocks the run;
  DesignGate `needs_work` loops to Proposal; all three tiers converge through
  Execution to the terminal step.
- **Contract round-trip:** `branches` + string ports survive serialize/parse and
  graph-sync.
- **Integration:** the Adaptive Delivery template installs, validates, and runs
  each tier to completion against a fixture goal.

## Rollout: retiring the consolidated templates

Once Adaptive Delivery is in and validated, the three templates it subsumes are
retired from the built-in catalog (`apps/daemon/src/workflows/templates/catalog.ts`):

- `orca/brainstorm` — *Brainstorm*
- `orca/feature-development` — *Feature Implementation*
- `orca/initiative-implementation` — *Initiative Implementation*

This is a **sequenced follow-up**, done after the new template ships and proves
out — not part of the splitter landing. Constraints:

- **Do not break in-flight runs.** Runs pin their template version (see
  `2026-06-15-run-version-pinning-design.md`), so retirement means removing the
  templates from the *installable catalog* for new goals, while any run that has
  already resolved one of these templates continues to completion. Verify the
  pinning path keeps a started run working when its source built-in is no longer
  in the catalog before removing anything.
- **Reseat the `recommended` flag.** Those three are currently
  `recommended: true`; Adaptive Delivery should take the recommended slot so new
  goals are steered to it.
- Leave the other built-ins (Bug Triage & Fix, Code Review, Refactor, Quality
  Coverage) untouched — they are not consolidated here.

## Future direction (not in scope)

For genuinely massive, multi-workspace initiatives, the sequential `task_plan`
loop is the wrong tool. The deliberate next step is a **fan-out / fan-in**
capability — a *sibling* primitive to the splitter (spawn **all** of N vs route
**one** of N):

- A **fan-out** node reads a runtime task list and instantiates a **child
  `WorkflowRun` per task**, each able to target a different workspace and run its
  own design→build→gate cycle.
- A **fan-in / join** node waits for the children and aggregates results to the
  parent.

This requires parent↔child run relationships, status aggregation, and a
**dynamically materialized** executed graph (today every graph is static and
validated at authoring time) — a substantial layer deferred on purpose. The
seam already exists: the graph validator's terminal-reachability is
branch-source-agnostic and explicitly anticipates step fan-out, and workspaces
are first-class. The alternative of parallel cursors *within one run* is
explicitly rejected — it breaks the single-cursor invariant the orchestrator is
built on; child runs give the same parallelism with better isolation.
