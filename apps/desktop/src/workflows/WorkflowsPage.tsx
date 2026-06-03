import { useEffect, useState } from "react";
import type { WorkflowScope, WorkflowTemplate } from "@orca/contracts";
import { listGoals, toErrorMessage } from "../api";
import { listTemplates } from "./api";
import { ScopeBadge, ScopeFilter } from "./ScopeControls";
import { TemplateDetail } from "./TemplateDetail";
import "./workflows.css";

const DRAFT_ID = "draft/new";

type ScopeFilterValue = "all" | WorkflowScope;

function makeDraftTemplate(): WorkflowTemplate {
  const now = new Date().toISOString();
  return {
    id: DRAFT_ID,
    name: "Untitled workflow",
    description: "",
    version: 0,
    isBuiltIn: false,
    isLocked: false,
    steps: [
      {
        id: "step-1",
        ordinal: 0,
        name: "New step",
        instructions: "",
        outputSchema: [{ key: "result", type: "string" as const, required: true }],
        agentPreference: [{ adapterId: "claude-code" as const, modelId: "claude-haiku-4-5" }],
      },
    ],
    guardrails: [],
    scope: "global" as const,
    scopeName: "",
    graph: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function WorkflowsPage() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilterValue>("all");
  const [goalOptions, setGoalOptions] = useState<string[]>([]);
  const [hasDraft, setHasDraft] = useState(false);

  // Load templates
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

  // Load goals once
  useEffect(() => {
    let cancelled = false;
    listGoals()
      .then((response) => {
        if (!cancelled) {
          setGoalOptions(response.goals.map((g) => g.title));
        }
      })
      .catch(() => {
        // non-fatal — scopePicker just shows no goal options
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build the displayed template list (real templates + optional local draft)
  const allDisplayed: WorkflowTemplate[] = hasDraft
    ? [makeDraftTemplate(), ...templates]
    : templates;

  // Scope counts are based on real templates only (exclude draft)
  const counts: Record<ScopeFilterValue, number> = {
    all: templates.length,
    global: templates.filter((t) => (t.scope ?? "global") === "global").length,
    workspace: templates.filter((t) => t.scope === "workspace").length,
    goal: templates.filter((t) => t.scope === "goal").length,
  };

  // Filter the list (draft always shown when present)
  const filteredTemplates =
    scopeFilter === "all"
      ? allDisplayed
      : allDisplayed.filter(
          (t) => t.id === DRAFT_ID || (t.scope ?? "global") === scopeFilter,
        );

  const selected =
    allDisplayed.find((t) => t.id === selectedId) ?? allDisplayed[0] ?? null;

  function handleCreateDraft() {
    setHasDraft(true);
    setSelectedId(DRAFT_ID);
    setScopeFilter("all");
  }

  function handleDiscardDraft() {
    setHasDraft(false);
    setSelectedId(templates[0]?.id ?? null);
  }

  function handleTemplateCreated(created: WorkflowTemplate) {
    setHasDraft(false);
    setTemplates((current) => sortTemplates([...current, created]));
    setSelectedId(created.id);
  }

  function handleTemplateSaved(updated: WorkflowTemplate) {
    setTemplates((current) =>
      sortTemplates(current.map((t) => (t.id === updated.id ? updated : t))),
    );
  }

  function handleTemplateDuplicated(duplicated: WorkflowTemplate) {
    setTemplates((current) => sortTemplates([...current, duplicated]));
    setSelectedId(duplicated.id);
  }

  return (
    <section className="workflows-page">
      {/* ── Left panel ───────────────────────────────────────────────────── */}
      <div className="workflows-page__sidebar">
        <div className="workflows-page__header">
          <div>
            <div className="mono workflows-page__eyebrow">Workflow Templates</div>
            <h1>Workflows</h1>
          </div>
          <button
            type="button"
            className="workflow-primary-btn workflow-primary-btn--secondary"
            onClick={handleCreateDraft}
            disabled={hasDraft}
            title="New workflow"
          >
            +
          </button>
        </div>

        {/* Scope filter */}
        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--hairline)", flexShrink: 0 }}>
          <ScopeFilter value={scopeFilter} setValue={setScopeFilter} counts={counts} />
        </div>

        {error && <div className="workflow-error-banner" style={{ margin: "8px 12px" }}>{error}</div>}

        <div className="scroll" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {loading ? (
            <div className="workflows-page__empty">Loading workflow templates…</div>
          ) : filteredTemplates.length === 0 ? (
            <div className="workflows-page__empty">No workflows in this scope.</div>
          ) : (
            filteredTemplates.map((t) => {
              const isSelected = t.id === selectedId;
              const isDraft = t.id === DRAFT_ID;
              return (
                <div
                  key={t.id}
                  onClick={() => {
                    setSelectedId(t.id);
                  }}
                  style={{
                    padding: "12px 14px",
                    borderBottom: "1px solid var(--hairline)",
                    background: isSelected ? "rgba(255,255,255,0.03)" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--text)",
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.name}
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
                    <ScopeBadge scope={t.scope} scopeName={t.scopeName} size="xs" />
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 4 }}>
                    {t.steps.length} step{t.steps.length !== 1 ? "s" : ""}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── Right panel ──────────────────────────────────────────────────── */}
      <div className="workflows-page__detail">
        {selected ? (
          <TemplateDetail
            key={selected.id}
            template={selected}
            isNew={selected.id === DRAFT_ID}
            goalOptions={goalOptions}
            onTemplateSaved={handleTemplateSaved}
            onTemplateDuplicated={handleTemplateDuplicated}
            onDiscard={handleDiscardDraft}
            onTemplateCreated={handleTemplateCreated}
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
