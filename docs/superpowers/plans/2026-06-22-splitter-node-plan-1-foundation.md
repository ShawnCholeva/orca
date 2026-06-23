# Splitter Node — Plan 1: Data & Pure Logic Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `splitter` node type's data layer and pure routing/validation/persistence logic, so a splitter graph can be authored, validated, routed, and have its decisions persisted — all unit-testable without the orchestrator.

**Architecture:** A splitter is the N-way generalization of a gate. Contracts gain a third node type, an author-named `branches` list, generalized string edge ports, an `evaluate_split` decision kind, and `SplitEvaluation` request/proposal schemas. The daemon gains a `validateGraph` splitter arm, a `resolveSplitterNext` router, and a `workflow_split_decisions` table with record/projection helpers mirroring gates. Gates are left untouched.

**Tech Stack:** TypeScript, Zod (contracts), better-sqlite3 (daemon), Vitest.

## Global Constraints

- Branch label bounds: **min 2, max 8 branches** per splitter; each label **1–60 chars**. Copied to constants `WORKFLOW_SPLITTER_MIN_BRANCHES = 2`, `WORKFLOW_SPLITTER_MAX_BRANCHES = 8`, `WORKFLOW_SPLITTER_MAX_BRANCH_LABEL_CHARS = 60`.
- **Do not modify gate behavior, the gate decision table, or built-in templates.** Splitter persistence lives in a separate `workflow_split_decisions` table.
- Edge `port` becomes a free string at the schema level; per-node-type semantics are enforced in `validateGraph`, not in Zod.
- The daemon imports `@orca/contracts` from its built `dist`. After changing contracts (Tasks 1–2), run `pnpm --filter @orca/contracts build` before the daemon tasks (3–5) so the new types resolve.
- Test commands: contracts → `pnpm --filter @orca/contracts test`; daemon → `pnpm --filter @orca/daemon test`.
- Scope of this plan ends at pure logic. Orchestrator wiring (`evaluate_split`), desktop UI, and the Adaptive Delivery template are Plans 2–4.

## File Structure

- Modify `packages/contracts/src/workflows/index.ts` — node/edge schemas, branch constants, decision-kind enums, `SplitEvaluationRequest`/`SplitEvaluationProposal`.
- Modify `packages/contracts/src/workflows/graph-contract.test.ts` — schema tests.
- Modify `packages/contracts/src/workflows/index.ts` is also re-exported by the package root; no extra wiring needed.
- Modify `apps/daemon/src/workflows/graph/validate-graph.ts` — splitter arm.
- Modify `apps/daemon/src/workflows/graph/validate-graph.test.ts` — splitter validation tests.
- Modify `apps/daemon/src/workflows/graph/graph-routing.ts` — `Destination`, `resolveSplitterNext`, `classify`.
- Modify `apps/daemon/src/workflows/graph/graph-routing.test.ts` — routing tests.
- Create `apps/daemon/migrations/0038_workflow_split_decisions.sql` — new table.
- Modify `apps/daemon/src/migrations.ts` — register the migration file.
- Create `apps/daemon/src/workflows/splitters/usecases.ts` — `recordSplitDecision`.
- Create `apps/daemon/src/workflows/splitters/projection.ts` — `listSplitDecisionsForRun`.
- Create `apps/daemon/src/workflows/splitters/usecases.test.ts` — persistence tests.

---

### Task 1: Contracts — node type, branches field, generalized port

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts` (around lines 27–46 constants, 293–322 node/edge schemas)
- Test: `packages/contracts/src/workflows/graph-contract.test.ts`

**Interfaces:**
- Produces: `WorkflowGraphNode.type` now `"step" | "gate" | "splitter"`; `WorkflowGraphNode.branches?: string[]`; `WorkflowGraphEdge.port?: string`; exported consts `WORKFLOW_SPLITTER_MIN_BRANCHES`, `WORKFLOW_SPLITTER_MAX_BRANCHES`, `WORKFLOW_SPLITTER_MAX_BRANCH_LABEL_CHARS`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/contracts/src/workflows/graph-contract.test.ts`:

```typescript
describe("WorkflowGraphNode splitter", () => {
  it("parses a splitter node with branches", () => {
    const node = WorkflowGraphNode.parse({
      id: "route",
      type: "splitter",
      name: "Route",
      instructions: "pick a tier",
      branches: ["clarify_first", "ground_and_design", "approach_only"],
    });
    expect(node.type).toBe("splitter");
    expect(node.branches).toEqual(["clarify_first", "ground_and_design", "approach_only"]);
  });

  it("rejects a splitter declaring fewer than 2 branches", () => {
    expect(() =>
      WorkflowGraphNode.parse({ id: "r", type: "splitter", name: "R", branches: ["only"] })
    ).toThrow();
  });

  it("accepts an arbitrary string edge port (splitter branch label)", () => {
    const edge = WorkflowGraphEdge.parse({ from: "route", to: "clarify", port: "clarify_first" });
    expect(edge.port).toBe("clarify_first");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/contracts test -- graph-contract`
Expected: FAIL — `type: "splitter"` not in enum; `branches` stripped by `.strict()`; `port: "clarify_first"` rejected by the `approved|rejected` enum.

- [ ] **Step 3: Add branch constants**

In `packages/contracts/src/workflows/index.ts`, after line 45 (`WORKFLOW_GATE_MAX_INSTRUCTIONS_CHARS`), add:

```typescript
export const WORKFLOW_SPLITTER_MIN_BRANCHES = 2;
export const WORKFLOW_SPLITTER_MAX_BRANCHES = 8;
export const WORKFLOW_SPLITTER_MAX_BRANCH_LABEL_CHARS = 60;
```

- [ ] **Step 4: Generalize the node type and add `branches`**

In `WorkflowGraphNode` (around line 293), change `type` and add `branches`:

```typescript
export const WorkflowGraphNode = z
  .object({
    id: Id100,
    type: z.enum(["step", "gate", "splitter"]),
    name: z.string().max(100).default(""),
    stepId: Id100.optional(),
    // Legacy gate field, retained read-only so pre-migration graphs still parse.
    condition: z.string().max(WORKFLOW_GATE_MAX_CONDITION_CHARS).optional(),
    // Gate + splitter nodes: orchestrator routing instructions.
    instructions: z.string().max(WORKFLOW_GATE_MAX_INSTRUCTIONS_CHARS).optional(),
    // Splitter nodes: author-named branch labels (one per outgoing port).
    branches: z
      .array(z.string().min(1).max(WORKFLOW_SPLITTER_MAX_BRANCH_LABEL_CHARS))
      .min(WORKFLOW_SPLITTER_MIN_BRANCHES)
      .max(WORKFLOW_SPLITTER_MAX_BRANCHES)
      .optional(),
    // Step nodes: explicit terminal designation. Exactly one per valid template.
    terminal: z.boolean().optional(),
  })
  .strict();
```

- [ ] **Step 5: Generalize the edge port**

In `WorkflowGraphEdge` (around line 318), change the `port` line from the enum to a bounded string:

```typescript
      port: z.string().min(1).max(WORKFLOW_SPLITTER_MAX_BRANCH_LABEL_CHARS).optional(),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @orca/contracts test -- graph-contract`
Expected: PASS (existing gate/edge tests still green — `"approved"`/`"rejected"` are valid strings).

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/graph-contract.test.ts
git commit -m "feat(contracts): add splitter node type, branches, generalized edge port"
```

---

### Task 2: Contracts — decision kinds + SplitEvaluation schemas

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts` (decision-kind enums ~144–207; new schemas after `GateEvaluationRequest` ~801)
- Test: `packages/contracts/src/workflows/graph-contract.test.ts`

**Interfaces:**
- Produces: `OrchestrationDecisionKind` and `WorkflowDecisionType` both include `"evaluate_split"`; `SplitEvaluationProposal` = `{ selectedBranch: string; reason: string; inputsConsidered: string[] }`; `SplitEvaluationRequest` with `splitter`, `goal`, `sourceStepOutput`, `priorDecisions`, `committedLedger`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/contracts/src/workflows/graph-contract.test.ts` (and add `SplitEvaluationProposal`, `SplitEvaluationRequest` to the import from `./index.js`):

```typescript
describe("SplitEvaluation schemas", () => {
  it("includes evaluate_split in the decision-kind enum", () => {
    expect(OrchestrationDecisionKind.parse("evaluate_split")).toBe("evaluate_split");
  });

  it("parses a split proposal", () => {
    const p = SplitEvaluationProposal.parse({
      selectedBranch: "ground_and_design",
      reason: "intent is clear; ground in code before designing",
      inputsConsidered: ["triage"],
    });
    expect(p.selectedBranch).toBe("ground_and_design");
  });

  it("parses a split request with a null source output", () => {
    const r = SplitEvaluationRequest.parse({
      splitter: { nodeId: "route", name: "Route", instructions: "pick", branches: ["a", "b"] },
      goal: { id: "g", description: "do the thing" },
      sourceStepOutput: null,
      priorDecisions: [],
      committedLedger: [],
    });
    expect(r.splitter.branches).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/contracts test -- graph-contract`
Expected: FAIL — `evaluate_split` not in enum; `SplitEvaluationProposal`/`SplitEvaluationRequest` undefined.

- [ ] **Step 3: Add `evaluate_split` to both enums**

In `OrchestrationDecisionKind` (around line 144) add `"evaluate_split",` as a new member. In `WorkflowDecisionType` (around line 195) add `"evaluate_split",` as a new member.

- [ ] **Step 4: Add the SplitEvaluation schemas**

In `packages/contracts/src/workflows/index.ts`, immediately after `GateEvaluationRequest` (around line 801), add:

```typescript
export const SplitEvaluationProposal = z
  .object({
    selectedBranch: z.string().min(1).max(WORKFLOW_SPLITTER_MAX_BRANCH_LABEL_CHARS),
    reason: z.string().min(1).max(1024),
    inputsConsidered: z.array(z.string().min(1).max(128)).max(50),
  })
  .strict();
export type SplitEvaluationProposal = z.infer<typeof SplitEvaluationProposal>;

export const SplitEvaluationRequest = z
  .object({
    splitter: z
      .object({
        nodeId: Id100,
        name: z.string().max(100),
        instructions: z.string().max(WORKFLOW_GATE_MAX_INSTRUCTIONS_CHARS),
        branches: z
          .array(z.string().min(1).max(WORKFLOW_SPLITTER_MAX_BRANCH_LABEL_CHARS))
          .min(WORKFLOW_SPLITTER_MIN_BRANCHES)
          .max(WORKFLOW_SPLITTER_MAX_BRANCHES),
      })
      .strict(),
    goal: z.object({ id: Id, description: z.string().max(4000) }).strict(),
    sourceStepOutput: z.record(z.string(), z.unknown()).nullable(),
    priorDecisions: z
      .array(
        z
          .object({
            nodeId: Id100,
            selectedBranch: z.string().min(1).max(WORKFLOW_SPLITTER_MAX_BRANCH_LABEL_CHARS),
            reason: z.string().max(1024),
          })
          .strict()
      )
      .max(50),
    committedLedger: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            recordType: z.string().min(1).max(64),
            status: z.string().min(1).max(64),
            note: z.string().max(500),
          })
          .strict()
      )
      .max(35)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!hasMaxSerializedBytes(value, ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SplitEvaluationRequest too large" });
    }
  });
export type SplitEvaluationRequest = z.infer<typeof SplitEvaluationRequest>;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @orca/contracts test -- graph-contract`
Expected: PASS

- [ ] **Step 6: Build contracts so the daemon picks up the new types**

Run: `pnpm --filter @orca/contracts build`
Expected: exits 0; `packages/contracts/dist` updated.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/graph-contract.test.ts
git commit -m "feat(contracts): add evaluate_split decision kind and SplitEvaluation schemas"
```

---

### Task 3: Validation — splitter arm in `validateGraph`

**Files:**
- Modify: `apps/daemon/src/workflows/graph/validate-graph.ts:36-69` (the per-node `if step / else gate` block)
- Test: `apps/daemon/src/workflows/graph/validate-graph.test.ts`

**Interfaces:**
- Consumes: `WorkflowGraphNode.branches`, `WorkflowGraphEdge.port` from Task 1.
- Produces: `validateGraph` returns splitter rule violations; a well-formed splitter graph yields `[]`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/daemon/src/workflows/graph/validate-graph.test.ts`. Reuse the existing `step()` helper:

```typescript
const splitterSteps = [step("triage", 0), step("a", 1), step("b", 2), step("done", 3)];

const splitterValid: WorkflowGraph = {
  nodes: [
    { id: "triage", type: "step", name: "Triage", stepId: "triage" },
    { id: "route", type: "splitter", name: "Route", instructions: "pick", branches: ["go_a", "go_b"] },
    { id: "a", type: "step", name: "A", stepId: "a" },
    { id: "b", type: "step", name: "B", stepId: "b" },
    { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
  ],
  edges: [
    { from: "triage", to: "route" },
    { from: "route", to: "a", port: "go_a" },
    { from: "route", to: "b", port: "go_b" },
    { from: "a", to: "done" },
    { from: "b", to: "done" },
  ],
  positions: {},
};

describe("validateGraph splitter", () => {
  it("accepts a well-formed splitter graph", () => {
    expect(validateGraph(splitterValid, splitterSteps)).toEqual([]);
  });

  it("rejects a splitter with a missing branch edge", () => {
    const g = { ...splitterValid, edges: splitterValid.edges.filter((e) => e.port !== "go_b") };
    expect(validateGraph(g, splitterSteps)).toContain(
      "splitter 'route' must have exactly one 'go_b' edge (found 0)"
    );
  });

  it("rejects a splitter outgoing edge with an undeclared port", () => {
    const g = {
      ...splitterValid,
      nodes: splitterValid.nodes.map((n) => (n.id === "route" ? { ...n, branches: ["go_a", "go_b"] } : n)),
      edges: [...splitterValid.edges, { from: "route", to: "done", port: "go_c" }],
    };
    expect(validateGraph(g, splitterSteps)).toContain("splitter edge must carry a declared branch port: route -> done");
  });

  it("rejects a splitter with duplicate branch labels", () => {
    const g = {
      ...splitterValid,
      nodes: splitterValid.nodes.map((n) => (n.id === "route" ? { ...n, branches: ["go_a", "go_a"] } : n)),
    };
    expect(validateGraph(g, splitterSteps)).toContain("splitter 'route' has duplicate branch labels");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/daemon test -- validate-graph`
Expected: FAIL — splitter currently falls into the gate `else` arm and reports gate-port errors.

- [ ] **Step 3: Add the splitter arm**

In `apps/daemon/src/workflows/graph/validate-graph.ts`, replace the `} else {` gate block (lines 53–68) so the branching is `step` / `else if gate` / `else splitter`:

```typescript
    } else if (node.type === "gate") {
      for (const outcome of ["approved", "rejected"] as const) {
        const matching = out.filter((e) => e.port === outcome);
        if (matching.length !== 1) {
          errors.push(
            `gate '${node.id}' must have exactly one '${outcome}' edge (found ${matching.length})`
          );
        }
      }
      for (const e of out) {
        if (e.port !== "approved" && e.port !== "rejected") {
          errors.push(`gate edge must carry a valid port: ${e.from} -> ${e.to}`);
        }
      }
    } else {
      // splitter
      const branches = node.branches ?? [];
      if (branches.length < 2 || branches.length > 8) {
        errors.push(`splitter '${node.id}' must declare 2-8 branches (found ${branches.length})`);
      }
      const uniqueBranches = new Set(branches);
      if (uniqueBranches.size !== branches.length) {
        errors.push(`splitter '${node.id}' has duplicate branch labels`);
      }
      for (const label of uniqueBranches) {
        const matching = out.filter((e) => e.port === label);
        if (matching.length !== 1) {
          errors.push(
            `splitter '${node.id}' must have exactly one '${label}' edge (found ${matching.length})`
          );
        }
      }
      for (const e of out) {
        if (!e.port || !uniqueBranches.has(e.port)) {
          errors.push(`splitter edge must carry a declared branch port: ${e.from} -> ${e.to}`);
        }
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- validate-graph`
Expected: PASS (existing step/gate validation tests still green).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/graph/validate-graph.ts apps/daemon/src/workflows/graph/validate-graph.test.ts
git commit -m "feat(daemon): validate splitter nodes and their branch ports"
```

---

### Task 4: Routing — `resolveSplitterNext` and `Destination`

**Files:**
- Modify: `apps/daemon/src/workflows/graph/graph-routing.ts:7-10` (`Destination`), `:60-64` (`classify`), add `resolveSplitterNext`
- Test: `apps/daemon/src/workflows/graph/graph-routing.test.ts`

**Interfaces:**
- Consumes: generalized `port` from Task 1.
- Produces: `Destination` now includes `{ kind: "splitter"; nodeId: string }`; `resolveSplitterNext(graph, splitterNodeId, branch): Destination`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/daemon/src/workflows/graph/graph-routing.test.ts` (add `resolveSplitterNext` to the import):

```typescript
const splitterGraph: WorkflowGraph = {
  nodes: [
    { id: "triage", type: "step", name: "Triage", stepId: "triage" },
    { id: "route", type: "splitter", name: "Route", instructions: "pick", branches: ["go_a", "go_b"] },
    { id: "a", type: "step", name: "A", stepId: "a" },
    { id: "b", type: "step", name: "B", stepId: "b", terminal: true },
  ],
  edges: [
    { from: "triage", to: "route" },
    { from: "route", to: "a", port: "go_a" },
    { from: "route", to: "b", port: "go_b" },
    { from: "a", to: "b" },
  ],
  positions: {},
};

describe("resolveSplitterNext", () => {
  it("routes a selected branch to its destination step", () => {
    expect(resolveSplitterNext(splitterGraph, "route", "go_a")).toEqual({ kind: "step", nodeId: "a" });
  });

  it("classifies a step that follows a step into a splitter destination", () => {
    const dest = resolveStepNext(splitterGraph, "triage");
    expect(dest).toEqual({ kind: "splitter", nodeId: "route" });
  });

  it("throws when the branch has no edge", () => {
    expect(() => resolveSplitterNext(splitterGraph, "route", "go_c")).toThrow(
      "splitter route must have exactly one 'go_c' edge, found 0"
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/daemon test -- graph-routing`
Expected: FAIL — `resolveSplitterNext` undefined; `classify` returns `{ kind: "step" }` for the splitter node.

- [ ] **Step 3: Extend `Destination`**

In `apps/daemon/src/workflows/graph/graph-routing.ts`, update the `Destination` union (lines 7–10):

```typescript
export type Destination =
  | { kind: "step"; nodeId: string }
  | { kind: "gate"; nodeId: string }
  | { kind: "splitter"; nodeId: string }
  | { kind: "terminal" };
```

- [ ] **Step 4: Teach `classify` about splitters**

Replace `classify` (lines 60–64):

```typescript
function classify(graph: WorkflowGraph, toId: string): Destination {
  const node = nodeById(graph, toId);
  if (!node) throw new GraphRoutingError(`edge points to unknown node: ${toId}`);
  if (node.type === "gate") return { kind: "gate", nodeId: toId };
  if (node.type === "splitter") return { kind: "splitter", nodeId: toId };
  return { kind: "step", nodeId: toId };
}
```

- [ ] **Step 5: Add `resolveSplitterNext`**

After `resolveGateNext` (around line 98), add:

```typescript
/** Resolves the destination for a splitter branch via the branch-labeled edge. */
export function resolveSplitterNext(
  graph: WorkflowGraph,
  splitterNodeId: string,
  branch: string
): Destination {
  const out = graph.edges.filter((e) => e.from === splitterNodeId && e.port === branch);
  if (out.length !== 1) {
    throw new GraphRoutingError(
      `splitter ${splitterNodeId} must have exactly one '${branch}' edge, found ${out.length}`
    );
  }
  return classify(graph, out[0].to);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- graph-routing`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/workflows/graph/graph-routing.ts apps/daemon/src/workflows/graph/graph-routing.test.ts
git commit -m "feat(daemon): resolveSplitterNext and splitter routing destination"
```

---

### Task 5: Persistence — `workflow_split_decisions` table + helpers

**Files:**
- Create: `apps/daemon/migrations/0038_workflow_split_decisions.sql`
- Modify: `apps/daemon/src/migrations.ts:51` (register the file)
- Create: `apps/daemon/src/workflows/splitters/usecases.ts`
- Create: `apps/daemon/src/workflows/splitters/projection.ts`
- Test: `apps/daemon/src/workflows/splitters/usecases.test.ts`

**Interfaces:**
- Consumes: `nextTraversalSeq` from `apps/daemon/src/workflows/gates/usecases.js` (reused, not duplicated).
- Produces: `recordSplitDecision(db, now, input): string` with `SplitDecisionInput` (`selectedBranch` instead of gate's `outcome`, no `issueRefs`); `listSplitDecisionsForRun(db, runId): SplitDecisionRecord[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/splitters/usecases.test.ts`:

```typescript
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../migrations.js";
import { nextTraversalSeq } from "../gates/usecases.js";
import { recordSplitDecision } from "./usecases.js";
import { listSplitDecisionsForRun } from "./projection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../../migrations");

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, MIG_DIR);
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at) VALUES ('g','G','','active',1,'2026-06-22T00:00:00.000Z','2026-06-22T00:00:00.000Z')"
  ).run();
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('t','T','',1,0,0,'[]','[]','2026-06-22T00:00:00.000Z','2026-06-22T00:00:00.000Z')"
  ).run();
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES ('r','g','t',1,'active','2026-06-22T00:00:00.000Z')"
  ).run();
});

describe("recordSplitDecision", () => {
  it("inserts and round-trips a split decision row", () => {
    const seq = nextTraversalSeq(db, "r");
    recordSplitDecision(db, () => "2026-06-22T00:00:01.000Z", {
      id: "sd1",
      goalId: "g",
      workflowRunId: "r",
      nodeId: "route",
      traversalSeq: seq,
      selectedBranch: "ground_and_design",
      reason: "intent clear",
      selectedEdgeTo: "research",
      inputsConsidered: ["triage"],
      ledgerVersion: 2,
    });
    const decisions = listSplitDecisionsForRun(db, "r");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      nodeId: "route",
      selectedBranch: "ground_and_design",
      selectedEdgeTo: "research",
      ledgerVersion: 2,
    });
  });

  it("rejects a duplicate (run, node, traversalSeq)", () => {
    const args = {
      id: "sd1",
      goalId: "g",
      workflowRunId: "r",
      nodeId: "route",
      traversalSeq: 1,
      selectedBranch: "approach_only",
      reason: "obvious",
      selectedEdgeTo: "proposal",
      inputsConsidered: [],
      ledgerVersion: 0,
    };
    recordSplitDecision(db, () => "2026-06-22T00:00:01.000Z", args);
    expect(() =>
      recordSplitDecision(db, () => "2026-06-22T00:00:02.000Z", { ...args, id: "sd2" })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- splitters/usecases`
Expected: FAIL — `./usecases.js`/`./projection.js` and the table do not exist.

- [ ] **Step 3: Create the migration**

Create `apps/daemon/migrations/0038_workflow_split_decisions.sql`:

```sql
-- 0038_workflow_split_decisions.sql
-- N-way splitter routing decisions. Mirrors workflow_gate_decisions but stores
-- the selected branch label instead of an approved/rejected outcome, and has no
-- issue references. Kept separate so branch labels never enter gate history.
CREATE TABLE workflow_split_decisions (
  id                      TEXT PRIMARY KEY,
  goal_id                 TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id                 TEXT NOT NULL,
  traversal_seq           INTEGER NOT NULL,
  selected_branch         TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  selected_edge_to        TEXT NOT NULL,
  inputs_considered_json  TEXT NOT NULL DEFAULT '[]',
  ledger_version          INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL
);
CREATE INDEX idx_workflow_split_decisions_run
  ON workflow_split_decisions(workflow_run_id, created_at DESC);
CREATE UNIQUE INDEX idx_workflow_split_decisions_seq
  ON workflow_split_decisions(workflow_run_id, node_id, traversal_seq);
```

- [ ] **Step 4: Register the migration**

In `apps/daemon/src/migrations.ts`, add the file to the `migrationFiles` array after `"0037_step_run_pending_judge.sql",` (line 51):

```typescript
  "0037_step_run_pending_judge.sql",
  "0038_workflow_split_decisions.sql",
```

- [ ] **Step 5: Create `recordSplitDecision`**

Create `apps/daemon/src/workflows/splitters/usecases.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface SplitDecisionInput {
  id?: string;
  goalId: string;
  workflowRunId: string;
  nodeId: string;
  traversalSeq: number;
  selectedBranch: string;
  reason: string;
  selectedEdgeTo: string;
  inputsConsidered: string[];
  ledgerVersion: number;
}

export function recordSplitDecision(
  db: Database.Database,
  now: () => string,
  input: SplitDecisionInput
): string {
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO workflow_split_decisions
       (id, goal_id, workflow_run_id, node_id, traversal_seq, selected_branch, reason,
        selected_edge_to, inputs_considered_json, ledger_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.goalId,
    input.workflowRunId,
    input.nodeId,
    input.traversalSeq,
    input.selectedBranch,
    input.reason.slice(0, 1024),
    input.selectedEdgeTo,
    JSON.stringify(input.inputsConsidered),
    input.ledgerVersion,
    now()
  );
  return id;
}
```

- [ ] **Step 6: Create `listSplitDecisionsForRun`**

Create `apps/daemon/src/workflows/splitters/projection.ts`:

```typescript
import type Database from "better-sqlite3";

export interface SplitDecisionRecord {
  id: string;
  goalId: string;
  workflowRunId: string;
  nodeId: string;
  traversalSeq: number;
  selectedBranch: string;
  reason: string;
  selectedEdgeTo: string;
  inputsConsidered: string[];
  ledgerVersion: number;
  createdAt: string;
}

interface Row {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  node_id: string;
  traversal_seq: number;
  selected_branch: string;
  reason: string;
  selected_edge_to: string;
  inputs_considered_json: string;
  ledger_version: number;
  created_at: string;
}

export function listSplitDecisionsForRun(
  db: Database.Database,
  runId: string
): SplitDecisionRecord[] {
  const rows = db
    .prepare("SELECT * FROM workflow_split_decisions WHERE workflow_run_id = ? ORDER BY created_at ASC")
    .all(runId) as Row[];
  return rows.map((r) => ({
    id: r.id,
    goalId: r.goal_id,
    workflowRunId: r.workflow_run_id,
    nodeId: r.node_id,
    traversalSeq: r.traversal_seq,
    selectedBranch: r.selected_branch,
    reason: r.reason,
    selectedEdgeTo: r.selected_edge_to,
    inputsConsidered: JSON.parse(r.inputs_considered_json),
    ledgerVersion: r.ledger_version,
    createdAt: r.created_at,
  }));
}
```

- [ ] **Step 7: Run the persistence + migration tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- splitters/usecases migrations`
Expected: PASS (the new migration applies cleanly in the migrations suite and the round-trip test is green).

- [ ] **Step 8: Typecheck the daemon end-to-end**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: exits 0 (confirms the generalized `port`/`branches` types from rebuilt contracts are consistent across the daemon).

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/migrations/0038_workflow_split_decisions.sql apps/daemon/src/migrations.ts apps/daemon/src/workflows/splitters/
git commit -m "feat(daemon): persist splitter branch decisions in workflow_split_decisions"
```

---

## Self-Review

**Spec coverage (this plan's slice):**
- Contracts: node type, `branches`, generalized `port`, `evaluate_split` decision kinds, `SplitEvaluation` request/proposal → Tasks 1–2. ✓
- Validation splitter rules (2–8 unique branches, one edge per branch, ports match declared) → Task 3. ✓
- Routing (`Destination` + `resolveSplitterNext` + `classify`) → Task 4. ✓
- Persistence (`workflow_split_decisions` + record + projection, separate from gates) → Task 5. ✓
- Gates untouched: gate arm preserved verbatim in Task 3; gate table/usecases unchanged; `nextTraversalSeq` reused, not forked. ✓
- **Deferred to later plans (not gaps):** orchestrator `evaluate_split` wiring + `routeBranchDestination` (Plan 2); desktop editor (Plan 3); Adaptive Delivery template + old-template rollout (Plan 4).

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step states an expected result. ✓

**Type consistency:** `selectedBranch` (not `outcome`) used consistently across `SplitEvaluationProposal`, `SplitDecisionInput`, `SplitDecisionRecord`, the SQL column, and tests. `resolveSplitterNext(graph, splitterNodeId, branch)` signature matches its test call. `Destination` `{ kind: "splitter" }` matches `classify` output and the routing test. Branch bounds (2–8, 60 chars) identical in node schema, request schema, and validation. ✓
