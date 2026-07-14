import { useState, useEffect, type CSSProperties, type Dispatch } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { FlowAction, FlowState, PendingWorkspace, PendingDocument } from "../state";
import type { ModelProviderInfo, WorkflowTemplate, WorkspaceSummary } from "@orca/contracts";
import {
  inspectWorkspace,
  listModelProviders,
  listWorkflowTemplates,
  listWorkspaces,
  toErrorMessage,
} from "../../api";
import type { ApiError } from "../../api";
import { defaultModelForProvider } from "../orchestratorDefaults";
import { expandTilde } from "../../utils/path";
import { detectDocumentKind, defaultDocumentName } from "../documents";
import { Field, FieldGroup, Btn, Pill, MiniSelect, inputStyle } from "../../workspaces/primitives";
import { Icon } from "../../workspaces/icons";

type Props = {
  state: Extract<FlowState, { phase: "coordinate" }>;
  dispatch: Dispatch<FlowAction>;
  /** When provided, the picker's empty state can jump to the Workspaces tab. */
  onNavigateToWorkspaces?: () => void;
};

const SOFT_CAP = 8;
const DOCS_SOFT_CAP = 20;

const PROVIDER_LABELS: Record<string, string> = {
  "orca/openai": "OpenAI",
  "orca/anthropic": "Claude",
};

function providerLabel(p: ModelProviderInfo): string {
  return PROVIDER_LABELS[p.id] ?? p.displayName;
}

// ── Shared styles ──────────────────────────────────────────────
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
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <input
          type="text"
          value={ws.name}
          maxLength={100}
          onChange={(e) => dispatch({ type: "editPendingName", index, name: e.target.value })}
          aria-label="Workspace name"
          style={{ ...inputStyle, padding: "5px 8px", fontSize: 12.5, fontWeight: 600 }}
        />
        <span style={monoPathStyle}>{ws.path}</span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <Pill tone="neutral" size="xs">
            {ws.workspaceType}
          </Pill>
          {ws.branch && (
            <Pill tone="info" size="xs">
              {ws.branch}
            </Pill>
          )}
          {ws.isDirty === true && (
            <Pill tone="warn" size="xs">
              dirty
            </Pill>
          )}
        </div>
      </div>
      <Btn kind="danger" size="xs" onClick={() => dispatch({ type: "removePending", index })}>
        Remove
      </Btn>
    </div>
  );
}

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
function DocumentsBlock({
  state,
  dispatch,
}: {
  state: Extract<FlowState, { phase: "coordinate" }>;
  dispatch: Dispatch<FlowAction>;
}) {
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const atCap = state.pendingDocuments.length >= DOCS_SOFT_CAP;

  function addResolvedRef(kind: "file" | "url", resolved: string): boolean {
    if (state.pendingDocuments.some((d) => d.ref === resolved)) {
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
        {state.pendingDocuments.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {state.pendingDocuments.map((doc, i) => (
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
              <Btn kind="quiet" onClick={() => void handleBrowse()}>
                Browse…
              </Btn>
            </div>
            {error && <p style={errorStyle}>{error}</p>}
          </>
        )}
      </div>
    </FieldGroup>
  );
}

// ── Orchestrator LLM + model (two stacked MiniSelects) ─────────
function OrchestratorFields({
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
      .then((rows) => {
        if (!cancelled) {
          setProviders(rows);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(toErrorMessage(err, "Failed to load model providers."));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
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
    const provider = selectable.find((p) => p.id === providerId);
    const defaultModel = provider ? defaultModelForProvider(provider) : null;
    onChange(defaultModel ? { providerId, modelId: defaultModel.id } : null);
  }

  function onModelChange(modelId: string) {
    if (!value) return;
    onChange({ ...value, modelId });
  }

  if (loading) {
    return (
      <Field label="Orchestrator LLM">
        <p style={mutedStyle}>Loading providers…</p>
      </Field>
    );
  }

  if (error) {
    return (
      <Field label="Orchestrator LLM">
        <p style={errorStyle}>{error}</p>
      </Field>
    );
  }

  if (selectable.length === 0) {
    return (
      <Field label="Orchestrator LLM">
        <p style={mutedStyle}>No providers configured. You can set one up in Settings.</p>
      </Field>
    );
  }

  return (
    <>
      <Field label="Orchestrator LLM">
        <MiniSelect
          value={value?.providerId ?? null}
          options={selectable.map((p) => ({ id: p.id, name: providerLabel(p) }))}
          onChange={onProviderChange}
          icon={<Icon.sparkle size={14} />}
          placeholder="Choose provider…"
        />
      </Field>
      <Field label="Orchestrator model">
        <MiniSelect
          value={value?.modelId ?? null}
          options={(selectedProvider?.models ?? []).map((m) => ({ id: m.id, name: m.displayName }))}
          onChange={onModelChange}
          icon={<Icon.cpu size={14} />}
          placeholder="Choose a model…"
        />
      </Field>
    </>
  );
}

// ── Workflow selector ──────────────────────────────────────────
function WorkflowField({
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
      .then((res) => {
        if (!cancelled) {
          setTemplates(res.templates);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(toErrorMessage(err, "Failed to load workflows."));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <Field label="Workflow">
        <p style={mutedStyle}>Loading workflows…</p>
      </Field>
    );
  }

  if (error) {
    return (
      <Field label="Workflow">
        <p style={errorStyle}>{error}</p>
      </Field>
    );
  }

  if (templates.length === 0) {
    return (
      <Field label="Workflow">
        <p style={mutedStyle}>No workflows available. Create one in the Workflows tab.</p>
      </Field>
    );
  }

  return (
    <Field label="Workflow">
      <MiniSelect
        value={value}
        options={templates.map((t) => ({
          id: t.id,
          name: t.name,
          hint: t.description || undefined,
        }))}
        onChange={onChange}
        icon={<Icon.workflow size={14} />}
        placeholder="Choose workflow…"
      />
    </Field>
  );
}

// ── Registered-workspace picker (inline dropdown) ──────────────
function RegisteredWorkspaceSelect({
  existingPaths,
  disabled,
  onPick,
  onNavigateToWorkspaces,
}: {
  existingPaths: string[];
  disabled: boolean;
  onPick: (ws: WorkspaceSummary) => void;
  onNavigateToWorkspaces?: () => void;
}) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listWorkspaces()
      .then((rows) => {
        if (!cancelled) {
          setWorkspaces(rows);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(toErrorMessage(err, "Failed to load workspaces."));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p style={errorStyle}>{error}</p>;

  if (loading) {
    return (
      <MiniSelect
        value={null}
        options={[]}
        onChange={() => {}}
        icon={<Icon.workspace size={14} />}
        placeholder="Loading workspaces…"
        disabled
      />
    );
  }

  // No registered workspaces at all — offer the jump to the Workspaces tab
  // (the modal's old empty state), rather than a dead dropdown.
  if (workspaces.length === 0) {
    return onNavigateToWorkspaces ? (
      <Btn kind="quiet" onClick={onNavigateToWorkspaces} icon={<Icon.workspace size={14} />}>
        Register a workspace…
      </Btn>
    ) : (
      <MiniSelect
        value={null}
        options={[]}
        onChange={() => {}}
        icon={<Icon.workspace size={14} />}
        placeholder="No registered workspaces"
        disabled
      />
    );
  }

  const existing = new Set(existingPaths);
  // Exclude workspaces whose folder no longer exists on disk — picking one would
  // only fail on inspect. They remain visible/removable in the Workspaces tab.
  const available = workspaces.filter((ws) => ws.exists && !existing.has(ws.path));

  return (
    <MiniSelect
      value={null}
      options={available.map((ws) => ({ id: ws.path, name: ws.name }))}
      onChange={(path) => {
        const ws = available.find((w) => w.path === path);
        if (ws) onPick(ws);
      }}
      icon={<Icon.workspace size={14} />}
      placeholder={available.length === 0 ? "All registered added" : "Pick from registered"}
      disabled={disabled || available.length === 0}
    />
  );
}

// ── Main CoordinateStep ────────────────────────────────────────
export function CoordinateStep({ state, dispatch, onNavigateToWorkspaces }: Props) {
  const [inspectError, setInspectError] = useState<string | null>(null);

  const atCap = state.pendingWorkspaces.length >= SOFT_CAP;

  // Inspect a folder path and add it to the pending workspaces. Shared by the
  // filesystem Browse flow and the registry picker — both arrive at the same
  // inspectSucceeded action, so the rest of the flow is source-agnostic.
  async function addWorkspaceByPath(path: string) {
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

  async function handlePickFolder() {
    if (state.inspecting || atCap) return;
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    await addWorkspaceByPath(selected as string);
  }

  function handlePickRegistered(ws: WorkspaceSummary) {
    void addWorkspaceByPath(ws.path);
  }

  const noWorkspace = state.pendingWorkspaces.length === 0;
  const noWorkflow = state.workflowTemplateId === null;
  const createDisabled = state.inspecting || noWorkspace || noWorkflow;
  const createTitle = noWorkspace
    ? "Add a workspace to continue"
    : noWorkflow
      ? "Select a workflow to continue"
      : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Workspaces */}
      <FieldGroup label="Workspaces" hint="Add local folders or git repos this Goal will operate on.">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {state.pendingWorkspaces.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {state.pendingWorkspaces.map((ws, i) => (
                <WorkspaceRow key={ws.path} ws={ws} index={i} dispatch={dispatch} />
              ))}
            </div>
          )}
          {atCap ? (
            <p style={mutedStyle}>Maximum {SOFT_CAP} workspaces reached.</p>
          ) : (
            <>
              <div>
                <Btn
                  kind="quiet"
                  onClick={() => void handlePickFolder()}
                  disabled={state.inspecting}
                  icon={<Icon.folder size={14} />}
                >
                  {state.inspecting ? "Inspecting…" : "Browse…"}
                </Btn>
              </div>
              <RegisteredWorkspaceSelect
                existingPaths={state.pendingWorkspaces.map((ws) => ws.path)}
                disabled={!!state.inspecting}
                onPick={handlePickRegistered}
                onNavigateToWorkspaces={onNavigateToWorkspaces}
              />
              {inspectError && (
                <p style={{ ...errorStyle, display: "flex", alignItems: "center", gap: 8 }}>
                  {inspectError}
                  <Btn kind="quiet" size="xs" onClick={() => void handlePickFolder()} disabled={state.inspecting}>
                    Retry
                  </Btn>
                </p>
              )}
              {state.error && !inspectError && <p style={errorStyle}>{state.error}</p>}
            </>
          )}
        </div>
      </FieldGroup>

      {/* Reference documents */}
      <DocumentsBlock state={state} dispatch={dispatch} />

      {/* Orchestrator LLM + model */}
      <OrchestratorFields
        value={state.orchestratorModel}
        onChange={(v) =>
          dispatch({ type: "setOrchestratorModel", orchestratorModel: v as typeof state.orchestratorModel })
        }
      />

      {/* Workflow */}
      <WorkflowField
        value={state.workflowTemplateId}
        onChange={(id) => dispatch({ type: "setWorkflowTemplateId", workflowTemplateId: id })}
      />

      {/* Footer actions */}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <Btn
          kind="quiet"
          onClick={() => dispatch({ type: "backToDescribe" })}
          disabled={state.inspecting}
          icon={<Icon.chevronLeft size={14} />}
        >
          Back
        </Btn>
        <Btn
          kind="primary"
          onClick={() => dispatch({ type: "submitRequested" })}
          disabled={createDisabled}
          title={createTitle}
        >
          Create Goal
        </Btn>
      </div>
    </div>
  );
}
