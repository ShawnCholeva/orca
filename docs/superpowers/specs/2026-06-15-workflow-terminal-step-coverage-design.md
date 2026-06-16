# Workflow Terminal-Step Coverage — Design

**Date:** 2026-06-15
**Status:** Approved (design)

## Problem

Every Orca workflow needs at least one terminal ("Done") state, and every branch
through a workflow must end at a terminal. Today this is only partially true:

- **Graph workflows** (Feature Implementation, Initiative Implementation) require
  *exactly one* `terminal: true` node via `validateGraph` (validate-graph.ts:31).
- **Graph-null workflows** (Brainstorm, Bug Triage & Fix, Code Review, Refactor,
  Quality Coverage) never run graph validation. `materializeLinearGraph`
  (graph-routing.ts:27) implicitly marks the highest-ordinal step terminal, so the
  terminal is whatever the last step happens to be — which may be a *working* step
  (`report`, `confirm_green`, `verify`) rather than a deliberate Done state.

Two concrete gaps:

1. **Built-ins:** Bug Triage & Fix, Code Review, and Quality Coverage have no
   dedicated `Done` step. They end on a working step.
2. **Validation:** the "exactly one terminal" rule is wrong in two ways. It is too
   strict (a graph may legitimately have multiple terminals — e.g. a gate routing
   `approved → Done` and `rejected → Abandoned`) and too weak (it counts terminals
   globally but does not verify each *branch* reaches one — a gate's `rejected`
   branch can route into a terminal-less cycle and still pass).

## Mental model

Every workflow **is a graph**; "linear" is simply a graph with no gates or
branches. `graph: null` is a compact encoding of "a linear graph whose terminal is
the last step," materialized at runtime by `materializeLinearGraph`. The design
converges the code onto this model: every workflow has an explicit terminal, and
the terminal invariant is enforced uniformly on the *effective* graph.

## Scope decisions (confirmed)

- **Definition of "has a terminal":** every workflow ends in a dedicated terminal
  step; every branch must reach a terminal.
- **Enforcement:** hard error (400) on create/update, applied to the effective
  graph for *every* workflow, not just ones carrying an explicit graph.
- **Multiple terminals allowed:** the rule is "≥1 terminal AND every reachable node
  can reach a terminal," not "exactly one terminal."
- **Parallel fan-out:** validation is written *fan-out-ready* (the
  terminal-reachability rule is branch-source-agnostic — it covers gate branches and
  step fan-out identically). But steps stay restricted to **one outgoing edge**, so
  the single-cursor execution engine stays coherent and no unrunnable graph can be
  authored. Concurrent/parallel step execution is explicitly **out of scope**.
- **No contract change, no DB migration.** `materializeLinearGraph` stays as the
  linear encoding.

## Changes

### 1. Validation rule (`apps/daemon/src/workflows/graph/validate-graph.ts`)

Replace the single terminal-count rule:

```
exactly one terminal step is required (found N)   // current, lines 31-33
```

with two rules:

- **At least one terminal:** `terminals.length >= 1`, else
  `"at least one terminal step is required (found 0)"`.
- **Terminal-reachability:** every node reachable from the initial node must have a
  path to *some* terminal node. Compute the set of nodes that can reach a terminal
  via reverse BFS from all terminal nodes over reversed edges; any forward-reachable
  node not in that set yields
  `"branch from '<id>' never reaches a terminal step"`.

Unchanged:

- Terminal steps have 0 outgoing edges; **non-terminal steps have exactly one**
  outgoing edge (keeps fan-out unauthorable); gates have one `approved` + one
  `rejected` edge.
- Edge integrity, unknown-step-template, forward reachability-from-initial,
  schema-reference checks.

### 2. Apply validation to every workflow (`apps/daemon/src/workflows/templates/routes.ts`)

Today `validateGraph` runs only when `parsed.data.graph` is truthy (routes.ts:101,
127). Change both the POST and PATCH paths to validate the **effective graph**:
materialize the linear graph from steps when no explicit graph is supplied, then run
`validateGraph` / `validateSchemaReferences` on it. Result: the terminal invariant
is a uniform hard error for every workflow. Graph-null linear drafts still pass
(their materialized last step is the terminal), so simple linear authoring keeps
working.

### 3. Built-in catalog (`apps/daemon/src/workflows/templates/catalog.ts`)

Every workflow is a graph; linear ones are just graphs without gates/branches. Give
all 7 built-ins **explicit graphs** with an explicit `terminal: true` node — no
built-in relies on `graph: null` / runtime materialization. `materializeLinearGraph`
remains only as a back-compat shim for any legacy stored null graphs.

- **Bug Triage & Fix, Code Review, Quality Coverage:** add a dedicated `Done` step
  (finalize/record outcome + `handoff`, mirroring the existing Brainstorm/Refactor
  `Done` steps and their `LIGHT` agent preference), and author an explicit linear
  graph chaining the steps and ending in `done` (`terminal: true`).
- **Brainstorm, Refactor:** author explicit linear graphs that chain their existing
  steps and mark their existing `done` step `terminal: true` (they currently have no
  graph). Their steps are otherwise unchanged.
- **Feature Implementation, Initiative Implementation:** unchanged (already explicit
  graphs with a terminal `done`).
- **Bump `version` 1 → 2** for every linear built-in (all five:
  `orca/brainstorm`, `orca/bug-triage-fix`, `orca/code-review`, `orca/refactor`,
  `orca/quality-coverage`), because each gains a graph (and three gain a step) and
  `upsertBuiltInTemplate` is version-guarded (`existing.version >= def.version`
  no-ops; usecases.ts:184) — existing installs would otherwise not re-seed.

All built-ins satisfy the new rule: each has a terminal that every node can reach
(Feature's `rejected → execution` loop still reaches `done` via the gate).

### 4. Desktop graph materialization (`apps/desktop/src/workflows/graph-sync.ts`)

The desktop always persists a non-null materialized graph on save (TemplateDetail.tsx),
but `buildInitialGraph` and `reconcileGraph` never set a terminal node — so a
default new workflow currently produces a graph with zero terminals. Under the new
uniform validation that is a hard 400. Fix the materialization to default a terminal,
mirroring the daemon's `materializeLinearGraph`:

- **`buildInitialGraph`:** mark the last (highest-index) step node `terminal: true`.
- **`reconcileGraph`:** preserve any existing terminal flag; if no surviving step
  node is terminal (e.g. the terminal step was deleted, or a legacy graph had none),
  mark the last step node `terminal: true`. This keeps exactly the author's choice
  when they set one, and otherwise guarantees a terminal exists.

### 5. Tests

- `validate-graph.test.ts`: update the assertion tied to the old "exactly one
  terminal" message; add cases for ≥1 terminal (multiple terminals pass), a
  terminal-less gate branch / cycle (fails with the branch message).
- `catalog.test.ts`: `code-review` stepCount 3 → 4; every built-in now has a non-null
  `graph`, so the existing per-definition `validateGraph` assertion runs for all 7;
  add an assertion that each built-in graph has ≥1 terminal step reachable from every
  node.
- `routes.test.ts`: a graph-null create/update materializes a terminal and succeeds;
  a workflow whose only branch never reaches a terminal returns 400 `invalid_graph`.
- `graph-sync.test.ts`: `buildInitialGraph` marks the last step terminal;
  `reconcileGraph` defaults a terminal when none survives and preserves an existing one.

## Out of scope

- Parallel/concurrent step execution (multi-cursor traversal, join semantics).
- Step-level `terminal` marker on the step contract (graph node `terminal` stays the
  single source of truth).
- DB migration of existing user templates (validation applies on next edit).
- **Pinning runs to `template_version` (planned fast-follow).** The runtime loads the
  *live* template (`getTemplateById(db, run.templateId)`), so bumping the three
  built-ins that gain a `Done` step (v1 → v2) means a run already in flight on the old
  version will, after finishing its previously-terminal last step, resolve the new
  edge to `Done` and dispatch it. This is a pre-existing live-template-loading
  property; this change is the first to trigger a structural mid-run graph change.
  Accepted for this branch (the run gains a finalize step). A separate feature will
  snapshot the template into the run (new `workflow_runs` columns + migration + an
  orchestrator read-path change) so runs execute against their pinned version — no
  template version history is stored today, so a lookup-by-version is not possible.
