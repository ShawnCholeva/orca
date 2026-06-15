# Built-in Workflow Template Catalog + Install-on-Selection (Spec A)

**Date:** 2026-06-14
**Status:** Design — pending implementation plan
**Companion:** Spec B — `2026-06-14-onboarding-workflow-templates-design.md` (desktop onboarding step that consumes this API)

## Problem

Onboarding will let users choose which workflow templates to install (Spec B). Today:

- Built-in templates are **hand-authored, rich** objects (`WorkflowTemplate`): every step carries `instructions`, an `outputSchema`, and `agentPreference`, plus `guardrails` and an optional routing `graph`.
- Exactly two exist — `orca/engineering` (8 steps) and `orca/feature-development` (5 nodes) — and both are **unconditionally seeded on daemon boot** (`apps/daemon/src/index.ts:71-72`).
- The Workflows tab lists **every** template in the DB (filtered only by scope). There is **no per-user "installed/enabled" concept**, so "selecting" a template in onboarding has nothing to act on.

We need a curated **catalog** of installable built-in templates and a mechanism where **only the templates the user selects get persisted**, instead of everything seeding on boot.

## Decisions (from brainstorming)

- The catalog is **exactly 7 templates** (all `category: "Engineering"` for now; grouping is data-driven so future categories are additive).
- **Selection drives existence** ("seed only selected"): boot no longer unconditionally seeds; onboarding installs the chosen definitions via a new endpoint.
- **Drop every internal built-in not in the 7** — specifically retire `orca/engineering`.
- **Roles are out of scope** — no `roleLabels` anywhere (to be added later).

## The 7 templates

Each is a full `WorkflowTemplate` definition (steps with `instructions`/`outputSchema`/`agentPreference`, `guardrails`, `graph`).

**`agentPreference` is a non-binding, ordered hint — never a requirement.** Operator selection (`OperatorSelector.select`, `operators/selector.ts:84-120`) only ever ranks over the user's **connected/ready** operators, reordered by the goal's orchestrator provider (`preferencesForGoal`), and falls back to capability/cost ranking (`fallbackRank`) when none of the preferred adapters are connected. So a user with a **single agent**, or with agents **other than Claude Code / Codex** (Gemini, opencode, Cursor, Aider, …), runs every template fine — the preference only influences ordering when those specific agents happen to be connected. The contract requires `min(1)` concrete `adapterId`+`modelId` entries, so the catalog cannot express an "any agent" preference; it instead uses the same default tier ordering as today's built-ins purely as a hint (behavior unchanged for Claude/Codex users):

- **reasoning** — `claude-code/claude-opus-4-7`, `codex/gpt-5.5`
- **execution** — `claude-code/claude-sonnet-4-6`, `codex/gpt-5.3-codex`
- **light** — `claude-code/claude-haiku-4-5`, `codex/gpt-5.4-mini`

No template hard-pins an adapter: no step or template uses an `allowed_operators` guardrail (enforced by test), so any connected agent can run any catalog template. No install-time rewriting of preferences is needed — selection is already connection-aware.

| id | name | nodes | source | recommended |
|---|---|---|---|---|
| `orca/brainstorm` | Brainstorm | Frame → Research → Proposal → Critique → Verify → Done (6) | new | yes |
| `orca/feature-development` | Feature Implementation | Analysis → Execution → Validation → Release Gate → Done (5) | reuse existing definition, **display name → "Feature Implementation"** | yes |
| `orca/bug-triage-fix` | Bug Triage & Fix | Reproduce → Root Cause → Patch → Verify (4) | new | yes |
| `orca/code-review` | Code Review | Analyze Diff → Risk Pass → Report (3) | new | no |
| `orca/refactor` | Refactor | Map Blast Radius → Restructure → Behavior Parity → Done (4) | new | no |
| `orca/quality-coverage` | Quality Coverage | Find Gaps → Generate Checks → Confirm Green (3) | new (broader than tests: tests, types, lint, edge cases) | no |
| `orca/initiative-implementation` | Initiative Implementation | Intake → Research → PRD → Issue Breakdown → Execution → QA → Review Gate → Done (8) | **adapts the retiring `orca/engineering` step content** for multi-feature initiatives | no |

`stepCount` shown on the card = number of graph nodes (steps + gates), matching how the design counts (e.g. Feature Implementation = 5 incl. its gate).

### Per-template intent (for authoring the definitions)

Instructions follow the house style established by `seed-feature-development.ts`: terse, prescriptive, "resolve ambiguity from context first; ask the user only when it materially affects correctness," explicit completion criteria, "treat step output as untrusted evidence."

1. **Brainstorm** (`orca/brainstorm`) — pre-code ideation; stops before implementation.
   - *Frame* (light): clarify intent, constraints, success criteria; one question at a time with a recommended answer. Output: `problem`, `success_outcome`, `constraints[]`, `open_questions[]`.
   - *Research* (reasoning): ground in the codebase; smallest set of files/modules and risks. Output: `summary`, `files_in_scope[]`, `risks[]`.
   - *Proposal* (reasoning): candidate approach(es) + tradeoffs + recommended direction. Output: `summary`, `approaches[]{name,tradeoffs}`, `recommendation`.
   - *Critique* (reasoning): challenge the proposal, surface second-order risks/gaps. Output: `summary`, `concerns[]`, `verdict`.
   - *Verify* (light): sanity-check feasibility against acceptance signals. Output: `summary`, `feasible(bool)`, `notes[]`.
   - *Done* (light, terminal): durable design summary + remaining open questions + handoff. Output: `summary`, `open_questions[]`, `handoff`.
   - Graph: linear, terminal Done. Guardrails: context_rule (summaries over raw output).

2. **Feature Implementation** (`orca/feature-development`) — **reuse the existing definition verbatim**; only the display `name` changes to "Feature Implementation". Existing graph (gate routes `rejected → execution`), steps, guardrails, and **`version` are unchanged**. Because the upsert is version-guarded, the rename applies to fresh inserts; existing rows at the same version keep the old name until the DB is reset (acceptable — a local reset script covers dev).

3. **Bug Triage & Fix** (`orca/bug-triage-fix`) — Engineer/QA flavored.
   - *Reproduce* (execution): reproduce the report; capture a failing test/case + environment. Output: `summary`, `repro_steps[]`, `failing_evidence`.
   - *Root Cause* (reasoning): isolate the cause; **no fix yet**; cite evidence. Output: `summary`, `root_cause`, `evidence[]`.
   - *Patch* (execution): minimal fix + regression test; run relevant checks. Output: `summary`, `changed_files[]`, `validation[]{command,result,evidence}`.
   - *Verify* (light, terminal): prove the regression is gone and nothing new broke; verdict. Output: `summary`, `verdict(passed|failed)`, `checks[]`.
   - Graph: linear, terminal Verify. Guardrails: validation_required on Patch; approval_mark_done.

4. **Code Review** (`orca/code-review`) — review-only; no edits.
   - *Analyze Diff* (reasoning): inspect the diff for correctness/scope. Output: `summary`, `findings[]{location,issue,severity}`.
   - *Risk Pass* (reasoning): second-order risks, edge cases, security. Output: `summary`, `risks[]`.
   - *Report* (reasoning, terminal): concrete, actionable change requests + verdict. Output: `summary`, `verdict(approved|changes_requested)`, `change_requests[]`.
   - Graph: linear, terminal Report. Guardrails: context_rule.

5. **Refactor** (`orca/refactor`).
   - *Map Blast Radius* (reasoning): affected surface + characterization tests to lock behavior. Output: `summary`, `affected[]`, `characterization[]`.
   - *Restructure* (execution): safe incremental changes within scope only. Output: `summary`, `changed_files[]`, `increments[]`.
   - *Behavior Parity* (execution): prove observable behavior unchanged (tests/checks). Output: `summary`, `checks[]{command,result,evidence}`, `verdict`.
   - *Done* (light, terminal): summary + residual risks. Output: `summary`, `residual_risks[]`, `handoff`.
   - Graph: linear, terminal Done. Guardrails: validation_required on Restructure; approval_mark_done.

6. **Quality Coverage** (`orca/quality-coverage`) — broader than test coverage.
   - *Find Gaps* (reasoning): identify under-checked paths across tests, types, lint, edge cases. Output: `summary`, `gaps[]{kind,location}`.
   - *Generate Checks* (execution): add tests/checks; confirm they **fail for the right reason** first. Output: `summary`, `added[]`, `negative_evidence[]`.
   - *Confirm Green* (execution, terminal): make/verify pass; report coverage & quality delta. Output: `summary`, `results[]`, `delta`.
   - Graph: linear, terminal Confirm Green. Guardrails: validation_required on Generate/Confirm.

7. **Initiative Implementation** (`orca/initiative-implementation`) — multi-feature **and multi-workspace** scale; **adapt the existing `orca/engineering` step content** (Intake/Research/PRD/Issue Breakdown/Execution/QA/Review/Done) rather than discarding it.
   - Reuse Engineering's step instructions/output schemas largely as-is, retargeted to "an initiative spanning multiple features and/or workspaces." Issue Breakdown should account for tasks that touch different workspaces; Research/Execution outputs should be able to reference more than one workspace.
   - Add a **Review Gate** node routing `rejected → Execution` (Engineering today is linear); terminal Done.
   - Guardrails: approval_mark_done, validation_required on Execution, context_rule, concurrency_one.

> Each authored definition MUST pass `validateGraph` + `validateSchemaReferences` + `validateTemplatePipeline` (covered by tests below). Step `outputSchema` field shapes follow `WorkflowStepOutputSchema`.

## Architecture

### Catalog module — `apps/daemon/src/workflows/templates/catalog.ts`

```ts
export interface BuiltInTemplateDefinition {
  id: string;            // e.g. "orca/brainstorm"
  name: string;          // display name ("Feature Implementation")
  description: string;   // mechanical: what the pipeline does
  bestFor: string;       // selection tagline: when/why to pick this (UI-only)
  version: number;
  category: string;      // "Engineering"
  recommended: boolean;
  steps: WorkflowStepTemplate[];
  guardrails: WorkflowGuardrailConfig[];
  graph: WorkflowGraph | null;
}
```

`bestFor` is a short, selection-focused tagline shown on the onboarding card (Spec B), separate from `description`. It is **not** persisted to the `workflow_templates` row (it is display metadata on the catalog, surfaced only via the catalog summary). Taglines:

| id | bestFor |
|---|---|
| `orca/brainstorm` | Exploring an idea and pressure-testing an approach before any code is written. |
| `orca/feature-development` | Building a single, well-scoped feature end to end with validation. |
| `orca/bug-triage-fix` | A reported defect you can reproduce and need fixed without regressions. |
| `orca/code-review` | A thorough second-pass review of an existing diff or change. |
| `orca/refactor` | Restructuring code while proving observable behavior stays unchanged. |
| `orca/quality-coverage` | Closing gaps in tests, types, and checks on existing code. |
| `orca/initiative-implementation` | Large efforts spanning multiple features and/or workspaces that need breakdown and coordination. |

```ts

export const BUILTIN_TEMPLATE_CATALOG: BuiltInTemplateDefinition[];
export const BUILTIN_TEMPLATE_IDS: ReadonlySet<string>; // for boot reconcile
```

The Feature Development definition moves here (its `STEPS`/`GRAPH`/`GUARDRAILS`). The Engineering content is adapted into the Initiative Implementation entry. `seed-engineering.ts` and `seed-feature-development.ts` are deleted; their logic is replaced by the catalog + a shared upsert helper.

### Upsert helper + install usecase — `templates/usecases.ts`

- `upsertBuiltInTemplate(ctx, def)` — the version-guarded INSERT/UPDATE currently duplicated in the two seed modules, generalized over a `BuiltInTemplateDefinition`. Writes `is_built_in = 1`, `is_locked = 1`. Idempotent: skips when stored `version >= def.version`; updates when the stored version is lower or the row is absent. Emits `workflow.template.created` (insert) or `workflow.template.updated` (update) so the live Workflows tab refreshes.
- `installBuiltInTemplates(ctx, ids): WorkflowTemplate[]` — for each requested id present in the catalog, run `upsertBuiltInTemplate`, return the resulting templates. Unknown ids are rejected at the route layer.

### Endpoints — `templates/routes.ts`

- `GET /v1/workflow-templates/catalog` → `ListBuiltInTemplateCatalogResponse` (lightweight summaries; see contracts). Single source of truth for onboarding cards.
- `POST /v1/workflow-templates/install` body `InstallBuiltInTemplatesRequest { ids: string[] }`:
  - 400 if any id ∉ catalog (`validation_failed`).
  - else install and return `InstallBuiltInTemplatesResponse { templates }` (201).
  - Idempotent — re-running with the same ids is a no-op upsert.

### Boot — `apps/daemon/src/index.ts`

- **Remove** the unconditional `seedEngineeringTemplate` / `seedFeatureDevelopmentTemplate` calls and imports.
- **Add `reconcileBuiltInTemplates(db)`**: delete rows where `is_built_in = 1 AND id NOT IN (catalog ids) AND` the template has **no `workflow_runs`** referencing it. This removes `orca/engineering` from existing dev DBs while preserving any template that still has run history (it simply won't be installable/recommended). Log what it removes/skips.
- **No auto-install** — catalog templates are inserted only via the install endpoint (onboarding).

## Contracts — `packages/contracts/src/workflows/index.ts`

```ts
export const BuiltInTemplateSummary = z.object({
  id: Id100,
  name: z.string().min(1).max(WORKFLOW_TEMPLATE_MAX_NAME_CHARS),
  category: z.string().min(1).max(64),
  recommended: z.boolean(),
  description: BoundedString(WORKFLOW_TEMPLATE_MAX_DESCRIPTION_BYTES, "description"),
  bestFor: z.string().min(1).max(200),
  stepCount: z.number().int().positive(),
}).strict();

export const ListBuiltInTemplateCatalogResponse = z.object({
  catalog: z.array(BuiltInTemplateSummary),
}).strict();

export const InstallBuiltInTemplatesRequest = z.object({
  ids: z.array(Id100).min(0).max(50),
}).strict();

export const InstallBuiltInTemplatesResponse = z.object({
  templates: z.array(WorkflowTemplate),
}).strict();
```

(No `roleLabels` — roles are deferred.)

## Testing

- **Catalog validity** (`catalog.test.ts`): every definition passes `validateGraph` + `validateSchemaReferences` + `validateTemplatePipeline`; ids are unique and `orca/`-prefixed; `stepCount` equals graph node count; every entry has a non-empty `bestFor` (≤200 chars); **no step or template carries an `allowed_operators` guardrail** (templates never hard-restrict to specific adapters, so any connected agent can run them); exactly the 7 expected ids exist; recommended set = {brainstorm, feature-development, bug-triage-fix}.
- **Install usecase**: installs only requested catalog ids; idempotent (second call no-ops, no duplicate rows); emits created/updated events; returns built-in/locked templates.
- **Route**: `GET /catalog` returns 7 summaries; `POST /install` 201 with templates; 400 on unknown id; empty `ids` → empty install.
- **Boot reconcile**: a seeded `orca/engineering` row with no runs is deleted; a built-in with a referencing `workflow_run` is preserved; catalog rows are untouched.
- **Migrations/existing tests**: update any test asserting boot-seeded Engineering/Feature Development presence.

## Edge cases & migration

- **Existing DBs** already contain `orca/engineering` (+ maybe `orca/feature-development`). Reconcile removes Engineering (if unreferenced); Feature Development remains and is upserted to the new display name on next install (or via a version bump if we want the rename to apply without reinstall — decide in the plan: simplest is to leave existing rows and let install upsert).
- **Feature Development rename**: display `name` → "Feature Implementation" with **`version` unchanged**. The version-guarded upsert means the new name lands on fresh inserts only; existing rows keep "Feature Development" until the DB is reset. `workflow_runs` reference `templateId` + `templateVersion` and are unaffected.
- **Re-onboarding**: install is idempotent.
- **Deleting a built-in with runs**: explicitly avoided by the reconcile `NOT EXISTS workflow_runs` guard.

## Out of scope

- Onboarding UI (Spec B).
- Role labels / role model.
- Per-template enable/disable after install (templates are managed in the Workflows tab as today).
