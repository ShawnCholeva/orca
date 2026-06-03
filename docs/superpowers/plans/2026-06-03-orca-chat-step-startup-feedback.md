# Orca Chat Step Startup Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the idle-looking, redundant startup state of the Orca chat with a "step is starting…" indicator that names the real workflow step, and remove the redundant goal title/description header card.

**Architecture:** All changes live in one React component, `apps/desktop/src/orchestrator/OrcaChat.tsx`, plus its test `OrcaChat.test.tsx`. We (1) delete the redundant header `SystemCard`, (2) render a `ThinkingRow`-style "starting" indicator while the run + step are active and Orca/agent has not yet spoken, and (3) enrich that indicator with the step's human name by fetching the workflow template inside the existing `load()` effect. No daemon, contract, or API-client changes — `getWorkflowTemplate` already exists.

**Tech Stack:** React + TypeScript, Vitest + @testing-library/react, `@orca/contracts` types.

---

## File Structure

- **Modify:** `apps/desktop/src/orchestrator/OrcaChat.tsx`
  - Remove the redundant header `SystemCard` (lines 381–387).
  - Add a `stepName: string | null` field to the `WorkflowState` type, `EMPTY_WORKFLOW_STATE`, and every `setWorkflowState(...)` call site.
  - Resolve `stepName` inside the existing `load()` effect via `getWorkflowTemplate(run.templateId)`.
  - Render a "starting" indicator (reusing the existing `ThinkingRow`) before the mapped messages.
  - Import `getWorkflowTemplate` from `../api`.
- **Modify (Test):** `apps/desktop/src/orchestrator/OrcaChat.test.tsx`
  - Update the existing test that depended on the removed header card.
  - Add the `getWorkflowTemplate` mock + a default template resolution.
  - Add cases for the starting indicator (shows with name, hidden once Orca spoke, ordinal-only fallback).

### Key facts confirmed from the codebase (do not re-derive)

- `WorkflowState` is defined at `OrcaChat.tsx:40-46`; `EMPTY_WORKFLOW_STATE` at `48-54`.
- The workflow `load()` effect is at `OrcaChat.tsx:176-244`. It already fetches `getGoalDetail`, `getWorkflowRun`, `listWorkflowDecisions`, `listWorkflowRunArtifacts`, and `getWorkflowStepRun`. There are **three** `setWorkflowState` call sites to keep in sync: the no-run branch (`199-205`), the active branch (`222-228`), and the error branch (`233`, via `EMPTY_WORKFLOW_STATE`).
- `getWorkflowTemplate(id)` is exported from `apps/desktop/src/api.ts:780` and returns `{ template }` (`GetWorkflowTemplateResponse`).
- `WorkflowRun.templateId` exists (`contracts/.../workflows/index.ts:335`). `WorkflowTemplate.steps[]` items have `{ id, ordinal, name }` (`WorkflowStepTemplate`, lines `271-281`). `WorkflowStepRun` carries `stepTemplateId` and `ordinal` (`406-425`).
- The existing `ThinkingRow` component (`OrcaChat.tsx:727-741`) takes a single `label: string` prop and renders the label plus animated dots. We reuse it for the starting indicator — no new component needed.
- In the test harness only `OrcaChat` is rendered (no goal rail), so the goal title currently appears **only** via the header card. Removing the card means the title disappears from the test DOM — the existing test at `OrcaChat.test.tsx:148-162` must be updated.

---

## Task 1: Remove the redundant header card

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx:379-387`
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx:148-162`

- [ ] **Step 1: Update the existing test so it asserts the header card is gone**

Replace the test currently at `OrcaChat.test.tsx:148-162` (the `it("shows the selected goal SystemCard and composer when a goal is selected", ...)` block) with this one:

```tsx
  it("does not render the goal title/description header card", async () => {
    setupRunLoad();
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    // Composer is the reliable "goal is selected" signal now that the header
    // card is gone (the goal title lives in the goal rail, not in OrcaChat).
    expect(await screen.findByPlaceholderText("Message Orca…")).toBeInTheDocument();
    // The goal title/description header card no longer renders inside the chat.
    expect(screen.queryByText("Ship Engineering workflow chat")).toBeNull();
    expect(screen.queryByText("Goal description")).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx -t "does not render the goal title/description header card"`
Expected: FAIL — `queryByText("Ship Engineering workflow chat")` finds the header card (still rendered), so `toBeNull()` fails.

- [ ] **Step 3: Remove the header card from the component**

In `OrcaChat.tsx`, delete the `SystemCard` block at lines 381–387 so the `selectedGoal && (` fragment opens directly onto the `loading` indicator. The region currently reads:

```tsx
        {selectedGoal && (
          <>
            <SystemCard
              title={selectedGoal.title}
              body={
                selectedGoal.description ||
                "This goal is ready for supervised workflow orchestration."
              }
            />

            {loading && <ThinkingRow label="routing" />}
```

Change it to:

```tsx
        {selectedGoal && (
          <>
            {loading && <ThinkingRow label="routing" />}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx -t "does not render the goal title/description header card"`
Expected: PASS.

- [ ] **Step 5: Run the full file to confirm no other test relied on the card**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx`
Expected: PASS (all tests green). If any other test fails on a missing goal title, it was relying on the removed card — update it to await `findByPlaceholderText("Message Orca…")` instead.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "refactor(desktop): remove redundant goal header card from Orca chat"
```

---

## Task 2: Render the "starting" indicator with an ordinal-only label

This task adds the indicator with the fallback label only (`Step {ordinal + 1} — starting …`). Task 3 enriches it with the real step name. Splitting this way keeps each test honest under TDD.

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx` (derived flag near line 306; render before `messages.map` at line 495)
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the `describe("OrcaChat", ...)` block in `OrcaChat.test.tsx` (e.g. after the test from Task 1). `setupRunLoad()` already configures an active run (`status: "active"`) and active step (`status: "active"`, `ordinal: 4`) with no orchestrator messages, so the indicator should appear:

```tsx
  it("shows the starting indicator while run and step are active and Orca has not spoken", async () => {
    setupRunLoad();
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    const indicator = await screen.findByTestId("step-starting");
    // ordinal is 4 → "Step 5"; name suffix is added in a later task.
    expect(indicator).toHaveTextContent("Step 5");
    expect(indicator).toHaveTextContent("starting");
  });

  it("hides the starting indicator once an orchestrator message exists", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [orcaMessage] });
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    // Wait for the orchestrator message to land, then assert the indicator is absent.
    expect(await screen.findByText("Start with a bounded verification pass.")).toBeInTheDocument();
    expect(screen.queryByTestId("step-starting")).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx -t "starting indicator"`
Expected: the "shows the starting indicator…" test FAILS (`findByTestId("step-starting")` times out — no such element yet). The "hides…" test passes trivially (no indicator exists), which is fine.

- [ ] **Step 3: Add the derived flag and label**

In `OrcaChat.tsx`, just after the `lastMessage` / `showMarkDoneCard` derivations (currently lines 306–307), add:

```tsx
  // Show a "step is starting…" indicator during the agent's first-turn latency:
  // the run and step are active but neither Orca nor the agent has paraphrased
  // anything into the chat yet. Clears automatically once the first turn lands.
  const orcaHasSpoken = messages.some(
    (m) => m.role === "orchestrator" || m.role === "agent_paraphrased",
  );
  const showStarting =
    workflowState.run?.status === "active" &&
    workflowState.stepRun?.status === "active" &&
    !orcaHasSpoken;
  const startingLabel = workflowState.stepRun
    ? `Step ${workflowState.stepRun.ordinal + 1}${
        workflowState.stepName ? ` · ${workflowState.stepName}` : ""
      } — starting (this can take ~30–60s)…`
    : "";
```

Note: `workflowState.stepName` does not exist on the type yet — Task 3 adds it. To keep this task compiling and green on its own, **temporarily** read it defensively. Use this exact expression instead of `workflowState.stepName` for now:

```tsx
  const startingLabel = workflowState.stepRun
    ? `Step ${workflowState.stepRun.ordinal + 1} — starting (this can take ~30–60s)…`
    : "";
```

(Task 3 replaces this line with the name-aware version above once `stepName` is on the type.)

- [ ] **Step 4: Render the indicator before the mapped messages**

In `OrcaChat.tsx`, immediately before the `{messages.map((message) => {` block (currently line 495), insert:

```tsx
            {showStarting && (
              <div data-testid="step-starting">
                <ThinkingRow label={startingLabel} />
              </div>
            )}

```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx -t "starting indicator"`
Expected: both tests PASS.

- [ ] **Step 6: Run the full file**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): show step-starting indicator during agent first-turn latency"
```

---

## Task 3: Resolve the real step name into the indicator

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx` (import; `WorkflowState` type; `EMPTY_WORKFLOW_STATE`; `load()` effect; `startingLabel`)
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx` (add `getWorkflowTemplate` mock; two cases)

- [ ] **Step 1: Add the `getWorkflowTemplate` mock plumbing and write the failing tests**

In `OrcaChat.test.tsx`, add a mock fn declaration alongside the others (near line 19):

```tsx
const getWorkflowTemplateMock = vi.fn();
```

Add it to the `vi.mock("../api", () => ({ ... }))` object (near line 25):

```tsx
  getWorkflowTemplate: (...args: unknown[]) => getWorkflowTemplateMock(...args),
```

In `beforeEach` (near line 123, beside the other resets), add a reset and a default resolution whose step `id` matches the `stepTemplateId` used by `setupRunLoad` (`"execution"`):

```tsx
    getWorkflowTemplateMock.mockReset();
    getWorkflowTemplateMock.mockResolvedValue({
      template: { steps: [{ id: "execution", ordinal: 4, name: "Build It" }] },
    });
```

Then add these two tests inside the `describe` block:

```tsx
  it("labels the starting indicator with the resolved step name", async () => {
    setupRunLoad();
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    const indicator = await screen.findByTestId("step-starting");
    expect(indicator).toHaveTextContent("Step 5 · Build It");
  });

  it("falls back to an ordinal-only label when the template fetch fails", async () => {
    setupRunLoad();
    getWorkflowTemplateMock.mockRejectedValue(new Error("nope"));
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    const indicator = await screen.findByTestId("step-starting");
    expect(indicator).toHaveTextContent("Step 5 — starting");
    expect(indicator).not.toHaveTextContent("Build It");
    expect(indicator).not.toHaveTextContent("·");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx -t "step name"`
Expected: the "labels … with the resolved step name" test FAILS (indicator shows `Step 5 — starting…`, no `· Build It`, because `stepName` isn't resolved yet). The fallback test may already pass — that's fine; it will still pass after the change.

- [ ] **Step 3: Import `getWorkflowTemplate`**

In `OrcaChat.tsx`, add `getWorkflowTemplate` to the existing import block from `../api` (lines 14–28). Insert it alphabetically near the other `getWorkflow*` imports:

```tsx
  getGoalDetail,
  getWorkflowRun,
  getWorkflowStepRun,
  getWorkflowTemplate,
```

- [ ] **Step 4: Add `stepName` to the `WorkflowState` type and the empty constant**

Change the `WorkflowState` type (lines 40–46) to:

```tsx
type WorkflowState = {
  detail: GoalDetailResponse | null;
  run: WorkflowRun | null;
  stepRun: WorkflowStepRun | null;
  stepName: string | null;
  decisions: WorkflowDecisionTrace[];
  artifacts: WorkflowArtifact[];
};
```

Change `EMPTY_WORKFLOW_STATE` (lines 48–54) to:

```tsx
const EMPTY_WORKFLOW_STATE: WorkflowState = {
  detail: null,
  run: null,
  stepRun: null,
  stepName: null,
  decisions: [],
  artifacts: [],
};
```

- [ ] **Step 5: Set `stepName` at both remaining `setWorkflowState` call sites**

In the no-run branch of `load()` (currently lines 199–205), add `stepName: null`:

```tsx
          setWorkflowState({
            detail,
            run: null,
            stepRun: null,
            stepName: null,
            decisions: [],
            artifacts: [],
          });
```

In the active branch (currently lines 217–228), resolve the template after the step run is fetched, then include `stepName`. Replace the block from the `const stepRun =` assignment through the `setWorkflowState({ ... })` call with:

```tsx
        const stepRun = runResponse.run.currentStepRunId
          ? (await getWorkflowStepRun(goalId, runResponse.run.currentStepRunId)).stepRun
          : null;
        if (cancelled) return;

        // Resolve the step's human name (e.g. "Build It") from the template.
        // Non-critical enrichment: on any failure we leave stepName null and the
        // starting indicator falls back to an ordinal-only label.
        let stepName: string | null = null;
        if (stepRun) {
          try {
            const templateResponse = await getWorkflowTemplate(runResponse.run.templateId);
            if (cancelled) return;
            stepName =
              templateResponse.template.steps.find(
                (step) => step.id === stepRun.stepTemplateId,
              )?.name ?? null;
          } catch {
            stepName = null;
          }
        }

        setWorkflowState({
          detail,
          run: runResponse.run,
          stepRun,
          stepName,
          decisions: sortByCreatedAtDesc(decisionsResponse.decisions),
          artifacts: sortByCreatedAtDesc(artifactsResponse.artifacts),
        });
```

(The error branch already uses `EMPTY_WORKFLOW_STATE`, which now carries `stepName: null` — no change needed there.)

- [ ] **Step 6: Switch `startingLabel` to the name-aware version**

Replace the ordinal-only `startingLabel` from Task 2 with the name-aware version:

```tsx
  const startingLabel = workflowState.stepRun
    ? `Step ${workflowState.stepRun.ordinal + 1}${
        workflowState.stepName ? ` · ${workflowState.stepName}` : ""
      } — starting (this can take ~30–60s)…`
    : "";
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx -t "step name"`
Expected: both PASS.

- [ ] **Step 8: Run the full file plus typecheck**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx`
Expected: PASS.

Run: `cd apps/desktop && pnpm tsc --noEmit`
Expected: no type errors (confirms `stepName` is threaded through every `WorkflowState` usage).

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): resolve real step name for the step-starting indicator"
```

---

## Final Verification

- [ ] **Run the full desktop test + lint + typecheck suite**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx && pnpm tsc --noEmit && pnpm lint`
Expected: all green. (If `pnpm lint` is not defined in `apps/desktop`, run the repo's configured lint command instead.)

- [ ] **Manual smoke (optional but recommended):** Create a goal with a workflow that auto-spawns step 1. Confirm the chat shows `Step 1 · <step name> — starting (this can take ~30–60s)…` immediately, that the goal title/description card is gone, and that the indicator disappears the moment the agent's first paraphrased turn arrives.

---

## Spec Coverage Check

- "Show immediate visible feedback the step is starting" → Task 2 (indicator render) + Task 3 (active-run/active-step/no-orca-message condition).
- "Use the step's real human name, not the template id" → Task 3 (`getWorkflowTemplate` → `steps.find(...).name`).
- "Remove the redundant header card" → Task 1.
- "Indicator clears once the agent's first turn is paraphrased" → Task 2 (`orcaHasSpoken` over `orchestrator`/`agent_paraphrased` roles) + the "hides…" test.
- "Template fetch failure → stepName null, ordinal-only label, no surfaced error" → Task 3 (try/catch returning null) + the fallback test.
- "All changes in `OrcaChat.tsx`; no daemon/contract/API changes" → confirmed; `getWorkflowTemplate` already exists in `api.ts`.
