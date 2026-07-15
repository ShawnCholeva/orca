# Worker-Backed Gates + Critique-as-Gate Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Adaptive Delivery's Critique a strong, worker-backed **gate** that loops back to Proposal on blocking findings — built on a new reusable "gates can be worker-backed" substrate capability.

**Architecture:** Decouple a gate's *evaluation substrate* (shadow one-shot LLM vs full worker agent) from its *role* (approve/reject routing + reject→loop + `GATE_REJECT_CAP` + stagnation + mode-park). Phase 1 adds an opt-in `evalSubstrate:"worker"` to gate nodes and a worker evaluation path in the engine that converges on the existing gate machinery. Phase 2 replaces the Critique *step* with a worker-backed Critique *gate* whose `rejected` port loops to Proposal.

**Tech Stack:** TypeScript, Zod contracts (`packages/contracts`), better-sqlite3, Fastify daemon (`apps/daemon`), Vitest, React desktop (`apps/desktop`), tmux-backed worker sessions.

**Design spec:** `docs/superpowers/specs/2026-07-15-worker-backed-critique-gate-design.md`

## Global Constraints

- **TDD always** — failing test first, watch it fail, minimal code, watch it pass, commit. (superpowers:test-driven-development)
- **Build order:** after any `packages/contracts` change run `pnpm --filter @orca/contracts build` before building/typechecking `apps/daemon` (stale contracts dist crashes the daemon).
- **`evalSubstrate` default = `"shadow"`** — existing `designgate`/`review` gates keep exact current behavior; zero migration.
- **Reuse, do not reinvent:** worker gates emit the existing `GateEvaluationProposal` (`packages/contracts/src/workflows/index.ts:857`); route/loop via the existing `evaluateAndParkGate` tail (`apps/daemon/src/workflows/orchestrator/dispatch-engine.ts` — `resolveGateNext`, `recordGateDecision`, `routeGateDestination`, `GATE_REJECT_CAP`, `issueRefsEqual`).
- **Template version:** `orca/adaptive-delivery` is currently **v11** (`catalog.ts:859`) → bump to **v12**.
- **Run the daemon from `dist`** for any live check (never tsx-watch): `pnpm --filter @orca/contracts build && pnpm --filter @orca/daemon build && ORCA_PORT=0 node apps/daemon/dist/index.js`.
- **Worker delivery** to a gate worker reuses the durable placeholder-tolerant deliver hardened in commit `03f80e9`.

---

## File Structure

**Phase 1 (substrate):**
- `packages/contracts/src/workflows/index.ts` — add `evalSubstrate` to `WorkflowGraphNode`.
- `apps/daemon/src/workflows/graph/validate-graph.ts` — validate worker-gate requirements.
- `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts` — worker evaluation path in `evaluateAndParkGate` (+ a new private `evaluateGateViaWorker` helper and a `parkForGateApproval` recommendation payload).
- `apps/daemon/src/workflows/orchestrator/gate-worker.ts` *(new)* — compose the worker gate prompt from `GateEvaluationRequest`; parse a `GateEvaluationProposal` from worker output. Keeps the worker-gate I/O in one focused unit.

**Phase 2 (feature):**
- `apps/daemon/src/workflows/templates/catalog.ts` — `ADAPTIVE_GRAPH` edit, remove `critique` step, `verify` grounding cleanup, version bump.
- `apps/desktop/src/orchestrator/OrcaChat.tsx` (+ `.test.tsx`) — render worker-gate reasoning + `issueRefs` on the gate card.

---

# PHASE 1 — Worker-backed gate substrate

## Task 1: Contract — `evalSubstrate` on gate nodes

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts:306-345` (`WorkflowGraphNodeBase` + refine)
- Test: `packages/contracts/src/workflows/graph-contract.test.ts`

**Interfaces:**
- Produces: `WorkflowGraphNode.evalSubstrate?: "shadow" | "worker"` (default `"shadow"`). A `type:"gate"` node with `evalSubstrate:"worker"` MUST carry `instructions` (the evaluator prompt) and `agentPreference: StepAgentChoice[]` (the strong-model lever). `StepAgentChoice` already exists at `index.ts:277`.

- [ ] **Step 1: Write the failing test**

```ts
// graph-contract.test.ts
import { WorkflowGraphNode } from "./index.js";

it("accepts a worker-backed gate with instructions + agentPreference", () => {
  const parsed = WorkflowGraphNode.parse({
    id: "critique", type: "gate", name: "Critique",
    evalSubstrate: "worker",
    instructions: "Challenge the approach…",
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-opus-4-8" }],
  });
  expect(parsed.evalSubstrate).toBe("worker");
});

it("defaults evalSubstrate to shadow when omitted", () => {
  const parsed = WorkflowGraphNode.parse({ id: "g", type: "gate", name: "G", instructions: "x" });
  expect(parsed.evalSubstrate).toBe("shadow");
});

it("rejects a worker gate missing agentPreference", () => {
  const r = WorkflowGraphNode.safeParse({
    id: "g", type: "gate", name: "G", evalSubstrate: "worker", instructions: "x",
  });
  expect(r.success).toBe(false);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`evalSubstrate` unknown key → strict object rejects; or default missing)

Run: `pnpm --filter @orca/contracts test -- graph-contract`
Expected: FAIL (unrecognized key `evalSubstrate` / refine not present).

- [ ] **Step 3: Implement — add the field + refine**

In `WorkflowGraphNodeBase` object (after `requiresLaunchApproval` at line 337), add:
```ts
    // Gate nodes: how the judgment is produced. "shadow" (default) = one-shot
    // orchestrator LLM eval; "worker" = a full worker agent (strong model, tools),
    // which then feeds the same gate routing/loop machinery.
    evalSubstrate: z.enum(["shadow", "worker"]).default("shadow"),
    // Worker gates carry the same agent selection steps use.
    agentPreference: z.array(StepAgentChoice).min(1).max(8).optional(),
```
Extend the `superRefine` (line 340) to add:
```ts
  if (n.type === "gate" && n.evalSubstrate === "worker") {
    if (!n.agentPreference || n.agentPreference.length === 0)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "worker gate requires agentPreference" });
    if (!n.instructions)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "worker gate requires instructions" });
  }
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @orca/contracts test -- graph-contract`
Expected: PASS (all three).

- [ ] **Step 5: Build contracts + commit**

```bash
pnpm --filter @orca/contracts build
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/graph-contract.test.ts
git commit -m "feat(contracts): worker-backed gate — evalSubstrate + agentPreference on WorkflowGraphNode"
```

---

## Task 2: Graph validation accepts worker gates

**Files:**
- Modify: `apps/daemon/src/workflows/graph/validate-graph.ts`
- Test: `apps/daemon/src/workflows/graph/validate-graph.test.ts`

**Interfaces:**
- Consumes: `WorkflowGraphNode.evalSubstrate` (Task 1).
- Produces: `validateGraph` accepts a `type:"gate"` node with `evalSubstrate:"worker"` (given agentPreference+instructions) and a **backward** edge from it (gate→earlier node), exactly as it already accepts `designgate → proposal`.

- [ ] **Step 1: Write the failing test** — a minimal graph with a worker gate looping backward validates clean.

```ts
it("validates a worker-backed gate with a backward loop edge", () => {
  const graph = {
    nodes: [
      { id: "a", type: "step", name: "A", stepId: "a" },
      { id: "g", type: "gate", name: "G", evalSubstrate: "worker", instructions: "x",
        agentPreference: [{ adapterId: "claude-code", modelId: "claude-opus-4-8" }] },
      { id: "b", type: "step", name: "B", stepId: "b", terminal: true },
    ],
    edges: [ {from:"a",to:"g"}, {from:"g",to:"b",port:"approved"}, {from:"g",to:"a",port:"rejected"} ],
    positions: { a:{x:0,y:0}, g:{x:0,y:1}, b:{x:0,y:2} },
  };
  expect(() => validateGraph(graph as never, [/* step tpls a,b */])).not.toThrow();
});
```
(Model the step-template arg on the existing tests in this file.)

- [ ] **Step 2: Run it — expect FAIL or PASS.** If `validateGraph` is substrate-agnostic it may already pass; if it asserts gate-specific shape (e.g. requires `instructions` only, forbids extra fields) it fails.

Run: `pnpm --filter @orca/daemon test -- validate-graph`

- [ ] **Step 3: Implement** — only if Step 2 failed: relax/extend the gate-node checks so `evalSubstrate:"worker"` gates are accepted; keep the existing "gate needs a valid approved/rejected port set" checks. (Follow the current gate-validation branch in `validate-graph.ts`.)

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @orca/daemon test -- validate-graph`

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/graph/validate-graph.ts apps/daemon/src/workflows/graph/validate-graph.test.ts
git commit -m "feat(daemon): graph validation accepts worker-backed gates with backward loop edges"
```

---

## Task 3: Gate worker I/O unit (`gate-worker.ts`)

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/gate-worker.ts`
- Test: `apps/daemon/src/workflows/orchestrator/gate-worker.test.ts`

**Interfaces:**
- Consumes: `GateEvaluationRequest` (`packages/contracts/src/workflows/index.ts:868`), `GateEvaluationProposal` (`:857`).
- Produces:
  - `composeGateWorkerPrompt(request: GateEvaluationRequest): string` — the worker objective: the gate `instructions` + rendered evidence (goal, source step output, committed ledger, prior gate decisions) + the required `orca:gate-decision` fenced-block output format.
  - `parseGateDecision(workerOutput: string): GateEvaluationProposal | null` — extract + `GateEvaluationProposal.safeParse` the fenced block; `null` on absent/invalid (caller escalates to human, mirroring `evaluateGate`'s null contract).

- [ ] **Step 1: Write the failing tests**

```ts
import { composeGateWorkerPrompt, parseGateDecision } from "./gate-worker.js";

it("composeGateWorkerPrompt includes the gate instructions and the output contract", () => {
  const p = composeGateWorkerPrompt({
    gate: { nodeId: "critique", name: "Critique", instructions: "CHALLENGE THE APPROACH" },
    goal: { title: "T", description: "D" }, sourceStepOutput: { chosen: "x" },
    committedLedger: [], priorGateDecisions: [],
  } as never);
  expect(p).toContain("CHALLENGE THE APPROACH");
  expect(p).toContain("orca:gate-decision");
});

it("parseGateDecision extracts a valid rejected decision with issueRefs", () => {
  const out = 'blah\n```orca:gate-decision\n{"reasoning":"r","outcome":"rejected","reason":"why","issueRefs":["lock","purity"],"inputsConsidered":["proposal"]}\n```\n';
  const d = parseGateDecision(out);
  expect(d?.outcome).toBe("rejected");
  expect(d?.issueRefs).toEqual(["lock","purity"]);
});

it("parseGateDecision returns null on missing/invalid block", () => {
  expect(parseGateDecision("no block here")).toBeNull();
  expect(parseGateDecision("```orca:gate-decision\n{not json}\n```")).toBeNull();
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found)

Run: `pnpm --filter @orca/daemon test -- gate-worker`

- [ ] **Step 3: Implement `gate-worker.ts`**

```ts
import { GateEvaluationProposal, type GateEvaluationRequest } from "@orca/contracts";

export function composeGateWorkerPrompt(request: GateEvaluationRequest): string {
  return [
    request.gate.instructions,
    "",
    "Judge the SOURCE STEP OUTPUT against the goal and the instructions above,",
    "grounding your verdict ONLY in the EVIDENCE. Do not invent findings.",
    "On 'rejected', issueRefs MUST enumerate the specific, addressable blocking",
    "failures — 'fix only these; do not rewrite what is correct'. On 'approved', issueRefs is [].",
    "",
    "EVIDENCE:",
    JSON.stringify({
      goal: request.goal,
      sourceStepOutput: request.sourceStepOutput,
      committedLedger: request.committedLedger,
      priorGateDecisions: request.priorGateDecisions,
    }),
    "",
    "When done, emit EXACTLY one fenced block, nothing after the closing fence:",
    "```orca:gate-decision",
    '{ "reasoning": "...", "outcome": "approved|rejected", "reason": "...", "issueRefs": [...], "inputsConsidered": [...] }',
    "```",
  ].join("\n");
}

const BLOCK = /```orca:gate-decision\s*([\s\S]*?)```/;

export function parseGateDecision(workerOutput: string): GateEvaluationProposal | null {
  const m = BLOCK.exec(workerOutput);
  if (!m) return null;
  try {
    const parsed = GateEvaluationProposal.safeParse(JSON.parse(m[1].trim()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @orca/daemon test -- gate-worker`

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/gate-worker.ts apps/daemon/src/workflows/orchestrator/gate-worker.test.ts
git commit -m "feat(daemon): gate-worker prompt composer + decision parser"
```

---

## Task 4: Engine — worker evaluation path in `evaluateAndParkGate`

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts` (`evaluateAndParkGate`, ~L2090-2178, and the `parkForGateApproval` payload)
- Test: `apps/daemon/src/workflows/orchestrator/dispatch-engine.gate-worker.test.ts` *(new)*

**Interfaces:**
- Consumes: `gateNode.evalSubstrate` (Task 1); `composeGateWorkerPrompt`/`parseGateDecision` (Task 3); existing `workerSpawn`/`workerDeliver` (dispatch-engine:275-276, used by `spawnStepAgent` at :452), `buildGateEvaluationRequest` (:2051), `resolveGateNext`/`recordGateDecision`/`routeGateDestination`, `GATE_REJECT_CAP`/`issueRefsEqual`.
- Produces: a worker-gate that **evaluates-always**, then splits on mode: automated → route inline on `outcome`; supervised → `parkForGateApproval` carrying `{ recommendedOutcome, reasoning, issueRefs }`.

**Design intent (from spec):** at the top of `evaluateAndParkGate`, before the current shadow/park branch (L2115-2149), insert:

```ts
if (gateNode.evalSubstrate === "worker") {
  const proposal = await this.evaluateGateViaWorker(db, now, { run, stepRun, goal, gateNode, graph }, options);
  if (!proposal) { this.parkForGateApproval(db, now, ctx, options); return; }  // escalate on failure
  // Reuse the EXISTING tail verbatim: stagnation + GATE_REJECT_CAP (L2151-2176),
  // then EITHER park-with-recommendation (supervised) OR route inline (automated).
  ... shared tail ...
}
```

`evaluateGateViaWorker` mirrors `spawnStepAgent`'s spawn+deliver (dispatch-engine:440-460): spawn a worker with `agentPreference[0]`'s adapter/model, deliver `composeGateWorkerPrompt(buildGateEvaluationRequest(...))`, and on the worker's Stop hook parse via `parseGateDecision`. The Stop-hook wiring reuses the same path steps use to surface `orca:step-complete`; a worker-gate session is tagged so the Stop handler routes its output to `parseGateDecision` instead of step scoring.

> **Implementation note for the executor:** this task grafts onto the worker lifecycle. Read `spawnStepAgent` (dispatch-engine.ts:~440-460) and the Stop-hook → `onAgentResponseDone` output-capture path first; reuse them. The gate-decision parse replaces step scoring for worker-gate sessions. Keep the automated-route and supervised-park tails **identical** to the shadow path's — only the *source* of `proposal` changes.

- [ ] **Step 1: Write the failing test** — inject a stub `workerSpawn`/`workerDeliver` that "delivers" a canned `orca:gate-decision` (rejected, issueRefs) and assert: (a) the run records a gate decision with those issueRefs; (b) automated mode routes to the `rejected` port's node; (c) a second rejection with the same issueRefs blocks the run (stagnation); (d) `evalSubstrate:"shadow"` gate path is unchanged. Model harness setup on `service.agent-step.test.ts` / existing gate tests.

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @orca/daemon test -- dispatch-engine.gate-worker`

- [ ] **Step 3: Implement** `evaluateGateViaWorker` + the `evalSubstrate` branch + the supervised recommendation payload on `parkForGateApproval`, per the design intent above. Keep the shared tail (stagnation/cap/route) factored so both substrates use it.

- [ ] **Step 4: Run — expect PASS; then full daemon suite**

Run: `pnpm --filter @orca/daemon test -- dispatch-engine.gate-worker` then `pnpm --filter @orca/daemon test`
Expected: new tests PASS; **0 regressions** (esp. existing gate/splitter/service tests).

- [ ] **Step 5: Build + commit**

```bash
pnpm --filter @orca/daemon build
git add apps/daemon/src/workflows/orchestrator/dispatch-engine.ts apps/daemon/src/workflows/orchestrator/dispatch-engine.gate-worker.test.ts
git commit -m "feat(daemon): worker-backed gate evaluation (evaluate-always; supervised park-with-recommendation, automated route)"
```

---

# PHASE 2 — Critique-as-worker-gate + the loop

## Task 5: Template — replace Critique step with a worker Critique gate

**Files:**
- Modify: `apps/daemon/src/workflows/templates/catalog.ts` (`ADAPTIVE_GRAPH`, the `critique` step in the steps array, the `orca/adaptive-delivery` version, `positions`)
- Test: `apps/daemon/src/workflows/templates/catalog.test.ts` (or the nearest template test)

**Interfaces:**
- Consumes: Task 1-4 (worker gates).
- Produces: `ADAPTIVE_GRAPH` where `critique` is `type:"gate", evalSubstrate:"worker"` with edges `proposal→critique`, `critique→verify (approved)`, `critique→proposal (rejected)`; the `critique` **step** definition removed; version **12**.

- [ ] **Step 1: Write the failing test** — assert the built `orca/adaptive-delivery` template: (a) has a `critique` node of `type:"gate"`, `evalSubstrate:"worker"`; (b) has edges `critique→verify` port `approved` and `critique→proposal` port `rejected`; (c) has **no** step template with id `critique`; (d) `version === 12`; (e) `validateGraph` passes.

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @orca/daemon test -- catalog`

- [ ] **Step 3: Implement** the `ADAPTIVE_GRAPH` node/edge edits, remove the `critique` step object from the steps array, bump `version: 12`, add a `critique` entry to `positions`. Critique gate node:
```ts
{ id: "critique", type: "gate", name: "Critique", evalSubstrate: "worker",
  agentPreference: STRONG_CRITIC_AGENT,   // Task 7
  instructions: CRITIQUE_GATE_INSTRUCTIONS },  // Task 7
```
Edges: replace `{from:"critique",to:"verify"}` with `{from:"proposal",to:"critique"}` (already exists as proposal→critique? confirm), `{from:"critique",to:"verify",port:"approved"}`, `{from:"critique",to:"proposal",port:"rejected"}`.

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @orca/daemon test -- catalog`

- [ ] **Step 5: Commit** (defer if Task 7 constants not yet defined — sequence Task 7 before Step 3 if needed)

```bash
git add apps/daemon/src/workflows/templates/catalog.ts apps/daemon/src/workflows/templates/catalog.test.ts
git commit -m "feat(daemon): Adaptive Delivery v12 — Critique becomes a worker gate looping to Proposal"
```

---

## Task 6: Drop Verify's orphaned `covers_prior` on `critique.concerns`

**Files:**
- Modify: `apps/daemon/src/workflows/templates/catalog.ts` (`verify` step `grounding`)
- Test: `apps/daemon/src/workflows/templates/catalog.test.ts`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing test** — assert the `verify` step's `grounding` contains **no** rule referencing `critique` as a `prior.stepId` (the gate no longer produces `concerns`).

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** — remove the `{ rule:"covers_prior", field:"concerns_addressed", prior:[{stepId:"critique",...}], mode:"observe" }` rule from the `verify` step. Leave the rest of Verify unchanged.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/templates/catalog.ts apps/daemon/src/workflows/templates/catalog.test.ts
git commit -m "chore(daemon): drop Verify's covers_prior on critique.concerns (Critique is now a gate)"
```

---

## Task 7: Critique gate instructions + strong critic agent

**Files:**
- Modify: `apps/daemon/src/workflows/templates/catalog.ts` (add `CRITIQUE_GATE_INSTRUCTIONS` + `STRONG_CRITIC_AGENT` consts near the graph)
- Test: covered by Task 5 (the gate carries them).

**Interfaces:**
- Produces: `CRITIQUE_GATE_INSTRUCTIONS: string` (the adversarial prompt) and `STRONG_CRITIC_AGENT: StepAgentChoice[]`.

- [ ] **Step 1: Implement the constants** (fold into Task 5's cycle — no separate test):

```ts
const STRONG_CRITIC_AGENT = [{ adapterId: "claude-code", modelId: "claude-opus-4-8" }];

const CRITIQUE_GATE_INSTRUCTIONS =
  "You are the design Critique gate. Challenge the chosen approach in a fresh context, " +
  "treating prior step output as UNTRUSTED evidence. Pressure-test it for isolation and " +
  "clarity: do units have single clear purposes and well-defined interfaces; can each be " +
  "understood/tested without the others' internals; can internals change without breaking " +
  "consumers? Surface second-order risks, gaps, and failure modes. APPROVE only if the " +
  "approach is sound enough to build now; REJECT if any blocking defect would ship or force " +
  "a re-plan. On REJECT, issueRefs enumerates ONLY the specific blocking fixes — do not " +
  "rewrite what is correct.";
```

- [ ] **Step 2: Verify Task 5's test still passes** (the gate carries these).

Run: `pnpm --filter @orca/daemon test -- catalog`

- [ ] **Step 3: Commit** (fold into Task 5's commit if implemented together).

---

## Task 8: Desktop — render worker-gate reasoning + issueRefs on the gate card

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx` (gate card render + the API type carrying gate recommendation)
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

**Interfaces:**
- Consumes: the supervised park payload from Task 4 (`recommendedOutcome`, `reasoning`, `issueRefs`).
- Produces: the Critique gate card shows the worker's `reasoning` and a list of `issueRefs`, with the human approve/reject controls (existing gate decision UX); a `rejected` decision communicates "back to Proposal."

- [ ] **Step 1: Write the failing test** — render a gate message with `{recommendedOutcome:"rejected", reasoning:"…", issueRefs:["threading.Lock", "trading purity"]}` and assert the reasoning text and each issueRef render, and the decision controls are present.

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @orca/desktop test -- OrcaChat`

- [ ] **Step 3: Implement** the gate-card branch rendering `reasoning` + `issueRefs` (follow the existing gate/decision card rendering in `OrcaChat.tsx`).

- [ ] **Step 4: Run — expect PASS + typecheck**

Run: `pnpm --filter @orca/desktop test -- OrcaChat && pnpm --filter @orca/desktop exec tsc -p tsconfig.json --noEmit`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): Critique gate card renders worker reasoning + issueRefs"
```

---

## Task 9: Live end-to-end verification (dogfood)

Not a code task — the acceptance gate.

- [ ] Rebuild contracts+daemon; restart dist daemon (`ORCA_PORT=0`).
- [ ] Create a fresh Adaptive Delivery goal (stock-trader ws) via the UI; drive to the Critique gate.
- [ ] **Assert (supervised):** the Critique gate produces a *worker-grade* review (rich reasoning + issueRefs), parks presenting it; approving → Verify; a rejection loops to **Proposal** (new proposal run), not Research.
- [ ] **Assert loop bound:** force ≥3 rejections (or stagnation) → run blocks with enumerated unresolved issues (`GATE_REJECT_CAP`).
- [ ] **Assert honesty:** no "approved with blocking issues" state is reachable.

---

## Self-Review (completed)

- **Spec coverage:** P1 evalSubstrate (T1), validation (T2), worker I/O (T3), engine path incl. evaluate-always + mode split (T4). P2 template loop (T5), Verify cleanup (T6), strong prompt/agent (T7), card UX (T8), live verify (T9). Composed human `designgate` unchanged (no task needed — kept as-is). CANDOR/other-gate-migration explicitly non-goals.
- **Placeholder scan:** engine Task 4 intentionally cites the `spawnStepAgent` worker-lifecycle pattern to reuse rather than reproducing the whole lifecycle — flagged as an implementation note, with exact anchors and the exact interface (`GateEvaluationProposal`, `workerSpawn`/`workerDeliver`, the shared route/park tail). All other steps carry concrete code.
- **Type consistency:** `evalSubstrate`, `agentPreference`, `GateEvaluationProposal` (`outcome/reasoning/reason/issueRefs/inputsConsidered`), `composeGateWorkerPrompt`/`parseGateDecision` used consistently across tasks.
