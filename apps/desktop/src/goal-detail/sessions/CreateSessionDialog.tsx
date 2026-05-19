import { useState, useEffect, FormEvent } from "react";
import type { AdapterSummary, Workspace } from "@orca/contracts";
import { listAdapters, createSession, startSession, ApiError, toErrorMessage } from "../../api";

function adapterBinEnvVar(id: string): string {
  return `ORCA_${id.toUpperCase().replace(/-/g, "_")}_BIN`;
}

type Props = {
  goalId: string;
  workspaces: Workspace[];
  onCreated(sessionId: string): void;
  onClose(): void;
};

export function CreateSessionDialog({ goalId, workspaces, onCreated, onClose }: Props) {
  const [adapters, setAdapters] = useState<AdapterSummary[]>([]);
  const [adaptersLoading, setAdaptersLoading] = useState(true);
  const [adaptersError, setAdaptersError] = useState<string | null>(null);

  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [adapterId, setAdapterId] = useState("");
  const [role, setRole] = useState("");
  const [instruction, setInstruction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAdaptersLoading(true);
    listAdapters()
      .then((res) => {
        setAdapters(res.adapters);
        if (res.adapters.length > 0) {
          setAdapterId(res.adapters[0]!.id);
        }
      })
      .catch((err) => setAdaptersError(toErrorMessage(err, "Failed to load adapters.")))
      .finally(() => setAdaptersLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedAdapter = adapters.find((a) => a.id === adapterId);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!workspaceId) { setError("Workspace is required."); return; }
    if (!adapterId) { setError("Adapter is required."); return; }
    if (role.length > 100) { setError("Role must be 100 characters or fewer."); return; }
    if (instruction.length > 4000) { setError("Instruction must be 4000 characters or fewer."); return; }

    setSubmitting(true);
    setError(null);
    try {
      const { session } = await createSession(goalId, {
        workspaceId,
        adapterId: adapterId as Parameters<typeof createSession>[1]["adapterId"],
        role: role.trim() || undefined,
        instruction: instruction.trim() || undefined,
      });
      await startSession(session.id, { terminalCols: 80, terminalRows: 24 });
      onCreated(session.id);
    } catch (err) {
      const ae = err instanceof ApiError ? err : null;
      const code = ae?.code;
      if (code === "command_not_found") {
        setError(`Adapter command not found. Set the binary path via the ${adapterBinEnvVar(adapterId)} env var.`);
      } else if (code === "workspace_unavailable") {
        setError("Workspace path is not accessible. Check that the directory exists.");
      } else {
        setError(toErrorMessage(err, "Failed to create session."));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="create-session-dialog" role="dialog" aria-label="Create Session">
      <div className="create-session-dialog-header">
        <h3 className="create-session-dialog-title">New Session</h3>
        <button type="button" className="goal-action-button" onClick={onClose} disabled={submitting}>
          Cancel
        </button>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="create-form">
        <div className="form-field">
          <label htmlFor="create-session-workspace">Workspace</label>
          <select
            id="create-session-workspace"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            disabled={submitting}
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
                disabled={submitting}
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
          <input
            id="create-session-role"
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            maxLength={100}
            placeholder="e.g. Architect"
            disabled={submitting}
          />
        </div>

        <div className="form-field">
          <label htmlFor="create-session-instruction">Instruction (optional)</label>
          <textarea
            id="create-session-instruction"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            maxLength={4000}
            rows={3}
            placeholder="Short instruction for this session…"
            disabled={submitting}
          />
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          <button
            type="submit"
            className="submit-button"
            disabled={submitting}
          >
            {submitting ? "Creating…" : "Create & Start"}
          </button>
        </div>
      </form>
    </div>
  );
}
