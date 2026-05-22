import { useState } from "react";
import {
  M7_RECOMMENDATION_MAX_RATIONALE_CHARS,
  M7_RECOMMENDATION_MAX_TITLE_CHARS,
  ProposedAction,
  RefinementFieldKey,
  type ProposedActionKind,
  type Recommendation,
} from "@orca/contracts";
import { toErrorMessage, type ModifyRecommendationRequest } from "../../api";

const TASK_ROLES = ["architect", "engineer", "reviewer", "qa", "generalist"] as const;
const REFINEMENT_FIELDS = RefinementFieldKey.options;
const REVIEWER_ROLES = ["reviewer", "qa"] as const;
const TASK_STATUSES = ["proposed", "open", "in_progress", "blocked", "done", "cancelled"] as const;
const ALL_KINDS: ProposedActionKind[] = [
  "create_session",
  "continue_session",
  "review_output",
  "refine_goal",
  "split_task",
  "run_validation",
  "resolve_conflict",
  "update_plan",
  "ask_user",
  "mark_complete",
  "pause_work",
];

type Props = {
  recommendation: Recommendation;
  onSave: (patch: ModifyRecommendationRequest) => Promise<void>;
  onClose: () => void;
};

export function RecommendationModifyDialog({ recommendation, onSave, onClose }: Props) {
  const [title, setTitle] = useState(recommendation.title);
  const [rationale, setRationale] = useState(recommendation.rationale);
  const [kind, setKind] = useState<ProposedActionKind>(recommendation.proposedAction.kind);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-kind fields, initialized from existing action
  const existingAction = recommendation.proposedAction;
  const [adapterId, setAdapterId] = useState(existingAction.kind === "create_session" ? existingAction.adapterId : "");
  const [sessionWorkspaceId, setSessionWorkspaceId] = useState(
    existingAction.kind === "create_session" ? (existingAction.workspaceId ?? "") : "",
  );
  const [sessionRole, setSessionRole] = useState<string>(
    existingAction.kind === "create_session" ? existingAction.role : "engineer",
  );
  const [sessionObjective, setSessionObjective] = useState(
    existingAction.kind === "create_session" ? existingAction.objective : "",
  );
  const [contextPackageId, setContextPackageId] = useState(
    existingAction.kind === "create_session" ? (existingAction.contextPackageId ?? "") : "",
  );
  const [sessionId, setSessionId] = useState(
    existingAction.kind === "continue_session"
      ? existingAction.sessionId
      : existingAction.kind === "review_output"
        ? existingAction.sessionId
        : "",
  );
  const [reviewerRole, setReviewerRole] = useState<"reviewer" | "qa">(
    existingAction.kind === "review_output" ? (existingAction.reviewerRole ?? "reviewer") : "reviewer",
  );
  const [missingFieldsText, setMissingFieldsText] = useState(
    existingAction.kind === "refine_goal" ? existingAction.missingFields.join("\n") : "",
  );
  const [splitTaskId, setSplitTaskId] = useState(
    existingAction.kind === "split_task" ? existingAction.taskId : "",
  );
  const [suggestedChildrenText, setSuggestedChildrenText] = useState(
    existingAction.kind === "split_task"
      ? existingAction.suggestedChildren.map((c) => c.title).join("\n")
      : "",
  );
  const [validationRole, setValidationRole] = useState<"reviewer" | "qa">(
    existingAction.kind === "run_validation" ? existingAction.suggestedRole : "reviewer",
  );
  const [validationTaskId, setValidationTaskId] = useState(
    existingAction.kind === "run_validation" ? (existingAction.taskId ?? "") : "",
  );
  const [validationSessionId, setValidationSessionId] = useState(
    existingAction.kind === "run_validation" ? (existingAction.sessionId ?? "") : "",
  );
  const [validationObjective, setValidationObjective] = useState(
    existingAction.kind === "run_validation" ? existingAction.objective : "",
  );
  const [conflictId, setConflictId] = useState(
    existingAction.kind === "resolve_conflict" ? existingAction.conflictId : "",
  );
  const [resolutionNote, setResolutionNote] = useState(
    existingAction.kind === "resolve_conflict" ? (existingAction.suggestedResolutionNote ?? "") : "",
  );
  const [updateTaskId, setUpdateTaskId] = useState(
    existingAction.kind === "update_plan" ? existingAction.taskId : "",
  );
  const [suggestedStatus, setSuggestedStatus] = useState(
    existingAction.kind === "update_plan" ? (existingAction.suggestedStatus ?? "") : "",
  );
  const [addCriteriaText, setAddCriteriaText] = useState(
    existingAction.kind === "update_plan"
      ? (existingAction.addAcceptanceCriteria ?? []).join("\n")
      : "",
  );
  const [askQuestion, setAskQuestion] = useState(
    existingAction.kind === "ask_user" ? existingAction.question : "",
  );
  const [markCompleteTaskId, setMarkCompleteTaskId] = useState(
    existingAction.kind === "mark_complete" ? existingAction.taskId : "",
  );
  const [pauseReason, setPauseReason] = useState(
    existingAction.kind === "pause_work" ? existingAction.reason : "",
  );
  const [relatedTaskIdsText, setRelatedTaskIdsText] = useState(
    existingAction.kind === "pause_work" ? existingAction.relatedTaskIds.join("\n") : "",
  );

  function buildProposedAction(): { ok: true; action: typeof ProposedAction._type } | { ok: false; error: string } {
    let raw: unknown;
    switch (kind) {
      case "create_session":
        raw = {
          kind,
          adapterId: adapterId.trim(),
          workspaceId: sessionWorkspaceId.trim() || undefined,
          role: sessionRole,
          objective: sessionObjective.trim(),
          contextPackageId: contextPackageId.trim() || undefined,
        };
        break;
      case "continue_session":
        raw = { kind, sessionId: sessionId.trim() };
        break;
      case "review_output":
        raw = {
          kind,
          sessionId: sessionId.trim(),
          reviewerRole: reviewerRole || undefined,
        };
        break;
      case "refine_goal": {
        const fields = missingFieldsText
          .split(/[\n,]/)
          .map((f) => f.trim())
          .filter(Boolean);
        raw = { kind, missingFields: fields };
        break;
      }
      case "split_task": {
        const children = suggestedChildrenText
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean)
          .map((title) => ({ title }));
        raw = { kind, taskId: splitTaskId.trim(), suggestedChildren: children };
        break;
      }
      case "run_validation":
        raw = {
          kind,
          suggestedRole: validationRole,
          objective: validationObjective.trim(),
          taskId: validationTaskId.trim() || undefined,
          sessionId: validationSessionId.trim() || undefined,
        };
        break;
      case "resolve_conflict":
        raw = {
          kind,
          conflictId: conflictId.trim(),
          suggestedResolutionNote: resolutionNote.trim() || undefined,
        };
        break;
      case "update_plan": {
        const criteria = addCriteriaText
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean);
        raw = {
          kind,
          taskId: updateTaskId.trim(),
          suggestedStatus: suggestedStatus || undefined,
          addAcceptanceCriteria: criteria.length > 0 ? criteria : undefined,
        };
        break;
      }
      case "ask_user":
        raw = { kind, question: askQuestion.trim() };
        break;
      case "mark_complete":
        raw = { kind, taskId: markCompleteTaskId.trim() };
        break;
      case "pause_work": {
        const ids = relatedTaskIdsText
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean);
        raw = { kind, reason: pauseReason.trim(), relatedTaskIds: ids };
        break;
      }
    }

    const result = ProposedAction.safeParse(raw);
    if (!result.success) {
      return { ok: false, error: result.error.issues[0]?.message ?? "Invalid action." };
    }
    return { ok: true, action: result.data };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const trimmedTitle = title.trim();
    if (!trimmedTitle) { setError("Title is required."); return; }
    if (trimmedTitle.length > M7_RECOMMENDATION_MAX_TITLE_CHARS) {
      setError(`Title must be ${M7_RECOMMENDATION_MAX_TITLE_CHARS} characters or fewer.`);
      return;
    }
    if (rationale.length > M7_RECOMMENDATION_MAX_RATIONALE_CHARS) {
      setError(`Rationale must be ${M7_RECOMMENDATION_MAX_RATIONALE_CHARS} characters or fewer.`);
      return;
    }

    const actionResult = buildProposedAction();
    if (!actionResult.ok) { setError(actionResult.error); return; }

    const patch: ModifyRecommendationRequest = {
      title: trimmedTitle !== recommendation.title ? trimmedTitle : undefined,
      rationale: rationale !== recommendation.rationale ? rationale : undefined,
      proposedAction:
        JSON.stringify(actionResult.action) !== JSON.stringify(recommendation.proposedAction)
          ? actionResult.action
          : undefined,
    };

    if (patch.title === undefined && patch.rationale === undefined && patch.proposedAction === undefined) {
      setError("No changes made.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (err) {
      setError(toErrorMessage(err, "Modify failed."));
      setSaving(false);
    }
  }

  return (
    <div className="recommendation-modify-dialog" role="dialog" aria-modal="true" aria-label="Modify Recommendation">
      <div className="task-dialog-content">
        <h4 className="task-dialog-title">Modify Recommendation</h4>
        <form className="create-form" onSubmit={(e) => void handleSubmit(e)}>
          <label htmlFor="rec-modify-title">Title</label>
          <input
            id="rec-modify-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={saving}
          />

          <label htmlFor="rec-modify-rationale">Rationale</label>
          <textarea
            id="rec-modify-rationale"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            rows={4}
            disabled={saving}
          />

          <label htmlFor="rec-modify-kind">Action Kind</label>
          <select
            id="rec-modify-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ProposedActionKind)}
            disabled={saving}
          >
            {ALL_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, " ")}
              </option>
            ))}
          </select>

          <PerKindFields
            kind={kind}
            saving={saving}
            adapterId={adapterId} setAdapterId={setAdapterId}
            sessionWorkspaceId={sessionWorkspaceId} setSessionWorkspaceId={setSessionWorkspaceId}
            sessionRole={sessionRole} setSessionRole={setSessionRole}
            sessionObjective={sessionObjective} setSessionObjective={setSessionObjective}
            contextPackageId={contextPackageId} setContextPackageId={setContextPackageId}
            sessionId={sessionId} setSessionId={setSessionId}
            reviewerRole={reviewerRole} setReviewerRole={setReviewerRole}
            missingFieldsText={missingFieldsText} setMissingFieldsText={setMissingFieldsText}
            splitTaskId={splitTaskId} setSplitTaskId={setSplitTaskId}
            suggestedChildrenText={suggestedChildrenText} setSuggestedChildrenText={setSuggestedChildrenText}
            validationRole={validationRole} setValidationRole={setValidationRole}
            validationTaskId={validationTaskId} setValidationTaskId={setValidationTaskId}
            validationSessionId={validationSessionId} setValidationSessionId={setValidationSessionId}
            validationObjective={validationObjective} setValidationObjective={setValidationObjective}
            conflictId={conflictId} setConflictId={setConflictId}
            resolutionNote={resolutionNote} setResolutionNote={setResolutionNote}
            updateTaskId={updateTaskId} setUpdateTaskId={setUpdateTaskId}
            suggestedStatus={suggestedStatus} setSuggestedStatus={setSuggestedStatus}
            addCriteriaText={addCriteriaText} setAddCriteriaText={setAddCriteriaText}
            askQuestion={askQuestion} setAskQuestion={setAskQuestion}
            markCompleteTaskId={markCompleteTaskId} setMarkCompleteTaskId={setMarkCompleteTaskId}
            pauseReason={pauseReason} setPauseReason={setPauseReason}
            relatedTaskIdsText={relatedTaskIdsText} setRelatedTaskIdsText={setRelatedTaskIdsText}
          />

          {error && <p className="form-error task-dialog-error">{error}</p>}

          <div className="task-dialog-actions">
            <button type="submit" className="goal-action-button" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" className="goal-action-button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type PerKindFieldsProps = {
  kind: ProposedActionKind;
  saving: boolean;
  adapterId: string; setAdapterId: (v: string) => void;
  sessionWorkspaceId: string; setSessionWorkspaceId: (v: string) => void;
  sessionRole: string; setSessionRole: (v: string) => void;
  sessionObjective: string; setSessionObjective: (v: string) => void;
  contextPackageId: string; setContextPackageId: (v: string) => void;
  sessionId: string; setSessionId: (v: string) => void;
  reviewerRole: "reviewer" | "qa"; setReviewerRole: (v: "reviewer" | "qa") => void;
  missingFieldsText: string; setMissingFieldsText: (v: string) => void;
  splitTaskId: string; setSplitTaskId: (v: string) => void;
  suggestedChildrenText: string; setSuggestedChildrenText: (v: string) => void;
  validationRole: "reviewer" | "qa"; setValidationRole: (v: "reviewer" | "qa") => void;
  validationTaskId: string; setValidationTaskId: (v: string) => void;
  validationSessionId: string; setValidationSessionId: (v: string) => void;
  validationObjective: string; setValidationObjective: (v: string) => void;
  conflictId: string; setConflictId: (v: string) => void;
  resolutionNote: string; setResolutionNote: (v: string) => void;
  updateTaskId: string; setUpdateTaskId: (v: string) => void;
  suggestedStatus: string; setSuggestedStatus: (v: string) => void;
  addCriteriaText: string; setAddCriteriaText: (v: string) => void;
  askQuestion: string; setAskQuestion: (v: string) => void;
  markCompleteTaskId: string; setMarkCompleteTaskId: (v: string) => void;
  pauseReason: string; setPauseReason: (v: string) => void;
  relatedTaskIdsText: string; setRelatedTaskIdsText: (v: string) => void;
};

function PerKindFields(p: PerKindFieldsProps) {
  const { kind, saving } = p;

  switch (kind) {
    case "create_session":
      return (
        <>
          <label htmlFor="rec-modify-adapter-id">Adapter ID</label>
          <input id="rec-modify-adapter-id" type="text" value={p.adapterId} onChange={(e) => p.setAdapterId(e.target.value)} disabled={saving} />
          <label htmlFor="rec-modify-session-ws">Workspace ID (optional)</label>
          <input id="rec-modify-session-ws" type="text" value={p.sessionWorkspaceId} onChange={(e) => p.setSessionWorkspaceId(e.target.value)} disabled={saving} />
          <label htmlFor="rec-modify-session-role">Role</label>
          <select id="rec-modify-session-role" value={p.sessionRole} onChange={(e) => p.setSessionRole(e.target.value)} disabled={saving}>
            {TASK_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <label htmlFor="rec-modify-session-obj">Objective</label>
          <textarea id="rec-modify-session-obj" value={p.sessionObjective} onChange={(e) => p.setSessionObjective(e.target.value)} rows={2} disabled={saving} />
          <label htmlFor="rec-modify-ctx-pkg">Context Package ID (optional)</label>
          <input id="rec-modify-ctx-pkg" type="text" value={p.contextPackageId} onChange={(e) => p.setContextPackageId(e.target.value)} disabled={saving} />
        </>
      );

    case "continue_session":
    case "review_output":
      return (
        <>
          <label htmlFor="rec-modify-session-id">Session ID</label>
          <input id="rec-modify-session-id" type="text" value={p.sessionId} onChange={(e) => p.setSessionId(e.target.value)} disabled={saving} />
          {kind === "review_output" && (
            <>
              <label htmlFor="rec-modify-reviewer-role">Reviewer Role (optional)</label>
              <select id="rec-modify-reviewer-role" value={p.reviewerRole} onChange={(e) => p.setReviewerRole(e.target.value as "reviewer" | "qa")} disabled={saving}>
                {REVIEWER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </>
          )}
        </>
      );

    case "refine_goal":
      return (
        <>
          <label htmlFor="rec-modify-missing-fields">
            Missing Fields (one per line: {REFINEMENT_FIELDS.join(", ")})
          </label>
          <textarea
            id="rec-modify-missing-fields"
            value={p.missingFieldsText}
            onChange={(e) => p.setMissingFieldsText(e.target.value)}
            rows={3}
            disabled={saving}
          />
        </>
      );

    case "split_task":
      return (
        <>
          <label htmlFor="rec-modify-split-task-id">Task ID</label>
          <input id="rec-modify-split-task-id" type="text" value={p.splitTaskId} onChange={(e) => p.setSplitTaskId(e.target.value)} disabled={saving} />
          <label htmlFor="rec-modify-children">Suggested Child Titles (one per line)</label>
          <textarea id="rec-modify-children" value={p.suggestedChildrenText} onChange={(e) => p.setSuggestedChildrenText(e.target.value)} rows={3} disabled={saving} />
        </>
      );

    case "run_validation":
      return (
        <>
          <label htmlFor="rec-modify-val-role">Suggested Role</label>
          <select id="rec-modify-val-role" value={p.validationRole} onChange={(e) => p.setValidationRole(e.target.value as "reviewer" | "qa")} disabled={saving}>
            {REVIEWER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <label htmlFor="rec-modify-val-obj">Objective</label>
          <textarea id="rec-modify-val-obj" value={p.validationObjective} onChange={(e) => p.setValidationObjective(e.target.value)} rows={2} disabled={saving} />
          <label htmlFor="rec-modify-val-task">Task ID (optional)</label>
          <input id="rec-modify-val-task" type="text" value={p.validationTaskId} onChange={(e) => p.setValidationTaskId(e.target.value)} disabled={saving} />
          <label htmlFor="rec-modify-val-session">Session ID (optional)</label>
          <input id="rec-modify-val-session" type="text" value={p.validationSessionId} onChange={(e) => p.setValidationSessionId(e.target.value)} disabled={saving} />
        </>
      );

    case "resolve_conflict":
      return (
        <>
          <label htmlFor="rec-modify-conflict-id">Conflict ID</label>
          <input id="rec-modify-conflict-id" type="text" value={p.conflictId} onChange={(e) => p.setConflictId(e.target.value)} disabled={saving} />
          <label htmlFor="rec-modify-res-note">Resolution Note (optional)</label>
          <textarea id="rec-modify-res-note" value={p.resolutionNote} onChange={(e) => p.setResolutionNote(e.target.value)} rows={2} disabled={saving} />
        </>
      );

    case "update_plan":
      return (
        <>
          <label htmlFor="rec-modify-update-task-id">Task ID</label>
          <input id="rec-modify-update-task-id" type="text" value={p.updateTaskId} onChange={(e) => p.setUpdateTaskId(e.target.value)} disabled={saving} />
          <label htmlFor="rec-modify-suggested-status">Suggested Status (optional)</label>
          <select id="rec-modify-suggested-status" value={p.suggestedStatus} onChange={(e) => p.setSuggestedStatus(e.target.value)} disabled={saving}>
            <option value="">— none —</option>
            {TASK_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
          </select>
          <label htmlFor="rec-modify-add-criteria">Add Acceptance Criteria (one per line, optional)</label>
          <textarea id="rec-modify-add-criteria" value={p.addCriteriaText} onChange={(e) => p.setAddCriteriaText(e.target.value)} rows={3} disabled={saving} />
        </>
      );

    case "ask_user":
      return (
        <>
          <label htmlFor="rec-modify-question">Question</label>
          <textarea id="rec-modify-question" value={p.askQuestion} onChange={(e) => p.setAskQuestion(e.target.value)} rows={2} disabled={saving} />
        </>
      );

    case "mark_complete":
      return (
        <>
          <label htmlFor="rec-modify-mark-task-id">Task ID</label>
          <input id="rec-modify-mark-task-id" type="text" value={p.markCompleteTaskId} onChange={(e) => p.setMarkCompleteTaskId(e.target.value)} disabled={saving} />
        </>
      );

    case "pause_work":
      return (
        <>
          <label htmlFor="rec-modify-pause-reason">Reason</label>
          <textarea id="rec-modify-pause-reason" value={p.pauseReason} onChange={(e) => p.setPauseReason(e.target.value)} rows={2} disabled={saving} />
          <label htmlFor="rec-modify-related-tasks">Related Task IDs (one per line)</label>
          <textarea id="rec-modify-related-tasks" value={p.relatedTaskIdsText} onChange={(e) => p.setRelatedTaskIdsText(e.target.value)} rows={2} disabled={saving} />
        </>
      );
  }
}
