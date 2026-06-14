# Feature Development Workflow and Graph Routing

**Date:** 2026-06-12
**Status:** Design revised after codebase review; ready for phased implementation planning

See [Implementation Phases](#implementation-phases) for the Phase 1 / 2 / 3
boundaries. Phase 1 (routing) and Phase 2 (ledger) are separately plannable.

## Problem

Orca workflow templates currently store a visual graph, but workflow execution
still advances linearly by step ordinal. Gate nodes are editable on the canvas,
but their free-form conditions are not executed. This prevents workflows from
routing backward for remediation or branching through an orchestrator decision.

The new Feature Development workflow needs this loop:

```text
Analysis -> Execution -> Validation -> Release Readiness Gate
                 ^                       |
                 +------ rejected -------+
                                         |
                                      approved
                                         |
                                         v
                                   Done [terminal]
```

Validation must remain independent and read-only. When it finds an issue, the
workflow must revisit Execution with the rejection reason and findings, then
run Validation again.

The routing capability must be generic enough for any workflow. The design must
also preserve useful evidence for Orca's existing step-scoring system and
establish durable workflow state that can later feed a cross-goal knowledge
graph.

## Goals

- Make the authored workflow graph authoritative for runtime routing.
- Preserve direct step-to-step edges as unconditional transitions.
- Execute gates through the orchestrator and constrain them to authored routes.
- Support forward and backward transitions between arbitrary workflow nodes.
- Keep every step attempt immutable when a node is revisited.
- Allow any executable step to be marked terminal.
- Give every workflow run a platform-managed durable ledger.
- Keep worker agents as evidence producers, not durable-state owners.
- Score executable steps only.
- Define the Feature Development workflow's instructions and output schemas.

## Non-Goals

- No visit limits or loop caps in this phase.
- No knowledge graph implementation.
- No cross-goal context retrieval.
- No user-managed simple/complex workflow modes.
- No score-based routing.
- No gate scoring.
- No arbitrary agent-selected destinations.

## Core Model

### Nodes

The workflow graph has two executable runtime node kinds:

- **Step:** launches an agent, validates structured output, reviews proposed
  ledger updates, and receives an independent step score.
- **Gate:** asks the orchestrator to select `approved` or `rejected` from the
  gate's instructions and committed workflow context. It does not launch a
  worker and is not scored.

The first step remains the lowest-ordinal step in this phase. After startup,
the graph, rather than ordinal order, determines every transition.

### Edges

- A direct `Step -> Step` edge is unconditional.
- A `Step -> Gate` edge is unconditional.
- Every nonterminal step has exactly one outgoing edge.
- Every gate exposes exactly two named ports: `approved` and `rejected`.
- Each gate port has exactly one configured destination.
- Gate destinations may be steps or other gates.
- Backward edges are valid.
- A terminal step has no outgoing edges.

Agents and the orchestrator never return arbitrary destination IDs. A gate
returns one of its declared outcomes, and the engine resolves the corresponding
edge.

#### Edge representation (contract change)

The current contract stores edges as unlabeled directed pairs
(`WorkflowGraphEdge = tuple([nodeId, nodeId])` in
`packages/contracts/src/workflows/index.ts`). An unlabeled pair cannot tell the
engine which of a gate's two outgoing edges is `approved` and which is
`rejected`, so port resolution is impossible under the current shape.

Replace the tuple with a labeled edge object:

```text
WorkflowGraphEdge {
  from: nodeId
  to: nodeId
  port?: "approved" | "rejected"   // required iff `from` is a gate node
}
```

- A step's single outgoing edge omits `port`.
- A gate has exactly two outgoing edges, one with `port: "approved"` and one
  with `port: "rejected"`.
- The engine resolves a gate outcome to the unique outgoing edge whose `port`
  matches the returned outcome.

This is a breaking change to the persisted `graph_json` shape. Existing graphs
storing two-element arrays are migrated to `{ from, to }` (no `port`) for step
edges; gate edges that previously had no port are reconstructed during the gate
migration (see [Migration and Compatibility](#migration-and-compatibility)).
The desktop graph editor (`apps/desktop/src/workflows/WorkflowFlow.tsx`,
`graph-sync.ts`) must emit and consume the labeled shape.

### Terminal Steps

Any normal executable step may be marked `terminal: true`. A valid template has
exactly one terminal step.

`terminal` is a routing property, so it lives on the **graph node**, not on the
shared `WorkflowStepTemplate`:

```text
WorkflowGraphNode {
  id
  type: "step" | "gate"
  name
  stepId?         // step nodes: references a WorkflowStepTemplate
  instructions?   // gate nodes only (replaces `condition`)
  terminal?: boolean   // step nodes only; exactly one node per template is true
}
```

A step node may also be referenced by more than one node only through distinct
node ids; the `terminal` flag is per node. The desktop step detail edits this
flag through the node, even though the rest of the step's content
(instructions, output schema, agent preferences) lives on the referenced
`WorkflowStepTemplate`.

The terminal step runs normally: it receives context, may ask material
questions, emits schema-validated output, proposes ledger updates, and is
scored. The workflow run completes only after that step finishes successfully
and its ledger update is committed (see
[Run Completion](#run-completion-and-the-mark-done-yield)).

The terminal designation is explicit. It is **not** inferred from the step name
or from a missing outgoing edge.

#### Replacing ordinal advancement

Today the engine advances by `template.steps.find(s => s.ordinal === current.ordinal + 1)`
in two places — the free function `advanceToNextStep`
(`apps/daemon/src/workflows/steps/usecases.ts`) and the orchestrator's
`commitAdvanceOrComplete` (`apps/daemon/src/workflows/orchestrator/service.ts`) —
and infers run completion from "no higher ordinal." Both sites must be replaced
with graph traversal that resolves the current node's outgoing edge (or a gate
outcome) to the next node, and detect completion from the explicit `terminal`
flag rather than ordinal exhaustion. Ordinal is retained only for stable
ordering, display, and initial-entry selection.

## Gate Execution

When a completed step routes to a gate:

1. The engine loads the gate instructions.
2. The engine supplies the orchestrator with the goal, source step output,
   relevant committed ledger state, prior gate decisions, and available
   acceptance evidence.
3. The orchestrator returns:

```text
outcome: "approved" | "rejected"
reason
issue_refs?: string[]
inputs_considered: string[]
```

4. The engine validates that the outcome is permitted.
5. The engine records the decision, reason, selected edge, inputs, and ledger
   version.
6. The engine follows the edge configured for that outcome.

The orchestrator performs the judgment. The engine owns transition validity and
state changes.

A gate may ask the user only when existing context cannot support a reliable
decision and the answer would materially affect routing.

#### Gate runtime state and persistence

Gates do not launch a worker and produce no `workflow_step_run`. The current
runtime has only one progress cursor — `workflow_runs.current_step_run_id`,
which references `workflow_step_runs` — so a run that is mid-gate has nowhere to
record its position, and boot reconciliation
(`apps/daemon/src/workflows/reconcile.ts`) would misclassify it as
`daemon_restart_state_drift`. The design adds:

- A run-level node cursor: `workflow_runs.current_node_id` and
  `current_node_kind ("step" | "gate")`. When the cursor is a step,
  `current_step_run_id` continues to point at the active step run; when the
  cursor is a gate, `current_step_run_id` is null.
- A `workflow_gate_decisions` table holding one immutable row per gate
  evaluation: `id, goal_id, workflow_run_id, node_id, traversal_seq, outcome,
  reason, selected_edge_to, inputs_considered_json, issue_refs_json,
  ledger_version, created_at`.
- A `traversal_seq` monotonic counter per run, incremented on every node entry.
  It disambiguates repeated visits so two `rejected` evaluations of the same
  gate across loop iterations are distinct rows (the existing
  `workflow_decisions` unique index keys on
  `(run, step_run_id, decision_type, input_fingerprint)`; gate decisions carry a
  null `step_run_id`, so `traversal_seq` must enter the fingerprint to avoid
  collisions). `traversal_seq` is also the ordering signal repair context uses
  to find "latest downstream findings" (see [Revisited Steps](#revisited-steps)).

Boot reconciliation is updated: a run whose cursor is a gate is resumable (re-run
the gate evaluation idempotently), not drift. A gate decision and the resulting
cursor move to the destination node are persisted in a single transaction before
the destination begins.

#### Gate evaluation under supervision

The default supervision mode is `supervised`, which already pauses every step
completion at a "Continue" confirmation checkpoint. A gate decision is surfaced
the same way: in `supervised` mode the engine records the gate decision but
pauses at a confirmation activity showing the outcome, reason, and selected
destination before moving the cursor; in `unsupervised` mode the transition is
automatic. The orchestrator's gate judgment is a new orchestration decision kind
(see [Contract additions](#contract-additions)).

## Revisited Steps

Routing back to a step creates a new step-run attempt. Earlier attempts, outputs,
scores, and gate decisions remain immutable.

### Attempt numbering

`workflow_step_runs` already carries an `attempt` column with a unique index on
`(workflow_run_id, step_template_id, attempt)`. This is a clean substrate for
immutable revisits, but the current forward-advance path
(`insertStep`) always inserts `attempt = 1`, so naively routing back into a step
would violate the unique index. A revisit must compute
`attempt = max(existing attempts for (run, step_template)) + 1`. Only the
forward-advance insertion path needs this change; `retryStep` already increments.

### Repair context (graph-aware, not ordinal-windowed)

The new attempt receives bounded repair context:

- original goal and constraints;
- the step's previous output;
- the rejecting gate's reason;
- latest downstream findings;
- relevant committed ledger records;
- outputs from the current traversal needed for the repair.

The step does not receive an unbounded raw workflow transcript.

**Implementation note.** The current context assembler
(`collectPriorStepArtifacts` in `service.ts`) filters to artifacts whose owning
step has `ordinal < current.ordinal`. That filter is fundamentally incompatible
with backward routing: when the Release Readiness gate routes
`rejected -> Execution`, the findings that must drive the repair (Validation
output, the gate's reason) belong to nodes at *higher* ordinals and would be
excluded. Repair-context assembly must be reworked to be graph- and
attempt-aware — keyed on the current traversal (`traversal_seq`) and the
rejecting gate decision — rather than on an ordinal window.

## Platform-Managed Workflow Ledger

> **Phase 2.** The ledger is a self-contained subsystem (new tables, versioning,
> canonical-ID allocation, an orchestrator review step, and a change to the
> `<orca:step-complete>` completion convention). It is orthogonal to graph
> routing and ships after Phase 1. The routing loop in Phase 1 functions without
> it; gates read whatever committed records exist. See
> [Implementation Phases](#implementation-phases).

Every workflow run receives a durable, versioned ledger automatically. Users do
not classify workflows as simple or complex and do not manually enable the
ledger.

The ledger supports stable records for requirements, deliverables, findings,
decisions, evidence, artifacts, and their relationships. Workflow-specific
records may extend these concepts, but the platform owns IDs, validation,
versioning, and persistence.

### Update Ownership

```text
step agent proposes updates
  -> orchestrator reviews and normalizes
  -> engine validates and commits
  -> gates read committed ledger state
```

The step agent has the richest local task context, so it proposes updates. It
cannot mutate durable state directly. The orchestrator may accept, correct, or
reject proposals against the goal, prior ledger, and step instructions. The
engine validates identifiers, relationships, evidence references, and
operation legality before committing a new immutable ledger version.

Each executable step completion includes platform-managed ledger proposals:

```text
ledger_updates[] {
  operation: "create" | "update" | "link"
  record_id
  record_type
  status
  evidence_refs: string[]
  related_record_ids?: string[]
  note
}
```

For an update or link, `record_id` identifies an existing canonical record. For
a create, the worker may propose a local reference; the orchestrator normalizes
it and the engine allocates the canonical stable ID before commit. Subsequent
records and evidence use only the committed canonical ID.

These updates belong to the completion envelope rather than each user-authored
business output schema. Orca adds and validates the envelope for every workflow.

Today a step's `<orca:step-complete>` payload is parsed as the business output
and validated against the step's `outputSchema`
(`extractOrcaStepCompleteBlock` / `validateStepOutput`). The envelope changes
that contract: the worker emits `{ output, ledger_updates }`, the engine
validates `output` against the authored schema and `ledger_updates` against the
platform schema independently. This parsing change lands with Phase 2 and must
stay backward-compatible with steps that emit no `ledger_updates` (treated as an
empty array).

Invalid business output or ledger proposals revise the current step. Gates read
only committed ledger versions.

### Future Knowledge Graph Alignment

The ledger is authoritative for one workflow run. A future knowledge graph can
project durable entities and relationships across runs and goals:

```text
Goal
  -> Workflow Run
    -> Requirement
      -> Deliverable
        -> Decision
        -> Artifact
        -> Validation Evidence
        -> Finding
```

This phase does not build that projection or cross-run retrieval.

## Scoring

Only executable step attempts are scored. Gates produce auditable decision
records but no quality score.

Workers do not self-score. Their structured output, artifacts, assumptions,
warnings, validation evidence, and ledger proposals are evidence for the
orchestrator's existing independent score:

- output completeness;
- output correctness;
- instruction adherence;
- downstream readiness;
- risk level;
- overall success score and handoff readiness.

Low scores are recorded but do not change routing. Invalid or missing scoring
does not block an otherwise approved transition, matching the existing scoring
policy.

## Feature Development Template

### Graph

```text
Analysis -> Execution -> Validation -> Release Readiness Gate
                 ^                       |
                 +------ rejected -------+
                                         |
                                      approved
                                         |
                                         v
                                   Done [terminal]
```

### Shared Agent Behavior

Every executable step first uses available goal, workspace, prior-step, and
ledger context. It asks the user only when unresolved ambiguity would
materially affect correctness, scope, or a required decision. Otherwise it
proceeds autonomously.

### Analysis

**Instructions**

> Analyze the goal and current codebase without modifying implementation files.
> Resolve ambiguity by inspecting available context first; ask the user only
> when an unresolved question would materially affect correctness or scope.
> Identify requirements, acceptance criteria, relevant files, existing
> patterns, dependencies, risks, and non-goals. Produce the smallest complete
> implementation plan for the entire feature. The plan must be actionable by a
> fresh Execution agent and include verification for each task. Do not complete
> while material questions remain unresolved.

**Output schema**

```text
summary
requirements[] {
  requirement
  acceptance
}
implementation_plan[] {
  task
  files: string[]
  verification
}
files_in_scope: string[]
non_goals?: string[]
artifacts[] {
  type
  reference
  description
}
risks?: string[]
blockers?: string[]
assumptions?: string[]
handoff
```

### Execution

**Instructions**

> Implement the complete scoped feature from the Analysis plan. Follow existing
> codebase patterns and limit changes to the approved scope. On a repeated
> attempt, prioritize unresolved Validation findings and preserve
> already-correct work. Add or update appropriate tests, then run the relevant
> tests, type checks, lint checks, and build checks available in the repository.
> Ask the user only when ambiguity materially affects correctness or requires a
> product decision. Record skipped checks and blockers explicitly. Do not claim
> completion unless the implementation and required verification are complete.

**Output schema**

```text
summary
completed_requirements: string[]
changes[] {
  file
  description
  requirement_refs: string[]
}
validation[] {
  command
  result: "passed" | "failed" | "skipped"
  evidence
}
artifacts[] {
  type
  reference
  description
}
risks?: string[]
blockers?: string[]
assumptions?: string[]
handoff
```

Execution advances only when the complete scoped feature is implemented.
Unfinished work is a blocker and does not proceed to Validation.

On a repeated attempt, the engine supplies the prior Execution output, Release
Readiness rejection reason, Validation issues, and relevant committed ledger
records.

### Validation

**Instructions**

> Independently validate the implementation against the goal, Analysis
> requirements, acceptance criteria, and Execution evidence. Do not modify
> implementation files. Inspect the actual diff and relevant code, run
> appropriate tests and checks, and verify both expected behavior and meaningful
> failure cases. Treat skipped checks as unresolved unless they are genuinely
> inapplicable and justified. Report every actionable issue with severity,
> evidence, affected requirements, and the required correction. Ask the user
> only when ambiguity materially affects the verdict. Pass only when no
> unresolved issue prevents delivery.

**Output schema**

```text
summary
verdict: "passed" | "failed"
requirement_results[] {
  requirement_ref
  result: "passed" | "failed"
  evidence
}
checks[] {
  command
  result: "passed" | "failed" | "skipped"
  evidence
}
issues[] {
  severity: "critical" | "high" | "medium" | "low"
  finding
  evidence
  requirement_refs: string[]
  required_change
}
artifacts[] {
  type
  reference
  description
}
risks?: string[]
blockers?: string[]
handoff
```

Validation is read-only. It does not repair findings.

### Release Readiness Gate

**Instructions**

> Review the committed workflow ledger, Validation output, goal, and acceptance
> criteria. Select `approved` only when Validation passed and no unresolved
> blocker or delivery-preventing issue remains. Select `rejected` when Execution
> must address actionable findings. Include a concise reason and the issue
> references that must be resolved. Do not perform implementation or validation
> work in this gate. Ask the user only when the available evidence cannot
> support a reliable routing decision.

**Outcomes**

```text
approved -> Done
rejected -> Execution
```

The gate records:

```text
outcome: "approved" | "rejected"
reason
issue_refs?: string[]
inputs_considered: string[]
```

### Done

Done is a normal executable step with `terminal: true`.

**Instructions**

> Finalize the completed feature after Release Readiness approval. Summarize what
> was delivered, map the final implementation to the accepted requirements, and
> record the validation evidence. Create requested operational artifacts such as
> release notes or a commit when the goal or repository workflow requires them.
> Do not make additional feature changes. If finalization exposes a material
> implementation or validation problem, report it as a blocker rather than
> concealing it. Ask the user only when a required finalization decision cannot
> be inferred safely. Complete only when the durable outcome and artifacts are
> accurately recorded.

**Output schema**

```text
summary
delivered_requirements: string[]
validation_evidence: string[]
operational_artifacts[] {
  type
  reference
  description
}
limitations?: string[]
follow_up_work?: string[]
blockers?: string[]
handoff
```

Done may create finalization artifacts, but it must not change the feature
implementation.

### Run completion and the mark-done yield

After the terminal step's output and ledger proposals validate and its result is
scored, the run is *ready to complete* — but completion preserves Orca's
existing single user yield point. The terminal step does not silently
auto-complete the run; it produces the `mark_run_complete` decision and the
`complete_workflow_run` recommendation, and the `approval_mark_done` guardrail
still gates the final transition, exactly as the current "no higher ordinal"
final step does today (`commitAdvanceOrComplete`). In `supervised` mode the
terminal step also passes through the normal per-step Continue checkpoint first.
Graph routing changes how the terminal node is *identified* (explicit
`terminal` flag instead of ordinal exhaustion); it does not remove the
human-authoritative completion gate.

## Workflow Authoring UI

The canvas retains its current interaction model:

1. Add and position step or gate nodes.
2. Drag direct edges between nodes.
3. Click a step to edit its instructions, output schema, agent preferences, and
   terminal designation.
4. Click a gate to edit its name and orchestrator instructions.
5. Drag the visible `approved` and `rejected` ports to their destinations.

Direct step edges remain unlabeled because they are unconditional. Gate ports
carry the route label.

Gate conditions are replaced by instructions plus the fixed outcome ports. The
gate detail modal shows the decision record shape so authors understand what the
orchestrator must return.

Users do not configure ledger availability. The run UI can expose committed
ledger state, version history, step evidence, scores, and gate decisions without
requiring ledger fields in every authored schema.

## Template Validation

Template save **rejects** (HTTP 4xx) graphs that violate any of these rules.
This is a behavior change: today template save runs only
`validateTemplatePipeline`, which checks `{{key}}` interpolation and returns
non-blocking *warnings*; the stored `graph` is never structurally validated.
Graph validation is new, blocking, and runs on create and update.

- exactly one terminal step exists;
- the terminal step has no outgoing edges;
- every nonterminal step has exactly one outgoing edge;
- every gate has both `approved` and `rejected` outcomes;
- each gate outcome has exactly one destination;
- direct step edges carry no port; gate edges carry a valid port;
- no exact duplicate directed edge exists;
- no self-edge exists;
- every edge references existing nodes;
- every node is reachable from the initial (lowest-ordinal) step;
- every step node references an existing step template;
- schema references resolve (see below) or reference platform context;
- all authored output schemas are valid.

Backward edges and cycles are valid. This phase does not impose a maximum number
of visits.

### Schema reference resolution

"Schema references" are the existing `{{key}}` interpolation tokens in step
instructions, not a new typed-reference system. Under linear ordinal execution
`validateTemplatePipeline` resolves a token if any earlier-ordinal step produces
`key`. Under graph routing the rule becomes: a token `{{key}}` is resolvable if
**every** path from the initial node to the referencing node passes through a
node that produces `key` in its output schema, or `key` is platform context.
Cycles do not invalidate a token: once a key is produced on all incoming paths
it stays available on revisits. Tokens that are resolvable on some but not all
incoming paths are a validation error, because a backward-routed attempt could
reach the step without the producer having run on that path.

## Runtime Failure Handling

- Invalid step output revises the current step.
- Invalid ledger proposals revise the current step.
- Invalid gate decisions retry gate evaluation.
- A blocked step pauses the workflow.
- A revisited step creates a new immutable attempt.
- Restart recovery resumes the current step or gate without duplicating a
  committed output, ledger version, score, or transition.
- Gate decisions and transitions are persisted before the destination begins.

## Verification

Coverage must include:

- direct unconditional step-to-step routing;
- gate outcome resolves to the correct port-labeled edge;
- gate `approved` routing;
- gate `rejected` backward routing;
- repeated Execution and Validation attempts;
- revisiting a step increments `attempt` and does not violate the step-run
  unique index;
- repeated gate evaluations across loops produce distinct decisions via
  `traversal_seq`;
- bounded repair-context assembly includes downstream findings on a backward
  route (not just lower-ordinal artifacts);
- terminal step completion still routes through the `mark_run_complete`
  approval / `approval_mark_done` guardrail;
- template rejection for malformed gate ports, terminal configuration,
  unreachable nodes, and unresolvable `{{key}}` references on some incoming path;
- ledger proposal review, validation, versioning, and replay safety;
- gate reads from committed, not proposed, ledger state;
- step scoring on every successful executable attempt;
- no gate scoring;
- restart recovery at step, gate (cursor = gate), ledger-commit, and transition
  boundaries, including no misclassification as drift mid-gate;
- desktop authoring of gate ports, backward edges, and terminal steps.

## Migration and Compatibility

Existing templates without a graph continue to materialize their current linear
step order as unconditional edges. Existing graphs that contain gate nodes with
free-form `condition` fields require migration to gate `instructions` and
explicit `approved` and `rejected` port edges before they can execute as
graph-authoritative templates.

The built-in `orca/engineering` template is seeded with `graph_json = NULL` and
no terminal flag; it continues to run by materialized linear order unless and
until it is reseeded with an explicit graph. No runtime regression: gates are
inert today, so no existing run depends on gate execution.

Step ordinals remain for stable ordering, display, and initial-entry selection,
but no longer select the next runtime step once graph execution is enabled.

### Contract additions

Additive changes required for Phase 1:

- `WorkflowGraphEdge`: tuple → labeled object `{ from, to, port? }` (see
  [Edge representation](#edge-representation-contract-change)); migrate stored
  two-element arrays to `{ from, to }`.
- `WorkflowGraphNode`: add `instructions?` (gate nodes, replacing `condition`,
  bounded like step instructions) and `terminal?` (step nodes).
- `OrchestrationDecisionKind`: add a gate-evaluation kind (e.g.
  `evaluate_gate`).
- `WorkflowDecisionType`: add a gate routing decision type (e.g.
  `evaluate_gate`).
- `workflow_runs`: add `current_node_id`, `current_node_kind`.
- New table `workflow_gate_decisions` and a per-run `traversal_seq` counter.

DB migrations are append-only numbered SQL files registered in `migrations.ts`;
the `current_node_*` columns and `workflow_gate_decisions` table are one new
migration each.

## Security

A step's free-text output feeds the orchestrator's gate decision. A faulty or
adversarial worker could try to steer routing through its output. The blast
radius is bounded — the orchestrator may only return `approved` or `rejected`,
the engine rejects any other value, and the engine (not the worker) owns the
edge resolution and state change — but gate instructions should frame the step
output as untrusted evidence rather than as directives, consistent with the
existing prompt conventions.

## Implementation Phases

This design is intentionally split; it is not one plan.

- **Phase 1 — Graph-authoritative routing (no ledger).** Edge/port contract,
  `terminal` node flag, graph traversal replacing ordinal advancement, gate
  execution with the `workflow_gate_decisions` table + run node cursor +
  `traversal_seq`, blocking template validation, graph-aware repair context,
  revisit attempt numbering, supervised-mode gate behavior, restart recovery at
  step/gate/transition boundaries, and the desktop authoring changes (gate
  ports, backward edges, terminal designation). Delivers the
  Analysis → Execution → Validation → Gate loop end to end.
- **Phase 2 — Platform-managed ledger.** Tables, versioning, canonical-ID
  allocation, orchestrator review/normalize, and the `<orca:step-complete>`
  completion-envelope change. Orthogonal to Phase 1; the routing loop runs
  without it.
- **Phase 3 — Feature Development template content.** The instructions and
  output schemas in [Feature Development Template](#feature-development-template).
  This is template data, not engine work; it depends on Phase 1 (and optionally
  the Phase 2 envelope) and could be authored as a custom template once Phase 1
  lands.

The cross-goal knowledge graph remains a non-goal in all phases.
