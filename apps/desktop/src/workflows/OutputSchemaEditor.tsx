import type { WorkflowStepOutputSchema, WorkflowStepOutputField } from "@orca/contracts";

type FieldType = WorkflowStepOutputField["type"];
type ItemType = NonNullable<WorkflowStepOutputField["itemType"]>;

const FIELD_TYPES: FieldType[] = ["string", "number", "boolean", "array", "object"];
const ITEM_TYPES: ItemType[] = ["string", "number", "boolean", "object"];

export interface OutputSchemaEditorProps {
  schema: WorkflowStepOutputSchema;
  onChange: (next: WorkflowStepOutputSchema) => void;
  disabled?: boolean;
}

export function OutputSchemaEditor({ schema, onChange, disabled = false }: OutputSchemaEditorProps) {
  function handleFieldChange(fieldIndex: number, patch: Partial<WorkflowStepOutputField>) {
    onChange(schema.map((field, i) => (i === fieldIndex ? { ...field, ...patch } : field)));
  }

  function handleAddField() {
    if (schema.length >= 32) return;
    onChange([...schema, { key: "field", type: "string" as FieldType, required: true }]);
  }

  function handleRemoveField(fieldIndex: number) {
    if (schema.length <= 1) return;
    onChange(schema.filter((_, i) => i !== fieldIndex));
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--text-3)",
            textTransform: "uppercase",
            letterSpacing: 1.2,
          }}
        >
          Output Schema
        </span>
        {!disabled && (
          <button
            type="button"
            onClick={handleAddField}
            disabled={schema.length >= 32}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              height: 22, padding: "0 8px", borderRadius: 7,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--hairline)",
              color: "var(--text)", fontFamily: "inherit",
              fontSize: 11.5, fontWeight: 500,
              cursor: schema.length >= 32 ? "not-allowed" : "pointer",
              opacity: schema.length >= 32 ? 0.5 : 1,
            }}
          >
            Add field
          </button>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {schema.map((field, fieldIndex) => (
          <div
            key={fieldIndex}
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 6,
              padding: "8px 10px",
              background: "var(--bg)",
              border: "1px solid var(--hairline)",
              borderRadius: 6,
            }}
          >
            <input
              type="text"
              aria-label={`Field ${fieldIndex + 1} key`}
              value={field.key}
              onChange={(e) => handleFieldChange(fieldIndex, { key: e.target.value })}
              disabled={disabled}
              placeholder="key"
              style={{
                width: 100,
                background: "transparent",
                border: "1px solid var(--hairline)",
                borderRadius: 5,
                padding: "4px 8px",
                color: "var(--text)",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11.5,
                outline: "none",
              }}
            />
            <select
              aria-label={`Field ${fieldIndex + 1} type`}
              value={field.type}
              onChange={(e) => {
                const nextType = e.target.value as FieldType;
                const patch: Partial<WorkflowStepOutputField> = { type: nextType };
                if (nextType !== "array") patch.itemType = undefined;
                handleFieldChange(fieldIndex, patch);
              }}
              disabled={disabled}
              style={{
                background: "var(--panel)",
                border: "1px solid var(--hairline)",
                borderRadius: 5,
                padding: "4px 6px",
                color: "var(--text)",
                fontFamily: "inherit",
                fontSize: 11.5,
                outline: "none",
                cursor: disabled ? "not-allowed" : "pointer",
              }}
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>

            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11.5,
                color: "var(--text-2)",
                cursor: disabled ? "not-allowed" : "pointer",
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={field.required}
                onChange={(e) => handleFieldChange(fieldIndex, { required: e.target.checked })}
                disabled={disabled}
              />
              required
            </label>

            <input
              type="text"
              aria-label={`Field ${fieldIndex + 1} description`}
              value={field.description ?? ""}
              onChange={(e) =>
                handleFieldChange(fieldIndex, {
                  description: e.target.value || undefined,
                })
              }
              disabled={disabled}
              placeholder="description (optional)"
              style={{
                flex: 1,
                minWidth: 100,
                background: "transparent",
                border: "1px solid var(--hairline)",
                borderRadius: 5,
                padding: "4px 8px",
                color: "var(--text)",
                fontFamily: "inherit",
                fontSize: 11.5,
                outline: "none",
              }}
            />

            {field.type === "array" && (
              <select
                aria-label={`Field ${fieldIndex + 1} item type`}
                value={field.itemType ?? ""}
                onChange={(e) =>
                  handleFieldChange(fieldIndex, {
                    itemType: (e.target.value as ItemType) || undefined,
                  })
                }
                disabled={disabled}
                style={{
                  background: "var(--panel)",
                  border: "1px solid var(--hairline)",
                  borderRadius: 5,
                  padding: "4px 6px",
                  color: "var(--text)",
                  fontFamily: "inherit",
                  fontSize: 11.5,
                  outline: "none",
                  cursor: disabled ? "not-allowed" : "pointer",
                }}
              >
                <option value="">item type (optional)</option>
                {ITEM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}

            {!disabled && (
              <button
                type="button"
                onClick={() => handleRemoveField(fieldIndex)}
                disabled={schema.length <= 1}
                title="Remove field"
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22, borderRadius: 5,
                  background: "var(--err-soft)",
                  border: "none",
                  color: "var(--err)",
                  cursor: schema.length <= 1 ? "not-allowed" : "pointer",
                  opacity: schema.length <= 1 ? 0.4 : 1,
                  fontFamily: "inherit",
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
