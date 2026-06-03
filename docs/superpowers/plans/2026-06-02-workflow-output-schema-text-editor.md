# Workflow Step Output Schema Text Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the field-by-field `OutputSchemaEditor` UI with a single text area using a typed shorthand grammar that round-trips losslessly to the existing structured `WorkflowStepOutputSchema`.

**Architecture:** Two pure functions (`serializeOutputSchema`, `parseOutputSchemaText`) convert between structured schema and text. The schema stays the canonical storage form, so daemon validation and the LLM structured-output prompt are untouched. `OutputSchemaEditor` becomes a thin text-area wrapper: it serializes the incoming schema to seed the box, parses on edit, emits `onChange` only on valid parse, and shows an inline error otherwise.

**Tech Stack:** TypeScript, React, Vitest + @testing-library/react, Zod (via `@orca/contracts`).

---

## File Structure

- **Create** `apps/desktop/src/workflows/output-schema-text.ts` — `serializeOutputSchema` + `parseOutputSchemaText`. Pure, no React. Single responsibility: schema ↔ text.
- **Create** `apps/desktop/src/workflows/output-schema-text.test.ts` — round-trip + parser error unit tests, including all built-in template schemas as fixtures.
- **Rewrite** `apps/desktop/src/workflows/OutputSchemaEditor.tsx` — text area + internal state + inline error; same existing props plus optional `onValidityChange`.
- **Rewrite** `apps/desktop/src/workflows/OutputSchemaEditor.test.tsx` — cover valid edit → onChange, invalid edit → error + no onChange, disabled → read-only.
- **(Optional) Modify** `StepEditor.tsx`, `NodeDetailModal.tsx`, `TemplateDetail.tsx` — wire `onValidityChange` to disable Save while any output schema text is invalid.

## Grammar (canonical)

```
field      := name "?"? typeSpec? description?
name       := [A-Za-z_][A-Za-z0-9_]*           ; zod enforces 1..64
"?"        := optional marker; absence ⇒ required: true
typeSpec   := (empty)             ⇒ string
            | ": string|number|boolean"
            | "[]"                ⇒ array, no itemType
            | ": <prim>[]"        ⇒ array itemType <prim>
            | "{" fieldlist "}"   ⇒ object (also accepts ": {")
            | "[]" "{" fieldlist "}" ⇒ array itemType object
description := "#" rest-of-line   ⇒ description (leaf fields only)
```

Separators between fields: comma and/or whitespace/newlines — all tolerated. Canonical serialization: 2-space indent, one field per line, siblings joined by `,\n`, `string` type omitted (bare name), object head `name {` (no colon), array-of-object `name[] {`. Descriptions are emitted only on leaf (scalar/simple-array) fields; object-level descriptions are not round-tripped (no built-in uses them).

---

## Task 1: Serializer

**Files:**
- Create: `apps/desktop/src/workflows/output-schema-text.ts`
- Test: `apps/desktop/src/workflows/output-schema-text.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/workflows/output-schema-text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { serializeOutputSchema } from "./output-schema-text";

describe("serializeOutputSchema", () => {
  it("renders bare string fields without a type", () => {
    const schema: WorkflowStepOutputSchema = [
      { key: "goal", type: "string", required: true },
      { key: "audience", type: "string", required: true },
    ];
    expect(serializeOutputSchema(schema)).toBe("goal,\naudience");
  });

  it("renders optional marker, primitives and typed arrays", () => {
    const schema: WorkflowStepOutputSchema = [
      { key: "confidence", type: "number", required: true },
      { key: "reviewed", type: "boolean", required: false },
      { key: "tags", type: "array", itemType: "string", required: true },
      { key: "ids", type: "array", required: false },
    ];
    expect(serializeOutputSchema(schema)).toBe(
      "confidence: number,\nreviewed?: boolean,\ntags: string[],\nids?[]",
    );
  });

  it("renders nested object and array-of-object with indentation", () => {
    const schema: WorkflowStepOutputSchema = [
      {
        key: "test_results",
        type: "object",
        required: true,
        fields: [
          { key: "ran", type: "boolean", required: true },
          { key: "skipped", type: "string", required: false },
        ],
      },
      {
        key: "tasks",
        type: "array",
        itemType: "object",
        required: true,
        fields: [{ key: "title", type: "string", required: true }],
      },
    ];
    expect(serializeOutputSchema(schema)).toBe(
      "test_results {\n  ran: boolean,\n  skipped?\n},\ntasks[] {\n  title\n}",
    );
  });

  it("appends a description on leaf fields", () => {
    const schema: WorkflowStepOutputSchema = [
      { key: "goal", type: "string", required: true, description: "primary objective" },
    ];
    expect(serializeOutputSchema(schema)).toBe("goal  # primary objective");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test output-schema-text`
Expected: FAIL — `serializeOutputSchema` not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/workflows/output-schema-text.ts`:

```ts
import { WorkflowStepOutputSchema, type WorkflowStepOutputField } from "@orca/contracts";

const pad = (depth: number) => "  ".repeat(depth);

function renderField(f: WorkflowStepOutputField, depth: number): string {
  const opt = f.required ? "" : "?";
  if (f.type === "object" && f.fields) {
    return `${pad(depth)}${f.key}${opt} {\n${renderFields(f.fields, depth + 1)}\n${pad(depth)}}`;
  }
  if (f.type === "array" && f.itemType === "object" && f.fields) {
    return `${pad(depth)}${f.key}${opt}[] {\n${renderFields(f.fields, depth + 1)}\n${pad(depth)}}`;
  }
  let typ = "";
  if (f.type === "array") {
    typ = f.itemType ? `: ${f.itemType}[]` : "[]";
  } else if (f.type !== "string") {
    typ = `: ${f.type}`;
  }
  const desc = f.description ? `  # ${f.description}` : "";
  return `${pad(depth)}${f.key}${opt}${typ}${desc}`;
}

function renderFields(fields: WorkflowStepOutputField[], depth: number): string {
  return fields.map((f) => renderField(f, depth)).join(",\n");
}

export function serializeOutputSchema(schema: WorkflowStepOutputSchema): string {
  return renderFields(schema, 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test output-schema-text`
Expected: PASS (4 serializer tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/workflows/output-schema-text.ts apps/desktop/src/workflows/output-schema-text.test.ts
git commit -m "feat(workflows): add output schema serializer"
```

---

## Task 2: Parser

**Files:**
- Modify: `apps/desktop/src/workflows/output-schema-text.ts`
- Test: `apps/desktop/src/workflows/output-schema-text.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/workflows/output-schema-text.test.ts`:

```ts
import { parseOutputSchemaText } from "./output-schema-text";

describe("parseOutputSchemaText", () => {
  it("parses bare names as required strings", () => {
    const r = parseOutputSchemaText("goal, audience");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schema).toEqual([
        { key: "goal", type: "string", required: true },
        { key: "audience", type: "string", required: true },
      ]);
    }
  });

  it("parses optional markers, primitives, typed and bare arrays", () => {
    const r = parseOutputSchemaText("confidence: number\nreviewed?: boolean\ntags: string[]\nids?[]");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schema).toEqual([
        { key: "confidence", type: "number", required: true },
        { key: "reviewed", type: "boolean", required: false },
        { key: "tags", type: "array", itemType: "string", required: true },
        { key: "ids", type: "array", required: false },
      ]);
    }
  });

  it("parses nested object (with and without colon) and array-of-object", () => {
    const r = parseOutputSchemaText("test_results: { ran: boolean, skipped? }\ntasks[] { title }");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schema).toEqual([
        {
          key: "test_results",
          type: "object",
          required: true,
          fields: [
            { key: "ran", type: "boolean", required: true },
            { key: "skipped", type: "string", required: false },
          ],
        },
        {
          key: "tasks",
          type: "array",
          itemType: "object",
          required: true,
          fields: [{ key: "title", type: "string", required: true }],
        },
      ]);
    }
  });

  it("parses a leaf description", () => {
    const r = parseOutputSchemaText("goal  # primary objective");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schema[0]).toEqual({
        key: "goal",
        type: "string",
        required: true,
        description: "primary objective",
      });
    }
  });

  it("rejects empty input", () => {
    const r = parseOutputSchemaText("   ");
    expect(r.ok).toBe(false);
  });

  it("rejects duplicate keys at the same level", () => {
    const r = parseOutputSchemaText("goal, goal");
    expect(r).toEqual({ ok: false, error: "Duplicate key 'goal'" });
  });

  it("rejects unknown type tokens", () => {
    const r = parseOutputSchemaText("count: integer");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("integer");
  });

  it("rejects unbalanced braces", () => {
    const r = parseOutputSchemaText("a { b");
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test output-schema-text`
Expected: FAIL — `parseOutputSchemaText` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/desktop/src/workflows/output-schema-text.ts`:

```ts
export type ParseResult =
  | { ok: true; schema: WorkflowStepOutputSchema }
  | { ok: false; error: string };

type Tok =
  | { t: "{" } | { t: "}" } | { t: "[" } | { t: "]" }
  | { t: ":" } | { t: "?" } | { t: "," }
  | { t: "name"; v: string }
  | { t: "desc"; v: string };

class ParseErr extends Error {}

const PRIMS = ["string", "number", "boolean"] as const;
type Prim = (typeof PRIMS)[number];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "#") {
      let j = i + 1;
      while (j < src.length && src[j] !== "\n") j++;
      toks.push({ t: "desc", v: src.slice(i + 1, j).trim() });
      i = j;
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "{" || c === "}" || c === "[" || c === "]" || c === ":" || c === "?" || c === ",") {
      toks.push({ t: c });
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: "name", v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseErr(`Unexpected character '${c}'`);
  }
  return toks;
}

export function parseOutputSchemaText(text: string): ParseResult {
  let toks: Tok[];
  try {
    toks = tokenize(text);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];
  const next = (): Tok | undefined => toks[pos++];

  function expect(t: Tok["t"]): void {
    const x = next();
    if (!x || x.t !== t) throw new ParseErr(`Expected '${t}'`);
  }

  function parseBraced(): WorkflowStepOutputField[] {
    expect("{");
    const fields = parseFieldList(true);
    expect("}");
    return fields;
  }

  function parseField(): WorkflowStepOutputField {
    const nameTok = next();
    if (!nameTok || nameTok.t !== "name") throw new ParseErr("Expected field name");
    let field: WorkflowStepOutputField = { key: nameTok.v, type: "string", required: true };
    if (peek()?.t === "?") { next(); field.required = false; }

    const p = peek();
    if (p?.t === ":") {
      next();
      const after = peek();
      if (after?.t === "{") {
        field = { ...field, type: "object", fields: parseBraced() };
      } else if (after?.t === "name") {
        const word = (next() as { t: "name"; v: string }).v;
        if (!(PRIMS as readonly string[]).includes(word)) throw new ParseErr(`Unknown type '${word}'`);
        if (peek()?.t === "[") {
          next();
          expect("]");
          field = { ...field, type: "array", itemType: word as Prim };
        } else {
          field = { ...field, type: word as Prim };
        }
      } else {
        throw new ParseErr(`Expected a type after ':' for '${field.key}'`);
      }
    } else if (p?.t === "[") {
      next();
      expect("]");
      if (peek()?.t === "{") {
        field = { ...field, type: "array", itemType: "object", fields: parseBraced() };
      } else {
        field = { ...field, type: "array" };
      }
    } else if (p?.t === "{") {
      field = { ...field, type: "object", fields: parseBraced() };
    }

    if (peek()?.t === "desc") {
      field = { ...field, description: (next() as { t: "desc"; v: string }).v };
    }
    return field;
  }

  function parseFieldList(insideBrace: boolean): WorkflowStepOutputField[] {
    const fields: WorkflowStepOutputField[] = [];
    const seen = new Set<string>();
    while (pos < toks.length) {
      const tok = peek();
      if (insideBrace && tok?.t === "}") break;
      if (tok?.t === ",") { next(); continue; }
      if (tok?.t !== "name") throw new ParseErr(`Expected field name, got '${tok?.t ?? "end"}'`);
      const f = parseField();
      if (seen.has(f.key)) throw new ParseErr(`Duplicate key '${f.key}'`);
      seen.add(f.key);
      fields.push(f);
    }
    return fields;
  }

  let fields: WorkflowStepOutputField[];
  try {
    fields = parseFieldList(false);
    if (pos < toks.length) throw new ParseErr("Unexpected trailing input");
  } catch (e) {
    if (e instanceof ParseErr) return { ok: false, error: e.message };
    throw e;
  }

  const result = WorkflowStepOutputSchema.safeParse(fields);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join(".");
    return { ok: false, error: path ? `${path}: ${issue.message}` : issue.message };
  }
  return { ok: true, schema: result.data };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test output-schema-text`
Expected: PASS (serializer + parser tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/workflows/output-schema-text.ts apps/desktop/src/workflows/output-schema-text.test.ts
git commit -m "feat(workflows): add output schema text parser"
```

---

## Task 3: Round-trip over all built-in schemas

This is the losslessness guarantee. Built-in schemas are defined in the daemon package; embed them here as fixtures (do not import across packages in a desktop unit test).

**Files:**
- Test: `apps/desktop/src/workflows/output-schema-text.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/workflows/output-schema-text.test.ts`:

```ts
// Fixtures mirror apps/daemon/src/workflows/templates/seed-engineering.ts output schemas.
const BUILTIN_SCHEMAS: WorkflowStepOutputSchema[] = [
  [
    { key: "problem", type: "string", required: true },
    { key: "success_outcome", type: "string", required: true },
    { key: "constraints", type: "array", itemType: "string", required: true },
    { key: "relevant_workspaces", type: "array", itemType: "string", required: false },
    { key: "open_questions", type: "array", itemType: "string", required: false },
  ],
  [
    { key: "summary", type: "string", required: true },
    { key: "changed_files", type: "array", itemType: "string", required: true },
    {
      key: "test_results",
      type: "object",
      required: true,
      fields: [
        { key: "ran", type: "boolean", required: true },
        { key: "passed", type: "boolean", required: true },
        { key: "skipped", type: "string", required: false },
      ],
    },
    { key: "blocked", type: "boolean", required: true },
    { key: "blocked_reason", type: "string", required: false },
  ],
  [
    { key: "summary", type: "string", required: true },
    {
      key: "tasks",
      type: "array",
      itemType: "object",
      required: true,
      fields: [
        { key: "title", type: "string", required: true },
        { key: "acceptance", type: "string", required: true },
      ],
    },
  ],
];

describe("round-trip", () => {
  it("serialize → parse returns the original schema for every built-in", () => {
    for (const schema of BUILTIN_SCHEMAS) {
      const text = serializeOutputSchema(schema);
      const parsed = parseOutputSchemaText(text);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.schema).toEqual(schema);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `pnpm --filter @orca/desktop test output-schema-text`
Expected: PASS if Tasks 1–2 are correct. If any fixture fails to round-trip, fix the serializer/parser (not the fixture) until it passes — this is the real acceptance gate.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/workflows/output-schema-text.test.ts
git commit -m "test(workflows): round-trip built-in output schemas through text"
```

---

## Task 4: Rewrite OutputSchemaEditor as a text area

**Files:**
- Rewrite: `apps/desktop/src/workflows/OutputSchemaEditor.tsx`
- Rewrite: `apps/desktop/src/workflows/OutputSchemaEditor.test.tsx`

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `apps/desktop/src/workflows/OutputSchemaEditor.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { OutputSchemaEditor } from "./OutputSchemaEditor";

const baseSchema: WorkflowStepOutputSchema = [
  { key: "summary", type: "string", required: true },
  { key: "count", type: "number", required: false },
];

function getTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Output Schema") as HTMLTextAreaElement;
}

describe("OutputSchemaEditor", () => {
  it("seeds the text area from the schema", () => {
    render(<OutputSchemaEditor schema={baseSchema} onChange={vi.fn()} />);
    expect(getTextarea().value).toBe("summary,\ncount?: number");
  });

  it("emits onChange with the parsed schema on valid edits", () => {
    const onChange = vi.fn();
    render(<OutputSchemaEditor schema={baseSchema} onChange={onChange} />);

    fireEvent.change(getTextarea(), { target: { value: "goal, audience" } });

    expect(onChange).toHaveBeenLastCalledWith([
      { key: "goal", type: "string", required: true },
      { key: "audience", type: "string", required: true },
    ]);
  });

  it("shows an error and suppresses onChange on invalid input", () => {
    const onChange = vi.fn();
    render(<OutputSchemaEditor schema={baseSchema} onChange={onChange} />);

    fireEvent.change(getTextarea(), { target: { value: "goal, goal" } });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Duplicate key 'goal'/)).toBeDefined();
  });

  it("reports validity changes", () => {
    const onValidityChange = vi.fn();
    render(
      <OutputSchemaEditor schema={baseSchema} onChange={vi.fn()} onValidityChange={onValidityChange} />,
    );

    fireEvent.change(getTextarea(), { target: { value: "a {" } });
    expect(onValidityChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(getTextarea(), { target: { value: "a" } });
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it("renders read-only when disabled", () => {
    render(<OutputSchemaEditor schema={baseSchema} onChange={vi.fn()} disabled />);
    expect(getTextarea().readOnly).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test OutputSchemaEditor`
Expected: FAIL — old component has no textarea labelled "Output Schema".

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `apps/desktop/src/workflows/OutputSchemaEditor.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { serializeOutputSchema, parseOutputSchemaText } from "./output-schema-text";

export interface OutputSchemaEditorProps {
  schema: WorkflowStepOutputSchema;
  onChange: (next: WorkflowStepOutputSchema) => void;
  disabled?: boolean;
  onValidityChange?: (valid: boolean) => void;
}

export function OutputSchemaEditor({
  schema,
  onChange,
  disabled = false,
  onValidityChange,
}: OutputSchemaEditorProps) {
  const [text, setText] = useState(() => serializeOutputSchema(schema));
  const [error, setError] = useState<string | null>(null);
  // Last serialized form we are in sync with; lets external schema changes re-seed
  // the box without clobbering in-progress (possibly non-canonical) typing.
  const synced = useRef(text);

  useEffect(() => {
    const incoming = serializeOutputSchema(schema);
    if (incoming !== synced.current) {
      synced.current = incoming;
      setText(incoming);
      setError(null);
      onValidityChange?.(true);
    }
  }, [schema, onValidityChange]);

  function handleText(value: string) {
    setText(value);
    const result = parseOutputSchemaText(value);
    if (result.ok) {
      setError(null);
      onValidityChange?.(true);
      synced.current = serializeOutputSchema(result.schema);
      onChange(result.schema);
    } else {
      setError(result.error);
      onValidityChange?.(false);
    }
  }

  return (
    <div>
      <span
        className="mono"
        style={{
          display: "block",
          marginBottom: 8,
          fontSize: 10,
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: 1.2,
        }}
      >
        Output Schema
      </span>
      <textarea
        aria-label="Output Schema"
        value={text}
        readOnly={disabled}
        onChange={(e) => !disabled && handleText(e.target.value)}
        spellCheck={false}
        style={{
          width: "100%",
          minHeight: 120,
          resize: "vertical",
          boxSizing: "border-box",
          background: "var(--bg)",
          color: "var(--text)",
          border: `1px solid ${error ? "var(--err)" : "var(--hairline)"}`,
          borderRadius: 6,
          padding: "8px 10px",
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 12,
          lineHeight: 1.55,
          outline: "none",
        }}
      />
      {error && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--err)" }}>{error}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test OutputSchemaEditor`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the broader workflow test suite to catch consumers**

Run: `pnpm --filter @orca/desktop test workflows`
Expected: PASS. If `StepEditor.test.tsx` or `NodeDetailModal.test.tsx` asserted on the old field-grid UI (Add field / Field N type / Remove field), update those assertions to the textarea (`getByLabelText("Output Schema")`). Make the minimal edit needed; do not change behavior.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @orca/desktop typecheck` (or `pnpm -w typecheck` if the package has no own script)
Expected: PASS — no unused imports left from the old component (`WorkflowStepOutputField`, `FieldType`, `ITEM_TYPES`, etc. are gone).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/workflows/OutputSchemaEditor.tsx apps/desktop/src/workflows/OutputSchemaEditor.test.tsx
git commit -m "feat(workflows): replace output schema field grid with text editor"
```

---

## Task 5 (optional polish): Disable Save while output schema text is invalid

Invalid text already never propagates, so a malformed schema cannot be saved — but Save would silently persist the last valid schema, ignoring the on-screen text. This task wires `onValidityChange` up to the Save control so the user gets explicit feedback.

Defer this if it proves to touch more than the three files below cleanly.

**Files:**
- Modify: `apps/desktop/src/workflows/StepEditor.tsx`
- Modify: `apps/desktop/src/workflows/NodeDetailModal.tsx`
- Modify: `apps/desktop/src/workflows/TemplateDetail.tsx`

- [ ] **Step 1: Add an invalid-output-schema flag to StepEditor**

In `StepEditor.tsx`, add an optional prop `onOutputSchemaValidityChange?: (invalid: boolean) => void` to the props type. Track invalid step indices in a `useState<Set<number>>`. Pass to each editor:

```tsx
<OutputSchemaEditor
  schema={step.outputSchema}
  onChange={(nextSchema) => updateStep(i, { outputSchema: nextSchema })}
  disabled={disabled}
  onValidityChange={(valid) =>
    setInvalidSteps((prev) => {
      const nextSet = new Set(prev);
      if (valid) nextSet.delete(i);
      else nextSet.add(i);
      return nextSet;
    })
  }
/>
```

Report aggregate upward in an effect: `useEffect(() => onOutputSchemaValidityChange?.(invalidSteps.size > 0), [invalidSteps, onOutputSchemaValidityChange]);`

- [ ] **Step 2: Mirror the same prop on NodeDetailModal**

In `NodeDetailModal.tsx`, thread an `onOutputSchemaValidityChange?: (invalid: boolean) => void` prop and pass `onValidityChange={(valid) => onOutputSchemaValidityChange?.(!valid)}` to its `OutputSchemaEditor` (single editor, so no Set needed).

- [ ] **Step 3: Gate Save in TemplateDetail**

In `TemplateDetail.tsx`, add `const [schemaInvalid, setSchemaInvalid] = useState(false);`, pass `onOutputSchemaValidityChange={setSchemaInvalid}` to `<StepEditor .../>` (and to `NodeDetailModal` if rendered here), and change the Save button to `disabled={!dirty || saving || duplicating || schemaInvalid}` (`TemplateDetail.tsx:456`).

- [ ] **Step 4: Test the gate**

Add to `TemplateDetail.test.tsx` (follow existing render helpers in that file) a test: render an editable template, type invalid output schema text into the "Output Schema" textarea, assert the "Save Changes" button is disabled; fix the text, assert it re-enables.

Run: `pnpm --filter @orca/desktop test TemplateDetail`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `pnpm --filter @orca/desktop test workflows`
Expected: PASS.

```bash
git add apps/desktop/src/workflows/StepEditor.tsx apps/desktop/src/workflows/NodeDetailModal.tsx apps/desktop/src/workflows/TemplateDetail.tsx apps/desktop/src/workflows/TemplateDetail.test.tsx
git commit -m "feat(workflows): disable Save while output schema text is invalid"
```

---

## Done When

- `output-schema-text.ts` parse/serialize round-trip every built-in schema (Task 3 green).
- `OutputSchemaEditor` is a single text area: seeds from schema, emits parsed schema on valid edits, shows inline error and suppresses `onChange` on invalid, read-only when disabled.
- `pnpm --filter @orca/desktop test workflows` and `typecheck` pass.
- (If Task 5 done) Save is disabled while any output schema text is invalid.
