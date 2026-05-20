import { useState, useEffect, useCallback } from "react";
import type { GoalDetailResponse } from "@orca/contracts";
import { getGoalDetail } from "../api";
import { WorkspaceListPanel } from "./WorkspaceListPanel";
import { SessionsPanel } from "./sessions/SessionsPanel";
import { MemoryPanel } from "./memory/MemoryPanel";
import { DecisionsPanel } from "./decisions/DecisionsPanel";

type Props = {
  goalId: string;
  onBack: () => void;
  refreshKey: number;
};

export function GoalDetailView({ goalId, onBack, refreshKey }: Props) {
  const [detail, setDetail] = useState<GoalDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getGoalDetail(goalId);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Goal detail.");
    } finally {
      setLoading(false);
    }
  }, [goalId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail, refreshKey]);

  if (loading && !detail) {
    return (
      <div className="goal-detail-loading">
        <p>Loading…</p>
      </div>
    );
  }

  if (error && !detail) {
    return (
      <div className="goal-detail-error">
        <p className="form-error">{error}</p>
        <button type="button" className="goal-action-button" onClick={() => void loadDetail()}>
          Retry
        </button>
      </div>
    );
  }

  if (!detail) return null;

  const { goal, refinement, workspaces } = detail;

  return (
    <div className="goal-detail">
      <div className="goal-detail-topbar">
        <button type="button" className="goal-action-button" onClick={onBack}>
          ← Back
        </button>
      </div>

      <div className="goal-detail-main">
        <header className="goal-detail-header">
          <h2 className="goal-detail-title">{goal.title}</h2>
          <span className={`goal-status goal-status--${goal.status}`}>{goal.status}</span>
        </header>

        {goal.description && (
          <p className="goal-detail-description">{goal.description}</p>
        )}

        {refinement && (
          <section className="goal-detail-section goal-refinement" aria-label="Refinement">
            <h3 className="goal-detail-section-title">Refinement</h3>

            {refinement.successCriteria.length > 0 && (
              <div className="refinement-display-block">
                <h4 className="refinement-display-heading">Success Criteria</h4>
                <ul className="refinement-display-list">
                  {refinement.successCriteria.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {refinement.constraints.length > 0 && (
              <div className="refinement-display-block">
                <h4 className="refinement-display-heading">Constraints</h4>
                <ul className="refinement-display-list">
                  {refinement.constraints.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {refinement.assumptions.length > 0 && (
              <div className="refinement-display-block">
                <h4 className="refinement-display-heading">Assumptions</h4>
                <ul className="refinement-display-list">
                  {refinement.assumptions.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        <WorkspaceListPanel
          goalId={goalId}
          workspaces={workspaces}
          onChanged={() => void loadDetail()}
        />

        <SessionsPanel goalId={goalId} workspaces={workspaces} />

        <MemoryPanel goalId={goalId} />

        <DecisionsPanel goalId={goalId} />
      </div>
    </div>
  );
}
