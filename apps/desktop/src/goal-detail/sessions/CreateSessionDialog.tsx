import { useState, useEffect, FormEvent } from "react";
import type { AdapterSummary, ContextAssembly, ContextPackage, ContextRole, CreateContextPackageResponse, Workspace } from "@orca/contracts";
import { listAdapters, createSession, startSession, createContextPackage, ApiError, toErrorMessage } from "../../api";
import { ContextPreviewPanel } from "../context-preview-panel";
import type { CreateSessionPrefill } from "../recommendations/RecommendationsPanel";

const CONTEXT_ROLES: { value: ContextRole; label: string }[] = [
  { value: "architect", label: "Architect" },
  { value: "engineer", label: "Engineer" },
  { value: "reviewer", label: "Reviewer" },
  { value: "generalist", label: "Generalist" },
];

function adapterBinEnvVar(id: string): string {
  return `ORCA_${id.toUpperCase().replace(/-/g, "_")}_BIN`;
}

function sessionErrorMessage(err: unknown, adapterId: string): string {
  const code = err instanceof ApiError ? err.code : undefined;
  if (code === "command_not_found") {
    return `Adapter command not found. Set the binary path via the ${adapterBinEnvVar(adapterId)} env var.`;
  }
  if (code === "workspace_unavailable") {
    return "Workspace path is not accessible. Check that the directory exists.";
  }
  return toErrorMessage(err, "Failed to create session.");
}

type Props = {
  goalId: string;
  workspaces: Workspace[];
  onCreated(sessionId: string): void;
  onClose(): void;
  onContextPrepared?: (response: CreateContextPackageResponse) => void;
  prefill?: CreateSessionPrefill | null;
};

export function CreateSessionDialog({ goalId, workspaces, onCreated, onClose, onContextPrepared, prefill = null }: Props) {
  const [adapters, setAdapters] = useState<AdapterSummary[]>([]);
  const [adaptersLoading, setAdaptersLoading] = useState(true);
  const [adaptersError, setAdaptersError] = useState<string | null>(null);

  const [workspaceId, setWorkspaceId] = useState(prefill?.workspaceId ?? workspaces[0]?.id ?? "");
  const [adapterId, setAdapterId] = useState(prefill?.adapterId ?? "");
  const [contextRole, setContextRole] = useState<ContextRole | "">((prefill?.role as ContextRole | undefined) ?? "");
  const [objective, setObjective] = useState(prefill?.objective ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextAssembly, setContextAssembly] = useState<ContextAssembly | null>(null);
  const [contextPkg, setContextPkg] = useState<ContextPackage | null>(null);

  useEffect(() => {
    setAdaptersLoading(true);
    listAdapters()
      .then((res) => {
        setAdapters(res.adapters);
        if (!prefill?.adapterId && res.adapters.length > 0) {
          setAdapterId(res.adapters[0]!.id);
        }
      })
      .catch((err) => setAdaptersError(toErrorMessage(err, "Failed to load adapters.")))
      .finally(() => setAdaptersLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedAdapter = adapters.find((a) => a.id === adapterId);
  const busy = submitting || preparing;
  const canPrepare = !!contextRole && objective.trim().length >= 4;

  async function handlePrepareContext(replacePackageId?: string) {
    if (!workspaceId) { setError("Workspace is required."); return; }
    if (!adapterId) { setError("Adapter is required."); return; }
    if (!contextRole) return;

    setPreparing(true);
    setError(null);
    try {
      const response = await createContextPackage(goalId, {
        adapterId: adapterId as Parameters<typeof createContextPackage>[1]["adapterId"],
        role: contextRole,
        objective: objective.trim(),
        workspaceId: workspaceId || undefined,
        taskId: prefill?.taskId,
        fromRecommendationId: prefill?.fromRecommendationId,
        replacePackageId,
      });
      setContextAssembly(response.assembly);
      setContextPkg(response.package);
      onContextPrepared?.(response);
    } catch (err) {
      setError(toErrorMessage(err, "Failed to prepare context."));
    } finally {
      setPreparing(false);
    }
  }

  async function handleLaunchWithContext(contextPackageId: string) {
    if (!workspaceId) { setError("Workspace is required."); return; }
    if (!adapterId) { setError("Adapter is required."); return; }

    setSubmitting(true);
    setError(null);
    try {
      const { session } = await createSession(goalId, {
        workspaceId,
        adapterId: adapterId as Parameters<typeof createSession>[1]["adapterId"],
        role: contextRole || undefined,
        instruction: objective.trim() || undefined,
        contextPackageId,
        taskId: prefill?.taskId,
        fromRecommendationId: prefill?.fromRecommendationId,
      });
      await startSession(session.id, { terminalCols: 80, terminalRows: 24 });
      onCreated(session.id);
    } catch (err) {
      setError(sessionErrorMessage(err, adapterId));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSkipContext(e: FormEvent) {
    e.preventDefault();
    if (!workspaceId) { setError("Workspace is required."); return; }
    if (!adapterId) { setError("Adapter is required."); return; }
    if (objective.length > 4000) { setError("Objective must be 4000 characters or fewer."); return; }

    setSubmitting(true);
    setError(null);
    try {
      const { session } = await createSession(goalId, {
        workspaceId,
        adapterId: adapterId as Parameters<typeof createSession>[1]["adapterId"],
        role: contextRole || undefined,
        instruction: objective.trim() || undefined,
        taskId: prefill?.taskId,
        fromRecommendationId: prefill?.fromRecommendationId,
      });
      await startSession(session.id, { terminalCols: 80, terminalRows: 24 });
      onCreated(session.id);
    } catch (err) {
      setError(sessionErrorMessage(err, adapterId));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="create-session-dialog" role="dialog" aria-label="Create Session">
      <div className="create-session-dialog-header">
        <h3 className="create-session-dialog-title">New Session</h3>
        <button type="button" className="goal-action-button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>

      <form onSubmit={(e) => void handleSkipContext(e)} className="create-form">
        <div className="form-field">
          <label htmlFor="create-session-workspace">Workspace</label>
          <select
            id="create-session-workspace"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            disabled={busy}
            required
          >
            <option value="">— select workspace —</option>
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
        </div>

        <div className="form-field">
          <label htmlFor="create-session-adapter">Adapter</label>
          {adaptersLoading ? (
            <p>Loading adapters…</p>
          ) : adaptersError ? (
            <p className="form-error">{adaptersError}</p>
          ) : (
            <>
              <select
                id="create-session-adapter"
                value={adapterId}
                onChange={(e) => setAdapterId(e.target.value)}
                disabled={busy}
                required
              >
                <option value="">— select adapter —</option>
                {adapters.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}{a.availability === "unavailable" ? " (unavailable)" : ""}
                  </option>
                ))}
              </select>
              {selectedAdapter?.availability === "unavailable" && selectedAdapter.detail && (
                <p className="form-hint session-adapter-unavailable">
                  Unavailable: {selectedAdapter.detail}
                </p>
              )}
            </>
          )}
        </div>

        <div className="form-field">
          <label htmlFor="create-session-role">Role (optional)</label>
          <select
            id="create-session-role"
            value={contextRole}
            onChange={(e) => setContextRole(e.target.value as ContextRole | "")}
            disabled={busy}
          >
            <option value="">— select role —</option>
            {CONTEXT_ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>

        <div className="form-field">
          <label htmlFor="create-session-objective">
            Objective (optional)
            <span className="form-char-count" aria-label={`${objective.length} of 4000 characters`}>
              {objective.length}/4000
            </span>
          </label>
          <textarea
            id="create-session-objective"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            maxLength={4000}
            rows={3}
            placeholder="Short objective for this session…"
            disabled={busy}
          />
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          <button
            type="button"
            className="submit-button submit-button--primary"
            onClick={() => void handlePrepareContext()}
            disabled={busy || !canPrepare}
          >
            {preparing ? "Preparing…" : "Prepare context"}
          </button>
          <button
            type="submit"
            className="submit-button"
            disabled={busy}
          >
            {submitting ? "Creating…" : "Skip context"}
          </button>
        </div>
      </form>

      {contextAssembly && (
        <ContextPreviewPanel
          goalId={goalId}
          assembly={contextAssembly}
          pkg={contextPkg}
          onStartSession={(packageId) => void handleLaunchWithContext(packageId)}
          onRegenerate={(replacePackageId) => void handlePrepareContext(replacePackageId)}
          onRetry={() => void handlePrepareContext()}
          busy={busy}
        />
      )}
    </div>
  );
}
