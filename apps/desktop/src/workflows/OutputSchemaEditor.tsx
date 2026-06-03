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
