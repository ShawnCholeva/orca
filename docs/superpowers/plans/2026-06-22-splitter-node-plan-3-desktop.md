# Splitter Node — Plan 3: Desktop Editor & Confirmation UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users author splitter nodes in the desktop workflow editor (add a splitter, name its branches, wire one outgoing edge per branch) and let supervised runs surface the splitter's "Routing to <branch> — Continue?" confirmation card with a working Continue button.

**Architecture:** Mirror the existing gate authoring UI for the editor (icon, add-node button, node render with N labeled output ports, a NodeDetail variant + body, graph-sync round-trip). For the runtime confirmation, **reuse the existing step-confirmation card** — Plan 2 parks a supervised splitter as a `step_confirmation_pending` activity (no new activity kind), so the only change is routing its **Continue** action to `confirmSplit(runId)` instead of `confirmStep(runId)` when the run is parked at a splitter (`currentNodeKind === "splitter"`). The splitter is always automated: the LLM already chose the branch; the user only acknowledges. There is **no** branch-pick UI.

**Tech Stack:** React, TypeScript, Tauri, Vitest + @testing-library/react.

## Global Constraints

- **No branch-pick UI and no new activity kinds.** The splitter confirmation is a Continue acknowledgment, not a choice. Do NOT add `splitter_decision_pending`/`splitter_decision` to `ActivitySourceKind`. Do NOT render N branch buttons in the run view.
- `confirmSplit(runId)` takes **only the run id** — the daemon route is `POST /v1/workflows/runs/:id/confirm-split` with an empty body (mirror `confirmStep`, NOT `decideGate`). The daemon already routes the stashed branch.
- Continue dispatches to `confirmSplit` **iff** the parked run's `currentNodeKind === "splitter"`; otherwise it stays `confirmStep`. This is the only distinguisher (both use `step_confirmation_pending`; a splitter park has `current_step_run_id === null`, `current_node_kind === "splitter"`).
- Branch labels: 2–8 per splitter, each 1–60 chars (contracts `WORKFLOW_SPLITTER_MIN_BRANCHES`/`MAX_BRANCHES`/`MAX_BRANCH_LABEL_CHARS`, already shipped). New splitters start with `branches: ["Branch A", "Branch B"]`.
- Edge `port` is already a generic string in contracts (Plan 1); gate `approved`/`rejected` and splitter branch labels share it. The only desktop-local narrowing to widen is `linkDrag.fromPort` in `WorkflowFlow.tsx` (currently `"approved" | "rejected"` → make it `string`).
- The confirmation card must tolerate `agent_session_id === null` (splitter cards have no agent, like gate cards) — verify the existing step-confirmation render path does not assume a session id.
- Do NOT change gate or step authoring/runtime behavior. Client-side branch-completeness validation is out of scope — the daemon's `validateGraph` (Plan 1) already rejects malformed splitter graphs on save and surfaces `WorkflowTemplateResponse.warnings`.
- Contracts already built (Plans 1–2). Test command: `pnpm --filter @orca/desktop test`; typecheck: `pnpm --filter @orca/desktop typecheck` (if defined; else `pnpm --filter @orca/desktop build`).

## Key existing code (anchors, read before editing)

- `apps/desktop/src/workflows/icons.tsx`: `GateGlyph` (~64-81), `ic()` factory (~10-29).
- `apps/desktop/src/workflows/WorkflowFlow.tsx`: `onAddNode` type (~9), Add-gate button (~254-268), `isGate` render (~422), step `+` port (~519-561), gate two-port block (~563-611), edge port `<text>` (~390-400), `linkDrag` type incl. `fromPort?: "approved"|"rejected"` (~41-47), edge-commit port store (~159-163).
- `apps/desktop/src/workflows/NodeDetailModal.tsx`: `NodeDetail` union (~6-25), `isGate` (~50), header/breadcrumb/placeholder (~116-135), body dispatch (~180-188), `GateBody` (~220-263, the "approved/rejected ports" copy at ~258).
- `apps/desktop/src/workflows/TemplateDetail.tsx`: `handleAddNode` gate case (~265-285), `handleGraphChange` non-step preservation (~233-251, the `n.type === "gate"` filter at ~241), `openNodeDetail` memo gate case (~358-376).
- `apps/desktop/src/workflows/graph-sync.ts`: `reconcileGraph` (~40-118), `existingGates` filter (~44), `validNodeIds` (~80-83), output nodes (~113).
- `apps/desktop/src/api.ts`: `confirmStep` (~1760-1767), `decideGate` (~1778-1793), `requestVoid` (~297-325).
- `apps/desktop/src/orchestrator/ActivityThread.tsx`: `pickLiveActivity` (~41-54), `LiveActivity` step-confirmation path with `ConfirmationCard` + Continue (~329-363).
- `apps/desktop/src/orchestrator/OrcaChat.tsx`: `handleContinue` (calls `confirmStep(runId)`), `handleGateDecision` (~735-747), `LiveActivity` wiring (~1008-1010). The `WorkflowRun` it loads exposes `currentNodeKind` (contracts, nullable string).
- Tests: `graph-sync.test.ts`, `NodeDetailModal.test.tsx`, `WorkflowFlow.test.tsx`, `TemplateDetail.test.tsx`. Conventions: inline graph objects with `type: "gate" as const`; `makeXDetail(onChange = vi.fn())` factories; `render` + `fireEvent` + `expect(onChange).toHaveBeenCalledWith(...)`.

## File Structure

- Modify `apps/desktop/src/workflows/icons.tsx` — `SplitterGlyph`.
- Modify `apps/desktop/src/workflows/graph-sync.ts` — preserve splitter nodes.
- Modify `apps/desktop/src/workflows/TemplateDetail.tsx` — add/preserve/detail splitter.
- Modify `apps/desktop/src/workflows/WorkflowFlow.tsx` — add-button, render, N ports, widen `fromPort`.
- Modify `apps/desktop/src/workflows/NodeDetailModal.tsx` — `kind: "splitter"` + `SplitterBody`.
- Modify `apps/desktop/src/api.ts` — `confirmSplit`.
- Modify `apps/desktop/src/orchestrator/OrcaChat.tsx` — route Continue to `confirmSplit` for splitter parks.
- Tests alongside each.

---

### Task 1: Splitter icon

**Files:**
- Modify: `apps/desktop/src/workflows/icons.tsx`
- Test: none (pure SVG; covered indirectly by WorkflowFlow tests)

**Interfaces:**
- Produces: `export function SplitterGlyph({ size }: { size?: number })` — a fork/branch glyph, same API as `GateGlyph`.

- [ ] **Step 1: Add the glyph**

Mirror `GateGlyph`'s shape/props. After `GateGlyph`:

```tsx
/** Fork shape used for splitter nodes. */
export function SplitterGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6" />
      <path d="M18 3v6" />
      <path d="M6 21v-6" />
    </svg>
  );
}
```

(Any clear fork/branch path is acceptable; keep `strokeWidth="1.8"` to match `GateGlyph`.)

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @orca/desktop typecheck` (or `build`)
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/workflows/icons.tsx
git commit -m "feat(desktop): add SplitterGlyph icon"
```

---

### Task 2: Graph model — preserve splitter nodes through sync

**Files:**
- Modify: `apps/desktop/src/workflows/graph-sync.ts` (`reconcileGraph` ~44, ~80-83, ~113)
- Modify: `apps/desktop/src/workflows/TemplateDetail.tsx` (`handleGraphChange` ~241, `handleAddNode` ~265-285)
- Test: `apps/desktop/src/workflows/graph-sync.test.ts`

**Interfaces:**
- Produces: `reconcileGraph` preserves `type === "splitter"` nodes (and their positions/edges) exactly as it preserves gates; `handleGraphChange` keeps splitter nodes; `handleAddNode("splitter")` inserts a splitter node with `branches: ["Branch A", "Branch B"]` and opens its detail.

- [ ] **Step 1: Write the failing test**

In `graph-sync.test.ts`, mirror the existing gate-preservation test:

```typescript
it("preserves existing splitter nodes (and branches) when adding a step", () => {
  const steps = [makeStep("s1"), makeStep("s2")];
  const base = buildInitialGraph(steps);
  const graphWithSplitter = {
    ...base,
    nodes: [
      ...base.nodes,
      { id: "split-1", type: "splitter" as const, name: "Route", branches: ["go_a", "go_b"] },
    ],
    positions: { ...base.positions, "split-1": { x: 200, y: 300 } },
  };
  const result = reconcileGraph([...steps, makeStep("s3")], graphWithSplitter);
  const splitter = result.nodes.find((n) => n.id === "split-1");
  expect(splitter).toBeTruthy();
  expect(splitter?.branches).toEqual(["go_a", "go_b"]);
  expect(result.positions["split-1"]).toEqual({ x: 200, y: 300 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @orca/desktop test -- graph-sync`
Expected: FAIL — `reconcileGraph` only preserves `type === "gate"` nodes, so the splitter is dropped.

- [ ] **Step 3: Generalize the non-step preservation in `reconcileGraph`**

Change the `existingGates` filter (~line 44) to keep both gate and splitter nodes:

```typescript
  const existingNonStep = graph.nodes.filter((n) => n.type === "gate" || n.type === "splitter");
```

Update the two downstream uses (the `validNodeIds` set ~80-83 and the output `nodes` ~113) to reference `existingNonStep` instead of `existingGates`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @orca/desktop test -- graph-sync`
Expected: PASS (gate-preservation test still green).

- [ ] **Step 5: Update `handleGraphChange` in TemplateDetail**

Change the `next.nodes.filter((n) => n.type === "gate")` (~line 241) to:

```typescript
    const nonStepNodes = next.nodes.filter((n) => n.type === "gate" || n.type === "splitter");
```

and use `nonStepNodes` in the returned `nodes: [...stepNodes, ...nonStepNodes]`.

- [ ] **Step 6: Add the splitter case to `handleAddNode`**

Mirror the gate block (~265-285) with a splitter branch:

```typescript
    } else if (type === "splitter") {
      setDraft((current) => {
        const id = `splitter-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
        const ys = Object.values(current.graph.positions).map((p) => p.y);
        const maxY = ys.length ? Math.max(...ys) : 0;
        const pos = { x: 110, y: maxY + 92 };
        const splitterNode: WorkflowGraphNode = {
          id, type: "splitter", name: "New splitter", branches: ["Branch A", "Branch B"],
        };
        const nextGraph: WorkflowGraph = {
          ...current.graph,
          nodes: [...current.graph.nodes, splitterNode],
          positions: { ...current.graph.positions, [id]: pos },
        };
        setTimeout(() => setOpenNodeId(id), 0);
        return { ...current, graph: nextGraph };
      });
    }
```

(Adjust the `handleAddNode` signature/type to `"step" | "gate" | "splitter"` — coordinate with Task 3's `onAddNode` widening; if Task 3 isn't done yet, widen the type here too so it compiles.)

- [ ] **Step 7: Run desktop typecheck + graph-sync test**

Run: `pnpm --filter @orca/desktop typecheck && pnpm --filter @orca/desktop test -- graph-sync`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/workflows/graph-sync.ts apps/desktop/src/workflows/TemplateDetail.tsx apps/desktop/src/workflows/graph-sync.test.ts
git commit -m "feat(desktop): preserve and add splitter nodes in the graph model"
```

---

### Task 3: Canvas render — add-splitter button, splitter node, N branch ports

**Files:**
- Modify: `apps/desktop/src/workflows/WorkflowFlow.tsx`
- Test: `apps/desktop/src/workflows/WorkflowFlow.test.tsx`

**Interfaces:**
- Consumes: `SplitterGlyph` (Task 1); `n.branches` on splitter nodes.
- Produces: `onAddNode` type `"step" | "gate" | "splitter"`; an "Add splitter" toolbar button; splitter nodes render with the splitter glyph and a distinct style; one labeled output port button per declared branch (drag wires an edge with `port = branchLabel`); `linkDrag.fromPort` widened to `string`.

- [ ] **Step 1: Write the failing test**

In `WorkflowFlow.test.tsx`, mirror an existing gate-render test. Assert (a) an "Add splitter" control exists and calls `onAddNode("splitter")`, and (b) a splitter node renders one port control per branch label:

```typescript
it("renders one output port per splitter branch", () => {
  const graph = {
    nodes: [
      { id: "s0", type: "step" as const, name: "Triage", stepId: "s0" },
      { id: "route", type: "splitter" as const, name: "Route", branches: ["go_a", "go_b"] },
    ],
    edges: [{ from: "s0", to: "route" }],
    positions: { s0: { x: 110, y: 20 }, route: { x: 110, y: 112 } },
  };
  render(<WorkflowFlow graph={graph} steps={[/* s0 step */]} onAddNode={vi.fn()} /* ...required props */ />);
  expect(screen.getByTitle(/connect go_a branch/i)).toBeInTheDocument();
  expect(screen.getByTitle(/connect go_b branch/i)).toBeInTheDocument();
});

it("adds a splitter via the toolbar", () => {
  const onAddNode = vi.fn();
  render(<WorkflowFlow /* ...props */ onAddNode={onAddNode} />);
  fireEvent.click(screen.getByText(/add splitter/i));
  expect(onAddNode).toHaveBeenCalledWith("splitter");
});
```

(Fill in the full required `WorkflowFlow` props by copying an existing render in this test file.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @orca/desktop test -- WorkflowFlow`
Expected: FAIL — no "Add splitter" control; splitter renders no branch ports.

- [ ] **Step 3: Widen `onAddNode` and `linkDrag.fromPort`**

- `onAddNode` (~line 9): `(type: "step" | "gate" | "splitter") => void`.
- `linkDrag` `fromPort` (~41-47): change `fromPort?: "approved" | "rejected"` to `fromPort?: string`.

- [ ] **Step 4: Add the "Add splitter" toolbar button**

After the Add-gate button (~268), inside the `!readOnly` toolbar, add a button mirroring it that calls `onAddNode("splitter")` and shows `<SplitterGlyph size={12} />` + "Add splitter" (import `SplitterGlyph`).

- [ ] **Step 5: Render splitter nodes + N branch ports**

- Add `const isSplitter = n.type === "splitter";` near `isGate` (~422). Give splitter a distinct but gate-like style (e.g. reuse the gate rounded style or a different `borderRadius`/accent so it's visually distinct from both step and gate). Show `<SplitterGlyph />` in the icon slot for splitters (mirror the `isGate` icon branch ~478-489).
- Add a splitter output-port block mirroring the gate two-port block (~563-611), but iterate `n.branches ?? []` and space ports evenly: for branch index `bi` of `count` branches, `left: ((bi + 1) / (count + 1)) * 100 + "%"`, `title={\`Drag to connect ${branch} branch\`}`, label text = the branch label, and on mousedown set `setLinkDrag({ fromId: n.id, fromPort: branch, ... })` with `startX = p.x + NODE_W * ((bi + 1) / (count + 1))`, `startY = p.y + NODE_H`. Render only when `!readOnly && isSplitter`.

The edge-commit code (~159-163) already stores `port` when `fromPort` is set, and the edge port `<text>` (~390-400) already renders any string — no change needed there.

- [ ] **Step 6: Run to verify pass**

Run: `pnpm --filter @orca/desktop test -- WorkflowFlow`
Expected: PASS (existing step/gate render tests stay green).

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter @orca/desktop typecheck
git add apps/desktop/src/workflows/WorkflowFlow.tsx apps/desktop/src/workflows/WorkflowFlow.test.tsx
git commit -m "feat(desktop): render splitter nodes with per-branch output ports"
```

---

### Task 4: Node detail — splitter branch-label editor

**Files:**
- Modify: `apps/desktop/src/workflows/NodeDetailModal.tsx`
- Modify: `apps/desktop/src/workflows/TemplateDetail.tsx` (`openNodeDetail` memo ~358-376)
- Test: `apps/desktop/src/workflows/NodeDetailModal.test.tsx`

**Interfaces:**
- Produces: a `NodeDetail` `kind: "splitter"` variant `{ kind: "splitter"; name: string; instructions: string; branches: string[]; onChange: (patch: { name?: string; instructions?: string; branches?: string[] }) => void }`; a `SplitterBody` editor (instructions textarea + a branch-label list with add/remove/rename, enforcing 2–8 labels); `openNodeDetail` returns this for `node.type === "splitter"`.

- [ ] **Step 1: Write the failing tests**

In `NodeDetailModal.test.tsx`, add a `makeSplitterDetail` factory and tests for renaming a branch, adding a branch, and editing instructions:

```typescript
function makeSplitterDetail(onChange = vi.fn()): Extract<NodeDetail, { kind: "splitter" }> {
  return { kind: "splitter", name: "Route", instructions: "Pick the entry tier", branches: ["go_a", "go_b"], onChange };
}

it("renames a branch label", () => {
  const onChange = vi.fn();
  render(<NodeDetailModal detail={makeSplitterDetail(onChange)} index={0} total={3} onPrev={null} onNext={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} />);
  const input = screen.getByDisplayValue("go_a");
  fireEvent.change(input, { target: { value: "clarify_first" } });
  expect(onChange).toHaveBeenCalledWith({ branches: ["clarify_first", "go_b"] });
});

it("adds a branch", () => {
  const onChange = vi.fn();
  render(<NodeDetailModal detail={makeSplitterDetail(onChange)} index={0} total={3} onPrev={null} onNext={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} />);
  fireEvent.click(screen.getByText(/add branch/i));
  expect(onChange).toHaveBeenCalledWith({ branches: ["go_a", "go_b", expect.any(String)] });
});

it("edits splitter instructions", () => {
  const onChange = vi.fn();
  render(<NodeDetailModal detail={makeSplitterDetail(onChange)} index={0} total={3} onPrev={null} onNext={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} />);
  fireEvent.change(screen.getByPlaceholderText(/route to/i), { target: { value: "If vague, go clarify" } });
  expect(onChange).toHaveBeenCalledWith({ instructions: "If vague, go clarify" });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @orca/desktop test -- NodeDetailModal`
Expected: FAIL — no splitter variant/body.

- [ ] **Step 3: Add the union variant**

Add to `NodeDetail` (~6-25):

```typescript
  | {
      kind: "splitter";
      name: string;
      instructions: string;
      branches: string[];
      onChange: (patch: { name?: string; instructions?: string; branches?: string[] }) => void;
    }
```

- [ ] **Step 4: Add `SplitterBody` and dispatch to it**

Add an `isSplitter = detail.kind === "splitter"` flag; use it for the header icon (`SplitterGlyph`), breadcrumb label ("Splitter"), and name placeholder. In the body dispatch (~180-188), render `<SplitterBody detail={...} readOnly={readOnly} />` for the splitter kind. Implement:

```tsx
function SplitterBody({ detail, readOnly }: { detail: Extract<NodeDetail, { kind: "splitter" }>; readOnly?: boolean }) {
  const branches = detail.branches ?? [];
  const rename = (i: number, value: string) =>
    detail.onChange({ branches: branches.map((b, j) => (j === i ? value : b)) });
  const add = () => detail.onChange({ branches: [...branches, `Branch ${String.fromCharCode(65 + branches.length)}`] });
  const remove = (i: number) => detail.onChange({ branches: branches.filter((_, j) => j !== i) });
  return (
    <div>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>Instructions</div>
      <textarea
        value={detail.instructions ?? ""}
        onChange={(e) => !readOnly && detail.onChange({ instructions: e.target.value })}
        readOnly={readOnly}
        placeholder="Route to the branch that best fits the goal; e.g. if vague, go clarify."
        rows={5}
      />
      <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", marginTop: 10 }}>Branches</div>
      {branches.map((b, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <input value={b} maxLength={60} readOnly={readOnly}
            onChange={(e) => !readOnly && rename(i, e.target.value)} />
          {!readOnly && branches.length > 2 && (
            <button type="button" onClick={() => remove(i)} title="Remove branch">×</button>
          )}
        </div>
      ))}
      {!readOnly && branches.length < 8 && (
        <button type="button" onClick={add} style={{ marginTop: 6 }}>Add branch</button>
      )}
      <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 8, lineHeight: 1.5 }}>
        The splitter reasons over context and routes to exactly one branch. Wire one outgoing edge per branch on the canvas.
      </div>
    </div>
  );
}
```

(Match the file's existing styling conventions for inputs/buttons; the Add/× guards enforce the 2–8 bound.)

- [ ] **Step 5: Add the `openNodeDetail` splitter case in TemplateDetail**

In the memo (~358-376), before/after the gate case, add:

```typescript
    if (node.type === "splitter") {
      return {
        kind: "splitter",
        name: node.name,
        instructions: node.instructions ?? "",
        branches: node.branches ?? [],
        onChange: (patch) => {
          setDraft((current) => ({
            ...current,
            graph: {
              ...current.graph,
              nodes: current.graph.nodes.map((n) => (n.id === openNodeId ? { ...n, ...patch } : n)),
            },
          }));
        },
      };
    }
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm --filter @orca/desktop test -- NodeDetailModal`
Expected: PASS (gate-body tests still green).

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter @orca/desktop typecheck
git add apps/desktop/src/workflows/NodeDetailModal.tsx apps/desktop/src/workflows/TemplateDetail.tsx apps/desktop/src/workflows/NodeDetailModal.test.tsx
git commit -m "feat(desktop): splitter node detail with a branch-label editor"
```

---

### Task 5: Confirmation card — Continue routes to confirmSplit for splitter parks

**Files:**
- Modify: `apps/desktop/src/api.ts` (after `confirmStep` ~1767)
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx` (`handleContinue`)
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx` if present (else a focused api test or a `handleContinue` unit test); mirror the file's existing confirm/gate test.

**Interfaces:**
- Produces: `export async function confirmSplit(runId: string): Promise<void>` (POST `/v1/workflows/runs/:id/confirm-split`, empty body, mirrors `confirmStep`); `handleContinue` calls `confirmSplit(runId)` when the parked run's `currentNodeKind === "splitter"`, else `confirmStep(runId)`.

- [ ] **Step 1: Add the API client**

Mirror `confirmStep` exactly (no body):

```typescript
export async function confirmSplit(runId: string): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  await requestVoid(
    `${baseUrl}/v1/workflows/runs/${runId}/confirm-split`,
    { method: "POST", headers: authHeaders(token) },
    "Failed to confirm split",
  );
}
```

- [ ] **Step 2: Write the failing test**

In the OrcaChat test (mirror the existing Continue/`handleGateDecision` test), assert that when the live run is parked at a splitter (`currentNodeKind === "splitter"`), clicking Continue calls `confirmSplit(runId)`, not `confirmStep`. Mock the api module:

```typescript
// mock confirmSplit + confirmStep; render OrcaChat with a run whose currentNodeKind === "splitter"
// and a paused step_confirmation_pending activity; click Continue; expect confirmSplit called with runId, confirmStep NOT called.
```

(Use the test file's existing harness for mounting OrcaChat with a fake run + activities. If OrcaChat has no test harness, add a focused test that exercises the dispatch helper you extract — see Step 3.)

- [ ] **Step 3: Route Continue**

In `handleContinue` (which currently calls `confirmStep(runId)`), branch on the live run's node kind. The run object in OrcaChat exposes `currentNodeKind`:

```typescript
  async function handleContinue() {
    if (!runId) return;
    setContinuing(true);
    try {
      if (run?.currentNodeKind === "splitter") {
        await confirmSplit(runId);
      } else {
        await confirmStep(runId);
      }
      setRefreshNonce((c) => c + 1);
    } catch (err) {
      setActionError(toErrorMessage(err, "Failed to continue."));
    } finally {
      setContinuing(false);
    }
  }
```

(Reconcile the exact state setters/var names — `run`, `runId`, `setContinuing`, `setRefreshNonce`, `toErrorMessage` — with what `handleContinue`/`handleGateDecision` already use. Import `confirmSplit`.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @orca/desktop test -- OrcaChat` (or the focused test added)
Expected: PASS — Continue dispatches to `confirmSplit` for splitter parks, `confirmStep` otherwise.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @orca/desktop typecheck
git add apps/desktop/src/api.ts apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): route supervised splitter Continue to confirmSplit"
```

---

## Self-Review

**Spec coverage:**
- Author splitter (icon, add button, render, branch ports, detail editor, graph-sync) → Tasks 1-4. ✓
- Supervised confirmation Continue → `confirmSplit` (no branch UI, no new activity kind, gated on `currentNodeKind === "splitter"`) → Task 5. ✓
- `linkDrag.fromPort` widened; edge port text + commit already generic → Task 3. ✓
- 2–8 branch bound enforced in the editor (Add/× guards) → Task 4. ✓
- Gate/step authoring + runtime untouched; daemon validation handles malformed graphs → constraints. ✓

**Reconciliation note (important):** The desktop survey proposed a `splitter_decision_pending` activity kind with N branch-pick buttons. That is REJECTED here — it contradicts Plan 2 (splitter is always automated; supervised mode is a Continue acknowledgment, and Plan 2 already parks as `step_confirmation_pending` resolved by branch-less `confirmSplit(runId)`). Plan 3 reuses the existing step-confirmation card and only redirects its Continue action. No contracts/activity-kind change.

**Placeholder scan:** Component/method bodies given in full; test bodies specified with concrete assertions. WorkflowFlow/OrcaChat tests say "copy the existing harness/props" because those render helpers are large and already exist — the implementer adapts them (intended pattern), not hand-invents.

**Type consistency:** `onAddNode`/`handleAddNode` both widen to `"step"|"gate"|"splitter"`. `NodeDetail` splitter `onChange` patch (`{name?,instructions?,branches?}`) matches `SplitterBody` calls and the `openNodeDetail` producer. `confirmSplit(runId)` (no branch) matches Plan 2's route. `linkDrag.fromPort: string` matches the edge `port` string. `reconcileGraph`/`handleGraphChange` both broaden the same `gate||splitter` predicate.

**Risk note:** Use a standard model for Tasks 2-5 (multi-file React with existing harnesses to adapt); Task 1 is trivial. Reconcile OrcaChat/WorkflowFlow var names against the real files — the references are faithful but the surrounding state names must match.
