import type { WorkflowTemplate } from "@orca/contracts";

interface TemplateListProps {
  templates: WorkflowTemplate[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function TemplateList({ templates, selectedId, onSelect }: TemplateListProps) {
  const builtIn = templates.filter((template) => template.isBuiltIn);
  const custom = templates.filter((template) => !template.isBuiltIn);

  return (
    <aside className="workflow-list-panel" aria-label="Workflow templates">
      <Section
        title="Built-in"
        templates={builtIn}
        selectedId={selectedId}
        onSelect={onSelect}
        emptyLabel="No built-in workflows."
      />
      <Section
        title="Custom Workflows"
        templates={custom}
        selectedId={selectedId}
        onSelect={onSelect}
        emptyLabel="No custom workflows yet."
      />
    </aside>
  );
}

interface SectionProps {
  title: string;
  templates: WorkflowTemplate[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  emptyLabel: string;
}

function Section({ title, templates, selectedId, onSelect, emptyLabel }: SectionProps) {
  return (
    <section className="workflow-list-section">
      <div className="workflow-list-section__header">
        <h2>{title}</h2>
        <span className="mono workflow-list-section__count">{templates.length}</span>
      </div>
      {templates.length === 0 ? (
        <p className="workflow-list-section__empty">{emptyLabel}</p>
      ) : (
        <ul className="workflow-list">
          {templates.map((template) => {
            const selected = template.id === selectedId;
            return (
              <li key={template.id}>
                <button
                  type="button"
                  className={`workflow-list-item ${selected ? "workflow-list-item--selected" : ""}`}
                  onClick={() => onSelect(template.id)}
                >
                  <div className="workflow-list-item__row">
                    <span className="workflow-list-item__name">{template.name}</span>
                    {template.isLocked && <span className="workflow-lock-badge">Locked</span>}
                  </div>
                  <div className="workflow-list-item__meta">
                    <span className="mono">v{template.version}</span>
                    <span>{template.steps.length} steps</span>
                    <span>{template.guardrails.length} guardrails</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
