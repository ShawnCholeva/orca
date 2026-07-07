import { useEffect } from "react";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { GateGlyph, SplitterGlyph, CloseIcon, ChevronLeftIcon, ChevronRightIcon } from "./icons";
import { OutputSchemaEditor } from "./OutputSchemaEditor";

export type NodeDetail =
  | {
      kind: "step";
      name: string;
      instructions: string;
      outputSchema: WorkflowStepOutputSchema;
      terminal?: boolean;
      onChange: (patch: {
        name?: string;
        instructions?: string;
        outputSchema?: WorkflowStepOutputSchema;
        terminal?: boolean;
      }) => void;
    }
  | {
      kind: "gate";
      name: string;
      instructions: string;
      onChange: (patch: { name?: string; instructions?: string }) => void;
    }
  | {
      kind: "splitter";
      name: string;
      instructions: string;
      branches: string[];
      onChange: (patch: { name?: string; instructions?: string; branches?: string[] }) => void;
    };

export interface NodeDetailModalProps {
  detail: NodeDetail;
  index: number;
  total: number;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onClose: () => void;
  onDelete: () => void;
  readOnly?: boolean;
  onOutputSchemaValidityChange?: (invalid: boolean) => void;
}

export function NodeDetailModal({
  detail,
  index,
  total,
  onPrev,
  onNext,
  onClose,
  onDelete,
  readOnly = false,
  onOutputSchemaValidityChange,
}: NodeDetailModalProps) {
  const isGate = detail.kind === "gate";
  const isSplitter = detail.kind === "splitter";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && onPrev) onPrev();
      if (e.key === "ArrowRight" && onNext) onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 50,
        background: "rgba(5,5,8,0.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(980px, 92%)",
          maxHeight: "90%",
          background: "var(--panel)",
          border: "1px solid var(--hairline-strong)",
          borderRadius: 14,
          boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "14px 16px",
            borderBottom: "1px solid var(--hairline)",
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: isGate || isSplitter ? 15 : 7,
              background: "var(--accent-soft)",
              color: "var(--accent)",
              border: "1px solid var(--accent-line)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            {isGate ? <GateGlyph size={14} /> : isSplitter ? <SplitterGlyph size={14} /> : String(index + 1).padStart(2, "0")}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              className="mono"
              style={{
                fontSize: 10.5,
                color: "var(--text-3)",
                textTransform: "uppercase",
                letterSpacing: 1.2,
              }}
            >
              {isGate ? "Gate" : isSplitter ? "Splitter" : "Workflow step"} · {index + 1} of {total}
            </div>
            <input
              value={detail.name ?? ""}
              onChange={(e) => !readOnly && detail.onChange({ name: e.target.value })}
              readOnly={readOnly}
              placeholder={isGate ? "Gate name" : isSplitter ? "Splitter name" : "Step name"}
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                outline: "none",
                color: "var(--text)",
                fontFamily: "inherit",
                fontSize: 15,
                fontWeight: 600,
                letterSpacing: -0.2,
                padding: "2px 0",
                borderBottom: "1px dashed transparent",
              }}
              onFocus={(e) => (e.currentTarget.style.borderBottomColor = "var(--hairline-strong)")}
              onBlur={(e) => (e.currentTarget.style.borderBottomColor = "transparent")}
            />
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22, borderRadius: 7,
              background: "transparent", border: "1px solid transparent",
              color: "var(--text-2)", cursor: "pointer",
            }}
          >
            <CloseIcon size={13} />
          </button>
        </header>

        {/* Body */}
        <div
          className="scroll"
          style={{
            flex: 1,
            padding: 18,
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {isGate ? (
            <GateBody detail={detail as Extract<NodeDetail, { kind: "gate" }>} readOnly={readOnly} />
          ) : isSplitter ? (
            <SplitterBody detail={detail as Extract<NodeDetail, { kind: "splitter" }>} readOnly={readOnly} />
          ) : (
            <StepBody
              detail={detail as Extract<NodeDetail, { kind: "step" }>}
              readOnly={readOnly}
              onOutputSchemaValidityChange={onOutputSchemaValidityChange}
            />
          )}
        </div>

        {/* Footer */}
        <footer
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 16px",
            borderTop: "1px solid var(--hairline)",
          }}
        >
          <FooterBtn onClick={onPrev ?? undefined} disabled={!onPrev}>
            <ChevronLeftIcon size={13} />
            Prev
          </FooterBtn>
          <FooterBtn onClick={onNext ?? undefined} disabled={!onNext}>
            Next
            <ChevronRightIcon size={13} />
          </FooterBtn>
          <div style={{ flex: 1 }} />
          {!readOnly && <FooterBtn onClick={onDelete}>Delete</FooterBtn>}
          <FooterBtn onClick={onClose} primary>
            Done
          </FooterBtn>
        </footer>
      </div>
    </div>
  );
}

function GateBody({ detail, readOnly }: { detail: Extract<NodeDetail, { kind: "gate" }>; readOnly?: boolean }) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: 1.2,
          marginBottom: 6,
        }}
      >
        Instructions
      </div>
      <textarea
        value={detail.instructions ?? ""}
        onChange={(e) => !readOnly && detail.onChange({ instructions: e.target.value })}
        readOnly={readOnly}
        placeholder="Approve only when … ; otherwise reject."
        rows={5}
        style={{
          width: "100%",
          resize: "vertical",
          minHeight: 96,
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--hairline)",
          borderRadius: 7,
          padding: "10px 12px",
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 12.5,
          lineHeight: 1.5,
          outline: "none",
          boxSizing: "border-box",
        }}
      />
      <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 8, lineHeight: 1.5 }}>
        The gate routes work through fixed <strong>approved</strong> or <strong>rejected</strong> ports.
        Provide routing criteria; the orchestrator records a decision with justification before advancing.
      </div>
    </div>
  );
}

function SplitterBody({ detail, readOnly }: { detail: Extract<NodeDetail, { kind: "splitter" }>; readOnly?: boolean }) {
  const branches = detail.branches ?? [];
  const rename = (i: number, value: string) =>
    detail.onChange({ branches: branches.map((b, j) => (j === i ? value : b)) });
  const add = () => detail.onChange({ branches: [...branches, `Branch ${String.fromCharCode(65 + branches.length)}`] });
  const remove = (i: number) => detail.onChange({ branches: branches.filter((_, j) => j !== i) });
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: 1.2,
          marginBottom: 6,
        }}
      >
        Instructions
      </div>
      <textarea
        value={detail.instructions ?? ""}
        onChange={(e) => !readOnly && detail.onChange({ instructions: e.target.value })}
        readOnly={readOnly}
        placeholder="Route to the branch that best fits the goal; e.g. if vague, go clarify."
        rows={5}
        style={{
          width: "100%",
          resize: "vertical",
          minHeight: 96,
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--hairline)",
          borderRadius: 7,
          padding: "10px 12px",
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 12.5,
          lineHeight: 1.5,
          outline: "none",
          boxSizing: "border-box",
        }}
      />
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: 1.2,
          marginTop: 16,
          marginBottom: 6,
        }}
      >
        Branches
      </div>
      {branches.map((b, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <input
            value={b}
            maxLength={60}
            readOnly={readOnly}
            onChange={(e) => !readOnly && rename(i, e.target.value)}
            style={{
              flex: 1,
              background: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--hairline)",
              borderRadius: 7,
              padding: "6px 10px",
              fontFamily: "inherit",
              fontSize: 13,
              outline: "none",
            }}
          />
          {!readOnly && branches.length > 2 && (
            <button
              type="button"
              onClick={() => remove(i)}
              title="Remove branch"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 26,
                height: 26,
                borderRadius: 7,
                background: "transparent",
                border: "1px solid transparent",
                color: "var(--text-2)",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {!readOnly && branches.length < 8 && (
        <button
          type="button"
          onClick={add}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 26,
            padding: "0 10px",
            borderRadius: 7,
            background: "transparent",
            border: "1px solid transparent",
            color: "var(--text-2)",
            fontFamily: "inherit",
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            marginTop: 6,
          }}
        >
          Add branch
        </button>
      )}
      <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 8, lineHeight: 1.5 }}>
        The splitter reasons over context and routes to exactly one branch. Wire one outgoing edge per branch on the canvas.
      </div>
    </div>
  );
}

function StepBody({
  detail,
  readOnly,
  onOutputSchemaValidityChange,
}: {
  detail: Extract<NodeDetail, { kind: "step" }>;
  readOnly?: boolean;
  onOutputSchemaValidityChange?: (invalid: boolean) => void;
}) {
  return (
    <>
      <div>
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--text-3)",
            textTransform: "uppercase",
            letterSpacing: 1.2,
            marginBottom: 6,
          }}
        >
          Instructions
        </div>
        <textarea
          value={detail.instructions ?? ""}
          onChange={(e) => !readOnly && detail.onChange({ instructions: e.target.value })}
          readOnly={readOnly}
          placeholder="What this step should accomplish."
          rows={9}
          style={{
            width: "100%",
            resize: "vertical",
            minHeight: 170,
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--hairline)",
            borderRadius: 7,
            padding: "10px 12px",
            fontFamily: "inherit",
            fontSize: 13,
            lineHeight: 1.55,
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>

      <OutputSchemaEditor
        schema={detail.outputSchema}
        onChange={(next) => !readOnly && detail.onChange({ outputSchema: next })}
        disabled={readOnly}
        onValidityChange={(valid) => onOutputSchemaValidityChange?.(!valid)}
        minHeight={300}
      />

      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          aria-label="Terminal step"
          checked={detail.terminal ?? false}
          onChange={(e) => !readOnly && detail.onChange({ terminal: e.target.checked })}
        />
        Terminal step (completes the workflow)
      </label>
    </>
  );
}

interface FooterBtnProps {
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
  children: React.ReactNode;
}

function FooterBtn({ onClick, disabled, primary, children }: FooterBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 26,
        padding: "0 10px",
        borderRadius: 7,
        background: primary ? "var(--accent)" : "transparent",
        border: "1px solid transparent",
        color: primary ? "#FFFFFF" : "var(--text-2)",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
        letterSpacing: 0.1,
      }}
    >
      {children}
    </button>
  );
}
