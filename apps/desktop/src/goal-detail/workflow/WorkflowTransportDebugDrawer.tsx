import { useEffect, useState } from "react";
import type {
  OrchestrationTransportAttempt,
  OrchestrationWorkerDetail,
  WorkflowRun,
} from "@orca/contracts";
import { getModelProviderDisplayName } from "@orca/contracts";

import { getOrchestrationWorker, toErrorMessage } from "../../api";
import {
  didFallback,
  formatAttemptStatus,
  formatFailureReason,
  formatTransportLabel,
  summarizeAttemptStatus,
} from "./transportStatus";

type Props = {
  attempts: OrchestrationTransportAttempt[];
  initialAttemptId: string | null;
  run: WorkflowRun;
  onClose: () => void;
};

export function WorkflowTransportDebugDrawer({
  attempts,
  initialAttemptId,
  run,
  onClose,
}: Props) {
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(
    initialAttemptId ?? attempts.at(-1)?.id ?? null,
  );
  const [worker, setWorker] = useState<OrchestrationWorkerDetail | null>(null);
  const [loadingWorker, setLoadingWorker] = useState(false);
  const [workerError, setWorkerError] = useState<string | null>(null);

  useEffect(() => {
    if (!attempts.some((attempt) => attempt.id === selectedAttemptId)) {
      setSelectedAttemptId(initialAttemptId ?? attempts.at(-1)?.id ?? null);
    }
  }, [attempts, initialAttemptId, selectedAttemptId]);

  const selectedAttempt =
    attempts.find((attempt) => attempt.id === selectedAttemptId) ?? attempts.at(-1) ?? null;

  useEffect(() => {
    if (!selectedAttempt?.workerId) {
      setWorker(null);
      setWorkerError(null);
      setLoadingWorker(false);
      return;
    }

    let cancelled = false;
    setLoadingWorker(true);
    setWorkerError(null);

    getOrchestrationWorker(selectedAttempt.workerId)
      .then((response) => {
        if (!cancelled) {
          setWorker(response.worker);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setWorker(null);
          setWorkerError(toErrorMessage(err, "Failed to load worker diagnostics."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingWorker(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedAttempt?.workerId]);

  const latestAttempt = attempts.at(-1) ?? null;

  return (
    <aside
      className="workflow-transport-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Transport Debug"
    >
      <div className="workflow-transport-drawer-header">
        <div>
          <h3 className="workflow-transport-drawer-title">Transport Debug</h3>
          <p className="workflow-transport-drawer-subtitle">
            {run.templateId} v{run.templateVersion} · {attempts.length} attempt
            {attempts.length === 1 ? "" : "s"}
          </p>
        </div>
        <button type="button" className="goal-action-button goal-action-button--secondary" onClick={onClose}>
          Close
        </button>
      </div>

      <dl className="workflow-transport-debug-grid">
        <div>
          <dt>Provider</dt>
          <dd>
            {latestAttempt ? getModelProviderDisplayName(latestAttempt.providerId) : "Not available"}
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{latestAttempt?.modelId ?? "Not available"}</dd>
        </div>
        <div>
          <dt>Fallback</dt>
          <dd>{didFallback(attempts) ? "Occurred" : "Not needed"}</dd>
        </div>
      </dl>

      <section className="workflow-transport-card">
        <div className="workflow-panel-card-header">
          <h4 className="workflow-panel-card-title">Attempt Timeline</h4>
          <span className="workflow-panel-card-meta">{attempts.length} recorded</span>
        </div>
        {attempts.length === 0 ? (
          <p className="workflow-panel-empty">No transport attempts recorded for this run.</p>
        ) : (
          <ol className="workflow-transport-attempt-list">
            {attempts.map((attempt) => {
              const status = summarizeAttemptStatus(attempt, attempts);
              const selected = attempt.id === selectedAttempt?.id;
              return (
                <li key={attempt.id}>
                  <button
                    type="button"
                    className={`workflow-transport-attempt-button${selected ? " workflow-transport-attempt-button--selected" : ""}`}
                    onClick={() => setSelectedAttemptId(attempt.id)}
                  >
                    <span className="workflow-transport-attempt-main">
                      <span className="workflow-transport-attempt-title">
                        {formatTransportLabel(attempt.transport)}
                      </span>
                      <span
                        className={`workflow-transport-status-chip workflow-transport-status-chip--${status.tone}`}
                      >
                        {status.label}
                      </span>
                    </span>
                    <span className="workflow-transport-attempt-meta">
                      {getModelProviderDisplayName(attempt.providerId)} · {attempt.modelId} ·{" "}
                      {formatAttemptStatus(attempt.status)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {selectedAttempt && (
        <section className="workflow-transport-card">
          <div className="workflow-panel-card-header">
            <h4 className="workflow-panel-card-title">Selected Attempt</h4>
            <span className="workflow-panel-card-meta">{selectedAttempt.id}</span>
          </div>

          <dl className="workflow-transport-detail-list">
            <div>
              <dt>Transport</dt>
              <dd>{formatTransportLabel(selectedAttempt.transport)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{formatAttemptStatus(selectedAttempt.status)}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{formatTimestamp(selectedAttempt.startedAt ?? selectedAttempt.createdAt)}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd>{selectedAttempt.finishedAt ? formatTimestamp(selectedAttempt.finishedAt) : "In progress"}</dd>
            </div>
            <div>
              <dt>Failure reason</dt>
              <dd>{formatFailureReason(selectedAttempt.failureReason) ?? "None"}</dd>
            </div>
            <div>
              <dt>Failure detail</dt>
              <dd>{selectedAttempt.failureMessage ?? selectedAttempt.diagnostics ?? "None"}</dd>
            </div>
          </dl>
        </section>
      )}

      <section className="workflow-transport-card">
        <div className="workflow-panel-card-header">
          <h4 className="workflow-panel-card-title">Worker Diagnostics</h4>
          <span className="workflow-panel-card-meta">
            {selectedAttempt?.workerId ?? "No worker"}
          </span>
        </div>

        {!selectedAttempt?.workerId ? (
          <p className="workflow-panel-empty">This attempt did not use a hidden worker.</p>
        ) : loadingWorker ? (
          <p className="workflow-panel-empty">Loading worker diagnostics…</p>
        ) : workerError ? (
          <p className="form-error" role="alert">{workerError}</p>
        ) : worker ? (
          <>
            <dl className="workflow-transport-detail-list">
              <div>
                <dt>Worker state</dt>
                <dd>{formatWorkerState(worker.state)}</dd>
              </div>
              <div>
                <dt>Last readiness/auth result</dt>
                <dd>{summarizeReadiness(worker)}</dd>
              </div>
              <div>
                <dt>Failure reason</dt>
                <dd>{formatFailureReason(worker.failureReason) ?? "None"}</dd>
              </div>
              <div>
                <dt>Last health check</dt>
                <dd>{worker.healthCheckedAt ? formatTimestamp(worker.healthCheckedAt) : "Not recorded"}</dd>
              </div>
            </dl>

            <div className="workflow-transport-output">
              <p className="workflow-transport-output-label">Sanitized output tail</p>
              <pre className="workflow-transport-output-tail">
                {worker.outputTail && worker.outputTail.trim().length > 0
                  ? worker.outputTail
                  : "No output tail recorded."}
              </pre>
            </div>
          </>
        ) : (
          <p className="workflow-panel-empty">No worker diagnostics recorded.</p>
        )}
      </section>
    </aside>
  );
}

function summarizeReadiness(worker: OrchestrationWorkerDetail): string {
  if (worker.state === "auth_required" || worker.failureReason === "interactive_auth_lost") {
    return worker.failureMessage ?? "Worker needs authentication before another attempt can run.";
  }
  if (worker.healthCheckedAt && (worker.state === "ready" || worker.state === "awaiting_input")) {
    return `Ready at ${formatTimestamp(worker.healthCheckedAt)}`;
  }
  if (worker.failureMessage) {
    return worker.failureMessage;
  }
  if (worker.healthCheckedAt) {
    return `Health checked at ${formatTimestamp(worker.healthCheckedAt)}`;
  }
  return "No readiness or auth result recorded.";
}

function formatWorkerState(state: OrchestrationWorkerDetail["state"]): string {
  return state.replace(/_/g, " ");
}

function formatTimestamp(value: string): string {
  return value.slice(0, 16).replace("T", " ");
}
