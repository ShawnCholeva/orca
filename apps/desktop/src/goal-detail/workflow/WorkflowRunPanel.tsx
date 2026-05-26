import { useCallback, useEffect, useState } from "react";
import type {
  ContextPackage,
  OrchestrationTransportAttempt,
  SessionSummary,
  Task,
  WorkflowArtifact,
  WorkflowDecisionTrace,
  WorkflowRun,
  WorkflowStepRun,
} from "@orca/contracts";
import {
  getWorkflowRun,
  getWorkflowStepRun,
  listContextPackages,
  listOrchestrationAttempts,
  listSessions,
  listTasks,
  listWorkflowDecisions,
  listWorkflowRunArtifacts,
  listWorkflowRuns,
  toErrorMessage,
} from "../../api";
import { ArtifactsList } from "./ArtifactsList";
import { DecisionTraceTimeline } from "./DecisionTraceTimeline";
import { StepTimeline } from "./StepTimeline";
import { TaskDagPreview } from "./TaskDagPreview";
import { WorkflowTransportDebugDrawer } from "./WorkflowTransportDebugDrawer";
import { summarizeWorkflowTransportStatus } from "./transportStatus";

type Props = {
  goalId: string;
  initialRunId?: string | null;
  refreshKey?: number;
};

type WorkflowPanelState = {
  runs: WorkflowRun[];
  run: WorkflowRun | null;
  stepRuns: WorkflowStepRun[];
  artifacts: WorkflowArtifact[];
  decisions: WorkflowDecisionTrace[];
  attempts: OrchestrationTransportAttempt[];
  tasks: Task[];
  sessions: SessionSummary[];
  contextPackages: ContextPackage[];
};

const EMPTY_STATE: WorkflowPanelState = {
  runs: [],
  run: null,
  stepRuns: [],
  artifacts: [],
  decisions: [],
  attempts: [],
  tasks: [],
  sessions: [],
  contextPackages: [],
};

const VALIDATION_ARTIFACT_TYPES = new Set(["test_report", "qa_report", "review_report"]);

export function WorkflowRunPanel({
  goalId,
  initialRunId = null,
  refreshKey = 0,
}: Props) {
  const [state, setState] = useState<WorkflowPanelState>(EMPTY_STATE);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId);
  const [debugAttemptId, setDebugAttemptId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const runsResponse = await listWorkflowRuns(goalId);
      const nextRunId = chooseRunId(runsResponse.runs, selectedRunId, initialRunId);

      if (!nextRunId) {
        setState(EMPTY_STATE);
        return;
      }

      if (selectedRunId !== nextRunId) {
        setSelectedRunId(nextRunId);
      }

      const [
        runResponse,
        decisionsResponse,
        artifactsResponse,
        tasksResponse,
        sessionsResponse,
        contextResponse,
        attemptsResponse,
      ] =
        await Promise.all([
          getWorkflowRun(goalId, nextRunId),
          listWorkflowDecisions(goalId, nextRunId),
          listWorkflowRunArtifacts(goalId, nextRunId),
          listTasks(goalId, { includeArchived: true, limit: 50 }),
          listSessions(goalId),
          listContextPackages(goalId, { limit: 50 }),
          listOrchestrationAttempts(goalId, nextRunId).catch(() => ({ attempts: [] })),
        ]);

      const stepRunIds = collectStepRunIds(
        runResponse.run,
        decisionsResponse.decisions,
        artifactsResponse.artifacts,
        tasksResponse.tasks,
        sessionsResponse.sessions,
        contextResponse.packages,
      );
      const stepRuns = (
        await Promise.all(
          stepRunIds.map(async (stepRunId) => {
            try {
              const response = await getWorkflowStepRun(goalId, stepRunId);
              return response.stepRun;
            } catch {
              return null;
            }
          }),
        )
      )
        .filter((stepRun): stepRun is WorkflowStepRun => stepRun !== null)
        .sort(compareStepRuns);

      const stepRunIdSet = new Set(stepRuns.map((stepRun) => stepRun.id));

      setState({
        runs: runsResponse.runs,
        run: runResponse.run,
        stepRuns,
        artifacts: sortByCreatedAtDesc(artifactsResponse.artifacts),
        decisions: sortByCreatedAtDesc(decisionsResponse.decisions),
        attempts: attemptsResponse.attempts,
        tasks: tasksResponse.tasks.filter(
          (task) =>
            task.workflowStepRunId !== null &&
            task.workflowStepRunId !== undefined &&
            stepRunIdSet.has(task.workflowStepRunId),
        ),
        sessions: sessionsResponse.sessions.filter(
          (session) =>
            session.workflowStepRunId !== null &&
            session.workflowStepRunId !== undefined &&
            stepRunIdSet.has(session.workflowStepRunId),
        ),
        contextPackages: contextResponse.packages.filter(
          (pkg) =>
            pkg.workflowStepRunId !== null &&
            pkg.workflowStepRunId !== undefined &&
            stepRunIdSet.has(pkg.workflowStepRunId),
        ),
      });
    } catch (err) {
      setError(toErrorMessage(err, "Failed to load workflow run."));
    } finally {
      setLoading(false);
    }
  }, [goalId, initialRunId, selectedRunId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const latestDecision = state.decisions[0] ?? null;
  const currentStep =
    state.run?.currentStepRunId !== null
      ? state.stepRuns.find((step) => step.id === state.run?.currentStepRunId) ?? null
      : null;
  const validationArtifactCount = state.artifacts.filter((artifact) =>
    VALIDATION_ARTIFACT_TYPES.has(artifact.type),
  ).length;
  const transportStatus = summarizeWorkflowTransportStatus(state.attempts);

  if (!loading && !error && state.runs.length === 0) {
    return null;
  }

  return (
    <section className="goal-detail-section workflow-run-panel" aria-label="Workflow">
      <div className="goal-detail-section-header">
        <div>
          <h3 className="goal-detail-section-title">Workflow</h3>
          {state.run && (
            <p className="workflow-run-panel-subtitle">
              {state.run.templateId} v{state.run.templateVersion} · started{" "}
              {formatTimestamp(state.run.startedAt)}
            </p>
          )}
        </div>
        {state.runs.length > 1 && (
          <label className="workflow-run-select">
            <span>Run</span>
            <select
              aria-label="Workflow run"
              value={selectedRunId ?? ""}
              onChange={(event) => setSelectedRunId(event.target.value)}
            >
              {state.runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {formatRunOption(run)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {loading && state.run === null && <p className="workflow-panel-empty">Loading workflow...</p>}

      {!loading && error && (
        <div className="workflow-panel-error">
          <p className="form-error">{error}</p>
          <button type="button" className="goal-action-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {state.run && (
        <div className="workflow-run-panel-body">
          <section className="workflow-run-summary">
            <div className="workflow-run-summary-head">
              <div>
                <p className="workflow-run-summary-label">Current run</p>
                <h4 className="workflow-run-summary-title">
                  {formatTemplateLabel(state.run.templateId)}
                  {currentStep ? ` · ${formatStepLabel(currentStep.stepTemplateId)}` : ""}
                </h4>
              </div>
              <span className={`workflow-run-summary-status workflow-run-summary-status--${state.run.status}`}>
                {state.run.status}
              </span>
            </div>

            <dl className="workflow-run-summary-grid">
              <div>
                <dt>Step runs</dt>
                <dd>{state.stepRuns.length}</dd>
              </div>
              <div>
                <dt>Artifacts</dt>
                <dd>{state.artifacts.length}</dd>
              </div>
              <div>
                <dt>Linked tasks</dt>
                <dd>{state.tasks.length}</dd>
              </div>
              <div>
                <dt>Linked sessions</dt>
                <dd>{state.sessions.length}</dd>
              </div>
              <div>
                <dt>Validation outputs</dt>
                <dd>{validationArtifactCount}</dd>
              </div>
              <div>
                <dt>Context packages</dt>
                <dd>{state.contextPackages.length}</dd>
              </div>
            </dl>

            {transportStatus && (
              <div className="workflow-run-transport-summary">
                <div>
                  <p className="workflow-run-summary-label">Transport</p>
                  <p className="workflow-run-next-action-title">{transportStatus.label}</p>
                </div>
                <button
                  type="button"
                  className="goal-action-button goal-action-button--secondary"
                  onClick={() => setDebugAttemptId(state.attempts.at(-1)?.id ?? null)}
                >
                  Debug transport
                </button>
              </div>
            )}

            {latestDecision && (
              <div className="workflow-run-next-action">
                <p className="workflow-run-summary-label">Next action</p>
                <p className="workflow-run-next-action-title">
                  {summarizeAction(latestDecision.selectedAction)}
                </p>
                <p className="workflow-run-next-action-reason">{latestDecision.reason}</p>
              </div>
            )}
          </section>

          <StepTimeline
            steps={state.stepRuns}
            currentStepRunId={state.run.currentStepRunId}
          />
          <ArtifactsList artifacts={state.artifacts} stepRuns={state.stepRuns} />
          <TaskDagPreview tasks={state.tasks} sessions={state.sessions} />
          <DecisionTraceTimeline
            decisions={state.decisions}
            attempts={state.attempts}
            onOpenTransportDebug={setDebugAttemptId}
          />
        </div>
      )}

      {state.run && debugAttemptId !== null && (
        <WorkflowTransportDebugDrawer
          attempts={state.attempts}
          initialAttemptId={debugAttemptId}
          run={state.run}
          onClose={() => setDebugAttemptId(null)}
        />
      )}
    </section>
  );
}

function chooseRunId(
  runs: WorkflowRun[],
  selectedRunId: string | null,
  initialRunId: string | null,
): string | null {
  if (selectedRunId && runs.some((run) => run.id === selectedRunId)) {
    return selectedRunId;
  }
  if (initialRunId && runs.some((run) => run.id === initialRunId)) {
    return initialRunId;
  }
  return runs[0]?.id ?? null;
}

function collectStepRunIds(
  run: WorkflowRun,
  decisions: WorkflowDecisionTrace[],
  artifacts: WorkflowArtifact[],
  tasks: Task[],
  sessions: SessionSummary[],
  contextPackages: ContextPackage[],
): string[] {
  const ids = new Set<string>();

  if (run.currentStepRunId) {
    ids.add(run.currentStepRunId);
  }
  for (const decision of decisions) {
    if (decision.stepRunId) ids.add(decision.stepRunId);
  }
  for (const artifact of artifacts) {
    if (artifact.stepRunId) ids.add(artifact.stepRunId);
  }
  for (const task of tasks) {
    if (task.workflowStepRunId) ids.add(task.workflowStepRunId);
  }
  for (const session of sessions) {
    if (session.workflowStepRunId) ids.add(session.workflowStepRunId);
  }
  for (const contextPackage of contextPackages) {
    if (contextPackage.workflowStepRunId) ids.add(contextPackage.workflowStepRunId);
  }

  return [...ids];
}

function compareStepRuns(left: WorkflowStepRun, right: WorkflowStepRun): number {
  return left.ordinal - right.ordinal || left.attempt - right.attempt;
}

function sortByCreatedAtDesc<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function formatTemplateLabel(templateId: string): string {
  return templateId === "orca/engineering" ? "Engineering workflow" : templateId;
}

function formatStepLabel(stepTemplateId: string): string {
  return stepTemplateId
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function summarizeAction(value: string): string {
  return value
    .replace(/^recommend_advance:/, "advance: ")
    .replace(/^recommend_/, "")
    .replace(/^request_input:/, "request input: ")
    .replace(/_/g, " ");
}

function formatTimestamp(value: string): string {
  return value.slice(0, 16).replace("T", " ");
}

function formatRunOption(run: WorkflowRun): string {
  return `${run.status} · ${formatTimestamp(run.startedAt)}`;
}
