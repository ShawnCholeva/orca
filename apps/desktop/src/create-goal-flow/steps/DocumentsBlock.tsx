import { useState, type CSSProperties, type Dispatch } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import type { FlowAction, PendingDocument } from "../state";
import { expandTilde } from "../../utils/path";
import { detectDocumentKind, defaultDocumentName } from "../documents";
import { FieldGroup, Btn, Pill, inputStyle } from "../../workspaces/primitives";

const DOCS_SOFT_CAP = 20;

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "8px 10px",
  background: "var(--panel-2)",
  border: "1px solid var(--hairline)",
  borderRadius: 8,
};

const monoPathStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--text-3)",
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const mutedStyle: CSSProperties = { fontSize: 12, color: "var(--text-3)", margin: 0 };
const errorStyle: CSSProperties = { fontSize: 12, color: "var(--err)", margin: 0 };

// ── Document row ───────────────────────────────────────────────
function DocumentRow({
  doc,
  index,
  dispatch,
}: {
  doc: PendingDocument;
  index: number;
  dispatch: Dispatch<FlowAction>;
}) {
  return (
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{doc.name}</span>
        <span style={monoPathStyle}>{doc.ref}</span>
        <div>
          <Pill tone="neutral" size="xs">
            {doc.kind}
          </Pill>
        </div>
      </div>
      <Btn kind="danger" size="xs" onClick={() => dispatch({ type: "removeDocument", index })}>
        Remove
      </Btn>
    </div>
  );
}

// ── Reference documents block ──────────────────────────────────
export function DocumentsBlock({
  documents,
  dispatch,
}: {
  documents: PendingDocument[];
  dispatch: Dispatch<FlowAction>;
}) {
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const atCap = documents.length >= DOCS_SOFT_CAP;

  function addResolvedRef(kind: "file" | "url", resolved: string): boolean {
    if (documents.some((d) => d.ref === resolved)) {
      setError("Document already added.");
      return false;
    }
    setError(null);
    dispatch({
      type: "addDocument",
      document: { kind, ref: resolved, name: defaultDocumentName(kind, resolved) },
    });
    return true;
  }

  async function handleAdd() {
    const trimmed = ref.trim();
    if (!trimmed || atCap) return;
    const kind = detectDocumentKind(trimmed);
    const resolved = kind === "file" ? await expandTilde(trimmed) : trimmed;
    if (addResolvedRef(kind, resolved)) setRef("");
  }

  async function handleBrowse() {
    if (atCap) return;
    const selected = await openDialog({ directory: false, multiple: true });
    if (!selected) return;
    for (const path of Array.isArray(selected) ? selected : [selected]) {
      addResolvedRef("file", path as string);
    }
  }

  return (
    <FieldGroup
      label="Reference documents"
      hint="Attach plans or docs (local files or links) to include in the Goal's context."
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {documents.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {documents.map((doc, i) => (
              <DocumentRow key={doc.ref} doc={doc} index={i} dispatch={dispatch} />
            ))}
          </div>
        )}
        {atCap ? (
          <p style={mutedStyle}>Maximum {DOCS_SOFT_CAP} documents reached.</p>
        ) : (
          <>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="text"
                value={ref}
                onChange={(e) => {
                  setRef(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleAdd();
                  }
                }}
                placeholder="/path/to/plan.md or https://…"
                aria-label="Document path or URL"
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
              />
              <Btn kind="primary" onClick={() => void handleAdd()} disabled={!ref.trim()}>
                Add
              </Btn>
              {/* Tauri-only, same reason as the workspace picker. No fallback is
                  needed here: the text input beside it already accepts a path or a
                  URL, so browser mode loses the convenience and keeps the capability. */}
              {isTauri() && (
                <Btn kind="quiet" onClick={() => void handleBrowse()}>
                  Browse…
                </Btn>
              )}
            </div>
            {error && <p style={errorStyle}>{error}</p>}
          </>
        )}
      </div>
    </FieldGroup>
  );
}
