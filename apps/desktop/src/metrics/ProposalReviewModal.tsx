import { useState } from "react";
import type { TemplateInstructionProposal } from "@orca/contracts";
import { Btn } from "../workspaces/primitives";
import { Sparkle, Close, Check } from "./metrics-icons";
import { diffLines, schemaChips, type DiffLine, type SchemaChip } from "./proposal-diff";

function ChipRow({ chips }: { chips: SchemaChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {chips.map((c, i) => (
        <span key={i} style={{ fontSize: 11, color: c.kind === "added" ? "var(--run)" : "var(--text-2)", background: "rgba(255,255,255,0.04)", border: "1px solid var(--hairline)", borderRadius: 6, padding: "2px 6px" }}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

function DiffBlock({ lines }: { lines: DiffLine[] }) {
  return (
    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 11.5, maxHeight: 240, overflow: "auto" }}>
      {lines.map((l, i) => (
        <div key={i} style={{ color: l.kind === "removed" ? "var(--err)" : l.kind === "added" ? "var(--run)" : "var(--text-3)" }}>
          {l.kind === "removed" ? "− " : l.kind === "added" ? "+ " : "  "}{l.text}
        </div>
      ))}
    </pre>
  );
}

type Props = {
  proposal: TemplateInstructionProposal;
  stepName: string;
  onApply: (edited: string) => void;
  onDismiss: () => void;
  onClose: () => void;
};

export function ProposalReviewModal({ proposal, stepName, onApply, onDismiss, onClose }: Props) {
  const [edited, setEdited] = useState(proposal.afterInstructions);
  const diff = diffLines(proposal.beforeInstructions, proposal.afterInstructions);
  const chips = proposal.component === "step_output_schema" ? schemaChips(proposal.beforeInstructions, proposal.afterInstructions) : [];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(5,8,14,0.55)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div role="dialog" aria-modal="true" aria-label={`Review change — ${stepName}`}
        style={{ width: "min(560px, 90vw)", maxHeight: "85vh", background: "var(--panel)", border: "1px solid var(--hairline-strong)", borderRadius: 14, boxShadow: "0 24px 80px rgba(0,0,0,0.55)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--hairline)" }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent-line)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Sparkle size={15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.2 }}>Orca proposes</div>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stepName}</div>
          </div>
          <Btn icon={<Close />} size="xs" title="Close" onClick={onClose} />
        </header>

        <div className="scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", lineHeight: 1.35 }}>{proposal.predictedImprovement}</div>
          {proposal.component === "step_output_schema" && chips.length > 0 && <ChipRow chips={chips} />}
          <div>
            <div className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-4)", marginBottom: 6 }}>Proposed change</div>
            <div style={{ borderLeft: "2px solid var(--hairline-strong)", paddingLeft: 10 }}><DiffBlock lines={diff} /></div>
          </div>
          <div>
            <div className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--run)", marginBottom: 6 }}>Edit before applying</div>
            <textarea value={edited} onChange={(e) => setEdited(e.target.value)} rows={6}
              style={{ width: "100%", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--hairline)", borderRadius: 6, fontFamily: "inherit", fontSize: 11.5, padding: "7px 10px", boxSizing: "border-box" }} />
          </div>
          <div style={{ color: "var(--text-2)" }}>Predicts: {proposal.predictedImprovement}</div>
          <div style={{ color: "var(--text-3)" }}>Preserves: {proposal.invariantsPreserved.join(", ") || "—"}</div>
        </div>

        <footer style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--hairline)" }}>
          <div style={{ flex: 1 }} />
          <Btn kind="ghost" size="sm" onClick={onDismiss}>Dismiss</Btn>
          <Btn kind="primary" size="sm" icon={<Check />} onClick={() => onApply(edited)}>Apply</Btn>
        </footer>
      </div>
    </div>
  );
}
