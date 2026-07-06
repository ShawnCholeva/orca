# SP2 — Check Proposals + Panel Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the learning loop its second revision target — R4 diagnoses propose deterministic output-schema tightenings — and bring the Self-improvement panel to full fidelity (diff modal, honest confidence, falsifier + canary lines).

**Architecture:** Spec: `docs/superpowers/specs/2026-07-06-sp2-design.md`. Control-plane only: one additive migration (0055 `component` column), contract widenings, a pure whitelist validator, deterministic R4→schema routing in `diagnose.ts`, a schema branch in the privileged apply path, component framing in the judge prompt, two new per-step version-delta projections, and a UI pass over `SelfImprovement.tsx`. The broker reuses the existing `propose_instruction_revision` kind (payload opaque to transport; validation is caller-supplied).

**Tech Stack:** TypeScript, zod contracts, better-sqlite3 migrations, vitest, React.

## Global Constraints

- **Zero jargon** in rendered copy: `/\b(oracle|sensor|verdict|refute|veto)\b/i` must not match any new user-facing string.
- **Whitelist (spec §3.3), enforced deterministically:** allowed = add field (required or optional), optional→required, add/extend `description`; banned = delete, rename, `type`/`itemType` change, any `enum` alteration, required→optional.
- **Canonical schema serialization:** `JSON.stringify(schema, null, 2)` — one helper, everywhere.
- **Deterministic routing:** R4 → `step_output_schema`; R1/R2/R3 → `step_instructions`. The LLM never picks the component.
- **No LLM calls in any read path.** Score/canary stay pure projections.
- **Constants:** `SCHEMA_INVALID_OUTPUT_THRESHOLD = 0.2` (in `canary.ts` beside `REGRESSION_THRESHOLD`); `VERSION_MIN` (aggregate.ts) gates both new deltas.
- **Repo gotchas:** after editing `packages/contracts`, run `pnpm --filter @orca/contracts build` before daemon tsc. A new migration id must be appended to the hardcoded lists in `apps/daemon/src/migrations.test.ts`, `apps/daemon/src/migrations/suggested-orchestration.test.ts`, and `apps/daemon/test/migrations-0006.test.ts` (recurring snapshot debt).
- Test commands: `pnpm -C apps/daemon test`, `pnpm -C apps/desktop test`, `pnpm -C packages/contracts test`; single file via trailing path arg.
- Every commit ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Report files: task-N-report.md files may hold stale prior-project content — always overwrite fresh.

---

### Task 1: Contracts + migration 0055 + store round-trip

**Files:**
- Modify: `packages/contracts/src/learning/index.ts`
- Modify: `packages/contracts/src/metrics/index.ts` (StepMetrics)
- Create: `apps/daemon/migrations/0055_proposal_component.sql`
- Modify: `apps/daemon/src/migrations.ts` (register 0055 after 0054, follow the existing registration pattern)
- Modify: `apps/daemon/src/learning/store.ts:4-43` (Row, rowToProposal, insertProposal)
- Test: `packages/contracts/src/learning/index.test.ts` (or the file where learning contract tests live — extend, don't create a duplicate), `apps/daemon/src/learning/store.test.ts`, the three migration snapshot-list tests

**Interfaces:**
- Produces (later tasks depend on these exact names):
  - `ProposalComponent = z.enum(["step_instructions", "step_output_schema"])` (exported)
  - `TemplateInstructionProposal.component: ProposalComponent` + superRefine: when `component === "step_output_schema"`, both `beforeInstructions` and `afterInstructions` must `JSON.parse` and pass `WorkflowStepOutputSchema.safeParse`
  - `ProposeSchemaRevisionProposal = z.object({ proposedOutputSchema: WorkflowStepOutputSchema, predictedImprovement: z.string().min(1), invariantsPreserved: z.array(DimensionKey), rationale: z.string().min(1).max(2000) }).strict()`
  - `JudgeInstructionEditRequest.step` gains `component: ProposalComponent.optional()`
  - `StepMetrics.versionInvalidOutputRateDelta: z.number().nullable()` (required, like `versionScoreDelta`)
  - `TemplateInstructionProposal` enriched-only optional fields: `invalidOutputRateDelta: z.number().nullable().optional()`, `targetDeltaVersions: z.object({ latest: z.number().int(), prior: z.number().int() }).strict().nullable().optional()`
  - Store: `insertProposal` persists `component`; `rowToProposal` reads it (defaulting handled by the column default)

- [ ] **Step 1: Write failing contract tests** (extend the learning contract test file):

```ts
import { TemplateInstructionProposal, ProposeSchemaRevisionProposal } from "./index.js";

const baseProposal = { /* copy an existing valid TemplateInstructionProposal fixture from this test file */ };

it("accepts a step_output_schema proposal whose before/after parse as schemas", () => {
  const schema = JSON.stringify([{ key: "summary", type: "string", required: true }], null, 2);
  const tighter = JSON.stringify([
    { key: "summary", type: "string", required: true },
    { key: "evidence_refs", type: "array", itemType: "string", required: true },
  ], null, 2);
  const p = TemplateInstructionProposal.parse({ ...baseProposal, component: "step_output_schema", beforeInstructions: schema, afterInstructions: tighter });
  expect(p.component).toBe("step_output_schema");
});

it("rejects a step_output_schema proposal whose afterInstructions is not a schema", () => {
  const schema = JSON.stringify([{ key: "summary", type: "string", required: true }], null, 2);
  const r = TemplateInstructionProposal.safeParse({ ...baseProposal, component: "step_output_schema", beforeInstructions: schema, afterInstructions: "just prose" });
  expect(r.success).toBe(false);
});

it("step_instructions proposals do not schema-validate their text", () => {
  const p = TemplateInstructionProposal.parse({ ...baseProposal, component: "step_instructions" });
  expect(p.component).toBe("step_instructions");
});

it("ProposeSchemaRevisionProposal round-trips", () => {
  const r = ProposeSchemaRevisionProposal.parse({
    proposedOutputSchema: [{ key: "risks", type: "array", itemType: "string", required: true }],
    predictedImprovement: "forces risk disclosure", invariantsPreserved: ["verificationStrength"], rationale: "weak-oracle step",
  });
  expect(r.proposedOutputSchema).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm -C packages/contracts test -- src/learning`
Expected: FAIL — `component` rejects the new enum value; `ProposeSchemaRevisionProposal` not exported.

- [ ] **Step 3: Implement contracts.** In `packages/contracts/src/learning/index.ts` (import `WorkflowStepOutputSchema` from `../workflows/output-schema.js`):

```ts
export const ProposalComponent = z.enum(["step_instructions", "step_output_schema"]);
export type ProposalComponent = z.infer<typeof ProposalComponent>;

export const ProposeSchemaRevisionProposal = z.object({
  proposedOutputSchema: WorkflowStepOutputSchema,
  predictedImprovement: z.string().min(1),
  invariantsPreserved: z.array(DimensionKey),
  rationale: z.string().min(1).max(2000),
}).strict();
export type ProposeSchemaRevisionProposal = z.infer<typeof ProposeSchemaRevisionProposal>;

function parsesAsSchema(text: string): boolean {
  try { return WorkflowStepOutputSchema.safeParse(JSON.parse(text)).success; } catch { return false; }
}
```

In `TemplateInstructionProposal`: `component: ProposalComponent` (replacing the literal), add the two enriched optional fields next to `targetDelta`/`targetImproved`, and wrap the object in:

```ts
.superRefine((p, ctx) => {
  if (p.component !== "step_output_schema") return;
  if (!parsesAsSchema(p.beforeInstructions)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["beforeInstructions"], message: "step_output_schema proposal: beforeInstructions must be a serialized output schema" });
  if (!parsesAsSchema(p.afterInstructions)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["afterInstructions"], message: "step_output_schema proposal: afterInstructions must be a serialized output schema" });
});
```

(If `TemplateInstructionProposal` is referenced with `.parse` on an object type elsewhere, note zod `.superRefine` returns a ZodEffects — downstream `.optional()`/`.nullable()` uses still work; `z.infer` type is unchanged.)

`JudgeInstructionEditRequest.step`: add `component: ProposalComponent.optional()`.
`packages/contracts/src/metrics/index.ts`: after `versionScoreDeltaVersions`, add:

```ts
  // Latest-vs-prior version delta of the step's invalid-output completion rate.
  // The schema-canary signal: a too-tight learned schema shows up here first.
  versionInvalidOutputRateDelta: z.number().nullable(),
```

- [ ] **Step 4: Migration.** Create `apps/daemon/migrations/0055_proposal_component.sql`:

```sql
-- SP2: proposals gain a second revision target (step_output_schema). Additive.
ALTER TABLE template_instruction_proposals ADD COLUMN component TEXT NOT NULL DEFAULT 'step_instructions';
```

Register in `apps/daemon/src/migrations.ts` following the 0054 entry's exact pattern. Append `0055_proposal_component` to the hardcoded lists in all three snapshot tests (Global Constraints).

- [ ] **Step 5: Store round-trip.** `store.ts`: add `component: string` to `Row`; `rowToProposal` uses `component: r.component` (line 16); `insertProposal` adds the column + value. Extend `store.test.ts` with a round-trip of a `step_output_schema` proposal (serialized schemas in before/after) asserting `component` survives.

- [ ] **Step 6: Run everything**

Run: `pnpm -C packages/contracts test && pnpm --filter @orca/contracts build && pnpm -C apps/daemon test -- src/learning src/migrations.test.ts src/migrations test/migrations-0006.test.ts && pnpm -C apps/daemon exec tsc --noEmit`
Expected: PASS. Fixture ripple: any test building a `TemplateInstructionProposal` literal already carries `component: "step_instructions"`? No — the type previously required the literal, so fixtures carry it; the enum widening is source-compatible. `StepMetrics` fixtures need `versionInvalidOutputRateDelta: null` added (daemon `diagnose.test.ts`/`canary.test.ts`, desktop fixtures break later — desktop is Task 7's problem; if desktop tsc must stay green per-task, add the field to desktop fixtures now, additively).

- [ ] **Step 7: Commit**

```bash
git add packages/contracts apps/daemon/migrations/0055_proposal_component.sql apps/daemon/src/migrations.ts apps/daemon/src/learning/store.ts apps/daemon/src/learning/store.test.ts apps/daemon/src/migrations.test.ts apps/daemon/src/migrations/suggested-orchestration.test.ts apps/daemon/test/migrations-0006.test.ts
git commit -m "feat(contracts,learning): step_output_schema proposal component — enum, migration 0055, store round-trip

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Also `git add` any fixture files touched in Step 6.)

---

### Task 2: The mutation-operator whitelist (`schema-mutation.ts`)

**Files:**
- Create: `apps/daemon/src/learning/schema-mutation.ts`
- Test: `apps/daemon/src/learning/schema-mutation.test.ts`

**Interfaces:**
- Produces:
  - `serializeSchema(s: WorkflowStepOutputSchema): string` — the ONE canonical serializer (`JSON.stringify(s, null, 2)`)
  - `parseSchema(text: string): WorkflowStepOutputSchema | null` — JSON.parse + zod, null on any failure
  - `validateSchemaTightening(before: WorkflowStepOutputSchema, after: WorkflowStepOutputSchema): { ok: true } | { ok: false; errors: string[] }`

- [ ] **Step 1: Write the failing table-driven test:**

```ts
import { describe, expect, it } from "vitest";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { parseSchema, serializeSchema, validateSchemaTightening } from "./schema-mutation.js";

const base: WorkflowStepOutputSchema = [
  { key: "summary", type: "string", required: true },
  { key: "tier", type: "string", required: true, enum: ["fast", "full"] },
  { key: "notes", type: "string", required: false },
];

const ok = (after: WorkflowStepOutputSchema) => expect(validateSchemaTightening(base, after)).toEqual({ ok: true });
const bad = (after: WorkflowStepOutputSchema, needle: string) => {
  const r = validateSchemaTightening(base, after);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toContain(needle);
};

describe("validateSchemaTightening", () => {
  it("allows adding a field (required or optional)", () => {
    ok([...base, { key: "evidence_refs", type: "array", itemType: "string", required: true }]);
    ok([...base, { key: "caveats", type: "string", required: false }]);
  });
  it("allows optional→required", () => {
    ok(base.map((f) => f.key === "notes" ? { ...f, required: true } : f));
  });
  it("allows adding/extending a description", () => {
    ok(base.map((f) => f.key === "summary" ? { ...f, description: "one paragraph" } : f));
  });
  it("bans deleting a field", () => bad(base.filter((f) => f.key !== "notes"), "removed"));
  it("bans renaming (delete+add manifests as a removal)", () =>
    bad(base.map((f) => f.key === "notes" ? { ...f, key: "remarks" } : f), "removed"));
  it("bans type changes", () => bad(base.map((f) => f.key === "notes" ? { ...f, type: "number" as const } : f), "type"));
  it("bans enum alteration — narrowing, widening, or removal", () => {
    bad(base.map((f) => f.key === "tier" ? { ...f, enum: ["fast"] } : f), "enum");
    bad(base.map((f) => f.key === "tier" ? { ...f, enum: ["fast", "full", "turbo"] } : f), "enum");
    bad(base.map((f) => { if (f.key !== "tier") return f; const { enum: _e, ...rest } = f; return rest; }), "enum");
  });
  it("bans required→optional (weakening)", () =>
    bad(base.map((f) => f.key === "summary" ? { ...f, required: false } : f), "optional"));
  it("recurses into nested object fields with the same rules", () => {
    const nestedBase: WorkflowStepOutputSchema = [
      { key: "plan", type: "object", required: true, fields: [{ key: "goal", type: "string", required: true }] },
    ];
    const removedNested: WorkflowStepOutputSchema = [
      { key: "plan", type: "object", required: true, fields: [] as never },
    ];
    // dropping a nested field is a removal
    const r = validateSchemaTightening(nestedBase, [{ key: "plan", type: "object", required: true, fields: [{ key: "why", type: "string", required: true }] }]);
    expect(r.ok).toBe(false);
    void removedNested;
  });
  // Spec success criterion 3: composition safety — every op that could break a
  // splitter branchKey (key identity + enum values) or a delegate writes mapping
  // (key identity) is banned above. This test documents the guarantee directly:
  it("composition contract: keys and enum values present before are present after, under any accepted edit", () => {
    const accepted: WorkflowStepOutputSchema = [
      ...base.map((f) => f.key === "notes" ? { ...f, required: true } : f),
      { key: "risks", type: "array" as const, itemType: "string" as const, required: true },
    ];
    expect(validateSchemaTightening(base, accepted)).toEqual({ ok: true });
    for (const before of base) {
      const after = accepted.find((f) => f.key === before.key)!;
      expect(after).toBeDefined();
      expect(after.type).toBe(before.type);
      expect(after.enum ?? null).toEqual(before.enum ?? null);
    }
  });
});

it("serializeSchema/parseSchema round-trip; parseSchema null on junk", () => {
  expect(parseSchema(serializeSchema(base))).toEqual(base);
  expect(parseSchema("not json")).toBeNull();
  expect(parseSchema('{"not":"a schema"}')).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm -C apps/daemon test -- src/learning/schema-mutation.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `schema-mutation.ts`:**

```ts
import { WorkflowStepOutputSchema, type WorkflowStepOutputField } from "@orca/contracts";

// The ONE canonical serialization for schemas riding proposal before/after fields.
export function serializeSchema(s: WorkflowStepOutputSchema): string {
  return JSON.stringify(s, null, 2);
}

export function parseSchema(text: string): WorkflowStepOutputSchema | null {
  try {
    const parsed = WorkflowStepOutputSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// The whitelisted mutation operator for learned schema edits (spec §3.3).
// Tightening only: additions and strictenings. Anything that could break a
// downstream reader (splitter branchKey, gate context, delegate writes) or
// weaken the check is banned — enforced here, deterministically, never by prompt.
export function validateSchemaTightening(
  before: WorkflowStepOutputSchema, after: WorkflowStepOutputSchema,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  checkFields(before, after, "", errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function checkFields(before: readonly WorkflowStepOutputField[], after: readonly WorkflowStepOutputField[], path: string, errors: string[]): void {
  const afterByKey = new Map(after.map((f) => [f.key, f]));
  for (const b of before) {
    const at = path ? `${path}.${b.key}` : b.key;
    const a = afterByKey.get(b.key);
    if (!a) { errors.push(`field "${at}" was removed — removing or renaming fields is not allowed`); continue; }
    if (a.type !== b.type) errors.push(`field "${at}" changed type ${b.type}→${a.type} — type changes are not allowed`);
    if ((a.itemType ?? null) !== (b.itemType ?? null)) errors.push(`field "${at}" changed its item type — not allowed`);
    if (JSON.stringify(a.enum ?? null) !== JSON.stringify(b.enum ?? null)) errors.push(`field "${at}" changed its enum — altering allowed values is not allowed`);
    if (b.required && !a.required) errors.push(`field "${at}" became optional — weakening a check is not allowed`);
    if (b.fields || a.fields) checkFields(b.fields ?? [], a.fields ?? [], at, errors);
  }
  // New fields in `after` are always allowed; the contract schema bounds them.
}
```

- [ ] **Step 4: Run** — same command → PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning/schema-mutation.ts apps/daemon/src/learning/schema-mutation.test.ts
git commit -m "feat(learning): deterministic schema-tightening whitelist (SP2 mutation operator)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: R4 routing + schema propose path

**Files:**
- Modify: `apps/daemon/src/learning/diagnose.ts` (DiagnosisBundle + component routing)
- Modify: `apps/daemon/src/learning/propose.ts` (payload + validator per component)
- Modify: `apps/daemon/src/learning/usecases.ts:40-47` (`stepInstructions` → `stepMeta` with outputSchema) and `analyzeTemplate` (proposal build per component)
- Test: `apps/daemon/src/learning/diagnose.test.ts`, `apps/daemon/src/learning/propose.test.ts`

**Interfaces:**
- Consumes: `ProposalComponent`, `ProposeSchemaRevisionProposal` (Task 1); `serializeSchema`, `parseSchema`, `validateSchemaTightening` (Task 2).
- Produces:
  - `DiagnosisBundle` gains `component: ProposalComponent` and `currentOutputSchemaJson: string` (canonical serialization of the step's current schema; `"[]"` when absent)
  - `diagnoseTemplate` input `stepInstructions: Map<string, string>` becomes `stepMeta: Map<string, { instructions: string; outputSchemaJson: string }>`
  - `buildProposePayload(bundle)` branches on component; `validateRevisionProposal(bundle)` (signature widened from `currentInstructions: string` to the bundle) returns the component-appropriate validator

- [ ] **Step 1: Failing tests.** In `diagnose.test.ts` (update the `instr` map fixture to the new `stepMeta` shape throughout the file):

```ts
const meta = new Map([["s1", { instructions: "Generate a proposal.", outputSchemaJson: '[\n  {\n    "key": "summary",\n    "type": "string",\n    "required": true\n  }\n]' }]]);

it("R4 routes to step_output_schema and carries the current schema", () => {
  const r4 = step({ score: 70, failureClusters: [], quality: { ...step().quality, verdictPassRate: 0.9, oracleSufficientRate: null } });
  const out = diagnoseTemplate({ detail: detail([r4]), signals: [], stepMeta: meta });
  expect(out).toHaveLength(1);
  expect(out[0].targetedFailureMode.rule).toBe("R4");
  expect(out[0].component).toBe("step_output_schema");
  expect(out[0].currentOutputSchemaJson).toContain('"summary"');
});

it("R1/R2/R3 keep step_instructions", () => {
  const r2 = step(); // existing fixture: invalid_output cluster of 8 → R2
  const out = diagnoseTemplate({ detail: detail([r2]), signals: [], stepMeta: meta });
  expect(out[0].component).toBe("step_instructions");
});
```

In `propose.test.ts`:

```ts
it("schema bundles produce a schema payload and a whitelist-enforcing validator", () => {
  const bundle = { /* reuse the file's bundle fixture */ , component: "step_output_schema" as const,
    currentOutputSchemaJson: serializeSchema([{ key: "summary", type: "string", required: true }]) };
  const payload = buildProposePayload(bundle);
  expect(payload.currentOutputSchema).toBe(bundle.currentOutputSchemaJson);
  expect(payload.instruction).toContain("tighten");

  const validate = validateRevisionProposal(bundle);
  const good = validate({ proposedOutputSchema: [
    { key: "summary", type: "string", required: true },
    { key: "evidence_refs", type: "array", itemType: "string", required: true },
  ], predictedImprovement: "x", invariantsPreserved: [], rationale: "y" });
  expect(good.accepted).toBe(true);

  const deletion = validate({ proposedOutputSchema: [{ key: "evidence_refs", type: "array", itemType: "string", required: true }],
    predictedImprovement: "x", invariantsPreserved: [], rationale: "y" });
  expect(deletion.accepted).toBe(false);
  if (!deletion.accepted) expect(deletion.failureMessage).toContain("removed");

  const noop = validate({ proposedOutputSchema: [{ key: "summary", type: "string", required: true }],
    predictedImprovement: "x", invariantsPreserved: [], rationale: "y" });
  expect(noop.accepted).toBe(false); // identical schema is a no-op
});
```

- [ ] **Step 2: Run to verify failures** — `pnpm -C apps/daemon test -- src/learning/diagnose.test.ts src/learning/propose.test.ts` → FAIL.

- [ ] **Step 3: Implement.**

`diagnose.ts` — add to imports: `import type { ProposalComponent } from "@orca/contracts";`. `DiagnosisBundle` gains `component: ProposalComponent; currentOutputSchemaJson: string;`. Rename input `stepInstructions` → `stepMeta: Map<string, { instructions: string; outputSchemaJson: string }>`. In the bundle build:

```ts
    const meta = input.stepMeta.get(step.stepTemplateId) ?? { instructions: "", outputSchemaJson: "[]" };
    // Deterministic routing (spec §3.2): R4 names a verification deficiency — the
    // lever is the deterministic completion validator, not the prompt. The core
    // owns which lever is pulled; the LLM only fills the content.
    const component: ProposalComponent = mode.rule === "R4" ? "step_output_schema" : "step_instructions";
    bundles.push({
      stepTemplateId: step.stepTemplateId,
      currentInstructions: meta.instructions,
      component,
      currentOutputSchemaJson: meta.outputSchemaJson,
      targetedFailureMode: mode,
      evidence: { /* unchanged */ },
    });
```

`usecases.ts` — replace `stepInstructions()`:

```ts
function stepMeta(db: Database.Database, templateId: string): Map<string, { instructions: string; outputSchemaJson: string }> {
  const row = db.prepare(`SELECT steps_json FROM workflow_templates WHERE id = ?`).get(templateId) as { steps_json: string } | undefined;
  const map = new Map<string, { instructions: string; outputSchemaJson: string }>();
  if (!row) return map;
  const steps = JSON.parse(row.steps_json) as { id: string; instructions?: string; outputSchema?: unknown }[];
  for (const s of steps) {
    map.set(s.id, { instructions: s.instructions ?? "", outputSchemaJson: JSON.stringify(s.outputSchema ?? [], null, 2) });
  }
  return map;
}
```

`analyzeTemplate` proposal build: `component: bundle.component`, and for schema bundles `beforeInstructions: bundle.currentOutputSchemaJson, afterInstructions: serializeSchema(fill.proposedOutputSchema)` (instructions bundles unchanged). The `fill` type becomes a union — parse per component (see propose.ts below); `predictedImprovement`/`invariantsPreserved`/`rationale` exist on both.

`propose.ts`:

```ts
import { ProposeInstructionRevisionProposal, ProposeSchemaRevisionProposal, type OrchestrationRequest } from "@orca/contracts";
import { parseSchema, serializeSchema, validateSchemaTightening } from "./schema-mutation.js";

const INSTRUCTION = /* existing text, unchanged */;
const SCHEMA_INSTRUCTION =
  "You are improving one step's REQUIRED OUTPUT STRUCTURE (its output schema) for a workflow template. " +
  "The step passes review but is weakly verified — tighten the schema so the step must show its work: " +
  "add checkable required fields (evidence references, risks, acceptance-criteria mapping). " +
  "TIGHTEN ONLY: you may add fields, make optional fields required, and add descriptions. " +
  "Never remove, rename, or retype a field, and never change an enum. Return only the structured proposal.";

export function buildProposePayload(bundle: DiagnosisBundle): Record<string, unknown> {
  if (bundle.component === "step_output_schema") {
    return {
      instruction: SCHEMA_INSTRUCTION,
      currentOutputSchema: bundle.currentOutputSchemaJson,
      targetedFailureMode: bundle.targetedFailureMode,
      refuteReasons: bundle.evidence.refuteReasons,
      metricSnapshot: bundle.evidence.metricSnapshot,
    };
  }
  return { /* existing instructions payload, unchanged */ };
}

export function validateRevisionProposal(bundle: DiagnosisBundle) {
  if (bundle.component === "step_output_schema") {
    const before = parseSchema(bundle.currentOutputSchemaJson) ?? [];
    return (raw: unknown): { accepted: true; parsed: ProposeSchemaRevisionProposal } | { accepted: false; failureMessage: string } => {
      const parsed = ProposeSchemaRevisionProposal.safeParse(raw);
      if (!parsed.success) return { accepted: false, failureMessage: "proposal failed schema (check field shapes / invariant keys)" };
      const tightening = validateSchemaTightening(before, parsed.data.proposedOutputSchema);
      if (!tightening.ok) return { accepted: false, failureMessage: `not a pure tightening: ${tightening.errors.join("; ").slice(0, 400)}` };
      if (serializeSchema(parsed.data.proposedOutputSchema) === serializeSchema(before)) {
        return { accepted: false, failureMessage: "proposed schema is identical to current (no-op)" };
      }
      return { accepted: true, parsed: parsed.data };
    };
  }
  const currentInstructions = bundle.currentInstructions;
  return /* existing instructions validator body, unchanged, using currentInstructions */;
}
```

`proposeInstructionRevision` keeps the same broker kind (`propose_instruction_revision` — payload is opaque to the transport); its return type widens to the union; the call site in `usecases.ts` narrows on `bundle.component` when building before/after.

- [ ] **Step 4: Run** — `pnpm -C apps/daemon test -- src/learning && pnpm -C apps/daemon exec tsc --noEmit` → PASS (fix `validateRevisionProposal` call sites — `usecases.ts` passes the bundle now).
- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning
git commit -m "feat(learning): R4 diagnoses route to schema proposals; whitelist-validated propose path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Apply / rollback / edited-schema validation

**Files:**
- Modify: `apps/daemon/src/learning/apply.ts`
- Modify: `apps/daemon/src/learning/routes.ts` (error mapping for the new error class — follow the file's existing error→status pattern; `InvalidSchemaEditError` → 422)
- Test: `apps/daemon/src/learning/apply.test.ts`

**Interfaces:**
- Consumes: `parseSchema`, `validateSchemaTightening` (Task 2); persisted `component` (Task 1).
- Produces: `InvalidSchemaEditError` (exported from apply.ts); `applyLearnedInstructionEdit`/`rollbackAppliedProposal` are component-aware with unchanged signatures.

- [ ] **Step 1: Failing tests** (reuse `apply.test.ts` fixtures — it seeds a template + proposal; add a `step_output_schema` proposal variant whose before/after are `serializeSchema` outputs):

```ts
it("applies a schema proposal: outputSchema replaced, version bumped, rollback restores", () => {
  // seed proposal with component step_output_schema, before=[summary], after=[summary, evidence_refs(required)]
  const { newVersion } = applyLearnedInstructionEdit(db, schemaProposalId, { decidedBy: "user", now: NOW });
  const steps = JSON.parse((db.prepare(`SELECT steps_json FROM workflow_templates WHERE id = ?`).get(TPL) as { steps_json: string }).steps_json);
  const step = steps.find((s: { id: string }) => s.id === STEP);
  expect(step.outputSchema.map((f: { key: string }) => f.key)).toEqual(["summary", "evidence_refs"]);
  expect(step.instructions).toBe(ORIGINAL_INSTRUCTIONS); // untouched
  const rolled = rollbackAppliedProposal(db, schemaProposalId, { decidedBy: "user", now: NOW2 });
  expect(rolled.newVersion).toBe(newVersion + 1);
  const stepsAfter = JSON.parse((db.prepare(`SELECT steps_json FROM workflow_templates WHERE id = ?`).get(TPL) as { steps_json: string }).steps_json);
  expect(stepsAfter.find((s: { id: string }) => s.id === STEP).outputSchema.map((f: { key: string }) => f.key)).toEqual(["summary"]);
});

it("refuses an edited schema that is invalid JSON or violates the whitelist", () => {
  expect(() => applyLearnedInstructionEdit(db, schemaProposalId2, { editedInstructions: "not json", decidedBy: "user", now: NOW }))
    .toThrow(InvalidSchemaEditError);
  const weakened = JSON.stringify([{ key: "summary", type: "string", required: false }], null, 2); // required→optional
  expect(() => applyLearnedInstructionEdit(db, schemaProposalId2, { editedInstructions: weakened, decidedBy: "user", now: NOW }))
    .toThrow(InvalidSchemaEditError);
  // proposal untouched:
  expect(getProposal(db, schemaProposalId2)!.status).toBe("pending");
});
```

- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement.** In `apply.ts`:

```ts
import { parseSchema, validateSchemaTightening } from "./schema-mutation.js";
import type { WorkflowStepOutputSchema } from "@orca/contracts";

export class InvalidSchemaEditError extends Error {}

// Sibling of setStepInstructionsInPlace — same privileged-write discipline and caveats.
function setStepOutputSchemaInPlace(db: Database.Database, templateId: string, stepTemplateId: string, schema: WorkflowStepOutputSchema, now: string): number {
  const tpl = readTemplate(db, templateId);
  if (!tpl) throw new StepNotFoundError(`template ${templateId} not found`);
  const steps = JSON.parse(tpl.steps_json) as { id: string; outputSchema?: unknown }[];
  const step = steps.find((s) => s.id === stepTemplateId);
  if (!step) throw new StepNotFoundError(`step ${stepTemplateId} not in template ${templateId}`);
  step.outputSchema = schema;
  const newVersion = tpl.version + 1;
  db.prepare(`UPDATE workflow_templates SET steps_json = ?, version = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(steps), newVersion, now, templateId);
  return newVersion;
}

// Resolve + validate the final text for a proposal per its component. For schema
// proposals a human edit must still be a valid, pure tightening of the BEFORE
// schema — an invalid template can never be written.
function resolveFinalWrite(p: TemplateInstructionProposalT, editedText: string | undefined): { finalText: string; write: (db: Database.Database, now: string) => number } {
  const finalText = editedText ?? p.afterInstructions;
  if (p.component === "step_output_schema") {
    const before = parseSchema(p.beforeInstructions) ?? [];
    const after = parseSchema(finalText);
    if (!after) throw new InvalidSchemaEditError("edited schema is not a valid output schema (must be the JSON field list)");
    const t = validateSchemaTightening(before, after);
    if (!t.ok) throw new InvalidSchemaEditError(`edited schema is not a pure tightening: ${t.errors.join("; ")}`);
    return { finalText, write: (db, now) => setStepOutputSchemaInPlace(db, p.templateId, p.stepTemplateId, after, now) };
  }
  return { finalText, write: (db, now) => setStepInstructionsInPlace(db, p.templateId, p.stepTemplateId, finalText, now) };
}
```

In `applyLearnedInstructionEdit`: compute `resolveFinalWrite(p, opts.editedInstructions)` BEFORE the transaction (so `InvalidSchemaEditError` throws without superseding/mutating), then inside the transaction call `resolved.write(db, opts.now)` and persist `afterInstructions: resolved.finalText`. In `rollbackAppliedProposal`: branch — schema component parses `p.beforeInstructions` via `parseSchema` (throw `StepNotFoundError`-style hard error only if unparseable, which the contract superRefine makes impossible for stored rows) and calls `setStepOutputSchemaInPlace`; instructions component unchanged. In `routes.ts`, map `InvalidSchemaEditError` to a 422 response with the error message, following the file's existing catch/mapping pattern.

- [ ] **Step 4: Run** — `pnpm -C apps/daemon test -- src/learning && pnpm -C apps/daemon exec tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning/apply.ts apps/daemon/src/learning/apply.test.ts apps/daemon/src/learning/routes.ts
git commit -m "feat(learning): schema-proposal apply/rollback with whitelist-validated human edits

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Judge component framing

**Files:**
- Modify: `apps/daemon/src/learning/judge.ts:5-32` (`composeJudgePrompt`)
- Modify: `apps/daemon/src/learning/usecases.ts` (`judgeProposal` request build: `step.component: p.component`)
- Test: `apps/daemon/src/learning/judge.test.ts`, `apps/daemon/src/learning/judge-usecase.test.ts`

**Interfaces:**
- Consumes: `JudgeInstructionEditRequest.step.component?` (Task 1).
- Produces: schema-component judge prompts frame the structure question; request carries the component.

- [ ] **Step 1: Failing tests.** In `judge.test.ts`:

```ts
it("frames schema proposals as output-structure evaluation", () => {
  const req = { ...baseRequest, step: { ...baseRequest.step, component: "step_output_schema" as const } };
  const { systemPrompt } = composeJudgePrompt(req);
  expect(systemPrompt).toContain("REQUIRED OUTPUT STRUCTURE");
  expect(systemPrompt).toContain("caught or improved by the tighter required structure");
  expect(systemPrompt).not.toContain("instruction text");
});

it("instructions proposals keep the existing framing", () => {
  const { systemPrompt } = composeJudgePrompt(baseRequest);
  expect(systemPrompt).toContain("instruction text");
});
```

In `judge-usecase.test.ts`: extend one shadow-path test to seed a `step_output_schema` proposal and assert the `ask` call's userPrompt JSON contains `"component":"step_output_schema"`.

- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement.** In `composeJudgePrompt`, derive the two component-dependent lines (all other lines unchanged):

```ts
  const isSchema = request.step.component === "step_output_schema";
  const systemPrompt = [
    isSchema
      ? "You are an INDEPENDENT reviewer evaluating a PROPOSED edit to one workflow step's REQUIRED OUTPUT STRUCTURE (its output schema)."
      : "You are an INDEPENDENT reviewer evaluating a PROPOSED edit to one workflow step's instruction text.",
    ...(isSchema ? [
      "The currentInstructions/proposedInstructions fields contain the BEFORE/AFTER output schema (a JSON field list the engine enforces at completion).",
      "For each failure case: would the failing output have been caught or improved by the tighter required structure?",
    ] : []),
    /* remaining existing lines verbatim */
  ].join("\n");
```

In `judgeProposal` (usecases.ts), the `JudgeInstructionEditRequest.safeParse` input's `step` gains `component: p.component`.

- [ ] **Step 4: Run** — `pnpm -C apps/daemon test -- src/learning` → PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning/judge.ts apps/daemon/src/learning/usecases.ts apps/daemon/src/learning/judge.test.ts apps/daemon/src/learning/judge-usecase.test.ts
git commit -m "feat(learning): judge frames schema proposals as output-structure evaluation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Invalid-output rate delta + schema canary

**Files:**
- Modify: `apps/daemon/src/metrics/aggregate.ts` (inside the `versionsPresent.length >= 2` block and the step literal)
- Modify: `apps/daemon/src/learning/canary.ts`
- Test: `apps/daemon/src/metrics/aggregate.steps.test.ts`, `apps/daemon/src/learning/canary.test.ts`

**Interfaces:**
- Consumes: `StepMetrics.versionInvalidOutputRateDelta` + proposal `invalidOutputRateDelta`/`targetDeltaVersions` contract fields (Task 1); persisted `component` (Task 1).
- Produces: `SCHEMA_INVALID_OUTPUT_THRESHOLD = 0.2` exported from canary.ts; enriched proposals carry `invalidOutputRateDelta` and `targetDeltaVersions`; `regressionDetected` includes the schema canary.

- [ ] **Step 1: Failing tests.** `aggregate.steps.test.ts`:

```ts
it("versionInvalidOutputRateDelta: invalid-output completion rate, latest minus prior, VERSION_MIN-gated", () => {
  const mk = (id: string, run: string, code: string | null, v: number, at: string) => {
    const t = sc(id, run, "s", code ? "failed" : "passed", true, at);
    t.templateVersion = v;
    t.transition.telemetry!.outcome = { status: code ? "failed" : "succeeded", failure_code: code as never };
    return t;
  };
  const ts = [
    mk("a", "r1", null, 1, "2026-05-01T00:00:00.000Z"), mk("b", "r2", null, 1, "2026-05-01T01:00:00.000Z"),
    mk("c", "r3", "invalid_output", 2, "2026-05-02T00:00:00.000Z"), mk("d", "r4", null, 2, "2026-05-02T01:00:00.000Z"),
  ];
  const runs: TemplateStepRun[] = ts.map((t) => ({
    workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1, status: "passed",
    startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: t.templateVersion,
  }));
  const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
  expect(step.versionInvalidOutputRateDelta).toBeCloseTo(0.5); // v2: 1/2, v1: 0/2
});
```

`canary.test.ts`:

```ts
it("schema canary: invalid-output spike on the applied version flags regression", () => {
  const steps = [{ ...stepFixture(), stepTemplateId: "s1", versionScoreDelta: 0.1,
    versionScoreDeltaVersions: { latest: 2, prior: 1 }, versionInvalidOutputRateDelta: 0.5 }];
  const [p] = enrichWithRegression([{ ...appliedProposal, component: "step_output_schema" }], summaryWithComparison, steps as never);
  expect(p.invalidOutputRateDelta).toBeCloseTo(0.5);
  expect(p.regressionDetected).toBe(true);
});

it("instruction proposals ignore the invalid-output canary; pair still gates it", () => {
  const steps = [{ ...stepFixture(), stepTemplateId: "s1", versionScoreDeltaVersions: { latest: 2, prior: 1 }, versionInvalidOutputRateDelta: 0.5 }];
  const [pi] = enrichWithRegression([appliedProposal], summaryWithComparison, steps as never); // step_instructions
  expect(pi.regressionDetected).toBe(false);
  const stale = [{ ...stepFixture(), stepTemplateId: "s1", versionScoreDeltaVersions: { latest: 1, prior: 0 }, versionInvalidOutputRateDelta: 0.5 }];
  const [ps] = enrichWithRegression([{ ...appliedProposal, component: "step_output_schema" }], summaryWithComparison, stale as never);
  expect(ps.invalidOutputRateDelta).toBeNull();
  expect(ps.regressionDetected).toBe(false);
});

it("enriched proposals carry targetDeltaVersions for UI display", () => {
  const steps = [{ ...stepFixture(), stepTemplateId: "s1", versionScoreDelta: 0.2, versionScoreDeltaVersions: { latest: 2, prior: 1 } }];
  const [p] = enrichWithRegression([appliedProposal], summaryWithComparison, steps as never);
  expect(p.targetDeltaVersions).toEqual({ latest: 2, prior: 1 });
});
```

(Adapt fixture names to the file's real ones, as in prior tasks.)

- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement.** `aggregate.ts` — inside the existing `if (versionsPresent.length >= 2)` block, after the score-delta computation:

```ts
      // Schema-canary signal: invalid-output completion rate per version, completions-only
      // basis (an invalid_output failure implies a step_complete happened), same floor.
      const invalidRateFor = (v: number): number | null => {
        const completes = finalStepCompletes.filter((t) => t.templateVersion === v);
        if (completes.length < VERSION_MIN) return null;
        return completes.filter((t) => t.transition.telemetry?.outcome.failure_code === "invalid_output").length / completes.length;
      };
      const ia = invalidRateFor(latestV), ib = invalidRateFor(priorV);
      if (ia != null && ib != null) versionInvalidOutputRateDelta = ia - ib;
```

with `let versionInvalidOutputRateDelta: number | null = null;` declared beside `versionScoreDelta`, and `versionInvalidOutputRateDelta,` added to the step literal beside `versionScoreDelta`.

`canary.ts` — add `export const SCHEMA_INVALID_OUTPUT_THRESHOLD = 0.2;` and in the post-gate branch:

```ts
    const invalidOutputRateDelta = spansApplied ? step?.versionInvalidOutputRateDelta ?? null : null;
    // A learned tightening's specific failure shape: the new checks reject output.
    const schemaCanaryTripped = p.component === "step_output_schema"
      && invalidOutputRateDelta != null && invalidOutputRateDelta > SCHEMA_INVALID_OUTPUT_THRESHOLD;
    return { ...p, regressionDetected: regressed || schemaCanaryTripped, watchedDeltas,
      targetDelta, targetImproved: targetDelta == null ? null : targetDelta > 0,
      targetDeltaVersions: spansApplied ? step?.versionScoreDeltaVersions ?? null : null,
      invalidOutputRateDelta };
```

Early-return path adds `targetDeltaVersions: null, invalidOutputRateDelta: null`.

- [ ] **Step 4: Run** — `pnpm -C apps/daemon test -- src/metrics src/learning && pnpm -C apps/daemon exec tsc --noEmit` → PASS (patch daemon `StepMetrics` fixtures for the new required field if not already done in Task 1).
- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/metrics apps/daemon/src/learning/canary.ts apps/daemon/src/learning/canary.test.ts
git commit -m "feat(metrics,learning): invalid-output version delta + schema canary on applied proposals

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Panel — diff modal, schema chips, honest confidence, judge reasoning

**Files:**
- Modify: `apps/desktop/src/metrics/SelfImprovement.tsx` (pending-card region, lines 103-150)
- Test: `apps/desktop/src/metrics/SelfImprovement.test.tsx`, `apps/desktop/src/metrics/no-jargon.test.tsx`

**Interfaces:**
- Consumes: proposal `component` (Task 1), judge `reasoning` (existing contract field).
- Produces: `diffLines(before, after)` and `schemaChips(beforeJson, afterJson)` exported from a new small module `apps/desktop/src/metrics/proposal-diff.ts` for testability.

- [ ] **Step 1: Failing tests** for the pure helpers (`apps/desktop/src/metrics/proposal-diff.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { diffLines, schemaChips } from "./proposal-diff";

describe("diffLines", () => {
  it("marks removed/added/kept lines by set membership", () => {
    expect(diffLines("a\nb\nc", "a\nc\nd")).toEqual([
      { kind: "kept", text: "a" }, { kind: "removed", text: "b" }, { kind: "kept", text: "c" }, { kind: "added", text: "d" },
    ]);
  });
});

describe("schemaChips", () => {
  const before = JSON.stringify([{ key: "summary", type: "string", required: true }, { key: "notes", type: "string", required: false }]);
  const after = JSON.stringify([
    { key: "summary", type: "string", required: true }, { key: "notes", type: "string", required: true },
    { key: "evidence_refs", type: "array", itemType: "string", required: true },
  ]);
  it("computes added and strictened chips", () => {
    expect(schemaChips(before, after)).toEqual([
      { kind: "strictened", label: "notes: now required" },
      { kind: "added", label: "+ evidence_refs (list of strings, required)" },
    ]);
  });
  it("returns [] on unparseable input", () => {
    expect(schemaChips("junk", after)).toEqual([]);
  });
});
```

And UI tests in `SelfImprovement.test.tsx` (adapt to its existing render/mocking idiom — it mocks `../api`):

```ts
it("pending card opens a review modal with the diff and keeps Apply/Dismiss", async () => { /* render with one pending step_instructions proposal; click "Review change"; expect removed/added lines rendered; Apply still calls applyProposal */ });
it("schema proposals render field chips, not raw JSON, in the summary", async () => { /* pending proposal with component step_output_schema; expect "+ evidence_refs" chip text */ });
it("judge block shows verdict, samples, and expandable reasoning — no invented percentage", async () => { /* proposal with judgment {verdict:"pass", reasoning:"because...", solvedSampleSize:2, failureSampleSize:2}; expect "because..." revealed under a details toggle; expect no "%\d" confidence-like string in the judge block */ });
```

- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement `proposal-diff.ts`:**

```ts
// Presentation helpers for proposal review. Set-membership line diff — adequate for
// instruction texts; not a minimal edit script and doesn't need to be.
export type DiffLine = { kind: "kept" | "removed" | "added"; text: string };
export function diffLines(before: string, after: string): DiffLine[] {
  const b = before.split("\n"), a = after.split("\n");
  const aSet = new Set(a), bSet = new Set(b);
  const out: DiffLine[] = [];
  for (const line of b) out.push({ kind: aSet.has(line) ? "kept" : "removed", text: line });
  for (const line of a) if (!bSet.has(line)) out.push({ kind: "added", text: line });
  return out;
}

type Field = { key: string; type: string; required: boolean; itemType?: string };
const TYPE_LABEL: Record<string, string> = { string: "text", number: "number", boolean: "yes/no", array: "list", object: "group" };
function describeType(f: Field): string {
  if (f.type === "array") return `list of ${TYPE_LABEL[f.itemType ?? "string"] ?? f.itemType}s`;
  return TYPE_LABEL[f.type] ?? f.type;
}
export type SchemaChip = { kind: "added" | "strictened"; label: string };
export function schemaChips(beforeJson: string, afterJson: string): SchemaChip[] {
  let before: Field[], after: Field[];
  try { before = JSON.parse(beforeJson); after = JSON.parse(afterJson); } catch { return []; }
  if (!Array.isArray(before) || !Array.isArray(after)) return [];
  const beforeByKey = new Map(before.map((f) => [f.key, f]));
  const chips: SchemaChip[] = [];
  for (const f of after) {
    const b = beforeByKey.get(f.key);
    if (!b) chips.push({ kind: "added", label: `+ ${f.key} (${describeType(f)}${f.required ? ", required" : ""})` });
    else if (!b.required && f.required) chips.push({ kind: "strictened", label: `${f.key}: now required` });
  }
  return chips;
}
```

Then rework the pending card in `SelfImprovement.tsx`: replace the strikethrough+textarea block (lines 111-114) with a summary line (instructions: first `diffLines` counts, e.g. "3 lines changed"; schema: the chips row) plus a **"Review change"** button that sets `reviewing: string | null` state; render a fixed-overlay modal (positioned like the existing dropdown pattern in `StepPerformance.tsx`: absolutely positioned panel with `var(--panel)` background, border, shadow) containing: the full diff (kept/removed/added lines tinted `var(--text-3)`/`var(--err)`/`var(--run)` in `<pre>` rows — schema proposals show chips above the raw before/after), the editable textarea (existing `editing` state), Predicts/Preserves lines, and the Apply/Dismiss buttons (same handlers). Judge block: keep verdict + reason; add `{p.judgment.reasoning && <details><summary>How the reviewer worked through it</summary><div>{p.judgment.reasoning}</div></details>}` and keep sample-size line. No invented confidence numbers anywhere.

- [ ] **Step 4: Run** — `pnpm -C apps/desktop test -- src/metrics && pnpm -C apps/desktop exec tsc --noEmit` → PASS, including `no-jargon.test.tsx` extended to render a pending + judged proposal card and assert the five-term regex finds nothing.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics
git commit -m "feat(metrics-ui): proposal review modal — line diff, schema chips, honest judge display

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Panel — applied-card falsifier + canary lines

**Files:**
- Modify: `apps/desktop/src/metrics/SelfImprovement.tsx` (applied-card region)
- Test: `apps/desktop/src/metrics/SelfImprovement.test.tsx`

**Interfaces:**
- Consumes: enriched `targetDelta`, `targetImproved`, `targetDeltaVersions`, `invalidOutputRateDelta` (Tasks 1+6).

- [ ] **Step 1: Failing tests:**

```ts
it("applied card renders the falsifier line in all three states", async () => {
  // improved: targetDelta 0.2, targetImproved true, targetDeltaVersions {latest:4, prior:3} → "improved +20 points (v3→v4)"
  // not improved: targetDelta -0.08, targetImproved false → "not improved (−8 points, v3→v4)"
  // awaiting: targetDelta null → "awaiting data — needs 2 scored runs on each version"
});
it("schema canary line renders when invalidOutputRateDelta exceeds the threshold", async () => {
  // component step_output_schema, invalidOutputRateDelta 0.5, regressionDetected true →
  // expect text matching /new checks are rejecting output/i and /\+50%/ and the Rollback button
});
```

(Fill with the file's real render idiom; assertions as shown.)

- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement.** In the applied-card block (after the existing watching/regression line):

```tsx
{(() => {
  const pair = p.targetDeltaVersions;
  const span = pair ? ` (v${pair.prior}→v${pair.latest})` : "";
  if (p.targetDelta == null) return (
    <div style={{ color: "var(--text-3)", marginTop: 4 }}>Target step: awaiting data — needs 2 scored runs on each version.</div>
  );
  const pts = Math.round(p.targetDelta * 100);
  return (
    <div style={{ color: p.targetImproved ? "var(--run)" : "var(--warn)", marginTop: 4 }}>
      Target step: {p.targetImproved ? `improved +${pts} points` : `not improved (${pts} points)`}{span}.
    </div>
  );
})()}
{p.component === "step_output_schema" && p.invalidOutputRateDelta != null && p.invalidOutputRateDelta > 0.2 && (
  <div style={{ color: "var(--err)", marginTop: 4 }}>
    New checks are rejecting output (+{Math.round(p.invalidOutputRateDelta * 100)}% of runs) — consider rollback.
  </div>
)}
```

(The `0.2` here mirrors `SCHEMA_INVALID_OUTPUT_THRESHOLD`; the daemon already folded the trip into `regressionDetected`, so the Rollback button appears via the existing condition — this line only explains why.)

- [ ] **Step 4: Run** — `pnpm -C apps/desktop test -- src/metrics && pnpm -C apps/desktop exec tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics
git commit -m "feat(metrics-ui): applied-card falsifier line + schema canary explanation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Docs + repo verification + live check

**Files:**
- Modify: `ORCA.md` (the Phase 5B / learning-loop paragraphs: note the second revision target — component enum, whitelist, schema canary), `FUTURE_WORK.md` if it tracks SP2/SP3 items.

- [ ] **Step 1: Docs.** Surgical additions matching the documents' existing voice; both honesty caveats style-matched (see the 5.5 ledger precedent). State: R4 → `step_output_schema` routing; deterministic whitelist; migration 0055; canary; judge component framing; panel fidelity. Flag SP3 remainder unchanged.
- [ ] **Step 2: Full sweep.** `pnpm -C packages/contracts test && pnpm -C apps/daemon exec tsc --noEmit && pnpm -C apps/daemon test && pnpm -C apps/desktop exec tsc --noEmit && pnpm -C apps/desktop test` → all green (desktop App.test.tsx flake excepted, verified same-on-base if it fires). Purity: `git diff <branch-base>..HEAD | grep -E "^\+.*((Date\.now)|(Math\.random))"` → no code hits.
- [ ] **Step 3: Live check (read-only parts mandatory, billed part optional).** Against the running daemon: `GET /v1/metrics/templates/:id` — every step carries `versionInvalidOutputRateDelta` (null with single-version data); `GET /v1/learning/proposals` route still parses (component defaulted rows). Browser: Metrics tab renders; Self-improvement rail unchanged for empty state. **Optional, flag to the user before running:** clicking "Analyze this template" on live data would exercise the full R4→schema path for real (Triage is R4-eligible: verdictPassRate 1.0, null oracle rate, n=6) but makes a billed shadow-LLM call — ask first.
- [ ] **Step 4: Commit docs; final whole-branch review** per the executing skill's process.

---

## Self-Review Notes

- **Spec coverage:** §3.1 → Task 1; §3.2 → Task 3; §3.3 → Task 2 (+criterion 3 test); §3.4 → Task 3; §3.5 → Task 4; §3.6 → Task 5; §3.7 → Tasks 1+6; §3.8 → Tasks 7+8; §5 edge cases → Tasks 3 (32-field cap rejects via contract max on `WorkflowStepOutputSchema`), 4 (invalid edit), 6 (thin samples); §7 criteria 1-8 → Tasks 3,2,2,4,5,6,7+8,9 respectively.
- **Type consistency:** `ProposalComponent`, `ProposeSchemaRevisionProposal`, `serializeSchema/parseSchema/validateSchemaTightening`, `DiagnosisBundle.component/currentOutputSchemaJson`, `stepMeta`, `InvalidSchemaEditError`, `SCHEMA_INVALID_OUTPUT_THRESHOLD`, `versionInvalidOutputRateDelta`, `invalidOutputRateDelta`, `targetDeltaVersions`, `diffLines/schemaChips` — names used identically across tasks.
- **Known simplification, deliberate:** `diffLines` is set-membership, not LCS — duplicate lines in instructions render as kept if the text appears anywhere; acceptable for review purposes and noted in the module comment.
