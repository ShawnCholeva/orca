import { useMemo, useState } from "react";
import {
  CreateWorkflowTemplateRequest,
  type CreateWorkflowTemplateRequest as CreateWorkflowTemplateInput,
  type WorkflowGraph,
  type WorkflowGraphNode,
  type WorkflowScope,
  type WorkflowTemplate,
} from "@orca/contracts";
import { toErrorMessage } from "../api";
import { createTemplate, duplicateTemplate, saveTemplate } from "./api";
import { LockIcon } from "./icons";
import { NodeDetailModal, type NodeDetail } from "./NodeDetailModal";
import { ScopePicker } from "./ScopeControls";
import { StepEditor, createStepDraft, type WorkflowStepDraft } from "./StepEditor";
import { WorkflowFlow } from "./WorkflowFlow";
import { buildInitialGraph, reconcileGraph } from "./graph-sync";

// ─── Draft types ──────────────────────────────────────────────────────────────

interface TemplateDraft {
  name: string;
  description: string;
  scope: WorkflowScope;
  scopeName: string;
  steps: WorkflowStepDraft[];
  graph: WorkflowGraph;
}

// Persisted-shape: the fields that are round-tripped through save/load.
// Used for dirty-tracking — positions are included via the graph.
interface PersistedShape {
  name: string;
  description: string;
  scope: WorkflowScope;
  scopeName: string;
  steps: WorkflowStepDraft[];
  graph: WorkflowGraph;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface TemplateDetailProps {
  template: WorkflowTemplate;
  isNew?: boolean;
  goalOptions?: string[];
  onTemplateSaved: (template: WorkflowTemplate) => void;
  onTemplateDuplicated: (template: WorkflowTemplate) => void;
  /** Called when a draft is discarded (only relevant when isNew=true) */
  onDiscard?: () => void;
  /** Called when a new template is created (replaces draft in parent) */
  onTemplateCreated?: (template: WorkflowTemplate) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDraft(template: WorkflowTemplate): TemplateDraft {
  const steps: WorkflowStepDraft[] = template.steps.map((step) => ({ ...step }));
  const graph =
    template.graph != null ? template.graph : buildInitialGraph(steps);
  return {
    name: template.name,
    description: template.description,
    scope: template.scope ?? "global",
    scopeName: template.scopeName ?? "",
    steps,
    graph,
  };
}

function toPersistedShape(draft: TemplateDraft, materializedGraph: WorkflowGraph): PersistedShape {
  return {
    name: draft.name,
    description: draft.description,
    scope: draft.scope,
    scopeName: draft.scopeName,
    steps: draft.steps,
    graph: materializedGraph,
  };
}

function buildTemplateInput(
  draft: TemplateDraft,
  guardrails: WorkflowTemplate["guardrails"],
  graph: WorkflowGraph,
): CreateWorkflowTemplateInput {
  const parsed = CreateWorkflowTemplateRequest.safeParse({
    name: draft.name.trim(),
    description: draft.description.trim(),
    scope: draft.scope,
    scopeName: draft.scope === "global" ? "" : draft.scopeName,
    steps: draft.steps.map((step, index) => ({
      id: step.id,
      ordinal: index,
      name: step.name.trim(),
      instructions: step.instructions,
      outputSchema: step.outputSchema,
      agentPreference: step.agentPreference,
    })),
    guardrails,
    graph,
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Workflow template validation failed.");
  }
  return parsed.data;
}

function buildDuplicateName(name: string): string {
  return name.endsWith(" Copy") ? `${name} 2` : `${name} Copy`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TemplateDetail({
  template,
  isNew = false,
  goalOptions = [],
  onTemplateSaved,
  onTemplateDuplicated,
  onDiscard,
  onTemplateCreated,
}: TemplateDetailProps) {
  const locked = template.isBuiltIn || template.isLocked;
  const [draft, setDraft] = useState<TemplateDraft>(() => toDraft(template));
  const [editing, setEditing] = useState(isNew);
  const [saving, setSaving] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  // True while any on-screen output-schema text is unparseable. Gates Save so
  // we never silently persist the last valid schema over visibly-invalid text.
  const [schemaInvalid, setSchemaInvalid] = useState(false);

  // Materialize the graph: reconcile steps into the working graph
  const materializedGraph = useMemo(
    () => reconcileGraph(draft.steps, draft.graph),
    [draft.steps, draft.graph],
  );

  // ── Dirty tracking ──────────────────────────────────────────────────────────

  // baseline is the persisted-shape at last save (or initial load).
  // Component remounts on template switch (key={selected.id} in WorkflowsPage),
  // so this initialization is correct for the switch case.
  // On save we update baseline explicitly (see handleSave).
  const initialDraft = useMemo(() => toDraft(template), []); // eslint-disable-line react-hooks/exhaustive-deps
  const initialMaterializedGraph = useMemo(
    () => reconcileGraph(initialDraft.steps, initialDraft.graph),
    [initialDraft],
  );
  const [baseline, setBaseline] = useState<PersistedShape>(() =>
    toPersistedShape(initialDraft, initialMaterializedGraph),
  );

  const dirty = useMemo(() => {
    const current = toPersistedShape(draft, materializedGraph);
    return JSON.stringify(current) !== JSON.stringify(baseline);
  }, [draft, materializedGraph, baseline]);

  // ── Save / Duplicate / Discard / Create ────────────────────────────────────

  async function handleSave() {
    setSaving(true);
    setError(null);
    setWarnings([]);
    try {
      const payload = buildTemplateInput(draft, template.guardrails, materializedGraph);
      const result = await saveTemplate(template.id, payload);
      if (result.warnings.length > 0) setWarnings(result.warnings);
      // Update baseline to current shape so dirty clears
      setBaseline(toPersistedShape(draft, materializedGraph));
      setEditing(false);
      onTemplateSaved(result.template);
    } catch (err) {
      setError(toErrorMessage(err, "Failed to save workflow template."));
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate() {
    setSaving(true);
    setError(null);
    setWarnings([]);
    try {
      const payload = buildTemplateInput(draft, [], materializedGraph);
      const result = await createTemplate(payload);
      if (result.warnings.length > 0) setWarnings(result.warnings);
      setEditing(false);
      onTemplateCreated?.(result.template);
    } catch (err) {
      setError(toErrorMessage(err, "Failed to create workflow template."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicate() {
    setDuplicating(true);
    setError(null);
    setWarnings([]);
    try {
      const result = await duplicateTemplate(template.id, buildDuplicateName(template.name));
      if (result.warnings.length > 0) setWarnings(result.warnings);
      onTemplateDuplicated(result.template);
    } catch (err) {
      setError(toErrorMessage(err, "Failed to duplicate workflow template."));
    } finally {
      setDuplicating(false);
    }
  }

  function handleDiscard() {
    if (isNew) {
      onDiscard?.();
    } else {
      // Revert draft to baseline (re-derive from template prop)
      const reverted = toDraft(template);
      setDraft(reverted);
      const revertedGraph = reconcileGraph(reverted.steps, reverted.graph);
      setBaseline(toPersistedShape(reverted, revertedGraph));
      setEditing(false);
      setError(null);
      setWarnings([]);
    }
  }

  // ── Graph callbacks ─────────────────────────────────────────────────────────

  function handleGraphChange(next: WorkflowGraph) {
    if (locked) return;
    setDraft((current) => {
      // Keep step-nodes in sync; accept gate nodes + positions + edges from next
      const stepNodes = current.steps.map((s) => {
        const existing = next.nodes.find((n) => n.id === s.id);
        return existing ?? { id: s.id, type: "step" as const, name: s.name, stepId: s.id };
      });
      const nonStepNodes = next.nodes.filter((n) => n.type === "gate" || n.type === "splitter");
      return {
        ...current,
        graph: {
          nodes: [...stepNodes, ...nonStepNodes],
          edges: next.edges,
          positions: next.positions,
        },
      };
    });
  }

  function handleAddNode(type: "step" | "gate" | "splitter") {
    if (locked) return;
    if (type === "step") {
      setDraft((current) => {
        const newStep = createStepDraft(current.steps);
        const nextSteps = [...current.steps, newStep];
        const nextGraph = reconcileGraph(nextSteps, current.graph);
        // schedule opening the new node
        setTimeout(() => setOpenNodeId(newStep.id), 0);
        return { ...current, steps: nextSteps, graph: nextGraph };
      });
    } else if (type === "gate") {
      setDraft((current) => {
        const id = `gate-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
        const ys = Object.values(current.graph.positions).map((p) => p.y);
        const maxY = ys.length ? Math.max(...ys) : 0;
        const pos = { x: 110, y: maxY + 92 };
        const gateNode: WorkflowGraphNode = {
          id,
          type: "gate",
          name: "New gate",
          condition: "",
        };
        const nextGraph: WorkflowGraph = {
          ...current.graph,
          nodes: [...current.graph.nodes, gateNode],
          positions: { ...current.graph.positions, [id]: pos },
        };
        setTimeout(() => setOpenNodeId(id), 0);
        return { ...current, graph: nextGraph };
      });
    } else if (type === "splitter") {
      setDraft((current) => {
        const id = `splitter-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
        const ys = Object.values(current.graph.positions).map((p) => p.y);
        const maxY = ys.length ? Math.max(...ys) : 0;
        const pos = { x: 110, y: maxY + 92 };
        const splitterNode: WorkflowGraphNode = {
          id, type: "splitter", name: "New splitter", branches: ["Branch A", "Branch B"],
        };
        const nextGraph: WorkflowGraph = {
          ...current.graph,
          nodes: [...current.graph.nodes, splitterNode],
          positions: { ...current.graph.positions, [id]: pos },
        };
        setTimeout(() => setOpenNodeId(id), 0);
        return { ...current, graph: nextGraph };
      });
    }
  }

  function handleRemoveNode(id: string) {
    if (locked) return;
    setDraft((current) => {
      // Is this a step node?
      const isStep = current.steps.some((s) => s.id === id);
      const nextSteps = isStep ? current.steps.filter((s) => s.id !== id) : current.steps;
      const { [id]: _drop, ...restPositions } = current.graph.positions;
      const nextGraph: WorkflowGraph = {
        nodes: current.graph.nodes.filter((n) => n.id !== id),
        edges: current.graph.edges.filter((e) => e.from !== id && e.to !== id),
        positions: restPositions,
      };
      return {
        ...current,
        steps: nextSteps,
        graph: isStep ? reconcileGraph(nextSteps, nextGraph) : nextGraph,
      };
    });
    if (openNodeId === id) setOpenNodeId(null);
  }

  function handleResetLayout() {
    setDraft((current) => ({
      ...current,
      graph: buildInitialGraph(current.steps),
    }));
  }

  // ── Node modal data ─────────────────────────────────────────────────────────

  const openNodeDetail: NodeDetail | null = useMemo(() => {
    if (!openNodeId) return null;
    const allNodes = materializedGraph.nodes;
    const node = allNodes.find((n) => n.id === openNodeId);
    if (!node) return null;

    if (node.type === "step") {
      const step = draft.steps.find((s) => s.id === node.id);
      if (!step) return null;
      return {
        kind: "step",
        name: step.name,
        instructions: step.instructions,
        outputSchema: step.outputSchema,
        terminal: node.terminal ?? false,
        onChange: (patch) => {
          setDraft((current) => {
            const nextSteps = current.steps.map((s) =>
              s.id === step.id ? { ...s, ...patch } : s,
            );
            // If name changed, reconcile to sync node name
            const nextGraph =
              patch.name !== undefined
                ? reconcileGraph(nextSteps, current.graph)
                : current.graph;
            // If terminal changed, update graph node
            const finalGraph =
              patch.terminal !== undefined
                ? {
                    ...nextGraph,
                    nodes: nextGraph.nodes.map((n) =>
                      n.id === step.id ? { ...n, terminal: patch.terminal } : n,
                    ),
                  }
                : nextGraph;
            return { ...current, steps: nextSteps, graph: finalGraph };
          });
        },
      };
    } else {
      // gate
      return {
        kind: "gate",
        name: node.name,
        instructions: node.instructions ?? node.condition ?? "",
        onChange: (patch) => {
          setDraft((current) => ({
            ...current,
            graph: {
              ...current.graph,
              nodes: current.graph.nodes.map((n) =>
                n.id === openNodeId ? { ...n, ...patch } : n,
              ),
            },
          }));
        },
      };
    }
  }, [openNodeId, materializedGraph.nodes, draft.steps]);

  const openNodeIndex = useMemo(() => {
    if (!openNodeId) return -1;
    return materializedGraph.nodes.findIndex((n) => n.id === openNodeId);
  }, [openNodeId, materializedGraph.nodes]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <section
      className="workflow-detail-panel"
      aria-label="Workflow template detail"
      style={{ position: "relative" }}
    >
      {/* Header */}
      <div className="workflow-detail-panel__header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="workflow-detail-panel__eyebrow mono">
            {locked ? "Built-in Workflow" : isNew ? "New Workflow" : "Custom Workflow"}
          </div>
          {editing ? (
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((c) => ({ ...c, name: e.target.value }))}
              autoFocus
              aria-label="Template Name"
              maxLength={100}
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
                color: "var(--text)",
                fontFamily: "inherit",
                fontSize: 20,
                fontWeight: 700,
                padding: 0,
                borderBottom: "1px dashed var(--hairline-strong)",
                width: "100%",
                maxWidth: 400,
              }}
            />
          ) : (
            <h2 className="workflow-detail-panel__title">{draft.name || template.name}</h2>
          )}
          <p className="workflow-detail-panel__meta">
            Version {template.version} · {draft.steps.length} step{draft.steps.length !== 1 ? "s" : ""}
          </p>
        </div>

        <div className="workflow-detail-panel__actions">
          {/* Duplicate to Custom — always available for non-new */}
          {!isNew && (
            <button
              type="button"
              className="workflow-primary-btn"
              onClick={handleDuplicate}
              disabled={duplicating || saving}
            >
              {duplicating ? "Duplicating…" : "Duplicate to Custom"}
            </button>
          )}

          {/* Unlocked non-new: Edit/Done toggle + Save Changes + Discard */}
          {!locked && !isNew && (
            <>
              {/* Edit toggles the meta/list editor; Done exits back to canvas view */}
              <button
                type="button"
                className="workflow-primary-btn workflow-primary-btn--secondary"
                onClick={() => setEditing((e) => !e)}
                disabled={saving}
              >
                {editing ? "Done" : "Edit"}
              </button>

              {/* Discard — only when there are unsaved changes */}
              {dirty && (
                <button
                  type="button"
                  className="workflow-primary-btn workflow-primary-btn--secondary"
                  onClick={handleDiscard}
                  disabled={saving}
                >
                  Discard changes
                </button>
              )}

              {/* Save Changes — always present for non-locked non-new, disabled when clean */}
              <button
                type="button"
                className="workflow-primary-btn"
                onClick={handleSave}
                disabled={!dirty || saving || duplicating || schemaInvalid}
              >
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </>
          )}

          {/* Draft footer — Discard / Create */}
          {isNew && (
            <>
              <button
                type="button"
                className="workflow-primary-btn workflow-primary-btn--secondary"
                onClick={handleDiscard}
                disabled={saving}
              >
                Discard
              </button>
              <button
                type="button"
                className="workflow-primary-btn"
                onClick={handleCreate}
                disabled={saving || duplicating}
              >
                {saving ? "Creating…" : "Create workflow"}
              </button>
            </>
          )}
        </div>
      </div>

      {locked && (
        <div className="workflow-locked-notice" role="note">
          <LockIcon />
          <span>
            <strong>Built-in workflow — read-only.</strong> Its steps and flow can&apos;t be
            edited. Click <em>Duplicate to Custom</em> to make an editable copy.
          </span>
        </div>
      )}

      {error && <div className="workflow-error-banner">{error}</div>}

      {warnings.length > 0 && (
        <div className="workflow-warnings">
          <strong>Heads up:</strong>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Description */}
      <div style={{ marginBottom: 12 }}>
        {editing ? (
          <input
            type="text"
            value={draft.description}
            onChange={(e) => setDraft((c) => ({ ...c, description: e.target.value }))}
            placeholder="Short description — what this workflow does, in one sentence."
            aria-label="Description"
            style={{
              width: "100%",
              background: "transparent",
              border: "none",
              borderBottom: "1px dashed var(--hairline-strong)",
              outline: "none",
              color: "var(--text)",
              fontFamily: "inherit",
              fontSize: 13,
              padding: "4px 2px",
              boxSizing: "border-box",
            }}
          />
        ) : (
          <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.55, margin: 0 }}>
            {draft.description || (
              <span style={{ color: "var(--text-4)", fontStyle: "italic" }}>No description.</span>
            )}
          </p>
        )}
      </div>

      {/* Scope picker — only in edit mode */}
      {editing && (
        <div style={{ marginBottom: 18 }}>
          <div
            className="mono"
            style={{ fontSize: 10, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 8 }}
          >
            Workflow scope
          </div>
          <ScopePicker
            scope={draft.scope}
            scopeName={draft.scopeName}
            onChange={({ scope, scopeName }) => setDraft((c) => ({ ...c, scope, scopeName }))}
            goalOptions={goalOptions}
          />
        </div>
      )}

      {/* Steps or canvas */}
      <div className="workflow-section">
        <div className="workflow-section__header">
          <h3>
            {editing ? "Steps" : "Flow"}
            {locked && <span className="workflow-section__readonly"> · read-only</span>}
          </h3>
        </div>

        {editing ? (
          <StepEditor
            steps={draft.steps}
            onChange={(nextSteps) =>
              setDraft((current) => ({
                ...current,
                steps: nextSteps,
                graph: current.graph,
              }))
            }
            disabled={locked}
            onOutputSchemaValidityChange={setSchemaInvalid}
          />
        ) : (
          <WorkflowFlow
            graph={materializedGraph}
            onGraphChange={handleGraphChange}
            onOpenNode={(id) => setOpenNodeId(id)}
            onAddNode={handleAddNode}
            onRemoveNode={handleRemoveNode}
            onResetLayout={handleResetLayout}
            readOnly={locked}
          />
        )}
      </div>

      {/* Node detail modal */}
      {openNodeDetail && openNodeIndex >= 0 && (
        <NodeDetailModal
          detail={openNodeDetail}
          index={openNodeIndex}
          total={materializedGraph.nodes.length}
          onPrev={
            openNodeIndex > 0
              ? () => setOpenNodeId(materializedGraph.nodes[openNodeIndex - 1].id)
              : null
          }
          onNext={
            openNodeIndex < materializedGraph.nodes.length - 1
              ? () => setOpenNodeId(materializedGraph.nodes[openNodeIndex + 1].id)
              : null
          }
          onClose={() => {
            setOpenNodeId(null);
            // The modal's invalid text leaves the screen on close; clear the gate
            // so a closed modal can't keep Save disabled.
            setSchemaInvalid(false);
          }}
          onDelete={() => {
            handleRemoveNode(openNodeId!);
          }}
          readOnly={locked}
          onOutputSchemaValidityChange={setSchemaInvalid}
        />
      )}
    </section>
  );
}
