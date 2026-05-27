# Instruction-Driven Workflow Steps (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deterministic `StepRule` workflow engine with instruction-driven steps where the orchestrator routes each step to a model operator that runs the step's `instructions`, interviews the user when needed, and emits a schema-validated structured output that chains to the next step.

**Architecture:** Workflow steps are authored as `(instructions, outputSchema)`. The orchestrator LLM selects a ready **model** operator (Phase 1) per step; the selected model runs a `run_step_skill` request returning either `{action:"ask", question}` or `{action:"complete", output, completion}`. `ask` surfaces as the existing `request_user_input` input card; `complete` validates `output` against `outputSchema`, stores a `step_output` artifact, and auto-advances intermediate steps (final step → `mark_run_complete` recommendation). Everything is evented and idempotent.

**Tech Stack:** TypeScript monorepo (pnpm workspaces), `zod` contracts in `packages/contracts`, Node daemon in `apps/daemon` (better-sqlite3, event store + projections), React/Vite desktop in `apps/desktop`, `vitest` for tests.

**Spec:** `docs/superpowers/specs/2026-05-27-instruction-driven-workflow-steps-design.md`

---

## Before you start (read these to match existing patterns)

- `packages/contracts/src/workflows/index.ts` — all workflow zod contracts.
- `apps/daemon/src/workflows/orchestrator/service.ts` — `requestNextDecision` and the
  `commit*Decision` helpers, `recordDecisionInTx`, `decisionFingerprint`,
  `appendDecisionRequested`, `createRecommendationForWorkflowInTx`.
- `apps/daemon/src/workflows/operators/selector.ts` — `OperatorSelector.select`,
  `SelectorInput`, `OperatorSelectionResult`.
- `apps/daemon/src/workflows/orchestration-transport/broker.ts` — `propose`, `BrokerResult`,
  `validateProposal` hook.
- `apps/daemon/src/workflows/steps/{routes.ts,projection.ts,usecases.ts}`.
- `apps/daemon/src/workflows/artifacts/usecases.ts` — `createArtifact`,
  `listArtifactsForRun`.
- `apps/daemon/src/workflows/runs/usecases.ts` — run lifecycle; step-run creation lives in
  `apps/daemon/src/workflows/reconcile.ts` (how the next step run is created on advance).
- `apps/daemon/src/migrations.ts` — migration list pattern.
- `apps/desktop/src/workflows/StepEditor.tsx`, `TemplateDetail.tsx`.

Run the whole suite once before starting to capture the green baseline:
`pnpm test` (expect all green at HEAD `7a0d040`).

---

## Task 1: Output schema contract + validator (pure)

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts`
- Create: `packages/contracts/src/workflows/output-schema.ts`
- Test: `packages/contracts/src/workflows/output-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// output-schema.test.ts
import { describe, expect, it } from "vitest";
import { WorkflowStepOutputSchema, validateStepOutput } from "./output-schema.js";

const schema = WorkflowStepOutputSchema.parse([
  { key: "problem", type: "string", required: true },
  { key: "constraints", type: "array", itemType: "string", required: true },
  { key: "open_questions", type: "array", itemType: "string", required: false },
]);

describe("validateStepOutput", () => {
  it("accepts a conforming object", () => {
    const r = validateStepOutput(schema, { problem: "x", constraints: ["a", "b"] });
    expect(r.ok).toBe(true);
  });
  it("rejects a missing required key", () => {
    const r = validateStepOutput(schema, { problem: "x" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors[0]).toMatch(/constraints/);
  });
  it("rejects wrong primitive type", () => {
    const r = validateStepOutput(schema, { problem: 5, constraints: [] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.join()).toMatch(/problem/);
  });
  it("rejects wrong array item type", () => {
    const r = validateStepOutput(schema, { problem: "x", constraints: [1, 2] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.join()).toMatch(/constraints\[0\]/);
  });
  it("validates one level of nested object fields", () => {
    const nested = WorkflowStepOutputSchema.parse([
      { key: "owner", type: "object", required: true, fields: [
        { key: "name", type: "string", required: true },
      ] },
    ]);
    expect(validateStepOutput(nested, { owner: { name: "a" } }).ok).toBe(true);
    expect(validateStepOutput(nested, { owner: {} }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test output-schema`
Expected: FAIL — `Cannot find module './output-schema.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// output-schema.ts
import { z } from "zod";

const PrimitiveType = z.enum(["string", "number", "boolean", "array", "object"]);
const ItemType = z.enum(["string", "number", "boolean", "object"]);

export type WorkflowStepOutputField = {
  key: string;
  type: z.infer<typeof PrimitiveType>;
  required: boolean;
  description?: string;
  itemType?: z.infer<typeof ItemType>;
  fields?: WorkflowStepOutputField[];
};

export const WorkflowStepOutputField: z.ZodType<WorkflowStepOutputField> = z.lazy(() =>
  z.object({
    key: z.string().min(1).max(64),
    type: PrimitiveType,
    required: z.boolean(),
    description: z.string().max(256).optional(),
    itemType: ItemType.optional(),
    fields: z.array(WorkflowStepOutputField).max(32).optional(),
  }).strict()
);

export const WorkflowStepOutputSchema = z.array(WorkflowStepOutputField).min(1).max(32);
export type WorkflowStepOutputSchema = z.infer<typeof WorkflowStepOutputSchema>;

export type ValidateResult = { ok: true } | { ok: false; errors: string[] };

function typeOf(value: unknown): "string" | "number" | "boolean" | "array" | "object" | "other" {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "other";
}

// depth: remaining nesting levels to validate (cap 2 total => start at 1 for nested call)
function checkField(
  field: WorkflowStepOutputField,
  value: unknown,
  path: string,
  depth: number,
  errors: string[]
): void {
  const actual = typeOf(value);
  if (actual !== field.type) {
    errors.push(`${path}: expected ${field.type}, got ${actual}`);
    return;
  }
  if (field.type === "array" && field.itemType) {
    (value as unknown[]).forEach((el, i) => {
      const elPath = `${path}[${i}]`;
      const elActual = typeOf(el);
      if (field.itemType === "object") {
        if (elActual !== "object") errors.push(`${elPath}: expected object, got ${elActual}`);
        else if (field.fields && depth > 0) checkObject(field.fields, el as Record<string, unknown>, elPath, depth - 1, errors);
      } else if (elActual !== field.itemType) {
        errors.push(`${elPath}: expected ${field.itemType}, got ${elActual}`);
      }
    });
  }
  if (field.type === "object" && field.fields && depth > 0) {
    checkObject(field.fields, value as Record<string, unknown>, path, depth - 1, errors);
  }
}

function checkObject(
  fields: WorkflowStepOutputField[],
  obj: Record<string, unknown>,
  path: string,
  depth: number,
  errors: string[]
): void {
  for (const field of fields) {
    const present = Object.prototype.hasOwnProperty.call(obj, field.key);
    const fieldPath = path ? `${path}.${field.key}` : field.key;
    if (!present) {
      if (field.required) errors.push(`${fieldPath}: required key missing`);
      continue;
    }
    checkField(field, obj[field.key], fieldPath, depth, errors);
  }
}

export function validateStepOutput(
  schema: WorkflowStepOutputSchema,
  output: unknown
): ValidateResult {
  if (typeOf(output) !== "object") return { ok: false, errors: ["output: expected object"] };
  const errors: string[] = [];
  checkObject(schema, output as Record<string, unknown>, "", 1, errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test output-schema`
Expected: PASS (5 tests).

- [ ] **Step 5: Re-export from the package entry and commit**

Add to `packages/contracts/src/workflows/index.ts` near the top:
```ts
export {
  WorkflowStepOutputSchema,
  WorkflowStepOutputField,
  validateStepOutput,
  type ValidateResult,
} from "./output-schema.js";
```
Verify `packages/contracts/src/index.ts` re-exports `./workflows/index.js` (it already does). Then:
```bash
git add packages/contracts/src/workflows/output-schema.ts packages/contracts/src/workflows/output-schema.test.ts packages/contracts/src/workflows/index.ts
git commit -m "feat(contracts): add WorkflowStepOutputSchema + validateStepOutput"
```

---

## Task 2: New step template shape + artifact types + interview turn

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts`
- Test: `packages/contracts/src/workflows/step-template.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// step-template.test.ts
import { describe, expect, it } from "vitest";
import { WorkflowStepTemplate, WorkflowArtifactType, InterviewTurn } from "./index.js";

describe("WorkflowStepTemplate (instruction-driven)", () => {
  it("accepts id/ordinal/name/instructions/outputSchema", () => {
    const parsed = WorkflowStepTemplate.parse({
      id: "intake", ordinal: 0, name: "Intake",
      instructions: "Interview the user.",
      outputSchema: [{ key: "problem", type: "string", required: true }],
    });
    expect(parsed.id).toBe("intake");
  });
  it("rejects removed fields", () => {
    expect(() => WorkflowStepTemplate.parse({
      id: "x", ordinal: 0, name: "X", instructions: "i",
      outputSchema: [{ key: "k", type: "string", required: true }],
      gateType: "human-input",
    })).toThrow();
  });
  it("requires instructions and a non-empty outputSchema", () => {
    expect(() => WorkflowStepTemplate.parse({ id: "x", ordinal: 0, name: "X", outputSchema: [] }))
      .toThrow();
  });
});

describe("artifact types + interview turn", () => {
  it("includes step_output and interview_turn", () => {
    expect(WorkflowArtifactType.parse("step_output")).toBe("step_output");
    expect(WorkflowArtifactType.parse("interview_turn")).toBe("interview_turn");
  });
  it("parses an interview turn body", () => {
    const t = InterviewTurn.parse({
      turnIndex: 0, questionDecisionId: "dec-1",
      question: "q", answer: "a", answeredAt: "2026-05-27T00:00:00.000Z",
    });
    expect(t.turnIndex).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test step-template`
Expected: FAIL — `gateType` still accepted / `InterviewTurn` undefined.

- [ ] **Step 3: Modify the contracts**

In `packages/contracts/src/workflows/index.ts`:

Add the byte constant near the other limits:
```ts
export const WORKFLOW_STEP_MAX_INSTRUCTIONS_BYTES = 8192;
```

Replace the entire `WorkflowStepTemplate` definition with:
```ts
export const WorkflowStepTemplate = z
  .object({
    id: Id100,
    ordinal: z.number().int().nonnegative(),
    name: z.string().min(1).max(100),
    instructions: BoundedString(WORKFLOW_STEP_MAX_INSTRUCTIONS_BYTES, "instructions"),
    outputSchema: WorkflowStepOutputSchema,
  })
  .strict();
export type WorkflowStepTemplate = z.infer<typeof WorkflowStepTemplate>;
```
(Ensure the `WorkflowStepOutputSchema` import/export from Task 1 is in scope.)

Extend `WorkflowArtifactType` enum with `"step_output"` and `"interview_turn"`:
```ts
export const WorkflowArtifactType = z.enum([
  "goal_brief", "open_questions", "research_summary", "prd", "issue_breakdown",
  "implementation_result", "test_report", "qa_report", "review_report",
  "final_summary", "memory_update",
  "step_output", "interview_turn",
]);
```

Add the interview-turn body schema (near artifact schemas):
```ts
export const InterviewTurn = z
  .object({
    turnIndex: z.number().int().nonnegative(),
    questionDecisionId: Id,
    question: z.string().min(1).max(2000),
    answer: z.string().min(1).max(8192),
    answeredAt: z.string().datetime(),
  })
  .strict();
export type InterviewTurn = z.infer<typeof InterviewTurn>;
```

`CreateWorkflowStepTemplate` (used by create/update requests) derives from
`WorkflowStepTemplate.omit({ ordinal: true }).extend({ ordinal: ...optional })`. Leave that
derivation as-is — it now inherits the new shape automatically.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test step-template`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/step-template.test.ts
git commit -m "feat(contracts): instruction-driven step template + step_output/interview_turn types"
```

---

## Task 3: Proposal envelope, decision kind, operator descriptor, submit request, step-run fields

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts`
- Test: `packages/contracts/src/workflows/step-skill.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// step-skill.test.ts
import { describe, expect, it } from "vitest";
import {
  StepSkillProposal, OrchestrationDecisionKind, OperatorDescriptor,
  SubmitWorkflowUserInputRequest, WorkflowStepRun,
} from "./index.js";

describe("StepSkillProposal", () => {
  it("parses an ask", () => {
    expect(StepSkillProposal.parse({ action: "ask", question: "why?" }).action).toBe("ask");
  });
  it("parses a complete with self-check", () => {
    const p = StepSkillProposal.parse({
      action: "complete",
      output: { problem: "x" },
      completion: { confidence: "high", assumptions: [], openQuestions: [], whyComplete: "done" },
    });
    expect(p.action).toBe("complete");
  });
});

it("adds run_step_skill kind", () => {
  expect(OrchestrationDecisionKind.parse("run_step_skill")).toBe("run_step_skill");
});

it("operator descriptor carries provider/model", () => {
  const d = OperatorDescriptor.parse({
    id: "orca/anthropic:claude-sonnet-4-6", kind: "model", displayName: "Claude",
    capabilities: [], ready: true, supportsRepoEditing: false, supportsTerminal: false,
    providerId: "orca/anthropic", modelId: "claude-sonnet-4-6",
  });
  expect(d.providerId).toBe("orca/anthropic");
});

it("submit request requires questionDecisionId path", () => {
  const r = SubmitWorkflowUserInputRequest.parse({
    stepRunId: "s1", questionDecisionId: "dec-1", answerText: "hello",
  });
  expect(r.questionDecisionId).toBe("dec-1");
});

it("step run drops exit criteria, adds selection fields", () => {
  const s = WorkflowStepRun.parse({
    id: "s1", goalId: "g", workflowRunId: "r", stepTemplateId: "intake",
    ordinal: 0, attempt: 1, status: "active",
    startedAt: null, finishedAt: null, blockedReason: null,
    selectedOperatorId: "orca/anthropic:claude-sonnet-4-6",
    selectedProviderId: "orca/anthropic", selectedModelId: "claude-sonnet-4-6",
    operatorSelectedAt: "2026-05-27T00:00:00.000Z",
  });
  expect(s.selectedModelId).toBe("claude-sonnet-4-6");
  expect("satisfiedExitCriteria" in s).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test step-skill`
Expected: FAIL — `StepSkillProposal` undefined / `run_step_skill` rejected.

- [ ] **Step 3: Modify the contracts**

Extend `OrchestrationDecisionKind`: add `"run_step_skill"`, remove `"evaluate_exit_criteria"`.

Add the proposal schema (near `OrchestrationProposalEnvelope`):
```ts
export const StepSkillProposal = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ask"),
    question: z.string().min(1).max(2000),
    rationale: z.string().max(1000).optional(),
  }).strict(),
  z.object({
    action: z.literal("complete"),
    output: z.record(z.unknown()),
    completion: z.object({
      confidence: z.enum(["low", "medium", "high"]),
      assumptions: z.array(z.string().max(500)).max(20),
      openQuestions: z.array(z.string().max(500)).max(20),
      whyComplete: z.string().max(1000),
    }).strict(),
  }).strict(),
]);
export type StepSkillProposal = z.infer<typeof StepSkillProposal>;
```

Extend `OperatorDescriptor` with optional provider/model:
```ts
providerId: ModelProviderId.optional(),
modelId: z.string().min(1).max(80).optional(),
```

Extend `SubmitWorkflowUserInputRequest` with:
```ts
questionDecisionId: Id.optional(),
```
(Optional at the contract layer for backward-compat with non-skill callers; the skill
submit route requires it — enforced in Task 8.)

Replace `WorkflowStepRun`: remove `satisfiedExitCriteria` and `outstandingExitCriteria`;
add:
```ts
selectedOperatorId: Id100.nullable().optional(),
selectedProviderId: ModelProviderId.nullable().optional(),
selectedModelId: z.string().min(1).max(80).nullable().optional(),
operatorSelectedAt: z.string().datetime().nullable().optional(),
```

Search the contracts file for `evaluate_exit_criteria` usages (e.g. in
`OrchestrationDecisionKind`) and remove. Leave `WorkflowDecisionType` as-is (it still has
`advance_step`, `mark_run_complete`, `request_user_input`, `select_operator`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test step-skill`
Expected: PASS.

- [ ] **Step 5: Build contracts + commit**

```bash
pnpm --filter @orca/contracts build
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/step-skill.test.ts
git commit -m "feat(contracts): StepSkillProposal, run_step_skill, operator provider/model, step-run selection fields"
```

---

## Task 4: DB migration for step-run selection columns

**Files:**
- Modify: `apps/daemon/src/migrations.ts`
- Modify: `apps/daemon/src/workflows/steps/projection.ts`
- Test: `apps/daemon/src/migrations.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

Add to `migrations.test.ts` (follow the existing harness that opens an in-memory DB and runs migrations):
```ts
it("workflow_step_runs has selection columns", () => {
  const db = openMigratedTestDb(); // use the existing helper in this file
  const cols = db.prepare("PRAGMA table_info(workflow_step_runs)").all() as { name: string }[];
  const names = cols.map((c) => c.name);
  expect(names).toContain("selected_operator_id");
  expect(names).toContain("selected_provider_id");
  expect(names).toContain("selected_model_id");
  expect(names).toContain("operator_selected_at");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test migrations`
Expected: FAIL — columns absent.

- [ ] **Step 3: Add the migration**

Append a new migration object to the migrations array in `migrations.ts` (match the
existing `{ id, up }` shape; bump to the next sequential id):
```ts
{
  id: <next-number>,
  name: "workflow_step_runs_operator_selection",
  up: (db) => {
    db.exec(`
      ALTER TABLE workflow_step_runs ADD COLUMN selected_operator_id TEXT;
      ALTER TABLE workflow_step_runs ADD COLUMN selected_provider_id TEXT;
      ALTER TABLE workflow_step_runs ADD COLUMN selected_model_id TEXT;
      ALTER TABLE workflow_step_runs ADD COLUMN operator_selected_at TEXT;
    `);
  },
},
```
(The exit-criteria columns `satisfied_exit_criteria_json` / `outstanding_exit_criteria_json`
remain in the table but are no longer read — SQLite ALTER cannot drop them cleanly and
leaving them is harmless.)

- [ ] **Step 4: Update the projection to read the new columns and stop reading exit criteria**

Rewrite `projection.ts` row mapping:
```ts
interface WorkflowStepRunRow {
  id: string; goal_id: string; workflow_run_id: string; step_template_id: string;
  ordinal: number; attempt: number; status: string;
  started_at: string | null; finished_at: string | null; blocked_reason: string | null;
  selected_operator_id: string | null; selected_provider_id: string | null;
  selected_model_id: string | null; operator_selected_at: string | null;
}
// SELECT updated to: id, goal_id, workflow_run_id, step_template_id, ordinal, attempt,
//   status, started_at, finished_at, blocked_reason, selected_operator_id,
//   selected_provider_id, selected_model_id, operator_selected_at
function rowToStepRun(row: WorkflowStepRunRow): WorkflowStepRunT {
  return WorkflowStepRun.parse({
    id: row.id, goalId: row.goal_id, workflowRunId: row.workflow_run_id,
    stepTemplateId: row.step_template_id, ordinal: row.ordinal, attempt: row.attempt,
    status: row.status, startedAt: row.started_at, finishedAt: row.finished_at,
    blockedReason: row.blocked_reason,
    selectedOperatorId: row.selected_operator_id,
    selectedProviderId: row.selected_provider_id as never,
    selectedModelId: row.selected_model_id,
    operatorSelectedAt: row.operator_selected_at,
  });
}
```
Add a writer helper used in Task 7:
```ts
export function recordOperatorSelection(
  db: Database.Database, id: string,
  sel: { operatorId: string; providerId: string; modelId: string; at: string }
): void {
  db.prepare(
    "UPDATE workflow_step_runs SET selected_operator_id=?, selected_provider_id=?, selected_model_id=?, operator_selected_at=? WHERE id=?"
  ).run(sel.operatorId, sel.providerId, sel.modelId, sel.at, id);
  resetWorkflowStepProjectionPreparedStatements();
}
```

- [ ] **Step 5: Run tests + commit**

Run: `pnpm --filter @orca/daemon test migrations`
Expected: PASS.
```bash
git add apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts apps/daemon/src/workflows/steps/projection.ts
git commit -m "feat(daemon): add operator-selection columns to workflow_step_runs"
```

---

## Task 5: Step execution input envelope builder (pure)

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/step-input.ts`
- Test: `apps/daemon/src/workflows/orchestrator/step-input.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildStepExecutionInput } from "./step-input.js";
import type { WorkflowArtifact, WorkflowStepTemplate } from "@orca/contracts";

const steps: WorkflowStepTemplate[] = [
  { id: "intake", ordinal: 0, name: "Intake", instructions: "i0", outputSchema: [{ key: "problem", type: "string", required: true }] },
  { id: "research", ordinal: 1, name: "Research", instructions: "i1", outputSchema: [{ key: "summary", type: "string", required: true }] },
];
const goal = { id: "g", description: "make it scroll" };

function out(stepRunId: string, ordinalStepId: string, body: object): WorkflowArtifact {
  return {
    id: `art-${ordinalStepId}`, goalId: "g", workflowRunId: "r", stepRunId,
    type: "step_output", title: ordinalStepId, body: JSON.stringify(body),
    source: "orchestrator", linkedSessionId: null, linkedTaskId: null,
    linkedContextPackageId: null, createdAt: "2026-05-27T00:00:00.000Z",
  } as WorkflowArtifact;
}

describe("buildStepExecutionInput", () => {
  it("ordinal 0 has null previousStepOutput and goal description", () => {
    const env = buildStepExecutionInput({ goal, steps, currentStep: steps[0], artifacts: [], transcript: [], stepRunByStepId: {} });
    expect(env.previousStepOutput).toBeNull();
    expect(env.priorStepOutputs).toEqual([]);
    expect(env.goal.description).toBe("make it scroll");
  });
  it("ordinal N exposes previous output + prior outputs", () => {
    const artifacts = [out("sr0", "intake", { problem: "p" })];
    const env = buildStepExecutionInput({
      goal, steps, currentStep: steps[1], artifacts, transcript: [],
      stepRunByStepId: { intake: "sr0" },
    });
    expect(env.previousStepOutput).toEqual({ problem: "p" });
    expect(env.priorStepOutputs).toEqual([{ stepId: "intake", stepName: "Intake", output: { problem: "p" } }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test step-input`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// step-input.ts
import type { InterviewTurn, WorkflowArtifact, WorkflowStepTemplate } from "@orca/contracts";

export interface StepExecutionInput {
  goal: { id: string; description: string };
  currentStep: Pick<WorkflowStepTemplate, "id" | "ordinal" | "name" | "instructions" | "outputSchema">;
  previousStepOutput: unknown | null;
  priorStepOutputs: Array<{ stepId: string; stepName: string; output: unknown }>;
  transcript: InterviewTurn[];
}

function parseOutput(body: string): unknown {
  try { return JSON.parse(body); } catch { return null; }
}

export function buildStepExecutionInput(args: {
  goal: { id: string; description: string };
  steps: WorkflowStepTemplate[];
  currentStep: WorkflowStepTemplate;
  artifacts: WorkflowArtifact[];
  transcript: InterviewTurn[];
  stepRunByStepId: Record<string, string>; // stepTemplateId -> stepRunId
}): StepExecutionInput {
  const { goal, steps, currentStep, artifacts, transcript, stepRunByStepId } = args;
  const outputByStepRunId = new Map<string, unknown>();
  for (const a of artifacts) {
    if (a.type === "step_output" && a.stepRunId) outputByStepRunId.set(a.stepRunId, parseOutput(a.body));
  }
  const priorStepOutputs: StepExecutionInput["priorStepOutputs"] = [];
  for (const s of steps) {
    if (s.ordinal >= currentStep.ordinal) continue;
    const sr = stepRunByStepId[s.id];
    if (sr && outputByStepRunId.has(sr)) {
      priorStepOutputs.push({ stepId: s.id, stepName: s.name, output: outputByStepRunId.get(sr) ?? null });
    }
  }
  const previousStepOutput =
    priorStepOutputs.length > 0 ? priorStepOutputs[priorStepOutputs.length - 1].output : null;
  return {
    goal,
    currentStep: { id: currentStep.id, ordinal: currentStep.ordinal, name: currentStep.name, instructions: currentStep.instructions, outputSchema: currentStep.outputSchema },
    previousStepOutput,
    priorStepOutputs,
    transcript,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test step-input`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/step-input.ts apps/daemon/src/workflows/orchestrator/step-input.test.ts
git commit -m "feat(daemon): step execution input envelope builder"
```

---

## Task 6: Transcript reconstruction + active-question helpers (pure)

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/interview.ts`
- Test: `apps/daemon/src/workflows/orchestrator/interview.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { reconstructTranscript, nextTurnIndex } from "./interview.js";
import type { WorkflowArtifact } from "@orca/contracts";

function turn(i: number, body: object): WorkflowArtifact {
  return {
    id: `t${i}`, goalId: "g", workflowRunId: "r", stepRunId: "sr",
    type: "interview_turn", title: `turn ${i}`, body: JSON.stringify(body),
    source: "user", linkedSessionId: null, linkedTaskId: null,
    linkedContextPackageId: null, createdAt: `2026-05-27T00:00:0${i}.000Z`,
  } as WorkflowArtifact;
}

describe("reconstructTranscript", () => {
  it("orders turns by turnIndex", () => {
    const arts = [
      turn(1, { turnIndex: 1, questionDecisionId: "d1", question: "q1", answer: "a1", answeredAt: "2026-05-27T00:00:01.000Z" }),
      turn(0, { turnIndex: 0, questionDecisionId: "d0", question: "q0", answer: "a0", answeredAt: "2026-05-27T00:00:00.000Z" }),
    ];
    const t = reconstructTranscript(arts);
    expect(t.map((x) => x.turnIndex)).toEqual([0, 1]);
    expect(nextTurnIndex(arts)).toBe(2);
  });
  it("nextTurnIndex is 0 with no turns", () => {
    expect(nextTurnIndex([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test interview`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// interview.ts
import { InterviewTurn, type WorkflowArtifact } from "@orca/contracts";

export function reconstructTranscript(artifacts: WorkflowArtifact[]): InterviewTurn[] {
  const turns: InterviewTurn[] = [];
  for (const a of artifacts) {
    if (a.type !== "interview_turn") continue;
    const parsed = InterviewTurn.safeParse(JSON.parse(a.body));
    if (parsed.success) turns.push(parsed.data);
  }
  return turns.sort((x, y) => x.turnIndex - y.turnIndex);
}

export function nextTurnIndex(artifacts: WorkflowArtifact[]): number {
  return reconstructTranscript(artifacts).reduce((max, t) => Math.max(max, t.turnIndex + 1), 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test interview`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/interview.ts apps/daemon/src/workflows/orchestrator/interview.test.ts
git commit -m "feat(daemon): interview transcript reconstruction helpers"
```

---

## Task 7: Skill-step branch in `requestNextDecision`

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Test: `apps/daemon/src/workflows/orchestrator/service.skill-step.test.ts` (create)

> Read `service.ts` fully first. Reuse: `recordDecisionInTx`, `decisionFingerprint`,
> `appendDecisionRequested`, `createRecommendationForWorkflowInTx`, `createArtifact`,
> `listArtifactsForRun`, the broker (`this.operatorSelector` / a broker handle), and the
> existing `commitUserInputDecision` (generalize it to take an explicit `question`).
> The service test files in the same directory show how to construct an in-memory DB,
> seed a run/step, and stub the broker/selector. Follow that harness exactly.

- [ ] **Step 1: Write the failing test (ask branch + complete branch + idempotency)**

```ts
// service.skill-step.test.ts  — shape; adapt setup helpers to the existing harness
import { describe, expect, it, vi } from "vitest";
import { setupSkillStepRun } from "./test-helpers.js"; // create alongside, mirroring existing service tests

describe("requestNextDecision (skill step)", () => {
  it("selects a model operator then asks the user", async () => {
    const t = setupSkillStepRun({
      proposeSelect: { operatorId: "orca/anthropic:claude-sonnet-4-6", providerId: "orca/anthropic", modelId: "claude-sonnet-4-6" },
      proposeSkill: { action: "ask", question: "What problem are we solving?" },
    });
    const r1 = await t.service.requestNextDecision(t.db, t.now, t.runId, t.opts); // selects
    const r2 = await t.service.requestNextDecision(t.db, t.now, t.runId, t.opts); // asks
    expect(r2.decision.decisionType).toBe("request_user_input");
    expect(r2.decision.reason).toBe("What problem are we solving?");
    expect(t.stepRun().selectedModelId).toBe("claude-sonnet-4-6");
  });

  it("does not re-ask while an unanswered question exists (idempotent)", async () => {
    const t = setupSkillStepRun({ /* already selected + one active question */ });
    const before = t.countDecisions("request_user_input");
    await t.service.requestNextDecision(t.db, t.now, t.runId, t.opts);
    expect(t.countDecisions("request_user_input")).toBe(before);
  });

  it("complete validates output, writes step_output, auto-advances intermediate", async () => {
    const t = setupSkillStepRun({
      twoSteps: true,
      proposeSkill: { action: "complete", output: { problem: "x" }, completion: { confidence: "high", assumptions: [], openQuestions: [], whyComplete: "ok" } },
      alreadySelected: true,
    });
    await t.service.requestNextDecision(t.db, t.now, t.runId, t.opts);
    expect(t.artifacts("step_output").length).toBe(1);
    expect(t.currentStepTemplateId()).toBe("research"); // advanced
  });

  it("complete on final step emits mark_run_complete recommendation (no auto-complete)", async () => {
    const t = setupSkillStepRun({ finalStep: true, alreadySelected: true,
      proposeSkill: { action: "complete", output: { summary: "x" }, completion: { confidence: "high", assumptions: [], openQuestions: [], whyComplete: "ok" } } });
    const r = await t.service.requestNextDecision(t.db, t.now, t.runId, t.opts);
    expect(r.recommendationIds.length).toBe(1);
    expect(t.recommendationType(r.recommendationIds[0])).toBe("complete_workflow_run");
    expect(t.run().status).toBe("active");
  });

  it("schema-invalid completion blocks the run after retry", async () => {
    const t = setupSkillStepRun({ alreadySelected: true,
      proposeSkill: { action: "complete", output: { wrong: 1 }, completion: { confidence: "low", assumptions: [], openQuestions: [], whyComplete: "?" } } });
    await t.service.requestNextDecision(t.db, t.now, t.runId, t.opts);
    expect(t.run().status).toBe("blocked");
    expect(t.run().blockedReason).toMatch(/schema/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test service.skill-step`
Expected: FAIL — branch not implemented.

- [ ] **Step 3: Implement the branch**

In `requestNextDecision`, immediately after loading `stepTpl` and `goal`, insert (before
the deterministic block, which you then delete in Task 9):
```ts
// All steps are instruction-driven in Phase 1.
return this.commitSkillStepDecision(db, now, { run, stepRun, stepTpl, template, goal }, options);
```

Add `commitSkillStepDecision` (new private method). Pseudocode → real code, reusing
existing helpers:
```ts
private async commitSkillStepDecision(db, now, ctx, options) {
  const artifacts = listArtifactsForRun(db, ctx.run.id);
  const stepArtifacts = artifacts.filter((a) => a.stepRunId === ctx.stepRun.id);

  // 1. idempotency: existing valid step_output -> advance/complete
  const existingOutput = stepArtifacts.find((a) => a.type === "step_output");
  if (existingOutput) return this.commitAdvanceOrComplete(db, now, ctx, options);

  // 2. idempotency: active unanswered question -> wait (no new decision)
  if (this.hasActiveUnansweredQuestion(db, ctx.stepRun.id)) {
    return this.commitNoop(db, now, ctx, options); // returns latest request_user_input decision, no new recommendation
  }

  // 3. select operator once
  if (!ctx.stepRun.selectedOperatorId) {
    return this.commitOperatorSelectionForSkill(db, now, ctx, options); // model operators only; persist via recordOperatorSelection
  }

  // 4. run the skill turn
  const transcript = reconstructTranscript(stepArtifacts);
  const stepRunByStepId = buildStepRunIndex(db, ctx.run.id); // stepTemplateId -> stepRunId
  const input = buildStepExecutionInput({
    goal: { id: ctx.goal.id, description: ctx.goal.description },
    steps: ctx.template.steps, currentStep: ctx.stepTpl, artifacts, transcript, stepRunByStepId,
  });
  const result = await this.broker.propose(
    { kind: "run_step_skill", goalId: ctx.goal.id, workflowRunId: ctx.run.id, stepRunId: ctx.stepRun.id,
      providerId: ctx.stepRun.selectedProviderId!, modelId: ctx.stepRun.selectedModelId!, payload: input },
    { validateProposal: (raw) => {
        const parsed = StepSkillProposal.safeParse(raw);
        if (!parsed.success) return { accepted: false, failureMessage: "invalid step skill proposal" };
        if (parsed.data.action === "complete") {
          const v = validateStepOutput(ctx.stepTpl.outputSchema, parsed.data.output);
          if (!v.ok) return { accepted: false, failureMessage: `schema: ${v.errors.join("; ")}` };
        }
        return { accepted: true, parsed: parsed.data };
      } }
  );

  if (result.status !== "proposed") {
    return this.blockRun(db, now, ctx, options, "step output did not match schema or transport failed");
  }
  const proposal = result.parsed as StepSkillProposal;
  if (proposal.action === "ask") {
    return this.commitUserInputDecision(db, now, ctx.goal.id, ctx.run.id, ctx.stepRun, ctx.stepTpl, proposal.question, options);
  }
  // complete
  const body = JSON.stringify({ ...proposal.output, _completion: proposal.completion });
  this.createStepOutputArtifact(db, now, ctx, body, options); // type: "step_output", source: "orchestrator"
  return this.commitAdvanceOrComplete(db, now, ctx, options);
}
```

Key sub-helpers to add (all in `service.ts`):
- `hasActiveUnansweredQuestion(db, stepRunId)`: there is a `request_user_input` decision for
  the step run with no `interview_turn` artifact whose `questionDecisionId` equals that
  decision id. (Query decisions for the step run; query interview_turn artifacts; compare.)
- `commitOperatorSelectionForSkill`: call `this.operatorSelector.select(...)` with the model
  operators filtered (`OperatorDescriptor.kind === "model"`), then `recordOperatorSelection`
  with provider/model taken from the chosen descriptor (NOT parsed from the id). Records the
  existing `select_operator` decision + `workflow.operator.selected` event (reuse
  `commitOperatorDecision` machinery; this is the existing path — keep its selection record,
  drop its guardrail/launch parts for model operators).
- `commitAdvanceOrComplete`: if a next step exists → create the next step run (reuse the
  advance path in `reconcile.ts` / the existing `advance_workflow_step` handling, but execute
  it directly instead of as a user-accepted recommendation) and request its decision; else →
  emit a `complete_workflow_run` recommendation (reuse `createRecommendationForWorkflowInTx`
  with `type: "complete_workflow_run"`), do NOT change run status.
- `blockRun`: set run status `blocked` with reason (reuse `markWorkflowRunBlocked` from
  `runs/usecases.ts`) after one retry of the propose call.
- Generalize `commitUserInputDecision` to take a `question: string` argument and use it
  directly (it currently derives the question from `rule.nextQuestion`).

Constructor: ensure the service has a broker handle (`this.broker`). If it currently only
holds `operatorSelector`, add the broker via the same DI used in `server.ts` where the
service is constructed; follow how `operatorSelector` is injected.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test service.skill-step`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.skill-step.test.ts apps/daemon/src/workflows/orchestrator/test-helpers.ts
git commit -m "feat(daemon): instruction-driven skill-step decision loop"
```

---

## Task 8: Submit route writes interview_turn with questionDecisionId

**Files:**
- Modify: `apps/daemon/src/workflows/steps/routes.ts`
- Test: `apps/daemon/src/workflows/steps/routes.skill-input.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// shape; adapt to the existing routes test harness in this directory
import { describe, expect, it } from "vitest";
import { setupSkillSubmit } from "./routes-test-helpers.js";

describe("submit workflow input (skill step)", () => {
  it("creates an interview_turn paired to the question decision", async () => {
    const t = setupSkillSubmit({ activeQuestionDecisionId: "dec-1", question: "What problem?" });
    await t.submit({ stepRunId: t.stepRunId, questionDecisionId: "dec-1", answerText: "scrolling" });
    const turns = t.artifacts("interview_turn");
    expect(turns.length).toBe(1);
    const body = JSON.parse(turns[0].body);
    expect(body).toMatchObject({ turnIndex: 0, questionDecisionId: "dec-1", question: "What problem?", answer: "scrolling" });
  });
  it("rejects a mismatched questionDecisionId", async () => {
    const t = setupSkillSubmit({ activeQuestionDecisionId: "dec-1", question: "q" });
    await expect(t.submit({ stepRunId: t.stepRunId, questionDecisionId: "dec-XXX", answerText: "x" }))
      .rejects.toThrow(/question/i);
  });
  it("does not create a duplicate turn for an already-answered question", async () => {
    const t = setupSkillSubmit({ activeQuestionDecisionId: "dec-1", question: "q", alreadyAnswered: true });
    await expect(t.submit({ stepRunId: t.stepRunId, questionDecisionId: "dec-1", answerText: "x" }))
      .rejects.toThrow(/already/i);
    expect(t.artifacts("interview_turn").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test routes.skill-input`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `routes.ts` submit handler, replace the `evaluateUserInputAsArtifact` block (lines
~90-134) with skill-step handling:
```ts
const answerText = parsed.data.answerText;
const questionDecisionId = parsed.data.questionDecisionId;
if (answerText !== undefined) {
  if (!questionDecisionId) throw new HttpError(400, "questionDecisionId is required");
  const decision = getDecisionById(deps.db, questionDecisionId); // add if missing; query workflow_decisions
  if (!decision || decision.stepRunId !== updatedStep.id || decision.decisionType !== "request_user_input") {
    throw new HttpError(400, "questionDecisionId does not match an active question for this step");
  }
  const existingTurns = listArtifactsForRun(deps.db, updatedStep.workflowRunId)
    .filter((a) => a.type === "interview_turn" && a.stepRunId === updatedStep.id);
  if (existingTurns.some((a) => JSON.parse(a.body).questionDecisionId === questionDecisionId)) {
    throw new HttpError(409, "question already answered");
  }
  const turn = {
    turnIndex: existingTurns.length,
    questionDecisionId,
    question: decision.reason,
    answer: redactSecrets(answerText),
    answeredAt: now(),
  };
  const created = createArtifact(deps.db, now, {
    goalId, workflowRunId: updatedStep.workflowRunId, stepRunId: updatedStep.id,
    type: "interview_turn", title: `Turn ${turn.turnIndex}`.slice(0, 256),
    body: JSON.stringify(turn), source: "user",
    linkedSessionId: null, linkedTaskId: null, linkedContextPackageId: null,
  }, deps.idFactory, stagedEvents);
  artifactIds.push(created.id);
}
```
Keep the existing `workflow.user.input.submitted` event append and the post-submit
`requestNextDecision` call (auto-advance). Remove the now-unused `stepRules` / `ctx` /
`evaluateUserInputAsArtifact` references in this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test routes.skill-input`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/steps/routes.ts apps/daemon/src/workflows/steps/routes.skill-input.test.ts
git commit -m "feat(daemon): persist interview_turn on skill-step input submit"
```

---

## Task 9: Remove the StepRule layer + deterministic engine paths

**Files:**
- Delete: `apps/daemon/src/workflows/steps/rules/` (entire directory)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (remove deterministic block)
- Modify: any importer of `stepRules` (grep first)

- [ ] **Step 1: Find all importers**

Run: `grep -rln "steps/rules\|stepRules\|nextQuestion\|evaluateUserInputAsArtifact\|evaluateGoalContextSatisfies\|applyGoalContextSatisfaction\|applyDeterministicRuleSatisfaction" apps/daemon/src --include=*.ts | grep -v test`
Expected: `service.ts`, `steps/routes.ts` (already cleaned in Task 8), possibly
`bootstrap-route.ts`, `server.ts`.

- [ ] **Step 2: Remove the deterministic block from `requestNextDecision`**

Delete: `applyDeterministicRuleSatisfaction`, `applyGoalContextSatisfaction`,
`missingInputs`, the `outstanding`/exit-criteria computation, the `gateType === "human-input"`
branch, the `commitMissingInputDecision` and `commitSatisfiedExitDecision` paths that are no
longer reachable, and the `operatorSelector.select` fallback block at the bottom (its useful
parts moved into `commitOperatorSelectionForSkill` in Task 7). The method body should reduce
to: load run/template/step/goal → `return this.commitSkillStepDecision(...)`.

- [ ] **Step 3: Delete the rules directory and fix imports**

```bash
git rm -r apps/daemon/src/workflows/steps/rules
```
Remove any `import ... from ".../steps/rules/..."` lines flagged in Step 1. If
`bootstrap-route.ts` referenced `evaluateGoalContextSatisfies` for goal seeding, delete that
seeding call (intake now seeds itself from `goal.description` via the envelope at ordinal 0).

- [ ] **Step 4: Build + run the daemon suite**

Run: `pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/daemon test`
Expected: PASS. Fix any test files that asserted on removed rule behavior by deleting/porting
them (e.g. old `intake.test.ts`, `service` exit-criteria tests). List deletions explicitly in
the commit.

- [ ] **Step 5: Commit**

```bash
git add -A apps/daemon/src/workflows
git commit -m "refactor(daemon): remove StepRule layer and deterministic step engine"
```

---

## Task 10: Reseed the Engineering template (instruction-driven)

**Files:**
- Modify: `apps/daemon/src/workflows/templates/seed-engineering.ts`
- Test: `apps/daemon/src/workflows/templates/seed-engineering.test.ts` (update/create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { WorkflowStepTemplate } from "@orca/contracts";
import { seedEngineeringTemplate, ENGINEERING_ID } from "./seed-engineering.js";
import { runMigrations } from "../../../migrations.js";

describe("engineering seed (instruction-driven)", () => {
  it("seeds steps with only instructions + outputSchema", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    seedEngineeringTemplate(db, () => "2026-05-27T00:00:00.000Z");
    const row = db.prepare("SELECT steps_json FROM workflow_templates WHERE id=?").get(ENGINEERING_ID) as { steps_json: string };
    const steps = JSON.parse(row.steps_json);
    for (const s of steps) expect(() => WorkflowStepTemplate.parse(s)).not.toThrow();
    const intake = steps.find((s: { id: string }) => s.id === "intake");
    expect(intake.instructions).toMatch(/interview/i);
    expect(intake.outputSchema.some((f: { key: string }) => f.key === "problem")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test seed-engineering`
Expected: FAIL — steps still have old fields.

- [ ] **Step 3: Rewrite the steps array + bump version**

Set `ENGINEERING_VERSION = 2`. Replace `ENGINEERING_STEPS` with entries shaped
`{ id, ordinal, name, instructions, outputSchema }`. Intake uses the grill-me text from the
spec (Engineering template reseed section). Example intake entry:
```ts
{
  id: "intake", ordinal: 0, name: "Intake",
  instructions:
    "Interview the user relentlessly about this goal until you reach shared understanding, " +
    "walking each branch of the decision tree and resolving dependencies one at a time. " +
    "Ask one question at a time. For each question, provide your recommended answer. " +
    "When a question may be answerable from attached workspace context, first use the " +
    "available workspace summaries or snippets; if no trustworthy workspace context is " +
    "available, ask the user directly instead of pretending to know. Complete only when the " +
    "brief is unambiguous; report remaining assumptions and open questions in the completion " +
    "self-check.",
  outputSchema: [
    { key: "problem", type: "string", required: true },
    { key: "success_outcome", type: "string", required: true },
    { key: "constraints", type: "array", itemType: "string", required: true },
    { key: "relevant_workspaces", type: "array", itemType: "string", required: false },
    { key: "open_questions", type: "array", itemType: "string", required: false },
  ],
},
```
Give `research`, `prd`, `issue_breakdown`, `execution`, `qa`, `review`, `done` placeholder
instructions (one sentence each describing the step's job) and a minimal `outputSchema`
(e.g. a single required `summary: string`), so the template validates. Keep the existing
`ENGINEERING_GUARDRAILS` array unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test seed-engineering`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/templates/seed-engineering.ts apps/daemon/src/workflows/templates/seed-engineering.test.ts
git commit -m "feat(daemon): reseed Engineering template as instruction-driven (intake = grill-me)"
```

---

## Task 11: Desktop StepEditor — two-field authoring + output-schema editor

**Files:**
- Modify: `apps/desktop/src/workflows/StepEditor.tsx`
- Modify: `apps/desktop/src/workflows/TemplateDetail.tsx` (drop removed-field display/inputs)
- Modify: `apps/desktop/src/workflows/WorkflowsPage.tsx` (default new-step payload)

- [ ] **Step 1: Update the create-template default payload**

In `WorkflowsPage.tsx` `handleCreateTemplate`, change the default step to:
```ts
steps: [
  { id: "step-1", name: "Step 1", instructions: "Describe what this step does.",
    outputSchema: [{ key: "result", type: "string", required: true }] },
],
```
Remove `purpose`, `requiredInputs`, `requiredOutputs`, `gateType`,
`recommendedCapabilities`, `validationExpectations`, `exitCriteria`,
`recommendedOperatorIds` from that object.

- [ ] **Step 2: Rewrite `StepEditor.tsx`**

Render exactly: a `name` input, an `instructions` `<textarea>`, and an **Output schema**
editor — a list of rows, each with: `key` text input, `type` `<select>`
(string/number/boolean/array/object), `required` checkbox, optional `description` input, an
`itemType` `<select>` shown only when `type === "array"`, and an "Add field" / "Remove"
control. Emit the updated step via the existing `onChange`/save prop. Delete all inputs for
removed fields. Match existing class names (`workflow-field`, `workflow-array-field`, …).

- [ ] **Step 3: Update `TemplateDetail.tsx`**

Remove rendering of removed fields. Ensure it passes `instructions` + `outputSchema` through
the save path (`updateTemplate`). No exit-criteria UI.

- [ ] **Step 4: Typecheck + run desktop tests**

Run: `pnpm --filter @orca/desktop typecheck && pnpm --filter @orca/desktop test`
Expected: PASS. Update/remove any StepEditor/TemplateDetail tests that referenced removed
fields.

- [ ] **Step 5: Manually verify in the browser**

Run the app (`pnpm --filter @orca/desktop dev` plus the daemon), open the Workflows tab,
create a template, confirm only Name / Instructions / Output schema are editable, and the
step list scrolls (Task 0 fix). If you cannot run the full stack, state so explicitly in the
PR rather than claiming verification.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/workflows/StepEditor.tsx apps/desktop/src/workflows/TemplateDetail.tsx apps/desktop/src/workflows/WorkflowsPage.tsx
git commit -m "feat(desktop): instruction + output-schema step editor"
```

---

## Task 12: OrcaChat — pass questionDecisionId, show completion self-check

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`
- Modify: `apps/desktop/src/orchestrator/components/WorkflowBanner.tsx`

- [ ] **Step 1: Thread `questionDecisionId` through submit**

`PendingInputPrompt` already carries `recommendationId`; add the originating
`questionDecisionId` (the `request_user_input` decision id — available on the recommendation
via its `decisionId`, or the latest `request_user_input` decision for the step). In
`handleSubmitInput`, pass `questionDecisionId` to `submitWorkflowUserInput`:
```ts
await submitWorkflowUserInput(selectedGoalId, restoredPendingInput.stepRunId, {
  stepRunId: restoredPendingInput.stepRunId,
  questionDecisionId: restoredPendingInput.questionDecisionId,
  answerText,
});
```
Update the `api.ts` `submitWorkflowUserInput` request type to include `questionDecisionId`.

- [ ] **Step 2: Render the completion self-check**

When the latest `step_output` artifact for the current step run has a `_completion` block,
render a small panel under the workflow banner: confidence badge + remaining assumptions /
open questions list. Parse from `artifact.body`.

- [ ] **Step 3: Remove exit-criteria display from `WorkflowBanner.tsx`**

Delete the SATISFIED / OUTSTANDING criteria rendering (the step run no longer carries
criteria). Keep the run/step name + next-action display.

- [ ] **Step 4: Typecheck + tests**

Run: `pnpm --filter @orca/desktop typecheck && pnpm --filter @orca/desktop test`
Expected: PASS. Update `OrcaChat.test.tsx` / `WorkflowBanner.test.tsx` for the changes.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/components/WorkflowBanner.tsx apps/desktop/src/api.ts
git commit -m "feat(desktop): send questionDecisionId; show step completion self-check"
```

---

## Task 13: Full-suite green + final integration pass

**Files:** repo-wide

- [ ] **Step 1: Typecheck everything**

Run: `pnpm typecheck`
Expected: PASS. Fix any residual references to removed contract fields.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: PASS. Investigate every failure as a real regression (no skips). Common breakage:
tests asserting on `exitCriteria`, `gateType`, `requiredInputs`, or the old intake question
sequence — port or delete with intent.

- [ ] **Step 3: Grep for orphaned references**

Run: `grep -rln "exitCriteria\|gateType\|requiredInputs\|requiredOutputs\|recommendedCapabilities\|recommendedOperatorIds\|validationExpectations\|evaluate_exit_criteria" apps packages --include=*.ts | grep -v test | grep -v dist`
Expected: no application-code hits (docs/specs may still reference history — that's fine).

- [ ] **Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore: remove orphaned references to deleted step fields"
```

---

## Self-review (completed during authoring)

- **Spec coverage:** authoring fields (T2), output schema + validation (T1), artifact types
  + interview turn (T2), proposal/decision-kind/operator/submit/step-run contracts (T3),
  DB + projection (T4), input envelope (T5), transcript (T6), select→ask→complete loop +
  idempotency + auto-advance + block-on-schema-fail (T7), interview_turn persistence +
  questionDecisionId (T8), removal of StepRule layer (T9), Engineering reseed/grill-me (T10),
  UI authoring (T11), UI question-id + completion self-check + banner cleanup (T12),
  green suite (T13). All spec sections map to a task.
- **Type consistency:** `validateStepOutput`, `WorkflowStepOutputSchema`, `StepSkillProposal`,
  `InterviewTurn`, `buildStepExecutionInput`, `reconstructTranscript`/`nextTurnIndex`,
  `recordOperatorSelection`, `commitSkillStepDecision` names are used consistently across
  tasks.
- **Open assumption to verify during T7:** exact broker/selector DI in `server.ts` and the
  `reconcile.ts` next-step-run creation helper — read before wiring, follow the existing
  pattern.

## Note: Task 0 (scroll bug) is already done

The Workflows-tab scroll fix lives in `apps/desktop/src/workflows/workflows.css`
(grid-template-rows + `.workflows-page__detail` flex/min-height + `.workflow-detail-panel`
`flex:1`) and is currently uncommitted. Commit it separately:
```bash
git add apps/desktop/src/workflows/workflows.css
git commit -m "fix(desktop): restore scroll in Workflows template detail"
```
