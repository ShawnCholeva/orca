import { useState, useEffect, useRef, useCallback } from "react";
import type {
  ContextAssembly,
  ContextAssemblyFailureCode,
  ContextPackage,
  ContextSourceType,
} from "@orca/contracts";
import { CONTEXT_PACKAGE_MAX_RENDERED_BYTES } from "@orca/contracts";
import {
  getContextPackage,
  listContextPackages,
  openEventStream,
  toErrorMessage,
} from "../../api";

const SOURCE_TYPE_LABELS: Record<ContextSourceType, string> = {
  goal: "Goal",
  refinement: "Refinement",
  workspace: "Workspace",
  document: "Document",
  memory_item: "Memory",
  decision: "Decision",
  session_summary: "Session summary",
};

const FAILURE_MESSAGES: Partial<Record<ContextAssemblyFailureCode, string>> = {
  invalid_input: "Invalid assembly input.",
  invalid_output: "Assembler produced invalid output.",
  output_too_large: "Context exceeds the size limit and cannot be assembled.",
  goal_archived: "Goal is archived.",
  source_missing: "Required source data is missing.",
  delivery_unavailable: "Context delivery is unavailable for this adapter.",
  internal_error: "An internal error occurred during assembly.",
  daemon_restart: "Assembly was interrupted by a daemon restart.",
};

type Props = {
  goalId: string;
  assembly: ContextAssembly | null;
  pkg: ContextPackage | null;
  onStartSession?: (packageId: string) => void;
  onRegenerate?: (replacePackageId: string) => void;
  onRetry?: () => void;
  busy?: boolean;
  readOnly?: boolean;
};

function countByType(types: ContextSourceType[]): Partial<Record<ContextSourceType, number>> {
  const counts: Partial<Record<ContextSourceType, number>> = {};
  for (const t of types) {
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

export function ContextPreviewPanel({
  goalId,
  assembly,
  pkg,
  onStartSession,
  onRegenerate,
  onRetry,
  busy = false,
  readOnly = false,
}: Props) {
  const [liveAssembly, setLiveAssembly] = useState<ContextAssembly | null>(assembly);
  const [livePkg, setLivePkg] = useState<ContextPackage | null>(pkg);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const liveAssemblyRef = useRef<ContextAssembly | null>(assembly);
  const refetchingRef = useRef(false);

  // Sync internal state when parent provides a new assembly (regenerate/retry)
  useEffect(() => {
    setLiveAssembly(assembly);
    setLivePkg(pkg);
    liveAssemblyRef.current = assembly;
    refetchingRef.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assembly?.id, pkg?.id]);

  const refetch = useCallback(async () => {
    if (refetchingRef.current) return;
    const asm = liveAssemblyRef.current;
    if (!asm) return;
    refetchingRef.current = true;
    try {
      // If package already fetched, re-fetch it directly; otherwise list to find updated assembly
      if (asm.packageId) {
        const pkgRes = await getContextPackage(asm.packageId);
        setLivePkg(pkgRes.package);
      } else {
        const res = await listContextPackages(goalId);
        const updated = res.assemblies.find((a) => a.id === asm.id);
        if (!updated) return;
        setLiveAssembly(updated);
        liveAssemblyRef.current = updated;
        if (updated.packageId) {
          const pkgRes = await getContextPackage(updated.packageId);
          setLivePkg(pkgRes.package);
        }
      }
    } catch (err) {
      setFetchError(toErrorMessage(err, "Failed to refresh context."));
    } finally {
      refetchingRef.current = false;
    }
  }, [goalId]);

  useEffect(() => {
    if (!liveAssembly) return;
    const stream = openEventStream({
      onEvent(event) {
        if (event.goalId !== goalId) return;
        if (!event.type.startsWith("context.")) return;
        void refetch();
      },
      onStatus() {},
    });
    return () => stream.close();
  }, [goalId, liveAssembly?.id, refetch]);

  if (!liveAssembly) {
    return (
      <div className="context-preview-panel context-preview-panel--idle">
        <p className="context-preview-idle-hint">
          Click <strong>Prepare context</strong> to assemble context for this session.
        </p>
      </div>
    );
  }

  const status = liveAssembly.status;
  const isPreparing = status === "pending" || status === "running";
  const isFailed = status === "failed";
  const isReady = status === "succeeded" && livePkg !== null;
  const sourceCounts = livePkg ? countByType(livePkg.sources.map((s) => s.type)) : {};

  return (
    <div className="context-preview-panel">
      {isPreparing && (
        <div className="context-preview-preparing" role="status" aria-live="polite">
          <span className="context-preview-spinner" aria-hidden="true" />
          <span>Assembling context…</span>
        </div>
      )}

      {!isPreparing && !isFailed && !isReady && (
        <div className="context-preview-preparing" role="status">
          <span>Loading…</span>
        </div>
      )}

      {isFailed && (
        <div className="context-preview-failed" role="alert">
          <p className="context-preview-failure-message">
            {(liveAssembly.failureCode ? FAILURE_MESSAGES[liveAssembly.failureCode] : undefined) ??
              "Assembly failed."}
          </p>
          {liveAssembly.failureCode && (
            <p className="context-preview-failure-code">
              Code: <code>{liveAssembly.failureCode}</code>
            </p>
          )}
          {!readOnly && onRetry && (
            <button
              type="button"
              className="submit-button"
              onClick={() => onRetry()}
              disabled={busy}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {isReady && livePkg && (
        <>
          <div className="context-preview-header">
            <span className="context-preview-meta">
              {livePkg.role} · {livePkg.adapterId} · {livePkg.renderedBytes}/
              {CONTEXT_PACKAGE_MAX_RENDERED_BYTES} bytes · ~{livePkg.estimatedTokens} tokens ·{" "}
              {livePkg.sourceCount} sources
            </span>
            {livePkg.sparse && (
              <span className="context-preview-badge context-preview-badge--sparse">Sparse</span>
            )}
            {livePkg.truncated && (
              <span className="context-preview-badge context-preview-badge--truncated">
                Truncated
              </span>
            )}
          </div>

          {livePkg.warnings.length > 0 && (
            <ul className="context-preview-warnings" aria-label="Warnings">
              {livePkg.warnings.map((w, i) => (
                <li key={i} className="context-preview-warning-chip">
                  {w}
                </li>
              ))}
            </ul>
          )}

          {livePkg.sparse && (
            <p className="context-preview-sparse-note">
              Context is thin — the goal has limited memory, decisions, and summaries.
            </p>
          )}

          <pre className="context-preview-body">{livePkg.renderedContext}</pre>

          {Object.keys(sourceCounts).length > 0 && (
            <div className="context-preview-sources" aria-label="Sources">
              {(Object.entries(sourceCounts) as [ContextSourceType, number][]).map(
                ([type, count]) => (
                  <span key={type} className="context-preview-source-count">
                    {SOURCE_TYPE_LABELS[type]}: {count}
                  </span>
                ),
              )}
            </div>
          )}

          {!readOnly && (onStartSession || onRegenerate) && (
            <div className="context-preview-actions">
              {onStartSession && (
                <button
                  type="button"
                  className="submit-button submit-button--primary"
                  onClick={() => onStartSession(livePkg.id)}
                  disabled={busy}
                >
                  Start session
                </button>
              )}
              {onRegenerate && (
                <button
                  type="button"
                  className="submit-button submit-button--secondary"
                  onClick={() => onRegenerate(livePkg.id)}
                  disabled={busy}
                >
                  Regenerate
                </button>
              )}
            </div>
          )}
        </>
      )}

      {fetchError && <p className="form-error">{fetchError}</p>}
    </div>
  );
}
