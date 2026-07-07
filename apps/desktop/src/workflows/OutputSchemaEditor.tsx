import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { serializeOutputSchema, parseOutputSchemaText } from "./output-schema-text";

export interface OutputSchemaEditorProps {
  schema: WorkflowStepOutputSchema;
  onChange: (next: WorkflowStepOutputSchema) => void;
  disabled?: boolean;
  onValidityChange?: (valid: boolean) => void;
  /** Default textarea height; the modal passes a taller one than the inline list editor. */
  minHeight?: number;
}

// Split one line into code and comment at the first # that is not inside a
// quoted enum literal (the tokenizer treats # as comment-to-EOL the same way).
function splitComment(line: string): { code: string; comment: string | null } {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && inQuote) { i++; continue; }
    if (c === '"') { inQuote = !inQuote; continue; }
    if (c === "#" && !inQuote) return { code: line.slice(0, i), comment: line.slice(i) };
  }
  return { code: line, comment: null };
}

// Metrics shared by the textarea and the highlight layer — any drift between the
// two misaligns the caret against the painted glyphs.
const sharedTextStyle: CSSProperties = {
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 12,
  lineHeight: 1.55,
  padding: "8px 10px",
  boxSizing: "border-box",
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
  wordBreak: "break-word",
  border: "1px solid transparent",
  margin: 0,
};

export function OutputSchemaEditor({
  schema,
  onChange,
  disabled = false,
  onValidityChange,
  minHeight = 120,
}: OutputSchemaEditorProps) {
  const [text, setText] = useState(() => serializeOutputSchema(schema));
  const [error, setError] = useState<string | null>(null);
  // Last serialized form we are in sync with; lets external schema changes re-seed
  // the box without clobbering in-progress (possibly non-canonical) typing.
  const synced = useRef(text);
  const layerRef = useRef<HTMLPreElement>(null);

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

  function syncScroll(el: HTMLTextAreaElement) {
    const layer = layerRef.current;
    if (layer) { layer.scrollTop = el.scrollTop; layer.scrollLeft = el.scrollLeft; }
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
      <div
        style={{
          position: "relative",
          background: "var(--bg)",
          border: `1px solid ${error ? "var(--err)" : "var(--hairline)"}`,
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        {/* Paint layer: same text, comments dimmed. The textarea above it owns
            editing, caret, and selection; its own text is transparent. */}
        <pre
          aria-hidden
          ref={layerRef}
          style={{
            ...sharedTextStyle,
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            pointerEvents: "none",
            color: "var(--text)",
          }}
        >
          {text.split("\n").map((line, i, arr) => {
            const { code, comment } = splitComment(line);
            return (
              <span key={i}>
                {code}
                {comment != null && (
                  <span className="schema-comment" style={{ color: "var(--text-4)" }}>{comment}</span>
                )}
                {i < arr.length - 1 ? "\n" : ""}
              </span>
            );
          })}
          {"\n"}
        </pre>
        <textarea
          aria-label="Output Schema"
          value={text}
          readOnly={disabled}
          onChange={(e) => !disabled && handleText(e.target.value)}
          onScroll={(e) => syncScroll(e.currentTarget)}
          spellCheck={false}
          style={{
            ...sharedTextStyle,
            position: "relative",
            display: "block",
            width: "100%",
            minHeight,
            resize: "vertical",
            background: "transparent",
            color: "transparent",
            caretColor: "var(--text)",
            outline: "none",
          }}
        />
      </div>
      {error && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--err)" }}>{error}</div>
      )}
    </div>
  );
}
