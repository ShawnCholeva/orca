import type { WorkflowTemplate } from "@orca/contracts";
import { ScopeBadge } from "./ScopeControls";

interface TemplateListProps {
  templates: WorkflowTemplate[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  draftId?: string | null;
}

export function TemplateList({ templates, selectedId, onSelect, draftId }: TemplateListProps) {
  return (
    <div className="workflow-list-panel" role="list" aria-label="Workflow templates">
      {templates.length === 0 ? (
        <p className="workflow-list-section__empty" style={{ padding: 18 }}>
          No workflows yet.
        </p>
      ) : (
        templates.map((template) => {
          const selected = template.id === selectedId;
          const isDraft = template.id === draftId;
          return (
            <div
              key={template.id}
              role="listitem"
              onClick={() => onSelect(template.id)}
              style={{
                padding: "12px 14px",
                borderBottom: "1px solid var(--hairline)",
                background: selected ? "rgba(255,255,255,0.03)" : "transparent",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {template.name}
                </span>
                {isDraft && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: "2px 6px",
                      borderRadius: 999,
                      background: "var(--accent-soft)",
                      color: "var(--accent)",
                      border: "1px solid var(--accent-line)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    draft
                  </span>
                )}
                <ScopeBadge scope={template.scope} scopeName={template.scopeName} size="xs" />
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 4 }}>
                {template.steps.length} step{template.steps.length !== 1 ? "s" : ""}
                {template.isLocked && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 10,
                      padding: "1px 5px",
                      borderRadius: 4,
                      background: "var(--warn-soft)",
                      color: "var(--warn)",
                      fontWeight: 600,
                    }}
                  >
                    locked
                  </span>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
