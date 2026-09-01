# Confirm-Card Field Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `display: "user" | "agent"` audience to workflow step output fields so the step-completion confirm card shows the human only the fields they are deciding on, folding the rest behind a disclosure — while every field continues to reach downstream agents unchanged.

**Architecture:** One optional key on `WorkflowStepOutputField` (absent ⇒ `agent`). `buildConfirmationSummary` splits schema fields into the card's existing `fields` array and a new optional `details` array; the desktop renders `details` inside a `<details>` disclosure. A legacy rule — a schema where no top-level field declares an audience is treated as all-`user` — keeps unannotated templates (duplicated, custom, or not yet annotated) rendering full-face exactly as they do today. [Corrected 2026-08-31: this does not distinguish in-flight from historical runs — the schema is read from each template's live row, not a per-run snapshot; see Task 3's background note.] All 98 top-level catalog fields are then annotated explicitly, so the `agent` default only ever governs fields added later.

**Tech Stack:** TypeScript, Zod (contracts), Vitest (daemon + contracts + desktop), React + Testing Library (desktop), plain CSS.

**Spec:** `docs/superpowers/specs/2026-08-31-confirm-card-field-display-design.md`

**Branch:** `feat/confirm-card-field-display` (already created; the spec is committed on `main` as `a880abb`).

## Global Constraints

- **The flag is display-only.** It must never filter what a downstream step receives. `buildStepExecutionInput` (`apps/daemon/src/workflows/orchestrator/step-input.ts:36-45`) passes the full prior output block via `priorStepOutputs` and is **not** modified by this plan.
- **Absent `display` ⇒ `agent`.** Agent visibility is the baseline; putting a field in front of the human is the deliberate act.
- **Nested subfields are never annotated.** `flattenField` renders a nested field into whichever array its *parent* selected, so `display` on a subfield would be inert. Only top-level `outputSchema` entries carry it.
- **Shared worktree.** Parallel agents are editing this same tree; there are ~19 pre-existing modified files that are not yours. **Stage explicit paths only — never `git add -A`.**
- **Zod objects here are `.strict()`.** A new key must be added to *both* the hand-written TS type and the Zod object in `output-schema.ts`, or parsing breaks.
- Test commands: `pnpm --filter @orca/contracts test`, `pnpm --filter @orca/daemon test`, `pnpm --filter @orca/desktop test`. Typecheck: `pnpm typecheck`.
- Task order matters: the desktop renderer (Task 4) lands **before** the catalog annotations (Task 5). Reversing them creates an intermediate commit where Triage's five fields are routed to `details` that nothing renders yet — i.e. temporarily invisible in the UI.

---

### Task 1: `display` audience on `WorkflowStepOutputField`

**Files:**
- Modify: `packages/contracts/src/workflows/output-schema.ts:1-34`
- Test: `packages/contracts/src/workflows/output-schema.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `WorkflowStepOutputField.display?: "user" | "agent"` — read by Task 3's builder and set by Task 5's catalog annotations.

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/workflows/output-schema.test.ts`:

```ts
describe("display audience", () => {
  it("accepts user and agent, and parses fields that omit it", () => {
    const withUser = WorkflowStepOutputField.parse({
      key: "rationale", type: "string", required: true, display: "user",
    });
    expect(withUser.display).toBe("user");

    const withAgent = WorkflowStepOutputField.parse({
      key: "known_files", type: "array", itemType: "string", required: false, display: "agent",
    });
    expect(withAgent.display).toBe("agent");

    // Absent is legal and stays absent — the `agent` default is applied by the
    // card builder, not by the parser, so a round-trip never invents a value.
    const bare = WorkflowStepOutputField.parse({ key: "problem", type: "string", required: true });
    expect(bare.display).toBeUndefined();
  });

  it("rejects an audience outside the enum", () => {
    expect(() =>
      WorkflowStepOutputField.parse({ key: "problem", type: "string", required: true, display: "both" })
    ).toThrow();
  });
});
```

If `WorkflowStepOutputField` and `describe`/`it`/`expect` are not already imported in that file, add them:

```ts
import { describe, it, expect } from "vitest";
import { WorkflowStepOutputField } from "./output-schema.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test -- output-schema`
Expected: FAIL — the `.strict()` object rejects the unrecognized key `display`.

- [ ] **Step 3: Write minimal implementation**

In `packages/contracts/src/workflows/output-schema.ts`, add the enum beside the existing ones (after line 4):

```ts
const DisplayAudience = z.enum(["user", "agent"]);
```

Add to the hand-written type (after `fields?:` on line 13):

```ts
  /** Who this field is for on the step-completion confirm card.
   *  `user` means user AND agent — it renders on the card face.
   *  `agent` means agent only *on the card*: it folds behind the card's
   *  disclosure. It does NOT filter the field out of `priorStepOutputs` —
   *  downstream steps receive every field either way (step-input.ts).
   *  Absent ⇒ `agent`, because agent visibility is the baseline; putting a
   *  field in front of the human is the deliberate act. */
  display?: z.infer<typeof DisplayAudience>;
```

And to the Zod object (after the `fields:` line):

```ts
    display: DisplayAudience.optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test -- output-schema`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/workflows/output-schema.ts packages/contracts/src/workflows/output-schema.test.ts
git commit -m "feat(contracts): add display audience to workflow step output fields"
```

---

### Task 2: `details` array on `ConfirmationSummary`

**Files:**
- Modify: `packages/contracts/src/index.ts:1391-1412`
- Test: `packages/contracts/src/index.test.ts:1801-1826`

**Interfaces:**
- Consumes: nothing from Task 1 (independent contract change).
- Produces: `ConfirmationSummary.details?: Array<{ label: string; value: string | string[] }>` — written by Task 3's builder, rendered by Task 4's desktop component.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe("ConfirmationSummary", ...)` block in `packages/contracts/src/index.test.ts`:

```ts
  it("accepts an optional details array alongside fields", () => {
    const parsed = ConfirmationSummary.parse({
      lead: "Provisional brief.",
      fields: [{ label: "Recommended step", value: "Clarify" }],
      details: [
        { label: "Known files", value: ["docs/cara.md", "apps/api/src/config.ts"] },
        { label: "Codebase state", value: "existing_ungrounded" },
      ],
      scoring: null,
    });
    expect(parsed.details).toHaveLength(2);
  });

  it("parses a card persisted before details existed", () => {
    const parsed = ConfirmationSummary.parse({
      lead: "ok", fields: [{ label: "Problem", value: "x" }], scoring: null,
    });
    expect(parsed.details).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test -- index`
Expected: FAIL on the first new test — `ConfirmationSummary` is `.strict()` and rejects `details`.

- [ ] **Step 3: Write minimal implementation**

In `packages/contracts/src/index.ts`, extract the inline card-field object to a named const immediately above `ConfirmationSummary` (line 1391):

```ts
const ConfirmationCardField = z
  .object({
    label: z.string().min(1).max(128),
    value: z.union([z.string().max(4000), z.array(z.string().max(4000)).max(64)]),
  })
  .strict();
```

Then replace the inline `fields` definition and add `details`:

```ts
    fields: z.array(ConfirmationCardField).max(32),
    // Fields whose schema marks them `display: "agent"` — folded behind the
    // card's disclosure rather than dropped. Optional so cards persisted
    // before this existed still parse.
    details: z.array(ConfirmationCardField).max(32).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test -- index`
Expected: PASS (both new tests, and the two pre-existing `ConfirmationSummary` tests still green)

- [ ] **Step 5: Build contracts so the daemon and desktop see the new types**

Run: `pnpm --filter @orca/contracts build`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): add optional details array to ConfirmationSummary"
```

---

### Task 3: Route fields by audience in the card builder

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/confirmation-summary.ts:174-205` (the `buildConfirmationSummary` body)
- Test: `apps/daemon/src/workflows/orchestrator/confirmation-summary.test.ts`

**Interfaces:**
- Consumes: `WorkflowStepOutputField.display` (Task 1); `ConfirmationSummary.details` (Task 2).
- Produces: `buildConfirmationSummary(...)` returns `details` only when at least one field routed there. Signature is otherwise unchanged — all six existing parameters and their order stay exactly as they are.

**Background the implementer needs:** this function is called from two places, both in `apps/daemon/src/activities/projection.ts` (lines 149 and 238), and both read the step's `outputSchema` from a query that joins `workflow_step_runs` to `workflow_templates` **by `template_id` only** (`LEFT JOIN workflow_templates wt ON wt.id = wr.template_id`) — no `template_version` filter, so this is always the template's **current, live** schema, not a per-run snapshot. What the `legacy` rule below protects is a schema with **no** `display` field anywhere — i.e. an unannotated template (duplicated via `duplicateTemplate`, custom, or a built-in template not yet annotated) — so its card still renders full-face instead of emptying out. *(Corrected 2026-08-31: this paragraph originally claimed the schema is snapshotted into `steps_json` per run and that the rule protects run history. Verified false by reading `projection.ts:160-230`; confirmed live against a completed goal whose history rendered in the new split format after its template was annotated.)*

- [ ] **Step 1: Write the failing tests**

Append to `apps/daemon/src/workflows/orchestrator/confirmation-summary.test.ts`:

```ts
describe("display audience routing", () => {
  const annotated: WorkflowStepOutputSchema = [
    { key: "problem", type: "string", required: true, display: "user" },
    { key: "rationale", type: "string", required: true, display: "user" },
    { key: "known_files", type: "array", itemType: "string", required: false, display: "agent" },
    { key: "codebase_state", type: "string", required: true, display: "agent" },
    // No `display` — inside an annotated schema the `agent` default applies.
    { key: "risks", type: "array", itemType: "string", required: false },
  ];

  const block = {
    problem: "Card is too loud",
    rationale: "Intent is undefined",
    known_files: ["a.ts", "b.ts"],
    codebase_state: "existing_ungrounded",
    risks: ["scope is unbounded"],
  };

  it("puts user fields on the face and agent fields (incl. unannotated) in details", () => {
    const out = buildConfirmationSummary(annotated, block, null, null);
    expect(out.fields).toEqual([
      { label: "Problem", value: "Card is too loud" },
      { label: "Rationale", value: "Intent is undefined" },
    ]);
    expect(out.details).toEqual([
      { label: "Known files", value: ["a.ts", "b.ts"] },
      { label: "Codebase state", value: "existing_ungrounded" },
      { label: "Risks", value: ["scope is unbounded"] },
    ]);
  });

  it("treats a schema with no audience anywhere as all-user and omits details", () => {
    const legacy: WorkflowStepOutputSchema = [
      { key: "problem", type: "string", required: true },
      { key: "known_files", type: "array", itemType: "string", required: false },
    ];
    const out = buildConfirmationSummary(legacy, block, null, null);
    expect(out.fields).toEqual([
      { label: "Problem", value: "Card is too loud" },
      { label: "Known files", value: ["a.ts", "b.ts"] },
    ]);
    expect(out.details).toBeUndefined();
  });

  it("keeps the splitter relabel on the face when the branch field is user", () => {
    const schema: WorkflowStepOutputSchema = [
      { key: "recommended_tier", type: "string", required: true, display: "user" },
      { key: "known_files", type: "array", itemType: "string", required: false, display: "agent" },
    ];
    const out = buildConfirmationSummary(
      schema,
      { recommended_tier: "clarify_first", known_files: ["a.ts"] },
      null,
      null,
      { branchKey: "recommended_tier", branchToName: { clarify_first: "Clarify" } }
    );
    expect(out.fields).toEqual([{ label: "Recommended step", value: "Clarify" }]);
    expect(out.details).toEqual([{ label: "Known files", value: ["a.ts"] }]);
  });

  it("routes a nested object's rows to its parent's target", () => {
    const schema: WorkflowStepOutputSchema = [
      {
        key: "decision", type: "object", required: true, display: "agent",
        fields: [
          { key: "tier", type: "string", required: true },
          { key: "reason", type: "string", required: true },
        ],
      },
    ];
    const out = buildConfirmationSummary(
      schema,
      { decision: { tier: "clarify_first", reason: "vague" } },
      null,
      null
    );
    expect(out.fields).toEqual([]);
    expect(out.details).toEqual([
      { label: "Decision · Tier", value: "clarify_first" },
      { label: "Decision · Reason", value: "vague" },
    ]);
  });
});
```

Note: `WorkflowStepOutputSchema` and `buildConfirmationSummary` are already imported at the top of this test file (lines 1-4). `describe`, `it`, `expect` likewise.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/daemon test -- confirmation-summary`
Expected: FAIL — `out.details` is `undefined` in the first test because the builder still pushes everything into `fields`.

- [ ] **Step 3: Write minimal implementation**

In `apps/daemon/src/workflows/orchestrator/confirmation-summary.ts`, replace the body of `buildConfirmationSummary` from `const obj = ...` through the `return` with:

```ts
  const obj = (block ?? {}) as Record<string, unknown>;
  const fields: CardField[] = [];
  const details: CardField[] = [];
  // A schema in which NO top-level field declares an audience is an unannotated
  // template — custom, not yet annotated, or a duplicate whose schema was later
  // edited in the desktop UI (which doesn't round-trip `display`; a fresh
  // duplicate keeps its annotations verbatim). (The schema here is always read
  // from the template's live row, not a per-run snapshot, so this is about the
  // template, not the run's age.) Treat all of it as `user` so its card renders
  // full-face instead of silently emptying — every field would otherwise
  // default to `agent` and fold behind the disclosure, leaving nothing but the
  // lead.
  const legacy = !outputSchema.some((f) => f.display !== undefined);
  for (const field of outputSchema) {
    if (field.key === "_completion") continue;
    const target = legacy || field.display === "user" ? fields : details;
    // A field that feeds a downstream splitter (e.g. Triage's `recommended_tier`)
    // is a routing decision; show the destination step's name instead of the raw
    // branch token so the user reads "Recommended step: Proposal", not the tier.
    if (routing && field.key === routing.branchKey) {
      const raw = obj[field.key];
      const name = typeof raw === "string" ? routing.branchToName[raw.trim()] : undefined;
      if (name) {
        target.push({ label: "Recommended step", value: name });
        continue;
      }
    }
    flattenField(field, obj[field.key], "", 1, target);
  }
  const lead = confirmationLead(scoring?.reason, proposal, refute ?? null);
  return {
    lead,
    fields: fields.slice(0, 32),
    ...(details.length > 0 ? { details: details.slice(0, 32) } : {}),
    scoring,
    refute: refute ?? null,
    ...(evidence !== undefined ? { evidence: buildEvidenceBundle(evidence) } : {}),
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- confirmation-summary`
Expected: PASS — the four new tests plus every pre-existing test in the file (they all use unannotated schemas, so the `legacy` rule keeps them on the face).

- [ ] **Step 5: Run the wider daemon suite for regressions**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS. Pay attention to `apps/daemon/src/activities/` tests — they exercise the two projection call sites.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/confirmation-summary.ts apps/daemon/src/workflows/orchestrator/confirmation-summary.test.ts
git commit -m "feat(daemon): route confirm-card fields by display audience"
```

---

### Task 4: Render the disclosure on the confirm card

**Files:**
- Modify: `apps/desktop/src/orchestrator/ActivityThread.tsx:105-120`
- Modify: `apps/desktop/src/orchestrator/orca-chat.css` (append near line 1175, beside `.step-confirm-field` rules)
- Test: `apps/desktop/src/orchestrator/ActivityThread.test.tsx`

**Interfaces:**
- Consumes: `ConfirmationSummary.details` (Task 2).
- Produces: a `data-testid="step-confirm-brief"` disclosure element. No exported symbols; `ConfirmFieldList` is module-local.

- [ ] **Step 1: Write the failing tests**

The test file already defines a `confirmActivity` fixture with a `confirmationSummary` (around line 261). Add a new `describe` block beside the `describe("refute advisory (5.4 L4)", ...)` block at line 292, using the same `render(<LiveActivity activity={...} />)` pattern those tests use (there is no shared render helper in this file):

```ts
describe("agent-audience brief disclosure", () => {
  it("folds details behind a disclosure that names the count", () => {
    render(
      <LiveActivity
        activity={{
          ...confirmActivity,
          confirmationSummary: {
            ...confirmActivity.confirmationSummary,
            fields: [{ label: "Recommended step", value: "Clarify" }],
            details: [
              { label: "Known files", value: ["docs/cara.md"] },
              { label: "Codebase state", value: "existing_ungrounded" },
            ],
          },
        }}
      />,
    );
    const brief = screen.getByTestId("step-confirm-brief");
    expect(brief).toHaveTextContent("Brief for the next step (2)");
    expect(brief).toHaveTextContent("Known files");
    expect(brief).toHaveTextContent("Codebase state");
    // The decision still reads on the card face.
    expect(screen.getByText("Recommended step")).toBeInTheDocument();
  });

  it("renders no disclosure when there are no details", () => {
    render(
      <LiveActivity
        activity={{
          ...confirmActivity,
          confirmationSummary: {
            ...confirmActivity.confirmationSummary,
            fields: [{ label: "Problem", value: "x" }],
          },
        }}
      />,
    );
    expect(screen.queryByTestId("step-confirm-brief")).toBeNull();
  });
});
```

Note: `<details>` content is present in the DOM even when collapsed, so `toHaveTextContent` works without expanding it — no click needed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/desktop test -- ActivityThread`
Expected: FAIL — `Unable to find an element by: [data-testid="step-confirm-brief"]`.

- [ ] **Step 3: Extract the field list into a reusable component**

In `apps/desktop/src/orchestrator/ActivityThread.tsx`, add above the component that currently contains line 105:

```tsx
function ConfirmFieldList({
  fields,
}: {
  fields: NonNullable<Activity["confirmationSummary"]>["fields"];
}) {
  return (
    <dl className="step-confirm-fields">
      {fields.map((f, i) => (
        <div key={i} className="step-confirm-field">
          <dt>{f.label}</dt>
          <dd>
            {Array.isArray(f.value) ? (
              <ul>{f.value.map((v, j) => <li key={j}>{v}</li>)}</ul>
            ) : (
              f.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
```

- [ ] **Step 4: Replace lines 105-120 with the list plus the disclosure**

```tsx
      {summary.fields.length > 0 ? <ConfirmFieldList fields={summary.fields} /> : null}
      {/* Fields the schema marks `display: "agent"` — handoff payload for the
          next step, not review material for the human. Folded, never dropped;
          the count makes it evident nothing was lost. */}
      {summary.details && summary.details.length > 0 ? (
        <details className="step-confirm-brief" data-testid="step-confirm-brief">
          <summary className="step-confirm-brief-summary">
            <span>Brief for the next step ({summary.details.length})</span>
          </summary>
          <ConfirmFieldList fields={summary.details} />
        </details>
      ) : null}
```

- [ ] **Step 5: Add the styles**

Append to `apps/desktop/src/orchestrator/orca-chat.css` after the `.step-confirm-field ul` rule (line 1175), mirroring the existing `.step-confirm-selfassess` disclosure at line 1238:

```css
.step-confirm-brief { margin: 0 0 16px; }
.step-confirm-brief-summary {
  cursor: pointer; font-size: 11px; color: var(--text-3);
  display: flex; align-items: baseline; gap: 8px;
}
.step-confirm-brief-summary::-webkit-details-marker { color: var(--text-4); }
.step-confirm-brief .step-confirm-fields { margin: 12px 0 0; }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @orca/desktop test -- ActivityThread`
Expected: PASS — both new tests plus every pre-existing confirm-card test (the extraction is behavior-preserving for `fields`).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/orchestrator/ActivityThread.tsx apps/desktop/src/orchestrator/orca-chat.css apps/desktop/src/orchestrator/ActivityThread.test.tsx
git commit -m "feat(desktop): fold agent-audience fields behind a confirm-card disclosure"
```

---

### Task 5: Annotate all 98 catalog fields and bump the seven template versions

**Files:**
- Modify: `apps/daemon/src/workflows/templates/catalog.ts` (step arrays at lines 68, 338, 444, 519, 595, 684, 726; template versions at lines 816-858)
- Test: `apps/daemon/src/workflows/templates/catalog.test.ts`

**Interfaces:**
- Consumes: `WorkflowStepOutputField.display` (Task 1); the routing behavior verified in Task 3.
- Produces: no new symbols — data-only changes to `BUILTIN_TEMPLATE_CATALOG`.

**What "annotate" means here:** add `display: "user"` (or `"agent"` for Triage's five) to each **top-level** `outputSchema` entry, e.g.

```ts
{ key: "problem", type: "string", required: true, display: "user" },
{ key: "known_files", type: "array", itemType: "string", required: false, display: "agent" },
```

Do **not** add `display` to any field inside a `fields: [...]` block — those are nested subfields and the key is inert there.

- [ ] **Step 1: Write the failing tests**

Append to `apps/daemon/src/workflows/templates/catalog.test.ts`:

```ts
describe("output field display audience", () => {
  const allSteps = BUILTIN_TEMPLATE_CATALOG.flatMap((t) => t.steps);

  it("annotates every top-level output field in every template", () => {
    const unannotated: string[] = [];
    for (const step of allSteps) {
      for (const f of step.outputSchema) {
        if (f.display === undefined) unannotated.push(`${step.id}.${f.key}`);
      }
    }
    expect(unannotated).toEqual([]);
  });

  it("leaves nested subfields unannotated — they inherit their parent's target", () => {
    const annotatedNested: string[] = [];
    for (const step of allSteps) {
      for (const f of step.outputSchema) {
        for (const child of f.fields ?? []) {
          if (child.display !== undefined) annotatedNested.push(`${step.id}.${f.key}.${child.key}`);
        }
      }
    }
    expect(annotatedNested).toEqual([]);
  });

  it("shows Triage's decision and folds its provisional brief", () => {
    const triage = allSteps.find((s) => s.id === "triage")!;
    const audience = Object.fromEntries(triage.outputSchema.map((f) => [f.key, f.display]));
    expect(audience).toEqual({
      problem: "user",
      success_outcome: "user",
      recommended_tier: "user",
      rationale: "user",
      constraints: "agent",
      known_files: "agent",
      risks: "agent",
      has_product_intent: "agent",
      codebase_state: "agent",
    });
  });

  it("bumps every template version so the annotated schemas actually install", () => {
    const versions = Object.fromEntries(BUILTIN_TEMPLATE_CATALOG.map((t) => [t.id, t.version]));
    expect(versions).toEqual({
      "orca/adaptive-delivery": 15,
      "orca/bug-triage-fix": 5,
      "orca/code-review": 4,
      "orca/refactor": 4,
      "orca/quality-coverage": 4,
      "orca/scope-brief": 2,
      "orca/scoped-delivery": 2,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/daemon test -- catalog`
Expected: FAIL — the first test lists all 98 fields as unannotated; the version test reports the current `14, 4, 3, 3, 3, 1, 1`.

- [ ] **Step 3: Annotate `ADAPTIVE_STEPS` (line 68)**

Exact top-level keys per step, in schema order:

- `triage` — `problem` **user**, `success_outcome` **user**, `constraints` **agent**, `known_files` **agent**, `risks` **agent**, `has_product_intent` **agent**, `codebase_state` **agent**, `recommended_tier` **user**, `rationale` **user**
- `clarify` — `problem`, `success_outcome`, `constraints`, `open_questions` — all **user**
- `research` — `summary`, `files_in_scope`, `risks` — all **user**
- `proposal` — `summary`, `approaches`, `recommendation`, `chosen_approach`, `task_plan` — all **user**
- `execution` — `summary`, `completed_requirements`, `changes`, `validation`, `artifacts`, `risks`, `blockers`, `assumptions`, `handoff` — all **user**
- `done` — `summary`, `delivered_requirements`, `validation_evidence`, `operational_artifacts`, `limitations`, `follow_up_work`, `blockers`, `handoff` — all **user**

- [ ] **Step 4: Annotate the remaining six step arrays — all fields `display: "user"`**

- `BUGFIX_STEPS` (line 338): `root_cause` — `summary`, `repro_steps`, `failing_evidence`, `root_cause`, `evidence`, `open_questions` · `pattern_analysis` — `summary`, `working_examples`, `differences` · `hypothesis` — `summary`, `hypothesis`, `failing_test` · `implementation` — `summary`, `changed_files`, `validation` · `done` — `summary`, `resolution`, `regression_evidence`, `open_questions`, `handoff`
- `CODE_REVIEW_STEPS` (line 444): `analyze_diff` — `summary`, `findings` · `risk_pass` — `summary`, `risks` · `report` — `summary`, `verdict`, `change_requests` · `done` — `summary`, `verdict`, `follow_up`, `handoff`
- `REFACTOR_STEPS` (line 519): `map_blast_radius` — `summary`, `affected`, `characterization` · `restructure` — `summary`, `changed_files`, `increments` · `behavior_parity` — `summary`, `checks`, `verdict` · `done` — `summary`, `residual_risks`, `handoff`
- `QUALITY_COVERAGE_STEPS` (line 595): `find_gaps` — `summary`, `gaps` · `generate_checks` — `summary`, `added`, `negative_evidence` · `confirm_green` — `summary`, `results`, `delta` · `done` — `summary`, `gaps_closed`, `handoff`
- `SCOPE_BRIEF_STEPS` (line 684): `draft` — `notes`, `risks` · `done` — `brief`
- `SCOPED_DELIVERY_STEPS` (line 726): `intake` — `goal_area` · `deliver` — `summary`, `outcome`

- [ ] **Step 5: Bump the seven template versions (lines 816-858)**

`orca/adaptive-delivery` 14 → **15**, `orca/bug-triage-fix` 4 → **5**, `orca/code-review` 3 → **4**, `orca/refactor` 3 → **4**, `orca/quality-coverage` 3 → **4**, `orca/scope-brief` 1 → **2**, `orca/scoped-delivery` 1 → **2**.

Add a `v15:` note to the adaptive-delivery comment block, matching the house style of the existing `v10:`–`v14:` entries:

```ts
    // v15: every top-level output field declares a `display` audience. Triage's
    // provisional brief (constraints, known_files, risks, has_product_intent,
    // codebase_state) is `agent` — it folds behind the confirm card's disclosure
    // because it is handoff fuel for the next step, not the routing decision the
    // human is confirming. Every other field is `user`, preserving today's cards.
```

- [ ] **Step 6: Verify installed versions before trusting the bump**

The `v10:` comment in `catalog.ts` records a prior incident: a learning-applied proposal had already written version 7 onto a live installation, so the change had to publish as 8. The boot upgrade installs a template only when the catalog version **exceeds** the installed one.

Run against the live daemon's database (the daemon runs in the `daemon-terminal` tmux session):

```bash
sqlite3 ~/.orca/orca.db "SELECT id, version FROM workflow_templates ORDER BY id;"
```

**Checked at planning time (2026-08-31), this returned exactly one row:**

```
orca/adaptive-delivery|14
```

So on this machine only Adaptive Delivery is installed, at 14 — safely below the 15 set in Step 5, and no forward-version incident to work around. The other six templates have **no row at all**, so their bumps cannot regress anything here; they matter for installations that do carry them.

If the query returns a version greater than or equal to what Step 5 sets, raise the catalog value above the installed one **and** update the version test in Step 1 to match. Do not silently ship a version that will not install.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- catalog`
Expected: PASS — all four new tests.

- [ ] **Step 8: Run the full daemon suite**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS. `catalog.triage-greenfield.test.ts`, `validate-graph.test.ts`, and `usecases.builtins.test.ts` all read these schemas; a stray `display` on a nested field or a malformed entry surfaces here.

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/src/workflows/templates/catalog.ts apps/daemon/src/workflows/templates/catalog.test.ts
git commit -m "feat(daemon): declare a display audience on every catalog output field"
```

---

### Task 6: Full verification and live check

**Files:** none modified unless a failure is found.

- [ ] **Step 1: Typecheck the monorepo**

Run: `pnpm typecheck`
Expected: exit 0

- [ ] **Step 2: Run every package's tests**

Run: `pnpm test`
Expected: all suites pass.

- [ ] **Step 3: Verify the real card in the browser**

Start the app: `pnpm dev:browser` (prints its Local URL). Drive it with the `mcp__playwright__*` tools.

Restart the daemon first so the v15 catalog installs, then start an Adaptive Delivery run and let Triage reach its confirmation pause. Confirm on screen:

1. The card face shows **Problem**, **Success outcome**, **Recommended step**, **Rationale** — and nothing else.
2. A **"Brief for the next step (5)"** disclosure sits below it.
3. Expanding it reveals Constraints, Known files, Risks, Has product intent, Codebase state.
4. ~~An older run's Triage card, opened from history, still shows all nine rows on its face — the `legacy` rule doing its job on a pre-`display` snapshot.~~ **Investigated and invalid (2026-08-31):** this check's premise is wrong. `buildConfirmationSummary`'s callers (`apps/daemon/src/activities/projection.ts:149,238`) join to `workflow_templates` by `template_id` only, not `template_version` — there is no per-run snapshot. Once Triage's live template row is upgraded to v15, an older Triage run opened from history renders in the **new split format** (four rows on the face, five behind the disclosure), the same as an in-flight run — it does not keep showing all nine rows. Confirmed live against a completed "Script Studio" goal.

- [ ] **Step 4: Commit any fixes, then report**

If steps 1-3 surfaced nothing, there is nothing to commit. Report the branch state and the four observations from Step 3.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §4.1 `display` on `WorkflowStepOutputField` | Task 1 |
| §4.1 `details` on `ConfirmationSummary` (via extracted `CardField`) | Task 2 |
| §4.2 audience routing + `legacy` back-compat rule | Task 3 |
| §4.3 desktop disclosure, count in the summary, CSS | Task 4 |
| §4.4 annotate 98 top-level fields; leave 31 nested unannotated | Task 5, Steps 3-4 |
| §4.5 seven version bumps + verify installed versions first | Task 5, Steps 5-6 |
| §5 testing (builder, contracts, catalog, desktop) | Tasks 1-5, each Step 1 |
| §6 shared-worktree staging discipline | Global Constraints; every commit stages explicit paths |

No gaps.

**Placeholder scan:** every code step carries real code. Both the desktop render pattern (`render(<LiveActivity activity={...} />)`, no shared helper) and the live template versions (one row, `orca/adaptive-delivery|14`) were verified against the repo and the live DB at planning time rather than left as instructions to go look. One step remains deliberately conditional: Task 5 Step 6 raises a version if the live DB ever holds a higher one — it states the exact check and the exact corrective action.

**Type consistency:** `display` is `"user" | "agent"` in Tasks 1, 3, and 5. `details` is `Array<{label, value}>`, optional, in Tasks 2, 3, and 4. `ConfirmFieldList` takes `fields` and is used for both arrays in Task 4. The builder's parameter list is unchanged, so the two `apps/daemon/src/activities/projection.ts` call sites need no edit — which is why that file appears in no task.
