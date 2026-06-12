# Feature Development Workflow and Graph Routing

**Date:** 2026-06-12
**Status:** Design approved; ready for implementation planning

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

### Terminal Steps

Any normal executable step may be marked `terminal: true`. A valid template has
exactly one terminal step.

The terminal step runs normally: it receives context, may ask material
questions, emits schema-validated output, proposes ledger updates, and is
scored. The workflow run completes only after that step finishes successfully
and its ledger update is committed.

The terminal designation is explicit. It is not inferred from the step name or
from a missing outgoing edge.

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

## Revisited Steps

Routing back to a step creates a new step-run attempt. Earlier attempts, outputs,
scores, and gate decisions remain immutable.

The new attempt receives bounded repair context:

- original goal and constraints;
- the step's previous output;
- the rejecting gate's reason;
- latest downstream findings;
- relevant committed ledger records;
- outputs from the current traversal needed for the repair.

The step does not receive an unbounded raw workflow transcript.

## Platform-Managed Workflow Ledger

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
implementation. After its output and ledger proposals validate and its result is
scored, the engine completes the workflow run.

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

Template save rejects graphs that violate any of these rules:

- exactly one terminal step exists;
- the terminal step has no outgoing edges;
- every nonterminal step has exactly one outgoing edge;
- every gate has both `approved` and `rejected` outcomes;
- each gate outcome has exactly one destination;
- direct step edges are unconditional;
- no exact duplicate directed edge exists;
- no self-edge exists;
- every edge references existing nodes;
- every step node references an existing step template;
- schema references resolve to output available on every incoming path or to
  platform context;
- all authored output schemas are valid.

Backward edges and cycles are valid. This phase does not impose a maximum number
of visits.

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
- gate `approved` routing;
- gate `rejected` backward routing;
- repeated Execution and Validation attempts;
- bounded repair-context assembly;
- terminal step completion;
- template rejection for malformed gate ports and terminal configuration;
- ledger proposal review, validation, versioning, and replay safety;
- gate reads from committed, not proposed, ledger state;
- step scoring on every successful executable attempt;
- no gate scoring;
- restart recovery at step, gate, ledger-commit, and transition boundaries;
- desktop authoring of gate ports, backward edges, and terminal steps.

## Migration and Compatibility

Existing templates without a graph continue to materialize their current linear
step order as unconditional edges. Existing graphs that contain gate nodes with
free-form `condition` fields require migration to gate instructions and explicit
`approved` and `rejected` edges before they can execute as graph-authoritative
templates.

Step ordinals remain for stable ordering, display, and initial-entry selection,
but no longer select the next runtime step once graph execution is enabled.
