import { useState, useEffect, type Dispatch } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { FlowAction, FlowState, PendingWorkspace } from "../state";
import type { ModelProviderInfo, WorkflowTemplate } from "@orca/contracts";
import { inspectWorkspace, listModelProviders, listWorkflowTemplates, toErrorMessage } from "../../api";
import type { ApiError } from "../../api";
import { defaultModelForProvider } from "../orchestratorDefaults";

type Props = {
  state: Extract<FlowState, { phase: "coordinate" }>;
  dispatch: Dispatch<FlowAction>;
};

const SOFT_CAP = 8;

const PROVIDER_LABELS: Record<string, string> = {
  "orca/openai": "OpenAI",
  "orca/anthropic": "Claude",
};

function providerLabel(p: ModelProviderInfo): string {
  return PROVIDER_LABELS[p.id] ?? p.displayName;
}

// ── Workspace row ──────────────────────────────────────────────
function WorkspaceRow({
  ws,
  index,
  dispatch,
}: {
  ws: PendingWorkspace;
  index: number;
  dispatch: Dispatch<FlowAction>;
}) {
  return (
    <li className="workspace-row">
      <div className="workspace-row-info">
        <input
          type="text"
          className="workspace-name-input"
          value={ws.name}
          maxLength={100}
          onChange={(e) => dispatch({ type: "editPendingName", index, name: e.target.value })}
          aria-label="Workspace name"
        />
        <span className="workspace-path-text">{ws.path}</span>
        <div className="workspace-chips">
          <span className="chip chip--type">{ws.workspaceType}</span>
          {ws.branch && <span className="chip chip--branch">{ws.branch}</span>}
          {ws.isDirty === true && <span className="chip chip--dirty">dirty</span>}
        </div>
      </div>
      <button
        type="button"
        className="goal-action-button goal-action-button--danger"
        onClick={() => dispatch({ type: "removePending", index })}
      >
        Remove
      </button>
    </li>
  );
}

// ── Split orchestrator LLM + model pickers ─────────────────────
function OrchestratorPicker({
  value,
  onChange,
}: {
  value: { providerId: string; modelId: string } | null;
  onChange: (v: { providerId: string; modelId: string } | null) => void;
}) {
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listModelProviders()
      .then((rows) => { if (!cancelled) { setProviders(rows); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(toErrorMessage(err, "Failed to load model providers.")); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const selectable = providers.filter((p) => p.models.length > 0);
  const selectedProvider = value ? selectable.find((p) => p.id === value.providerId) ?? null : null;

  useEffect(() => {
    if (value || selectable.length !== 1) return;
    const provider = selectable[0]!;
    const defaultModel = defaultModelForProvider(provider);
    if (defaultModel) onChange({ providerId: provider.id, modelId: defaultModel.id });
  }, [selectable, value, onChange]);

  function onProviderChange(providerId: string) {
    if (!providerId) { onChange(null); return; }
    const provider = selectable.find((p) => p.id === providerId);
    const defaultModel = provider ? defaultModelForProvider(provider) : null;
    onChange(defaultModel ? { providerId, modelId: defaultModel.id } : null);
  }

  function onModelChange(modelId: string) {
    if (!value || !modelId) { onChange(null); return; }
    onChange({ ...value, modelId });
  }

  if (loading) {
    return (
      <>
        <div className="form-field">
          <label>Orchestrator LLM</label>
          <p className="form-hint">Loading providers…</p>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <div className="form-field">
        <label>Orchestrator LLM</label>
        <p className="form-error">{error}</p>
      </div>
    );
  }

  if (selectable.length === 0) {
    return (
      <div className="form-field">
        <label>Orchestrator LLM</label>
        <p className="form-hint">No providers configured. You can set one up in Settings.</p>
      </div>
    );
  }

  return (
    <>
      <div className="form-field">
        <label htmlFor="coord-llm-provider">Orchestrator LLM</label>
        <select
          id="coord-llm-provider"
          value={value?.providerId ?? ""}
          onChange={(e) => onProviderChange(e.target.value)}
        >
          <option value="">Choose provider…</option>
          {selectable.map((p) => (
            <option key={p.id} value={p.id}>{providerLabel(p)}</option>
          ))}
        </select>
      </div>

      {selectedProvider && (
        <div className="form-field">
          <label htmlFor="coord-llm-model">Orchestrator model</label>
          <select
            id="coord-llm-model"
            value={value?.modelId ?? ""}
            onChange={(e) => onModelChange(e.target.value)}
          >
            {selectedProvider.models.map((m) => (
              <option key={m.id} value={m.id}>{m.displayName}</option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}

// ── Workflow selector ──────────────────────────────────────────
function WorkflowSelector({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listWorkflowTemplates()
      .then((res) => { if (!cancelled) { setTemplates(res.templates); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(toErrorMessage(err, "Failed to load workflows.")); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="form-field">
        <label>Workflow</label>
        <p className="form-hint">Loading workflows…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="form-field">
        <label>Workflow</label>
        <p className="form-error">{error}</p>
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <div className="form-field">
        <label>Workflow</label>
        <p className="form-hint">No workflows available. Create one in the Workflows tab.</p>
      </div>
    );
  }

  return (
    <div className="form-field">
      <label htmlFor="coord-workflow">Workflow</label>
      <select
        id="coord-workflow"
        value={value ?? ""}
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value);
        }}
      >
        <option value="" disabled>Choose workflow…</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      {value && (() => {
        const tpl = templates.find((t) => t.id === value);
        return tpl?.description ? (
          <p className="form-hint">{tpl.description}</p>
        ) : null;
      })()}
    </div>
  );
}

// ── Main CoordinateStep ────────────────────────────────────────
export function CoordinateStep({ state, dispatch }: Props) {
  const [inspectError, setInspectError] = useState<string | null>(null);

  const atCap = state.pendingWorkspaces.length >= SOFT_CAP;

  async function handlePickFolder() {
    if (state.inspecting || atCap) return;
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    const path = selected as string;
    setInspectError(null);
    dispatch({ type: "inspectRequested" });
    try {
      const { preview } = await inspectWorkspace({ inputPath: path });
      dispatch({ type: "inspectSucceeded", preview, inputPath: path, name: preview.name });
    } catch (err) {
      const code = (err as ApiError).code ?? (err as ApiError).message ?? "Inspection failed";
      dispatch({ type: "inspectFailed", error: code });
      setInspectError(code);
    }
  }

  return (
    <div className="flow-step">
      {/* Workspaces */}
      <div className="form-field">
        <label>Workspaces</label>
        {state.pendingWorkspaces.length > 0 && (
          <ul className="workspace-pending-list" style={{ marginBottom: 8 }}>
            {state.pendingWorkspaces.map((ws, i) => (
              <WorkspaceRow key={ws.path} ws={ws} index={i} dispatch={dispatch} />
            ))}
          </ul>
        )}
        {atCap ? (
          <p className="workspace-cap-notice">Maximum {SOFT_CAP} workspaces reached.</p>
        ) : (
          <div className="workspace-add-row">
            <button
              type="button"
              className="goal-action-button workspace-browse-btn"
              onClick={() => void handlePickFolder()}
              disabled={state.inspecting}
            >
              {state.inspecting ? "Inspecting…" : "Browse…"}
            </button>
            {inspectError && (
              <p className="form-error workspace-inspect-error">
                {inspectError}
                <button
                  type="button"
                  className="goal-action-button workspace-retry-btn"
                  onClick={() => void handlePickFolder()}
                  disabled={state.inspecting}
                >
                  Retry
                </button>
              </p>
            )}
            {state.error && !inspectError && (
              <p className="form-error">{state.error}</p>
            )}
          </div>
        )}
        <p className="form-hint">Add local folders or git repos this Goal will operate on.</p>
      </div>

      {/* Orchestrator LLM + model */}
      <OrchestratorPicker
        value={state.orchestratorModel}
        onChange={(v) => dispatch({ type: "setOrchestratorModel", orchestratorModel: v as typeof state.orchestratorModel })}
      />

      {/* Workflow */}
      <WorkflowSelector
        value={state.workflowTemplateId}
        onChange={(id) => dispatch({ type: "setWorkflowTemplateId", workflowTemplateId: id })}
      />

      <div className="flow-step-actions">
        <button
          type="button"
          className="goal-action-button"
          onClick={() => dispatch({ type: "backToDescribe" })}
          disabled={state.inspecting}
        >
          ← Back
        </button>
        <button
          type="button"
          className="submit-button"
          onClick={() => dispatch({ type: "submitRequested" })}
          disabled={state.inspecting || state.workflowTemplateId === null}
          title={state.workflowTemplateId === null ? "Select a workflow to continue" : undefined}
        >
          Create Goal
        </button>
      </div>
    </div>
  );
}
