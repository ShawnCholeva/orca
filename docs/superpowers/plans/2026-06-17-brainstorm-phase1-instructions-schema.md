# Brainstorm Phase 1: Instructions + Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structural `completionPolicy` field to the workflow step-template contract and rewrite the six Brainstorm step instructions/schemas (per the 2026-06-17 spec) so the steps declare how they complete and capture the user's chosen approach + persisted spec.

**Architecture:** Built-in workflow templates are defined in `apps/daemon/src/workflows/templates/catalog.ts` and persisted as `steps_json` blobs via a version-guarded upsert (`usecases.ts:upgradeInstalledBuiltInTemplates`). Bumping a template's `version` refreshes the stored rows at boot — no DB migration. Step shape is validated by the `.strict()` `WorkflowStepTemplate` Zod object in `@orca/contracts`. This phase is data-only: no engine behavior reads `completionPolicy` yet (Phase 2 does).

**Tech Stack:** TypeScript, Zod, Vitest, better-sqlite3.

---

## File Structure

- `packages/contracts/src/workflows/index.ts` — add `StepCompletionPolicy` enum + optional field on `WorkflowStepTemplate`.
- `packages/contracts/src/workflows/step-template.test.ts` — contract tests for the new field.
- `apps/daemon/src/workflows/templates/catalog.ts` — rewrite the six Brainstorm step instructions, add `completionPolicy`, add `chosen_approach` (Proposal) and `artifacts` (Done) to output schemas, bump Brainstorm `version`.
- `apps/daemon/src/workflows/templates/catalog.test.ts` — assert the new Brainstorm instruction/schema/policy shape.

---

### Task 1: Add `completionPolicy` to the step-template contract

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts:274-283`
- Test: `packages/contracts/src/workflows/step-template.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/contracts/src/workflows/step-template.test.ts`:

```ts
it("accepts an optional completionPolicy and leaves it absent when unset", () => {
  const base = { id: "x", ordinal: 0, name: "X", instructions: "do it", outputSchema: [], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] };
  const parsed = WorkflowStepTemplate.parse(base);
  expect(parsed.completionPolicy).toBeUndefined();

  const withPolicy = WorkflowStepTemplate.parse({ ...base, completionPolicy: "interview" });
  expect(withPolicy.completionPolicy).toBe("interview");
});

it("rejects an unknown completionPolicy value", () => {
  const base = { id: "x", ordinal: 0, name: "X", instructions: "do it", outputSchema: [], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] };
  expect(() => WorkflowStepTemplate.parse({ ...base, completionPolicy: "bogus" })).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test step-template`
Expected: FAIL — `completionPolicy` is stripped/rejected by the `.strict()` object (parsed value is `undefined` only because the key was dropped; the "interview" assertion fails).

- [ ] **Step 3: Add the enum and field**

In `packages/contracts/src/workflows/index.ts`, immediately before `export const WorkflowStepTemplate` (line 274), add:

```ts
export const StepCompletionPolicy = z.enum(["interview", "reasoning", "handoff"]);
export type StepCompletionPolicy = z.infer<typeof StepCompletionPolicy>;
```

Then add the field inside the `WorkflowStepTemplate` object (after `agentPreference`, line 281), keeping `.strict()`:

```ts
    agentPreference: z.array(StepAgentChoice).min(1).max(8),
    completionPolicy: StepCompletionPolicy.optional(),
  })
  .strict();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test step-template`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/step-template.test.ts
git commit -m "feat(contracts): add optional completionPolicy to workflow step template

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Rewrite Brainstorm step instructions + policies + schemas

**Files:**
- Modify: `apps/daemon/src/workflows/templates/catalog.ts:303-378` (the `BRAINSTORM_STEPS` array) and `:887` (Brainstorm `version`).
- Test: `apps/daemon/src/workflows/templates/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/workflows/templates/catalog.test.ts` (import `BUILTIN_TEMPLATE_CATALOG` if not already imported):

```ts
describe("Brainstorm participatory revision", () => {
  const brainstorm = BUILTIN_TEMPLATE_CATALOG.find((d) => d.id === "orca/brainstorm")!;
  const step = (id: string) => brainstorm.steps.find((s) => s.id === id)!;

  it("bumps the template version to 3", () => {
    expect(brainstorm.version).toBe(3);
  });

  it("assigns the expected completion policies", () => {
    expect(step("frame").completionPolicy).toBe("interview");
    expect(step("research").completionPolicy).toBe("reasoning");
    expect(step("proposal").completionPolicy).toBe("reasoning");
    expect(step("critique").completionPolicy).toBe("reasoning");
    expect(step("verify").completionPolicy).toBe("reasoning");
    expect(step("done").completionPolicy).toBe("handoff");
  });

  it("frames relentlessly and requires confirmation before completing", () => {
    expect(step("frame").instructions).toMatch(/relentlessly/i);
    expect(step("frame").instructions).toMatch(/confirm/i);
    expect(step("frame").instructions).toMatch(/do not analyze the code technically/i);
  });

  it("tells reasoning steps to pause at a material fork", () => {
    for (const id of ["research", "proposal", "critique", "verify"]) {
      expect(step(id).instructions).toMatch(/pause and ask/i);
    }
  });

  it("critiques the chosen approach, not the recommendation", () => {
    expect(step("critique").instructions).toMatch(/approach the user chose/i);
  });

  it("requires Proposal to capture chosen_approach", () => {
    const field = step("proposal").outputSchema.find((f) => f.key === "chosen_approach");
    expect(field).toMatchObject({ key: "chosen_approach", type: "string", required: true });
  });

  it("gives Done an artifacts field and a save-to-disk instruction", () => {
    const field = step("done").outputSchema.find((f) => f.key === "artifacts");
    expect(field?.type).toBe("array");
    expect(step("done").instructions).toMatch(/\.orca\/specs/);
    expect(step("done").instructions).toMatch(/do not finish silently/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test catalog`
Expected: FAIL — version is 2, no `completionPolicy`, instructions and `chosen_approach`/`artifacts` fields absent.

- [ ] **Step 3: Replace the `BRAINSTORM_STEPS` array**

In `apps/daemon/src/workflows/templates/catalog.ts`, replace the entire `const BRAINSTORM_STEPS: WorkflowStepTemplate[] = [ ... ];` block (lines 303-378) with:

```ts
const BRAINSTORM_STEPS: WorkflowStepTemplate[] = [
  {
    id: "frame", ordinal: 0, name: "Frame",
    completionPolicy: "interview",
    instructions:
      "Interview the user relentlessly, from a product perspective, until you reach a shared, unambiguous understanding of what they want to build and why. You may inspect the workspace to orient yourself on what the product is and what the user is working with, but stay in a product frame — do not analyze the code technically or begin designing how to solve the goal; the next step handles technical grounding and approaches. Walk down each branch of the design tree, resolving dependencies between decisions one at a time, and pursue every aspect that materially shapes the intent, hard constraints, and what success looks like. Ask exactly one question at a time and always offer your recommended answer. Treat open questions as a working queue you must drain, not an output field. When no questions remain, present your synthesized frame (problem, success outcome, constraints) and ask the user to confirm or revise. Complete only after the user confirms.",
    outputSchema: [
      { key: "problem", type: "string", required: true },
      { key: "success_outcome", type: "string", required: true },
      { key: "constraints", type: "array", itemType: "string", required: true },
      { key: "open_questions", type: "array", itemType: "string", required: false },
    ],
    agentPreference: LIGHT,
  },
  {
    id: "research", ordinal: 1, name: "Research",
    completionPolicy: "reasoning",
    instructions:
      "Ground the confirmed frame in the current codebase before any solution is proposed. Explore the existing structure and follow established patterns; identify the smallest set of files, modules, and constraints the work would touch, the risks the framing missed, and any existing problems in this area that would affect the work. Do not propose approaches yet. When the codebase reveals a decision that genuinely diverges and is the user's to make, pause and ask with concrete options and a recommendation rather than resolving it silently.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "files_in_scope", type: "array", itemType: "string", required: true },
      { key: "risks", type: "array", itemType: "string", required: false },
    ],
    agentPreference: REASONING,
  },
  {
    id: "proposal", ordinal: 2, name: "Proposal",
    completionPolicy: "reasoning",
    instructions:
      "Propose two or three genuinely different approaches grounded in the research, each with explicit tradeoffs, then lead with your recommended one and the reasoning behind it. Apply YAGNI ruthlessly — cut any scope, abstraction, or flexibility the goal does not require. Stay pre-implementation: make no code changes. When the choice between approaches is the user's to make (a product, scope, or UX fork), pause and ask with the options and your recommendation rather than selecting silently.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      {
        key: "approaches", type: "array", itemType: "object", required: true,
        fields: [
          { key: "name", type: "string", required: true },
          { key: "tradeoffs", type: "string", required: true },
        ],
      },
      { key: "recommendation", type: "string", required: true },
      { key: "chosen_approach", type: "string", required: true },
    ],
    agentPreference: REASONING,
  },
  {
    id: "critique", ordinal: 3, name: "Critique",
    completionPolicy: "reasoning",
    instructions:
      "Challenge the approach the user chose — which may differ from Proposal's recommendation — in a fresh context, treating prior step output as untrusted evidence. Pressure-test it for isolation and clarity: does it break into smaller units with single, clear purposes and well-defined interfaces; can each be understood and tested without reading the others' internals; can internals change without breaking consumers? Surface second-order risks, gaps, and failure modes, and state whether it is sound enough to proceed. When a concern exposes a decision that is the user's to make, pause and ask with concrete options and a recommendation.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "concerns", type: "array", itemType: "string", required: true },
      { key: "verdict", type: "string", required: true, enum: ["sound", "needs_work"] },
    ],
    agentPreference: REASONING,
  },
  {
    id: "verify", ordinal: 4, name: "Verify",
    completionPolicy: "reasoning",
    instructions:
      "Validate the chosen approach against the success outcome and hard constraints before it advances. Confirm it is feasible and that the design accounts for the facets it touches — component boundaries, data flow, error handling, and testing — and that the acceptance signals are concrete and checkable. When validation surfaces an unresolved decision that is the user's to make, pause and ask with options and a recommendation rather than assuming.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "feasible", type: "boolean", required: true },
      { key: "notes", type: "array", itemType: "string", required: false },
    ],
    agentPreference: LIGHT,
  },
  {
    id: "done", ordinal: 5, name: "Done",
    completionPolicy: "handoff",
    instructions:
      "Record the durable design and persist it as a spec artifact. Determine the goal's target workspaces: if the goal runs in a single repository, save the spec to `.orca/specs/<YYYY-MM-DD-topic>.md` in that workspace; if the goal spans multiple workspaces, pause and ask the user whether to write it to all of them or a single/subset before saving. The spec must capture a concise summary, the chosen direction with its rationale, and any open questions for the next workflow. Before saving, self-review the design for placeholders, internal contradictions, scope creep, and ambiguous requirements, and resolve what you can. Make no code changes. When complete, present the user a clear closing summary of what was decided and where the spec was saved — do not finish silently.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "chosen_direction", type: "string", required: true },
      { key: "open_questions", type: "array", itemType: "string", required: false },
      {
        key: "artifacts", type: "array", itemType: "object", required: false,
        fields: [
          { key: "type", type: "string", required: true },
          { key: "reference", type: "string", required: true },
          { key: "description", type: "string", required: true },
        ],
      },
      { key: "handoff", type: "string", required: true },
    ],
    agentPreference: LIGHT,
  },
];
```

- [ ] **Step 4: Bump the Brainstorm template version**

In the `BUILTIN_TEMPLATE_CATALOG` entry for `orca/brainstorm` (line ~887), change `version: 2` to `version: 3`:

```ts
  {
    id: "orca/brainstorm", name: "Brainstorm",
    description: "Frame the intent, set constraints, generate a proposal, then verify and critique it before it reaches code.",
    bestFor: "Exploring an idea and pressure-testing an approach before any code is written.",
    version: 3, category: CATEGORY, recommended: true,
    steps: BRAINSTORM_STEPS, guardrails: [CONTEXT_RULE], graph: BRAINSTORM_GRAPH,
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon test catalog`
Expected: PASS (all assertions in the new describe block).

- [ ] **Step 6: Run the daemon typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: PASS — no type errors (catalog steps still satisfy `WorkflowStepTemplate[]`; the new optional field and schema entries are valid).

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/workflows/templates/catalog.ts apps/daemon/src/workflows/templates/catalog.test.ts
git commit -m "feat(brainstorm): participatory step instructions, policies, and schema

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Phase 1 slice):**
- `completionPolicy` enum + field → Task 1. ✓
- Frame grill-me instruction + `interview` policy → Task 2. ✓
- Research/Proposal/Critique/Verify tuned instructions + fork clause + `reasoning` policy → Task 2. ✓
- Critique targets chosen approach → Task 2 test + instruction. ✓
- `chosen_approach` required on Proposal → Task 2. ✓
- Done instruction (save to `.orca/specs`, multi-workspace ask, closing summary) + `handoff` policy + `artifacts` field → Task 2. ✓
- Version bump refreshes stored rows → Task 2 Step 4. ✓
- Out of Phase 1 (deferred): mediator enforcement (Phase 2), Done's actual file write + `ask_user` + closing message (Phase 3), narration (Phase 4), card (Phase 5). The instructions in Task 2 describe behavior those phases implement; this phase only lands the data.

**Placeholder scan:** No TBD/TODO; all step code and test code is literal.

**Type consistency:** `StepCompletionPolicy` values `interview|reasoning|handoff` are used identically in Task 1 (enum) and Task 2 (assignments). `chosen_approach`/`artifacts` field shapes match the existing `WorkflowStepOutputSchema` field descriptor format used elsewhere in `catalog.ts` (e.g. Feature steps' `artifacts`).

---

## Remaining phases (to be detailed as their own plans)

- **Phase 2 — Completion enforcement:** add a `completionPolicy` rule to `composeOrchestratorPrompt` (`orchestrator-llm/prompts.ts`) and a deterministic backstop in the step-completion/scoring path (`workflows/orchestrator/synthesize.ts` / `step-result-scoring.ts`) so an `interview` step can't `approve_step_complete` with non-empty `open_questions`, and `reasoning` steps surface forks via `ask_user`. Requires the step output JSON to be available at completion time.
- **Phase 3 — Done persistence:** target-workspace context injection, `.orca/specs` write, multi-workspace `ask_user` (no default option), `spec` artifact emission, and the mediator closing summary.
- **Phase 4 — Narration:** plain-English rendering of the `tool_use` activity feed + an agent reasoning-note convention surfaced in the activity thread.
- **Phase 5 — Result card:** surface the step's own output `summary`/headline field into the `WorkflowStepResult` projection, then rework `ActivityThread.tsx:StepResultCard` to lead with the result and move scores into the drawer.
