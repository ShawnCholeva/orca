import { useEffect, useState } from "react";
import type { WorkflowTemplate } from "@orca/contracts";
import { toErrorMessage } from "../api";
import { createTemplate, listTemplates } from "./api";
import { TemplateDetail } from "./TemplateDetail";
import { TemplateList } from "./TemplateList";
import "./workflows.css";

export function WorkflowsPage() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listTemplates()
      .then((response) => {
        if (cancelled) return;
        setTemplates(sortTemplates(response.templates));
        setSelectedId((current) => current ?? response.templates[0]?.id ?? null);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(toErrorMessage(err, "Failed to load workflow templates."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = templates.find((template) => template.id === selectedId) ?? templates[0] ?? null;

  async function handleCreateTemplate() {
    setCreating(true);
    setError(null);
    try {
      const result = await createTemplate({
        name: "Untitled Workflow",
        description: "",
        steps: [
          {
            id: "step-1",
            name: "Step 1",
            instructions: "Describe what this step does.",
            outputSchema: [{ key: "result", type: "string", required: true }],
          },
        ],
        guardrails: [],
      });
      setTemplates((current) => sortTemplates([...current, result.template]));
      setSelectedId(result.template.id);
    } catch (err) {
      setError(toErrorMessage(err, "Failed to create workflow template."));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="workflows-page">
      <div className="workflows-page__sidebar">
        <div className="workflows-page__header">
          <div>
            <div className="mono workflows-page__eyebrow">Workflow Templates</div>
            <h1>Workflows</h1>
          </div>
          <button
            type="button"
            className="workflow-primary-btn workflow-primary-btn--secondary"
            onClick={handleCreateTemplate}
            disabled={creating}
          >
            {creating ? "Creating…" : "New Template"}
          </button>
        </div>
        {error && <div className="workflow-error-banner">{error}</div>}
        {loading ? (
          <div className="workflows-page__empty">Loading workflow templates…</div>
        ) : templates.length === 0 ? (
          <div className="workflows-page__empty">No workflow templates available yet.</div>
        ) : (
          <TemplateList
            templates={templates}
            selectedId={selected?.id ?? null}
            onSelect={setSelectedId}
          />
        )}
      </div>

      <div className="workflows-page__detail">
        {selected ? (
          <TemplateDetail
            template={selected}
            onTemplateSaved={(updated) => {
              setTemplates((current) =>
                sortTemplates(current.map((entry) => (entry.id === updated.id ? updated : entry))),
              );
            }}
            onTemplateDuplicated={(duplicated) => {
              setTemplates((current) => sortTemplates([...current, duplicated]));
              setSelectedId(duplicated.id);
            }}
          />
        ) : (
          <div className="workflows-page__detail-empty">
            Select a workflow template to inspect its steps and guardrails.
          </div>
        )}
      </div>
    </section>
  );
}

function sortTemplates(templates: WorkflowTemplate[]): WorkflowTemplate[] {
  return [...templates].sort((left, right) => {
    if (left.isBuiltIn !== right.isBuiltIn) return left.isBuiltIn ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}
