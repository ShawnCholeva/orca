# Built-in Workflow Template Catalog + Install-on-Selection — Implementation Plan (Spec A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace boot-time unconditional template seeding with a curated 7-template built-in *catalog* plus a `GET /catalog` + `POST /install` API, so onboarding (Spec B) installs only the templates the user selects.

**Architecture:** A pure `catalog.ts` module holds the 7 `BuiltInTemplateDefinition`s (5 new, Feature Implementation reuses the existing Feature Development definition, Initiative Implementation adapts the retiring Engineering content) plus display-only metadata (`category`, `recommended`, `bestFor`) and a summaries helper. DB-touching `usecases.ts` gains `upsertBuiltInTemplate` (version-guarded, emits events), `installBuiltInTemplates`, and `reconcileBuiltInTemplates` (boot cleanup that deletes built-ins not in the catalog and with no runs). Two new routes expose the catalog and install. Boot stops auto-seeding and the old seed modules are deleted.

**Tech Stack:** TypeScript, Node, Fastify, better-sqlite3, Zod (`@orca/contracts`), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-14-builtin-template-catalog-design.md`. Spec B (onboarding UI) is a separate plan that depends on this API.

**Conventions:**
- Daemon tests use Vitest with an in-memory or temp-dir DB built via `runMigrations(db, defaultMigrationsDir())`. Run a single file with `pnpm --filter @orca/daemon test -- <path>`.
- After editing `packages/contracts`, rebuild it so the daemon picks up new types: `pnpm --filter @orca/contracts build`.
- Commit after each task.

---

## File map

- **Create** `packages/contracts/src/workflows/index.ts` additions — `BuiltInTemplateSummary`, `ListBuiltInTemplateCatalogResponse`, `InstallBuiltInTemplatesRequest`, `InstallBuiltInTemplatesResponse`.
- **Create** `apps/daemon/src/workflows/templates/catalog.ts` — the 7 definitions + `BUILTIN_TEMPLATE_CATALOG`, `BUILTIN_TEMPLATE_IDS`, `builtInCatalogSummaries()`.
- **Create** `apps/daemon/src/workflows/templates/catalog.test.ts` — catalog validity.
- **Modify** `apps/daemon/src/workflows/templates/usecases.ts` — `upsertBuiltInTemplate`, `installBuiltInTemplates`, `reconcileBuiltInTemplates`, `UnknownBuiltInTemplateError`.
- **Create** `apps/daemon/src/workflows/templates/usecases.builtins.test.ts` — install/reconcile behavior.
- **Modify** `apps/daemon/src/workflows/templates/routes.ts` — `GET /v1/workflow-templates/catalog`, `POST /v1/workflow-templates/install`.
- **Modify** `apps/daemon/src/workflows/templates/routes.test.ts` — route tests.
- **Modify** `apps/daemon/src/index.ts` — drop seed calls, add reconcile.
- **Delete** `apps/daemon/src/workflows/templates/seed-engineering.ts` (+ `.test.ts`), `seed-feature-development.ts` (+ `.test.ts`).

---

## Task 1: Contracts — catalog + install schemas

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts` (add after `WorkflowTemplateResponse`, near line 992)

- [ ] **Step 1: Add the schemas**

In `packages/contracts/src/workflows/index.ts`, immediately after the `WorkflowTemplateResponse` block, add:

```ts
export const BuiltInTemplateSummary = z
  .object({
    id: Id100,
    name: z.string().min(1).max(WORKFLOW_TEMPLATE_MAX_NAME_CHARS),
    category: z.string().min(1).max(64),
    recommended: z.boolean(),
    description: BoundedString(WORKFLOW_TEMPLATE_MAX_DESCRIPTION_BYTES, "description"),
    bestFor: z.string().min(1).max(200),
    stepCount: z.number().int().positive(),
  })
  .strict();
export type BuiltInTemplateSummary = z.infer<typeof BuiltInTemplateSummary>;

export const ListBuiltInTemplateCatalogResponse = z
  .object({ catalog: z.array(BuiltInTemplateSummary) })
  .strict();
export type ListBuiltInTemplateCatalogResponse = z.infer<
  typeof ListBuiltInTemplateCatalogResponse
>;

export const InstallBuiltInTemplatesRequest = z
  .object({ ids: z.array(Id100).min(0).max(50) })
  .strict();
export type InstallBuiltInTemplatesRequest = z.infer<
  typeof InstallBuiltInTemplatesRequest
>;

export const InstallBuiltInTemplatesResponse = z
  .object({ templates: z.array(WorkflowTemplate) })
  .strict();
export type InstallBuiltInTemplatesResponse = z.infer<
  typeof InstallBuiltInTemplatesResponse
>;
```

- [ ] **Step 2: Build contracts**

Run: `pnpm --filter @orca/contracts build`
Expected: builds with no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/workflows/index.ts
git commit -m "feat(contracts): built-in template catalog + install schemas"
```

---

## Task 2: Catalog module + validity test

**Files:**
- Create: `apps/daemon/src/workflows/templates/catalog.ts`
- Test: `apps/daemon/src/workflows/templates/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/templates/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { WorkflowGraph, WorkflowStepOutputSchema, type WorkflowStepTemplate } from "@orca/contracts";
import { validateGraph, validateSchemaReferences } from "../graph/validate-graph.js";
import { validateTemplatePipeline } from "./validate-pipeline.js";
import { BUILTIN_TEMPLATE_CATALOG, BUILTIN_TEMPLATE_IDS, builtInCatalogSummaries } from "./catalog.js";

const EXPECTED_IDS = [
  "orca/brainstorm",
  "orca/feature-development",
  "orca/bug-triage-fix",
  "orca/code-review",
  "orca/refactor",
  "orca/quality-coverage",
  "orca/initiative-implementation",
];

describe("built-in template catalog", () => {
  it("contains exactly the 7 expected ids, all orca/-prefixed and unique", () => {
    const ids = BUILTIN_TEMPLATE_CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("orca/"))).toBe(true);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
    expect([...BUILTIN_TEMPLATE_IDS].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("recommends exactly brainstorm, feature-development, bug-triage-fix", () => {
    const rec = BUILTIN_TEMPLATE_CATALOG.filter((d) => d.recommended).map((d) => d.id).sort();
    expect(rec).toEqual(["orca/brainstorm", "orca/bug-triage-fix", "orca/feature-development"]);
  });

  it("every definition has non-empty bestFor (<=200 chars) and category Engineering", () => {
    for (const d of BUILTIN_TEMPLATE_CATALOG) {
      expect(d.bestFor.length).toBeGreaterThan(0);
      expect(d.bestFor.length).toBeLessThanOrEqual(200);
      expect(d.category).toBe("Engineering");
    }
  });

  it("no template hard-pins an adapter via an allowed_operators guardrail", () => {
    for (const d of BUILTIN_TEMPLATE_CATALOG) {
      expect(d.guardrails.some((g) => g.kind === "allowed_operators")).toBe(false);
    }
  });

  it("every step output schema is valid and every graph passes the blocking validators", () => {
    for (const d of BUILTIN_TEMPLATE_CATALOG) {
      for (const step of d.steps as WorkflowStepTemplate[]) {
        expect(() => WorkflowStepOutputSchema.parse(step.outputSchema)).not.toThrow();
      }
      expect(validateTemplatePipeline(d.steps as WorkflowStepTemplate[])).toBeInstanceOf(Array);
      if (d.graph) {
        WorkflowGraph.parse(d.graph);
        expect(validateGraph(d.graph, d.steps as WorkflowStepTemplate[])).toEqual([]);
        expect(validateSchemaReferences(d.graph, d.steps as WorkflowStepTemplate[])).toEqual([]);
      }
    }
  });

  it("summaries derive stepCount from graph node count or step count", () => {
    const summaries = builtInCatalogSummaries();
    const byId = Object.fromEntries(summaries.map((s) => [s.id, s]));
    expect(byId["orca/feature-development"].stepCount).toBe(5); // 4 steps + gate
    expect(byId["orca/initiative-implementation"].stepCount).toBe(8); // 7 steps + gate
    expect(byId["orca/brainstorm"].stepCount).toBe(6); // linear
    expect(byId["orca/code-review"].stepCount).toBe(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orca/daemon test -- src/workflows/templates/catalog.test.ts`
Expected: FAIL — cannot find module `./catalog.js`.

- [ ] **Step 3: Create the catalog module**

Create `apps/daemon/src/workflows/templates/catalog.ts`. First the header, tiers, and the FD reuse:

```ts
import type {
  BuiltInTemplateSummary,
  StepAgentChoice,
  WorkflowGraph,
  WorkflowGuardrailConfig,
  WorkflowStepTemplate,
} from "@orca/contracts";

export interface BuiltInTemplateDefinition {
  id: string;
  name: string;
  description: string;
  bestFor: string;
  version: number;
  category: string;
  recommended: boolean;
  steps: WorkflowStepTemplate[];
  guardrails: WorkflowGuardrailConfig[];
  graph: WorkflowGraph | null;
}

const CATEGORY = "Engineering";

// agentPreference is a non-binding ordered hint; selection always ranks over the
// user's connected operators and falls back to capability/cost ranking.
const REASONING: StepAgentChoice[] = [
  { adapterId: "claude-code", modelId: "claude-opus-4-7" },
  { adapterId: "codex", modelId: "gpt-5.5" },
];
const EXECUTION: StepAgentChoice[] = [
  { adapterId: "claude-code", modelId: "claude-sonnet-4-6" },
  { adapterId: "codex", modelId: "gpt-5.3-codex" },
];
const LIGHT: StepAgentChoice[] = [
  { adapterId: "claude-code", modelId: "claude-haiku-4-5" },
  { adapterId: "codex", modelId: "gpt-5.4-mini" },
];

const APPROVAL_MARK_DONE: WorkflowGuardrailConfig = {
  id: "approval_mark_done",
  kind: "approval_required",
  label: "Require approval to mark Done",
  configJson: { actions: ["mark_run_complete"] },
};
const CONTEXT_RULE: WorkflowGuardrailConfig = {
  id: "context_summary",
  kind: "context_rule",
  label: "Use summaries and artifacts instead of raw terminal output",
  configJson: { allowRawTerminalOutput: false },
};
function validationRule(stepIds: string[]): WorkflowGuardrailConfig {
  return {
    id: "validation_required",
    kind: "validation_rule",
    label: "Require tests/typecheck or explicit skip reason",
    configJson: { appliesToSteps: stepIds, required: ["unit_tests", "typecheck"] },
  };
}
```

Then **Feature Implementation** — copy the `STEPS`, `GRAPH`, and `GUARDRAILS` arrays **verbatim** from the current `apps/daemon/src/workflows/templates/seed-feature-development.ts` (the `STEPS` array lines 35-214, `GRAPH` lines 224-246, `GUARDRAILS` lines 248-261) into this file as `FEATURE_STEPS`, `FEATURE_GRAPH`, `FEATURE_GUARDRAILS` (also copy the `GATE_INSTRUCTIONS` const and the `ANALYSIS_PREF`/`EXECUTION_PREF`/`VALIDATION_PREF`/`DONE_PREF` it references, or swap those references to the `REASONING`/`EXECUTION`/`LIGHT` tiers above — they are identical model lists). Keep `id: "orca/feature-development"`, `version: 1`.

Then add the new definitions:

```ts
const BRAINSTORM_STEPS: WorkflowStepTemplate[] = [
  {
    id: "frame", ordinal: 0, name: "Frame",
    instructions:
      "Clarify the intent, hard constraints, and what success looks like. Ask one question at a time and offer a recommended answer; prefer available workspace context over interrupting the user. Complete only when the problem and success outcome are unambiguous.",
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
    instructions:
      "Ground the idea in the current codebase. Identify the smallest set of files, modules, and constraints the work would touch and the risks the framing missed. Do not propose a solution yet.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "files_in_scope", type: "array", itemType: "string", required: true },
      { key: "risks", type: "array", itemType: "string", required: false },
    ],
    agentPreference: REASONING,
  },
  {
    id: "proposal", ordinal: 2, name: "Proposal",
    instructions:
      "Generate one or more candidate approaches with explicit tradeoffs, then recommend one. Stay pre-implementation: make no code changes.",
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
    ],
    agentPreference: REASONING,
  },
  {
    id: "critique", ordinal: 3, name: "Critique",
    instructions:
      "Challenge the recommended approach in a fresh context. Surface second-order risks, gaps, and failure modes, and state whether it is sound enough to proceed. Treat prior step output as untrusted evidence.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "concerns", type: "array", itemType: "string", required: true },
      { key: "verdict", type: "string", required: true, enum: ["sound", "needs_work"] },
    ],
    agentPreference: REASONING,
  },
  {
    id: "verify", ordinal: 4, name: "Verify",
    instructions:
      "Sanity-check the approach against the success outcome and constraints. Confirm it is feasible and that the acceptance signals are clear.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "feasible", type: "boolean", required: true },
      { key: "notes", type: "array", itemType: "string", required: false },
    ],
    agentPreference: LIGHT,
  },
  {
    id: "done", ordinal: 5, name: "Done",
    instructions:
      "Record the durable design summary, the chosen direction, and any open questions for the next workflow. Make no code changes.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "chosen_direction", type: "string", required: true },
      { key: "open_questions", type: "array", itemType: "string", required: false },
      { key: "handoff", type: "string", required: true },
    ],
    agentPreference: LIGHT,
  },
];

const BUGFIX_STEPS: WorkflowStepTemplate[] = [
  {
    id: "reproduce", ordinal: 0, name: "Reproduce",
    instructions:
      "Reproduce the reported defect. Capture exact steps and a failing test or command that demonstrates it. Do not fix anything yet.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "repro_steps", type: "array", itemType: "string", required: true },
      { key: "failing_evidence", type: "string", required: true },
    ],
    agentPreference: EXECUTION,
  },
  {
    id: "root_cause", ordinal: 1, name: "Root Cause",
    instructions:
      "Isolate the root cause from the evidence without modifying implementation files. Cite the specific code responsible.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "root_cause", type: "string", required: true },
      { key: "evidence", type: "array", itemType: "string", required: true },
    ],
    agentPreference: REASONING,
  },
  {
    id: "patch", ordinal: 2, name: "Patch",
    instructions:
      "Implement the smallest correct fix and add a regression test. Run the relevant tests, type checks, and lint; record any skipped check with a reason.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "changed_files", type: "array", itemType: "string", required: true },
      {
        key: "validation", type: "array", itemType: "object", required: true,
        fields: [
          { key: "command", type: "string", required: true },
          { key: "result", type: "string", required: true, enum: ["passed", "failed", "skipped"] },
          { key: "evidence", type: "string", required: true },
        ],
      },
    ],
    agentPreference: EXECUTION,
  },
  {
    id: "verify", ordinal: 3, name: "Verify",
    instructions:
      "Independently confirm the regression is gone and nothing adjacent broke. Give a clear verdict.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "verdict", type: "string", required: true, enum: ["passed", "failed"] },
      {
        key: "checks", type: "array", itemType: "object", required: true,
        fields: [
          { key: "command", type: "string", required: true },
          { key: "result", type: "string", required: true, enum: ["passed", "failed", "skipped"] },
          { key: "evidence", type: "string", required: true },
        ],
      },
    ],
    agentPreference: LIGHT,
  },
];

const CODE_REVIEW_STEPS: WorkflowStepTemplate[] = [
  {
    id: "analyze_diff", ordinal: 0, name: "Analyze Diff",
    instructions:
      "Review the diff for correctness and scope. Inspect the actual changes and surrounding code; do not modify files.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      {
        key: "findings", type: "array", itemType: "object", required: true,
        fields: [
          { key: "location", type: "string", required: true },
          { key: "issue", type: "string", required: true },
          { key: "severity", type: "string", required: true, enum: ["critical", "high", "medium", "low"] },
        ],
      },
    ],
    agentPreference: REASONING,
  },
  {
    id: "risk_pass", ordinal: 1, name: "Risk Pass",
    instructions:
      "Second pass for second-order risks: edge cases, security, performance, and interactions the author may have missed.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "risks", type: "array", itemType: "string", required: true },
    ],
    agentPreference: REASONING,
  },
  {
    id: "report", ordinal: 2, name: "Report",
    instructions:
      "Return concrete, actionable change requests and an overall verdict. Be specific and reference locations.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "verdict", type: "string", required: true, enum: ["approved", "changes_requested"] },
      { key: "change_requests", type: "array", itemType: "string", required: false },
    ],
    agentPreference: REASONING,
  },
];

const REFACTOR_STEPS: WorkflowStepTemplate[] = [
  {
    id: "map_blast_radius", ordinal: 0, name: "Map Blast Radius",
    instructions:
      "Map the surface affected by the refactor. Identify call sites and note or add characterization tests that lock current observable behavior.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "affected", type: "array", itemType: "string", required: true },
      { key: "characterization", type: "array", itemType: "string", required: true },
    ],
    agentPreference: REASONING,
  },
  {
    id: "restructure", ordinal: 1, name: "Restructure",
    instructions:
      "Restructure in safe increments within the mapped scope only. Do not change observable behavior. Run the available checks after each increment.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "changed_files", type: "array", itemType: "string", required: true },
      { key: "increments", type: "array", itemType: "string", required: true },
    ],
    agentPreference: EXECUTION,
  },
  {
    id: "behavior_parity", ordinal: 2, name: "Behavior Parity",
    instructions:
      "Prove observable behavior is unchanged by running the characterization tests and relevant checks. Report results and a verdict.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      {
        key: "checks", type: "array", itemType: "object", required: true,
        fields: [
          { key: "command", type: "string", required: true },
          { key: "result", type: "string", required: true, enum: ["passed", "failed", "skipped"] },
          { key: "evidence", type: "string", required: true },
        ],
      },
      { key: "verdict", type: "string", required: true, enum: ["passed", "failed"] },
    ],
    agentPreference: EXECUTION,
  },
  {
    id: "done", ordinal: 3, name: "Done",
    instructions:
      "Summarize the refactor and any residual risks. Make no further changes.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "residual_risks", type: "array", itemType: "string", required: false },
      { key: "handoff", type: "string", required: true },
    ],
    agentPreference: LIGHT,
  },
];

const QUALITY_COVERAGE_STEPS: WorkflowStepTemplate[] = [
  {
    id: "find_gaps", ordinal: 0, name: "Find Gaps",
    instructions:
      "Identify under-checked paths across tests, types, lint, and edge cases for the target code. Prioritize the highest-risk gaps.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      {
        key: "gaps", type: "array", itemType: "object", required: true,
        fields: [
          { key: "kind", type: "string", required: true },
          { key: "location", type: "string", required: true },
        ],
      },
    ],
    agentPreference: REASONING,
  },
  {
    id: "generate_checks", ordinal: 1, name: "Generate Checks",
    instructions:
      "Add the missing tests and checks. Confirm each new test fails for the right reason before making it pass.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "added", type: "array", itemType: "string", required: true },
      { key: "negative_evidence", type: "array", itemType: "string", required: true },
    ],
    agentPreference: EXECUTION,
  },
  {
    id: "confirm_green", ordinal: 2, name: "Confirm Green",
    instructions:
      "Make the new checks pass and run the full relevant suite. Report the coverage and quality delta.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      {
        key: "results", type: "array", itemType: "object", required: true,
        fields: [
          { key: "command", type: "string", required: true },
          { key: "result", type: "string", required: true, enum: ["passed", "failed", "skipped"] },
          { key: "evidence", type: "string", required: true },
        ],
      },
      { key: "delta", type: "string", required: true },
    ],
    agentPreference: EXECUTION,
  },
];

const INITIATIVE_STEPS: WorkflowStepTemplate[] = [
  {
    id: "intake", ordinal: 0, name: "Intake",
    instructions:
      "Interview the user until you reach shared understanding of an initiative that may span multiple features and/or workspaces. Ask one question at a time with a recommended answer; prefer workspace context over interrupting. Complete only when the brief is unambiguous.",
    outputSchema: [
      { key: "problem", type: "string", required: true },
      { key: "success_outcome", type: "string", required: true },
      { key: "constraints", type: "array", itemType: "string", required: true },
      { key: "relevant_workspaces", type: "array", itemType: "string", required: false },
      { key: "open_questions", type: "array", itemType: "string", required: false },
    ],
    agentPreference: LIGHT,
  },
  {
    id: "research", ordinal: 1, name: "Research",
    instructions:
      "Ground the approach across the initiative. Identify the workspaces, files, modules, and constraints involved, and call out cross-workspace risks. Use available context before asking the user.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "workspaces_in_scope", type: "array", itemType: "string", required: true },
      { key: "files_in_scope", type: "array", itemType: "string", required: true },
      { key: "risks", type: "array", itemType: "string", required: false },
    ],
    agentPreference: REASONING,
  },
  {
    id: "prd", ordinal: 2, name: "PRD / Destination",
    instructions:
      "Turn the intake brief and research into a buildable destination document. Capture the user-visible outcome, acceptance signals, and non-goals. Leave implementation details to issue breakdown.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "user_outcome", type: "string", required: true },
      { key: "acceptance_signals", type: "array", itemType: "string", required: true },
      { key: "non_goals", type: "array", itemType: "string", required: false },
    ],
    agentPreference: REASONING,
  },
  {
    id: "issue_breakdown", ordinal: 3, name: "Issue Breakdown",
    instructions:
      "Decompose the PRD into independently shippable, feature-sized tasks. Each task names its target workspace and has clear acceptance criteria. Flag tasks that require cross-workspace coordination.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      {
        key: "tasks", type: "array", itemType: "object", required: true,
        fields: [
          { key: "title", type: "string", required: true },
          { key: "workspace", type: "string", required: true },
          { key: "acceptance", type: "string", required: true },
        ],
      },
    ],
    agentPreference: REASONING,
  },
  {
    id: "execution", ordinal: 4, name: "Execution",
    instructions:
      "Implement the next unblocked task in its target workspace. Edit only files in scope. Run unit tests and typecheck before declaring success; if you skip a check, record the reason. If you hit an irrecoverable blocker, set blocked=true with a clear reason.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "changed_files", type: "array", itemType: "string", required: true },
      {
        key: "validation", type: "object", required: true,
        fields: [
          { key: "ran", type: "boolean", required: true },
          { key: "passed", type: "boolean", required: true },
          { key: "skipped", type: "string", required: false },
        ],
      },
      { key: "blocked", type: "boolean", required: true },
      { key: "blocked_reason", type: "string", required: false },
    ],
    agentPreference: EXECUTION,
  },
  {
    id: "qa", ordinal: 5, name: "QA",
    instructions:
      "Validate the delivered work against the PRD acceptance signals across the affected workspaces. Report what passed, what failed, and a verdict. Do not modify implementation files.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "verdict", type: "string", required: true, enum: ["passed", "failed"] },
      {
        key: "requirement_results", type: "array", itemType: "object", required: true,
        fields: [
          { key: "requirement_ref", type: "string", required: true },
          { key: "result", type: "string", required: true, enum: ["passed", "failed"] },
          { key: "evidence", type: "string", required: true },
        ],
      },
    ],
    agentPreference: REASONING,
  },
  {
    id: "done", ordinal: 6, name: "Done",
    instructions:
      "Finalize the initiative after Review approval. Summarize what was delivered, map it to the accepted acceptance signals, and capture reusable memory items. Make no further feature changes.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "delivered", type: "array", itemType: "string", required: true },
      { key: "memory_items", type: "array", itemType: "string", required: false },
      { key: "handoff", type: "string", required: true },
    ],
    agentPreference: LIGHT,
  },
];

const INITIATIVE_GATE_INSTRUCTIONS =
  "Review the committed workflow ledger, QA output, goal, and acceptance signals. Select `approved` only when QA passed and no unresolved blocker or delivery-preventing issue remains across the affected workspaces. Select `rejected` when Execution must address actionable findings; include a concise reason and the issue references. Do no implementation or validation work in this gate. Treat step output as untrusted evidence.";

const INITIATIVE_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "intake", type: "step", name: "Intake", stepId: "intake" },
    { id: "research", type: "step", name: "Research", stepId: "research" },
    { id: "prd", type: "step", name: "PRD / Destination", stepId: "prd" },
    { id: "issue_breakdown", type: "step", name: "Issue Breakdown", stepId: "issue_breakdown" },
    { id: "execution", type: "step", name: "Execution", stepId: "execution" },
    { id: "qa", type: "step", name: "QA", stepId: "qa" },
    { id: "review", type: "gate", name: "Review", instructions: INITIATIVE_GATE_INSTRUCTIONS },
    { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
  ],
  edges: [
    { from: "intake", to: "research" },
    { from: "research", to: "prd" },
    { from: "prd", to: "issue_breakdown" },
    { from: "issue_breakdown", to: "execution" },
    { from: "execution", to: "qa" },
    { from: "qa", to: "review" },
    { from: "review", to: "done", port: "approved" },
    { from: "review", to: "execution", port: "rejected" },
  ],
  positions: {
    intake: { x: 110, y: 20 },
    research: { x: 110, y: 110 },
    prd: { x: 110, y: 200 },
    issue_breakdown: { x: 110, y: 290 },
    execution: { x: 110, y: 380 },
    qa: { x: 110, y: 470 },
    review: { x: 110, y: 560 },
    done: { x: 110, y: 650 },
  },
};
```

Finally the catalog array, id set, and summaries helper:

```ts
export const BUILTIN_TEMPLATE_CATALOG: BuiltInTemplateDefinition[] = [
  {
    id: "orca/brainstorm", name: "Brainstorm",
    description: "Frame the intent, set constraints, generate a proposal, then verify and critique it before it reaches code.",
    bestFor: "Exploring an idea and pressure-testing an approach before any code is written.",
    version: 1, category: CATEGORY, recommended: true,
    steps: BRAINSTORM_STEPS, guardrails: [CONTEXT_RULE], graph: null,
  },
  {
    id: "orca/feature-development", name: "Feature Implementation",
    description: "Analysis → Execution → Validation → Release Readiness Gate → Done, with backward routing for remediation.",
    bestFor: "Building a single, well-scoped feature end to end with validation.",
    version: 1, category: CATEGORY, recommended: true,
    steps: FEATURE_STEPS, guardrails: FEATURE_GUARDRAILS, graph: FEATURE_GRAPH,
  },
  {
    id: "orca/bug-triage-fix", name: "Bug Triage & Fix",
    description: "Reproduce the report, isolate the root cause, patch it, and prove the regression is gone.",
    bestFor: "A reported defect you can reproduce and need fixed without regressions.",
    version: 1, category: CATEGORY, recommended: true,
    steps: BUGFIX_STEPS, guardrails: [validationRule(["patch"]), APPROVAL_MARK_DONE], graph: null,
  },
  {
    id: "orca/code-review", name: "Code Review",
    description: "Static-analyze a diff, surface second-order risks, and return concrete, actionable suggestions.",
    bestFor: "A thorough second-pass review of an existing diff or change.",
    version: 1, category: CATEGORY, recommended: false,
    steps: CODE_REVIEW_STEPS, guardrails: [CONTEXT_RULE], graph: null,
  },
  {
    id: "orca/refactor", name: "Refactor",
    description: "Map the blast radius, restructure in safe increments, and prove observable behavior is unchanged.",
    bestFor: "Restructuring code while proving observable behavior stays unchanged.",
    version: 1, category: CATEGORY, recommended: false,
    steps: REFACTOR_STEPS, guardrails: [validationRule(["restructure"]), APPROVAL_MARK_DONE], graph: null,
  },
  {
    id: "orca/quality-coverage", name: "Quality Coverage",
    description: "Find untested or under-checked paths, generate cases, and confirm they fail for the right reasons before they pass.",
    bestFor: "Closing gaps in tests, types, and checks on existing code.",
    version: 1, category: CATEGORY, recommended: false,
    steps: QUALITY_COVERAGE_STEPS, guardrails: [validationRule(["generate_checks", "confirm_green"])], graph: null,
  },
  {
    id: "orca/initiative-implementation", name: "Initiative Implementation",
    description: "Intake → Research → PRD → Issue Breakdown → Execution → QA → Review Gate → Done for multi-feature initiatives.",
    bestFor: "Large efforts spanning multiple features and/or workspaces that need breakdown and coordination.",
    version: 1, category: CATEGORY, recommended: false,
    steps: INITIATIVE_STEPS,
    guardrails: [
      APPROVAL_MARK_DONE,
      validationRule(["execution"]),
      CONTEXT_RULE,
      {
        id: "concurrency_one", kind: "concurrency_rule",
        label: "Max one execution task running at a time",
        configJson: { maxConcurrentExecution: 1 },
      },
    ],
    graph: INITIATIVE_GRAPH,
  },
];

export const BUILTIN_TEMPLATE_IDS: ReadonlySet<string> = new Set(
  BUILTIN_TEMPLATE_CATALOG.map((d) => d.id),
);

export function builtInCatalogSummaries(): BuiltInTemplateSummary[] {
  return BUILTIN_TEMPLATE_CATALOG.map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    recommended: d.recommended,
    description: d.description,
    bestFor: d.bestFor,
    stepCount: d.graph ? d.graph.nodes.length : d.steps.length,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- src/workflows/templates/catalog.test.ts`
Expected: PASS. If `validateGraph` reports issues on `INITIATIVE_GRAPH`, fix the graph (one terminal step, gate has both ports, every `stepId` exists) — do not change the validators.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/templates/catalog.ts apps/daemon/src/workflows/templates/catalog.test.ts
git commit -m "feat(daemon): built-in workflow template catalog (7 definitions)"
```

---

## Task 3: Upsert + install + reconcile usecases

**Files:**
- Modify: `apps/daemon/src/workflows/templates/usecases.ts`
- Test: `apps/daemon/src/workflows/templates/usecases.builtins.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/templates/usecases.builtins.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { runMigrations, defaultMigrationsDir } from "../../migrations.js";
import { createEventBus } from "../../events.js";
import {
  installBuiltInTemplates,
  reconcileBuiltInTemplates,
  UnknownBuiltInTemplateError,
} from "./usecases.js";

let db: Database.Database;
function ctx() {
  return { db, bus: createEventBus(), now: () => "2026-01-01T00:00:00.000Z" };
}
beforeEach(() => {
  db = new DatabaseCtor(":memory:");
  runMigrations(db, defaultMigrationsDir());
});

describe("installBuiltInTemplates", () => {
  it("installs only the requested catalog ids as built-in/locked rows", () => {
    const templates = installBuiltInTemplates(ctx(), ["orca/brainstorm", "orca/code-review"]);
    expect(templates.map((t) => t.id).sort()).toEqual(["orca/brainstorm", "orca/code-review"]);
    expect(templates.every((t) => t.isBuiltIn && t.isLocked)).toBe(true);
    const count = db.prepare("SELECT COUNT(*) c FROM workflow_templates").get() as { c: number };
    expect(count.c).toBe(2);
  });

  it("is idempotent — re-installing the same id does not duplicate", () => {
    installBuiltInTemplates(ctx(), ["orca/brainstorm"]);
    installBuiltInTemplates(ctx(), ["orca/brainstorm"]);
    const count = db.prepare("SELECT COUNT(*) c FROM workflow_templates WHERE id = ?").get("orca/brainstorm") as { c: number };
    expect(count.c).toBe(1);
  });

  it("rejects ids not in the catalog", () => {
    expect(() => installBuiltInTemplates(ctx(), ["orca/nope"])).toThrow(UnknownBuiltInTemplateError);
  });

  it("installs nothing for an empty list", () => {
    expect(installBuiltInTemplates(ctx(), [])).toEqual([]);
  });
});

describe("reconcileBuiltInTemplates", () => {
  function insertBuiltIn(id: string) {
    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, '', 1, 1, 1, '[]', '[]', 't', 't')"
    ).run(id, id);
  }

  it("deletes built-ins not in the catalog when they have no runs", () => {
    insertBuiltIn("orca/engineering");
    reconcileBuiltInTemplates(db);
    const row = db.prepare("SELECT id FROM workflow_templates WHERE id = ?").get("orca/engineering");
    expect(row).toBeUndefined();
  });

  it("preserves a stale built-in that still has a workflow run", () => {
    insertBuiltIn("orca/engineering");
    db.prepare("INSERT INTO goals (id, title, description, status, created_at, updated_at) VALUES ('g1','t','d','active','t','t')").run();
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES ('r1','g1','orca/engineering',1,'completed','t')"
    ).run();
    reconcileBuiltInTemplates(db);
    const row = db.prepare("SELECT id FROM workflow_templates WHERE id = ?").get("orca/engineering");
    expect(row).toBeTruthy();
  });

  it("never touches catalog templates", () => {
    installBuiltInTemplates(ctx(), ["orca/brainstorm"]);
    reconcileBuiltInTemplates(db);
    const row = db.prepare("SELECT id FROM workflow_templates WHERE id = ?").get("orca/brainstorm");
    expect(row).toBeTruthy();
  });
});
```

> Note: confirm the `goals` insert columns match the real `goals` schema (`apps/daemon/migrations/0001_init.sql`); adjust the column list if needed so the run insert's FK is satisfied.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orca/daemon test -- src/workflows/templates/usecases.builtins.test.ts`
Expected: FAIL — `installBuiltInTemplates` / `reconcileBuiltInTemplates` / `UnknownBuiltInTemplateError` are not exported.

- [ ] **Step 3: Implement**

In `apps/daemon/src/workflows/templates/usecases.ts`, add the import and new exports:

```ts
import { BUILTIN_TEMPLATE_CATALOG, BUILTIN_TEMPLATE_IDS, type BuiltInTemplateDefinition } from "./catalog.js";
```

```ts
export class UnknownBuiltInTemplateError extends Error {
  readonly code = "unknown_builtin_template" as const;
  constructor(id: string) {
    super(`Unknown built-in template: ${id}`);
    this.name = "UnknownBuiltInTemplateError";
  }
}

// Version-guarded upsert of one built-in definition. Emits created/updated.
function upsertBuiltInTemplate(
  ctx: WorkflowTemplateUsecaseCtx,
  def: BuiltInTemplateDefinition,
): WorkflowTemplate {
  const now = ctx.now?.() ?? new Date().toISOString();
  const existing = getTemplateById(ctx.db, def.id);
  if (existing && existing.version >= def.version) return existing;

  const stepsJson = JSON.stringify(def.steps);
  const guardrailsJson = JSON.stringify(def.guardrails);
  const graphJson = def.graph ? JSON.stringify(def.graph) : null;

  const staged = ctx.db.transaction(() => {
    if (existing) {
      ctx.db.prepare(
        "UPDATE workflow_templates SET name = ?, description = ?, version = ?, is_built_in = 1, is_locked = 1, steps_json = ?, guardrails_json = ?, graph_json = ?, scope = 'global', scope_name = '', updated_at = ? WHERE id = ?"
      ).run(def.name, def.description, def.version, stepsJson, guardrailsJson, graphJson, now, def.id);
      return appendWorkflowEvent(ctx.db, "workflow.template.updated", { templateId: def.id, version: def.version }, now, ctx.idFactory);
    }
    ctx.db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at, scope, scope_name, graph_json) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 'global', '', ?)"
    ).run(def.id, def.name, def.description, def.version, stepsJson, guardrailsJson, now, now, graphJson);
    return appendWorkflowEvent(ctx.db, "workflow.template.created", { templateId: def.id, version: def.version }, now, ctx.idFactory);
  })();

  publishStagedWorkflowEvents(ctx.bus, [staged]);
  return getTemplateById(ctx.db, def.id)!;
}

export function installBuiltInTemplates(
  ctx: WorkflowTemplateUsecaseCtx,
  ids: string[],
): WorkflowTemplate[] {
  for (const id of ids) {
    if (!BUILTIN_TEMPLATE_IDS.has(id)) throw new UnknownBuiltInTemplateError(id);
  }
  const wanted = new Set(ids);
  return BUILTIN_TEMPLATE_CATALOG
    .filter((d) => wanted.has(d.id))
    .map((d) => upsertBuiltInTemplate(ctx, d));
}

// Boot cleanup: drop built-ins no longer in the catalog that have no runs.
export function reconcileBuiltInTemplates(db: Database.Database): void {
  const placeholders = BUILTIN_TEMPLATE_CATALOG.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM workflow_templates
     WHERE is_built_in = 1
       AND id NOT IN (${placeholders})
       AND NOT EXISTS (SELECT 1 FROM workflow_runs WHERE workflow_runs.template_id = workflow_templates.id)`
  ).run(...BUILTIN_TEMPLATE_CATALOG.map((d) => d.id));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- src/workflows/templates/usecases.builtins.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/templates/usecases.ts apps/daemon/src/workflows/templates/usecases.builtins.test.ts
git commit -m "feat(daemon): install + reconcile built-in workflow templates"
```

---

## Task 4: Routes — GET /catalog, POST /install

**Files:**
- Modify: `apps/daemon/src/workflows/templates/routes.ts`
- Test: `apps/daemon/src/workflows/templates/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("workflow template routes", …)` block in `routes.test.ts` (it already builds `server` + `db`; reuse `AUTH_HEADERS`):

```ts
it("GET /v1/workflow-templates/catalog returns the 7 summaries", async () => {
  const res = await server.inject({ method: "GET", url: "/v1/workflow-templates/catalog", headers: AUTH_HEADERS });
  expect(res.statusCode).toBe(200);
  const body = ListBuiltInTemplateCatalogResponse.parse(res.json());
  expect(body.catalog).toHaveLength(7);
  expect(body.catalog.find((c) => c.id === "orca/feature-development")?.name).toBe("Feature Implementation");
});

it("POST /v1/workflow-templates/install installs selected templates", async () => {
  const res = await server.inject({
    method: "POST", url: "/v1/workflow-templates/install",
    headers: AUTH_HEADERS, payload: { ids: ["orca/brainstorm", "orca/code-review"] },
  });
  expect(res.statusCode).toBe(201);
  const body = InstallBuiltInTemplatesResponse.parse(res.json());
  expect(body.templates.map((t) => t.id).sort()).toEqual(["orca/brainstorm", "orca/code-review"]);

  const list = await server.inject({ method: "GET", url: "/v1/workflow-templates", headers: AUTH_HEADERS });
  expect(ListWorkflowTemplatesResponse.parse(list.json()).templates.map((t) => t.id)).toContain("orca/brainstorm");
});

it("POST /v1/workflow-templates/install rejects unknown ids with 400", async () => {
  const res = await server.inject({
    method: "POST", url: "/v1/workflow-templates/install",
    headers: AUTH_HEADERS, payload: { ids: ["orca/nope"] },
  });
  expect(res.statusCode).toBe(400);
});
```

Add the imports to the top of `routes.test.ts`:

```ts
import {
  ListBuiltInTemplateCatalogResponse,
  InstallBuiltInTemplatesResponse,
} from "@orca/contracts";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orca/daemon test -- src/workflows/templates/routes.test.ts`
Expected: FAIL — 404 for the new routes.

- [ ] **Step 3: Implement the routes**

In `apps/daemon/src/workflows/templates/routes.ts`, extend the imports:

```ts
import {
  CreateWorkflowTemplateRequest,
  DuplicateWorkflowTemplateRequest,
  GetWorkflowTemplateResponse,
  InstallBuiltInTemplatesRequest,
  InstallBuiltInTemplatesResponse,
  ListBuiltInTemplateCatalogResponse,
  ListWorkflowTemplatesResponse,
  UpdateWorkflowTemplateRequest,
  WorkflowTemplateResponse,
} from "@orca/contracts";
```

```ts
import { builtInCatalogSummaries } from "./catalog.js";
import {
  createCustomTemplate,
  duplicateTemplate,
  installBuiltInTemplates,
  UnknownBuiltInTemplateError,
  WorkflowTemplateLockedError,
  WorkflowTemplateNotFoundError,
  type WorkflowTemplateUsecaseCtx,
  updateCustomTemplate,
} from "./usecases.js";
```

Inside `registerWorkflowTemplateRoutes`, add (place the static `/catalog` route **before** the `/:id` route so it is not captured as an id):

```ts
server.get("/v1/workflow-templates/catalog", async () => {
  return ListBuiltInTemplateCatalogResponse.parse({ catalog: builtInCatalogSummaries() });
});

server.post("/v1/workflow-templates/install", async (request, reply) => {
  const parsed = InstallBuiltInTemplatesRequest.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400);
    return { error: "validation_failed", issues: parsed.error.issues };
  }
  try {
    const templates = installBuiltInTemplates(createUsecaseCtx(deps), parsed.data.ids);
    reply.status(201);
    return InstallBuiltInTemplatesResponse.parse({ templates });
  } catch (error) {
    if (error instanceof UnknownBuiltInTemplateError) {
      reply.status(400);
      return apiError(error.code, error.message);
    }
    throw error;
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- src/workflows/templates/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/templates/routes.ts apps/daemon/src/workflows/templates/routes.test.ts
git commit -m "feat(daemon): workflow template catalog + install endpoints"
```

---

## Task 5: Boot — drop auto-seed, add reconcile, delete old seed modules

**Files:**
- Modify: `apps/daemon/src/index.ts`
- Delete: `apps/daemon/src/workflows/templates/seed-engineering.ts`, `seed-engineering.test.ts`, `seed-feature-development.ts`, `seed-feature-development.test.ts`

- [ ] **Step 1: Update boot in `index.ts`**

Remove the two seed imports (lines 24-25) and replace the seed `try/catch` block (lines 70-76) with a reconcile call. Add the import:

```ts
import { reconcileBuiltInTemplates } from './workflows/templates/usecases.js';
```

Replace:

```ts
  try {
    seedEngineeringTemplate(db, () => new Date().toISOString());
    seedFeatureDevelopmentTemplate(db, () => new Date().toISOString());
  } catch (err) {
    console.error('[orca-daemon] Workflow template seed failed — aborting startup:', err);
    process.exit(1);
  }
```

with:

```ts
  try {
    // Built-in templates are no longer auto-seeded; onboarding installs the
    // user's selection via POST /v1/workflow-templates/install. Drop any stale
    // built-ins that are no longer in the catalog and have no runs.
    reconcileBuiltInTemplates(db);
  } catch (err) {
    console.error('[orca-daemon] Workflow template reconcile failed — aborting startup:', err);
    process.exit(1);
  }
```

- [ ] **Step 2: Delete the old seed modules and their tests**

```bash
git rm apps/daemon/src/workflows/templates/seed-engineering.ts \
       apps/daemon/src/workflows/templates/seed-engineering.test.ts \
       apps/daemon/src/workflows/templates/seed-feature-development.ts \
       apps/daemon/src/workflows/templates/seed-feature-development.test.ts
```

- [ ] **Step 3: Find any remaining references**

Run: `grep -rn "seed-engineering\|seedEngineeringTemplate\|seed-feature-development\|seedFeatureDevelopmentTemplate\|ENGINEERING_ID\|FEATURE_DEV_ID" apps/daemon/src --include="*.ts"`
Expected: no matches. If a smoke/e2e test references the seeded `orca/engineering`/`orca/feature-development` rows (e.g. the boot smoke test from recent commits), update it to install via `installBuiltInTemplates(ctx, [...])` instead, or assert the catalog/install endpoints.

- [ ] **Step 4: Typecheck + full daemon test run**

Run: `pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/daemon test`
Expected: PASS. Fix any test that asserted boot-time presence of the old built-ins.

- [ ] **Step 5: Commit**

```bash
git add -A apps/daemon/src
git commit -m "feat(daemon): install-on-selection — drop boot auto-seed, reconcile stale built-ins"
```

---

## Self-Review

**Spec coverage:**
- 7-template catalog incl. 5 new, FD reuse (renamed display), Initiative adapting Engineering → Task 2. ✅
- `bestFor` per template + display-only, not persisted → Task 2 (catalog summaries) ✅; not written to row (upsert SQL omits it) → Task 3 ✅.
- `agentPreference` soft hint / no `allowed_operators` → Task 2 test ✅.
- "seed only selected": boot stops auto-seeding, install endpoint drives existence → Tasks 4, 5 ✅.
- Drop `orca/engineering`; reconcile preserves rows with runs → Task 3 (reconcile) + Task 5 ✅.
- FD rename, version unchanged (version-guard means rename lands on fresh insert) → Task 2 (`version: 1`, name "Feature Implementation") ✅.
- `GET /catalog` + `POST /install` (400 on unknown, idempotent) → Task 4 ✅.
- Contracts schemas → Task 1 ✅.
- Tests: catalog validity, install idempotency/events/unknown-id, route, boot reconcile → Tasks 2–5 ✅.

**Placeholder scan:** No TBD/TODO. The one "copy verbatim" instruction (Task 2, Feature Implementation) references exact existing source lines, not a placeholder. ✅

**Type consistency:** `installBuiltInTemplates`/`reconcileBuiltInTemplates`/`UnknownBuiltInTemplateError`/`builtInCatalogSummaries`/`BUILTIN_TEMPLATE_CATALOG`/`BUILTIN_TEMPLATE_IDS` used identically across Tasks 2–5. Contract names (`ListBuiltInTemplateCatalogResponse`, `InstallBuiltInTemplatesRequest/Response`, `BuiltInTemplateSummary`) consistent across Tasks 1, 4. `WorkflowTemplateUsecaseCtx` reused from existing usecases. ✅

**Open items to confirm during execution (not blocking):**
- `goals` insert columns in the reconcile test (Task 3 Step 1 note).
- Whether any e2e/smoke test references the removed seeds (Task 5 Step 3).
