import { useEffect, useRef, useState, type CSSProperties } from "react";
import { WorkflowStepOutputSchema as WorkflowStepOutputSchemaValue } from "@orca/contracts";
import type { WorkflowStepOutputField, WorkflowStepOutputSchema } from "@orca/contracts";
import { ChevronRightIcon, CloseIcon } from "./icons";

export interface OutputSchemaEditorProps {
  schema: WorkflowStepOutputSchema;
  onChange: (next: WorkflowStepOutputSchema) => void;
  disabled?: boolean;
  onValidityChange?: (valid: boolean) => void;
}

// One <select> value per shape the contract can express. `[]` is an untyped list
// (type array, no itemType) — never authored here, but it must round-trip.
const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "string", label: "text" },
  { value: "number", label: "number" },
  { value: "boolean", label: "yes / no" },
  { value: "string[]", label: "text list" },
  { value: "number[]", label: "number list" },
  { value: "boolean[]", label: "yes / no list" },
  { value: "object", label: "object" },
  { value: "object[]", label: "object list" },
  { value: "[]", label: "list" },
];

function typeValue(f: WorkflowStepOutputField): string {
  if (f.type === "array") return f.itemType ? `${f.itemType}[]` : "[]";
  return f.type;
}

function withType(f: WorkflowStepOutputField, value: string): WorkflowStepOutputField {
  const { type: _t, itemType: _i, enum: _e, fields: _f, ...base } = f;
  switch (value) {
    case "string":
      return f.enum ? { ...base, type: "string", enum: f.enum } : { ...base, type: "string" };
    case "number":
    case "boolean":
      return { ...base, type: value };
    case "[]":
      return { ...base, type: "array" };
    case "object":
      return f.fields ? { ...base, type: "object", fields: f.fields } : { ...base, type: "object" };
    case "object[]":
      return f.fields
        ? { ...base, type: "array", itemType: "object", fields: f.fields }
        : { ...base, type: "array", itemType: "object" };
    default: {
      const itemType = value.slice(0, -2) as "string" | "number" | "boolean";
      return { ...base, type: "array", itemType };
    }
  }
}

function hasNestedFields(f: WorkflowStepOutputField): boolean {
  return f.type === "object" || (f.type === "array" && f.itemType === "object");
}

// Draft-level checks the contract's zod schema reports poorly (or not at all):
// a blank name is what a freshly added row has, and a duplicate would silently
// collapse into one key at runtime.
function findDraftError(fields: WorkflowStepOutputField[]): string | null {
  const seen = new Set<string>();
  for (const f of fields) {
    if (!f.key) return "Every field needs a name";
    if (seen.has(f.key)) return `Duplicate key '${f.key}'`;
    seen.add(f.key);
    if (f.fields) {
      const nested = findDraftError(f.fields);
      if (nested) return nested;
    }
  }
  return null;
}

function validate(fields: WorkflowStepOutputField[]): string | null {
  const draftError = findDraftError(fields);
  if (draftError) return draftError;
  const result = WorkflowStepOutputSchemaValue.safeParse(fields);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

const cellInput: CSSProperties = {
  width: "100%",
  background: "transparent",
  border: "none",
  outline: "none",
  color: "var(--text)",
  fontFamily: "inherit",
  fontSize: 12.5,
  padding: "6px 8px",
  boxSizing: "border-box",
};

const monoLabel: CSSProperties = {
  fontSize: 10,
  color: "var(--text-3)",
  textTransform: "uppercase",
  letterSpacing: 1.2,
};

const iconButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 6,
  background: "transparent",
  border: "1px solid transparent",
  color: "var(--text-3)",
  cursor: "pointer",
  padding: 0,
};

// Column widths shared by the header and every row so they line up.
const COL = { type: 118, required: 80, shownTo: 118, icons: 52 };

export function OutputSchemaEditor({
  schema,
  onChange,
  disabled = false,
  onValidityChange,
}: OutputSchemaEditorProps) {
  const [draft, setDraft] = useState<WorkflowStepOutputField[]>(schema);
  const [error, setError] = useState<string | null>(null);
  // Last schema we emitted (or were seeded with); lets an external change re-seed
  // the rows without clobbering an in-progress draft that is not yet valid.
  const synced = useRef(JSON.stringify(schema));

  useEffect(() => {
    const incoming = JSON.stringify(schema);
    if (incoming !== synced.current) {
      synced.current = incoming;
      setDraft(schema);
      setError(null);
      onValidityChange?.(true);
    }
  }, [schema, onValidityChange]);

  function update(next: WorkflowStepOutputField[]) {
    setDraft(next);
    const problem = validate(next);
    setError(problem);
    onValidityChange?.(problem === null);
    if (problem === null) {
      synced.current = JSON.stringify(next);
      onChange(next);
    }
  }

  return (
    <div>
      <span className="mono" style={{ ...monoLabel, display: "block", marginBottom: 8 }}>
        Output Schema
      </span>
      <div
        style={{
          background: "var(--bg)",
          border: `1px solid ${error ? "var(--err)" : "var(--hairline)"}`,
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <div
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            padding: "6px 8px",
            borderBottom: "1px solid var(--hairline)",
            ...monoLabel,
          }}
        >
          <span style={{ flex: 1 }}>Name</span>
          <span style={{ width: COL.type }}>Type</span>
          <span style={{ width: COL.required, textAlign: "center" }}>Required</span>
          <span style={{ width: COL.shownTo }}>Shown to</span>
          <span style={{ width: COL.icons }} />
        </div>
        <FieldRows fields={draft} onChange={update} disabled={disabled} path="" />
        {!disabled && (
          <AddButton label="Add field" onClick={() => update([...draft, { key: "", type: "string", required: true }])} />
        )}
      </div>
      {error && <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--err)" }}>{error}</div>}
    </div>
  );
}

function FieldRows({
  fields,
  onChange,
  disabled,
  path,
}: {
  fields: WorkflowStepOutputField[];
  onChange: (next: WorkflowStepOutputField[]) => void;
  disabled: boolean;
  /** "" at the top level, "2." for the children of field 2. */
  path: string;
}) {
  const nested = path !== "";
  return (
    <>
      {fields.map((f, i) => (
        <FieldRow
          key={i}
          field={f}
          label={`${path}${i + 1}`}
          nested={nested}
          disabled={disabled}
          onChange={(next) => onChange(fields.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(fields.filter((_, j) => j !== i))}
        />
      ))}
    </>
  );
}

function FieldRow({
  field,
  label,
  nested,
  disabled,
  onChange,
  onRemove,
}: {
  field: WorkflowStepOutputField;
  label: string;
  nested: boolean;
  disabled: boolean;
  onChange: (next: WorkflowStepOutputField) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const shownTo = field.display ?? "agent";

  function setNested(next: WorkflowStepOutputField[]) {
    const { fields: _f, ...rest } = field;
    onChange(next.length ? { ...rest, fields: next } : rest);
  }

  function setEnum(raw: string) {
    const values = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const { enum: _e, ...rest } = field;
    onChange(values.length ? { ...rest, enum: values } : rest);
  }

  function setDescription(raw: string) {
    const { description: _d, ...rest } = field;
    onChange(raw ? { ...rest, description: raw } : rest);
  }

  return (
    <div style={{ borderTop: "1px solid var(--hairline)" }}>
      <div style={{ display: "flex", alignItems: "center", paddingLeft: nested ? 22 : 0 }}>
        <input
          aria-label={`Field ${label} name`}
          value={field.key}
          disabled={disabled}
          placeholder="field_name"
          spellCheck={false}
          onChange={(e) => onChange({ ...field, key: e.target.value })}
          style={{ ...cellInput, flex: 1, fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}
        />
        <select
          aria-label={`Field ${label} type`}
          value={typeValue(field)}
          disabled={disabled}
          onChange={(e) => onChange(withType(field, e.target.value))}
          style={{ ...cellInput, width: COL.type, cursor: disabled ? "default" : "pointer" }}
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <div style={{ width: COL.required, display: "flex", justifyContent: "center" }}>
          <input
            type="checkbox"
            aria-label={`Field ${label} required`}
            checked={field.required}
            disabled={disabled}
            onChange={(e) => onChange({ ...field, required: e.target.checked })}
          />
        </div>
        <div style={{ width: COL.shownTo }}>
          {!nested && (
            <div
              role="radiogroup"
              aria-label={`Field ${label} shown to`}
              style={{
                display: "inline-flex",
                border: "1px solid var(--hairline)",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              {(["user", "agent"] as const).map((who) => {
                const on = shownTo === who;
                return (
                  <button
                    key={who}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={disabled}
                    onClick={() => !on && onChange({ ...field, display: who })}
                    style={{
                      padding: "3px 9px",
                      fontFamily: "inherit",
                      fontSize: 11.5,
                      fontWeight: on ? 600 : 500,
                      background: on ? "var(--accent-soft)" : "transparent",
                      color: on ? "var(--accent)" : "var(--text-3)",
                      border: "none",
                      cursor: disabled ? "default" : "pointer",
                    }}
                  >
                    {who === "user" ? "User" : "Agent"}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div style={{ width: COL.icons, display: "flex", justifyContent: "flex-end", gap: 2, paddingRight: 6 }}>
          <button
            type="button"
            aria-label={`Field ${label} options`}
            aria-expanded={open}
            title="Description and allowed values"
            onClick={() => setOpen((v) => !v)}
            style={{
              ...iconButton,
              color: open || field.description || field.enum ? "var(--text-2)" : "var(--text-4, var(--text-3))",
              transform: open ? "rotate(90deg)" : "none",
            }}
          >
            <ChevronRightIcon size={12} />
          </button>
          {!disabled && (
            <button
              type="button"
              aria-label={`Remove field ${label}`}
              title="Remove field"
              onClick={onRemove}
              style={iconButton}
            >
              <CloseIcon size={10} />
            </button>
          )}
        </div>
      </div>

      {open && (
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "0 8px 8px",
            paddingLeft: nested ? 30 : 8,
          }}
        >
          <input
            aria-label={`Field ${label} description`}
            value={field.description ?? ""}
            disabled={disabled}
            placeholder="Description (optional)"
            onChange={(e) => setDescription(e.target.value)}
            style={{ ...cellInput, flex: 1, border: "1px solid var(--hairline)", borderRadius: 6, background: "var(--panel)" }}
          />
          {field.type === "string" && (
            <input
              aria-label={`Field ${label} allowed values`}
              value={field.enum?.join(", ") ?? ""}
              disabled={disabled}
              placeholder="Allowed values, comma-separated (optional)"
              spellCheck={false}
              onChange={(e) => setEnum(e.target.value)}
              style={{ ...cellInput, flex: 1, border: "1px solid var(--hairline)", borderRadius: 6, background: "var(--panel)" }}
            />
          )}
        </div>
      )}

      {hasNestedFields(field) && (
        <div style={{ marginLeft: nested ? 30 : 8, borderLeft: "2px solid var(--hairline-strong)" }}>
          <FieldRows fields={field.fields ?? []} onChange={setNested} disabled={disabled} path={`${label}.`} />
          {!disabled && (
            <AddButton
              label={`Add field to ${field.key || `field ${label}`}`}
              onClick={() => setNested([...(field.fields ?? []), { key: "", type: "string", required: true }])}
            />
          )}
        </div>
      )}
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 26,
        margin: "4px 4px",
        padding: "0 8px",
        borderRadius: 6,
        background: "transparent",
        border: "1px solid transparent",
        color: "var(--text-2)",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 500,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
