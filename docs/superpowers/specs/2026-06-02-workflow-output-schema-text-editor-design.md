# Workflow Step Output Schema — Text Editor

**Date:** 2026-06-02
**Branch:** feat/workflows-dag-redesign
**Status:** Design approved, pending spec review

## Problem

The workflow step output schema is authored through a field-by-field clicky UI
(`OutputSchemaEditor.tsx`): one row per field with key input, type `<select>`,
required checkbox, description input, and item-type `<select>`. Defining a
multi-field nested schema is slow and tedious.

The user wants a single open text field where the whole schema is typed in a
compact shorthand, e.g.:

```
intent: {
  goal,
  audience,
  success_criteria,
  open_questions[]
}
```

## Goals

- Replace the field-by-field editor with one text area.
- Bare field names default to `string` + required — the common case stays terse.
- Express the full existing schema (types, optional, arrays, item-types, nested
  objects, arrays-of-objects, descriptions) when needed — **lossless** round-trip.
- Keep the runtime contract unchanged: storage stays `WorkflowStepOutputSchema`
  (structured), so `validateStepOutput` and the LLM structured-output prompt are
  untouched.

## Non-Goals

- No change to `WorkflowStepOutputSchema` contract, daemon, or validation logic.
- No change to the consuming components' prop contract.
- No new schema capability beyond what the contract already supports.

## Approach

The text area is **internal** to `OutputSchemaEditor`. Its existing props are
unchanged; one optional prop (`onValidityChange`) is added:

```ts
{ schema: WorkflowStepOutputSchema; onChange: (next) => void; disabled?: boolean;
  onValidityChange?: (valid: boolean) => void }
```

Two pure functions do the work, in a new `output-schema-text.ts` module:

- `serializeOutputSchema(schema: WorkflowStepOutputSchema): string`
- `parseOutputSchemaText(text: string): { ok: true; schema } | { ok: false; error: string }`

`serialize ∘ parse` and `parse ∘ serialize` round-trip losslessly (canonical
form). These get the bulk of the unit tests.

### Component behavior

- Holds internal `text` state, seeded from `serializeOutputSchema(schema)`.
- Re-seeds from the prop when the incoming `schema` identity changes from outside
  (switching steps, external edits) **and** the prop differs from the current
  text's parse — avoids clobbering in-progress typing.
- On each edit: parse the text.
  - Valid → call `onChange(parsed.schema)`.
  - Invalid → do **not** call `onChange`; show an inline error message and a red
    border. Parent keeps the last valid schema.
- `disabled` → render the serialized text read-only (built-in locked templates).

### Save gating

Invalid text never propagates, so an invalid schema can never be saved. To avoid
the surprise of "Save uses my last valid text, not what's on screen," the editor
exposes an optional `onValidityChange?(valid: boolean)` callback. `StepEditor`
and `NodeDetailModal` disable their Save control while any output-schema editor
reports invalid. (Feasibility of wiring this into the existing dirty/Save path is
confirmed during planning; if disproportionate, fall back to inline-error-only.)

## Grammar (Typed)

A schema is a comma- and/or newline-separated list of fields. The top level is
the same field list, unbraced. Trailing commas tolerated. Whitespace
insignificant.

```
field      := name "?"? typeSpec? description?
name       := [A-Za-z_][A-Za-z0-9_]*          ; 1..64 chars
"?"        := optional marker; absence ⇒ required: true
typeSpec   := (empty)                ⇒ { type: "string" }
            | ": string"             ⇒ { type: "string" }
            | ": number"             ⇒ { type: "number" }
            | ": boolean"            ⇒ { type: "boolean" }
            | "[]"                   ⇒ { type: "array" }                       (no itemType)
            | ": string[]"           ⇒ { type: "array", itemType: "string" }
            | ": number[]"           ⇒ { type: "array", itemType: "number" }
            | ": boolean[]"          ⇒ { type: "array", itemType: "boolean" }
            | "{" fieldlist "}"      ⇒ { type: "object", fields: [...] }
            | "[]" "{" fieldlist "}" ⇒ { type: "array", itemType: "object", fields: [...] }
description := "#" rest-of-line       ⇒ { description: trimmed }              ; 0..256 chars
```

Notes:
- `?` sits between name and type: `skipped?`, `change_requests?: string[]`.
- `#` description runs to end of line; only valid on single-line fields. Objects
  spanning lines may attach a description on their opening line:
  `test_results: { # ... ` — keep it simple: description allowed only on fields
  without a multi-line `{ ... }` body. (Built-ins use no descriptions, so this is
  a rare path.)
- Canonical serialization: nested objects/arrays-of-objects pretty-print across
  lines with 2-space indent; flat fields on their own line; `string` type omitted
  (bare); `?` for optional; `#` description appended.

### Worked example — the `implement` built-in (lossless)

Structured:
```ts
summary: string (req)
changed_files: string[] (req)
test_results: object (req) { ran: boolean(req), passed: boolean(req), skipped: string(opt) }
blocked: boolean (req)
blocked_reason: string (opt)
```

Text (canonical serialization):
```
summary,
changed_files: string[],
test_results: {
  ran: boolean,
  passed: boolean,
  skipped?
},
blocked: boolean,
blocked_reason?
```

## Parser errors

`parseOutputSchemaText` returns a single human-readable `error` string on the
first problem. Cases:
- Empty schema (contract requires ≥1 field).
- Duplicate key at the same level.
- Invalid name (chars / length > 64).
- Unknown type token.
- Unbalanced `{ }`.
- Nesting deeper than the contract allows (`fields` max depth — mirror
  `WorkflowStepOutputField` limits: array max 32 per level).

After a successful structural parse, the result is validated through
`WorkflowStepOutputSchema.parse()` (zod) as the final authority, so the parser
never produces a schema the contract would reject.

## Files

- **New:** `apps/desktop/src/workflows/output-schema-text.ts` — parse/serialize.
- **New:** `apps/desktop/src/workflows/output-schema-text.test.ts` — round-trip +
  error-case unit tests, including every built-in template schema.
- **Rewrite:** `apps/desktop/src/workflows/OutputSchemaEditor.tsx` — text area +
  internal state + error display; same external props (plus optional
  `onValidityChange`).
- **Rewrite:** `apps/desktop/src/workflows/OutputSchemaEditor.test.tsx` — cover
  text editing, invalid-input error display, disabled read-only.
- **Maybe edit:** `StepEditor.tsx`, `NodeDetailModal.tsx` — wire
  `onValidityChange` into Save gating (only if planning confirms it's clean).

## Testing

- Unit: `parse`/`serialize` round-trip on every built-in schema + hand-written
  edge cases (optional, number, boolean, typed arrays, nested objects,
  arrays-of-objects, descriptions).
- Unit: each parser error case yields a clear message.
- Component: typing valid text fires `onChange` with correct schema; invalid text
  shows error and suppresses `onChange`; `disabled` renders read-only.

## Risks

- **Grammar ambiguity / parser bugs.** Mitigated by the zod re-validation backstop
  and exhaustive round-trip tests over real schemas.
- **Description on multi-line objects** is a corner the grammar restricts rather
  than fully solving; acceptable since no template uses descriptions.
