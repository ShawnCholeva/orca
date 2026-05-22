import { useState } from "react";
import {
  ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS,
  ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS,
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

type FieldState = {
  adapterId: string;
  sessionWorkspaceId: string;
  sessionRole: string;
  sessionObjective: string;
  contextPackageId: string;
  sessionId: string;
  reviewerRole: "reviewer" | "qa";
  missingFieldsText: string;
  splitTaskId: string;
  suggestedChildrenText: string;
  validationRole: "reviewer" | "qa";
  validationTaskId: string;
  validationSessionId: string;
  validationObjective: string;
  conflictId: string;
  resolutionNote: string;
  updateTaskId: string;
  suggestedStatus: string;
  addCriteriaText: string;
  askQuestion: string;
  markCompleteTaskId: string;
  pauseReason: string;
  relatedTaskIdsText: string;
};

const EMPTY_FIELDS: FieldState = {
  adapterId: "",
  sessionWorkspaceId: "",
  sessionRole: "engineer",
  sessionObjective: "",
  contextPackageId: "",
  sessionId: "",
  reviewerRole: "reviewer",
  missingFieldsText: "",
  splitTaskId: "",
  suggestedChildrenText: "",
  validationRole: "reviewer",
  validationTaskId: "",
  validationSessionId: "",
  validationObjective: "",
  conflictId: "",
  resolutionNote: "",
  updateTaskId: "",
  suggestedStatus: "",
  addCriteriaText: "",
  askQuestion: "",
  markCompleteTaskId: "",
  pauseReason: "",
  relatedTaskIdsText: "",
};

function initFieldState(action: ProposedAction): FieldState {
  switch (action.kind) {
    case "create_session":
      return {
        ...EMPTY_FIELDS,
        adapterId: action.adapterId,
        sessionWorkspaceId: action.workspaceId ?? "",
        sessionRole: action.role,
        sessionObjective: action.objective,
        contextPackageId: action.contextPackageId ?? "",
      };
    case "continue_session":
      return { ...EMPTY_FIELDS, sessionId: action.sessionId };
    case "review_output":
      return { ...EMPTY_FIELDS, sessionId: action.sessionId, reviewerRole: action.reviewerRole ?? "reviewer" };
    case "refine_goal":
      return { ...EMPTY_FIELDS, missingFieldsText: action.missingFields.join("\n") };
    case "split_task":
      return {
        ...EMPTY_FIELDS,
        splitTaskId: action.taskId,
        suggestedChildrenText: action.suggestedChildren.map((c) => c.title).join("\n"),
      };
    case "run_validation":
      return {
        ...EMPTY_FIELDS,
        validationRole: action.suggestedRole,
        validationObjective: action.objective,
        validationTaskId: action.taskId ?? "",
        validationSessionId: action.sessionId ?? "",
      };
    case "resolve_conflict":
      return {
        ...EMPTY_FIELDS,
        conflictId: action.conflictId,
        resolutionNote: action.suggestedResolutionNote ?? "",
      };
    case "update_plan":
      return {
        ...EMPTY_FIELDS,
        updateTaskId: action.taskId,
        suggestedStatus: action.suggestedStatus ?? "",
        addCriteriaText: (action.addAcceptanceCriteria ?? []).join("\n"),
      };
    case "ask_user":
      return { ...EMPTY_FIELDS, askQuestion: action.question };
    case "mark_complete":
      return { ...EMPTY_FIELDS, markCompleteTaskId: action.taskId };
    case "pause_work":
      return {
        ...EMPTY_FIELDS,
        pauseReason: action.reason,
        relatedTaskIdsText: action.relatedTaskIds.join("\n"),
      };
  }
}

type Props = {
  recommendation: Recommendation;
  onSave: (patch: ModifyRecommendationRequest) => Promise<void>;
  onClose: () => void;
};

export function RecommendationModifyDialog({ recommendation, onSave, onClose }: Props) {
  const [title, setTitle] = useState(recommendation.title);
  const [rationale, setRationale] = useState(recommendation.rationale);
  const [kind, setKind] = useState<ProposedActionKind>(recommendation.proposedAction.kind);
  const [fields, setFields] = useState<FieldState>(() => initFieldState(recommendation.proposedAction));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setField<K extends keyof FieldState>(key: K, value: FieldState[K]) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  function buildProposedAction(): { ok: true; action: typeof ProposedAction._type } | { ok: false; error: string } {
    let raw: unknown;
    switch (kind) {
      case "create_session":
        raw = {
          kind,
          adapterId: fields.adapterId.trim(),
          workspaceId: fields.sessionWorkspaceId.trim() || undefined,
          role: fields.sessionRole,
          objective: fields.sessionObjective.trim(),
          contextPackageId: fields.contextPackageId.trim() || undefined,
        };
        break;
      case "continue_session":
        raw = { kind, sessionId: fields.sessionId.trim() };
        break;
      case "review_output":
        raw = { kind, sessionId: fields.sessionId.trim(), reviewerRole: fields.reviewerRole || undefined };
        break;
      case "refine_goal": {
        const missingFields = fields.missingFieldsText
          .split(/[\n,]/)
          .map((f) => f.trim())
          .filter(Boolean);
        raw = { kind, missingFields };
        break;
      }
      case "split_task": {
        const children = fields.suggestedChildrenText
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => ({ title: t }));
        raw = { kind, taskId: fields.splitTaskId.trim(), suggestedChildren: children };
        break;
      }
      case "run_validation":
        raw = {
          kind,
          suggestedRole: fields.validationRole,
          objective: fields.validationObjective.trim(),
          taskId: fields.validationTaskId.trim() || undefined,
          sessionId: fields.validationSessionId.trim() || undefined,
        };
        break;
      case "resolve_conflict":
        raw = {
          kind,
          conflictId: fields.conflictId.trim(),
          suggestedResolutionNote: fields.resolutionNote.trim() || undefined,
        };
        break;
      case "update_plan": {
        const criteria = fields.addCriteriaText
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean);
        raw = {
          kind,
          taskId: fields.updateTaskId.trim(),
          suggestedStatus: fields.suggestedStatus || undefined,
          addAcceptanceCriteria: criteria.length > 0 ? criteria : undefined,
        };
        break;
      }
      case "ask_user":
        raw = { kind, question: fields.askQuestion.trim() };
        break;
      case "mark_complete":
        raw = { kind, taskId: fields.markCompleteTaskId.trim() };
        break;
      case "pause_work": {
        const ids = fields.relatedTaskIdsText
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean);
        raw = { kind, reason: fields.pauseReason.trim(), relatedTaskIds: ids };
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
    if (trimmedTitle.length > ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS) {
      setError(`Title must be ${ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS} characters or fewer.`);
      return;
    }
    if (rationale.length > ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS) {
      setError(`Rationale must be ${ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS} characters or fewer.`);
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
    } finally {
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

          <PerKindFields kind={kind} saving={saving} fields={fields} setField={setField} />

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

type SetField = <K extends keyof FieldState>(key: K, value: FieldState[K]) => void;

type PerKindFieldsProps = {
  kind: ProposedActionKind;
  saving: boolean;
  fields: FieldState;
  setField: SetField;
};

function PerKindFields({ kind, saving, fields, setField }: PerKindFieldsProps) {
  switch (kind) {
    case "create_session":
      return (
        <>
          <label htmlFor="rec-modify-adapter-id">Adapter ID</label>
          <input id="rec-modify-adapter-id" type="text" value={fields.adapterId} onChange={(e) => setField("adapterId", e.target.value)} disabled={saving} />
          <label htmlFor="rec-modify-session-ws">Workspace ID (optional)</label>
          <input id="rec-modify-session-ws" type="text" value={fields.sessionWorkspaceId} onChange={(e) => setField("sessionWorkspaceId", e.target.value)} disabled={saving} />
          <label htmlFor="rec-modify-session-role">Role</label>
          <select id="rec-modify-session-role" value={fields.sessionRole} onChange={(e) => setField("sessionRole", e.target.value)} disabled={saving}>
            {TASK_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <label htmlFor="rec-modify-session-obj">Objective</label>
          <textarea id="rec-modify-session-obj" value={fields.sessionObjective} onChange={(e) => setField("sessionObjective", e.target.value)} rows={2} disabled={saving} />
          <label htmlFor="rec-modify-ctx-pkg">Context Package ID (optional)</label>
          <input id="rec-modify-ctx-pkg" type="text" value={fields.contextPackageId} onChange={(e) => setField("contextPackageId", e.target.value)} disabled={saving} />
        </>
      );

    case "continue_session":
    case "review_output":
      return (
        <>
          <label htmlFor="rec-modify-session-id">Session ID</label>
          <input id="rec-modify-session-id" type="text" value={fields.sessionId} onChange={(e) => setField("sessionId", e.target.value)} disabled={saving} />
          {kind === "review_output" && (
            <>
              <label htmlFor="rec-modify-reviewer-role">Reviewer Role (optional)</label>
              <select id="rec-modify-reviewer-role" value={fields.reviewerRole} onChange={(e) => setField("reviewerRole", e.target.value as "reviewer" | "qa")} disabled={saving}>
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
            value={fields.missingFieldsText}
            onChange={(e) => setField("missingFieldsText", e.target.value)}
            rows={3}
            disabled={saving}
          />
        </>
      );

    case "split_task":
      return (
        <>
          <label htmlFor="rec-modify-split-task-id">Task ID</label>
          <input id="rec-modify-split-task-id" type="text" value={fields.splitTaskId} onChange={(e) => setField("splitTaskId", e.target.value)} disabled={saving} />
          <label htmlFor="rec-modify-children">Suggested Child Titles (one per line)</label>
          <textarea id="rec-modify-children" value={fields.suggestedChildrenText} onChange={(e) => setField("suggestedChildrenText", e.target.value)} rows={3} disabled={saving} />
        </>
      );

    case "run_validation":
      return (
        <>
          <label htmlFor="rec-modify-val-role">Suggested Role</label>
          <select id="rec-modify-val-role" value={fields.validationRole} onChange={(e) => setField("validationRole", e.target.value as "reviewer" | "qa")} disabled={saving}>
            {REVIEWER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <label htmlFor="rec-modify-val-obj">Objective</label>
          <textarea id="rec-modify-val-obj" value={fields.validationObjective} onChange={(e) => setField("validationObjective", e.target.value)} rows={2} disabled={saving} />
          <label htmlFor="rec-modify-val-task">Task ID (optional)</label>
          <input id="rec-modify-val-task" type="text" value={fields.validationTaskId} onChange={(e) => setField("validationTaskId", e.target.value)} disabled={saving} />
          <label htmlFor="rec-modify-val-session">Session ID (optional)</label>
          <input id="rec-modify-val-session" type="text" value={fields.validationSessionId} onChange={(e) => setField("validationSessionId", e.target.value)} disabled={saving} />
        </>
      );

    case "resolve_conflict":
      return (
        <>
          <label htmlFor="rec-modify-conflict-id">Conflict ID</label>
          <input id="rec-modify-conflict-id" type="text" value={fields.conflictId} onChange={(e) => setField("conflictId", e.target.value)} disabled={saving} />
          <label htmlFor="rec-modify-res-note">Resolution Note (optional)</label>
          <textarea id="rec-modify-res-note" value={fields.resolutionNote} onChange={(e) => setField("resolutionNote", e.target.value)} rows={2} disabled={saving} />
        </>
      );

    case "update_plan":
      return (
        <>
          <label htmlFor="rec-modify-update-task-id">Task ID</label>
          <input id="rec-modify-update-task-id" type="text" value={fields.updateTaskId} onChange={(e) => setField("updateTaskId", e.target.value)} disabled={saving} />
          <label htmlFor="rec-modify-suggested-status">Suggested Status (optional)</label>
          <select id="rec-modify-suggested-status" value={fields.suggestedStatus} onChange={(e) => setField("suggestedStatus", e.target.value)} disabled={saving}>
            <option value="">— none —</option>
            {TASK_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
          </select>
          <label htmlFor="rec-modify-add-criteria">Add Acceptance Criteria (one per line, optional)</label>
          <textarea id="rec-modify-add-criteria" value={fields.addCriteriaText} onChange={(e) => setField("addCriteriaText", e.target.value)} rows={3} disabled={saving} />
        </>
      );

    case "ask_user":
      return (
        <>
          <label htmlFor="rec-modify-question">Question</label>
          <textarea id="rec-modify-question" value={fields.askQuestion} onChange={(e) => setField("askQuestion", e.target.value)} rows={2} disabled={saving} />
        </>
      );

    case "mark_complete":
      return (
        <>
          <label htmlFor="rec-modify-mark-task-id">Task ID</label>
          <input id="rec-modify-mark-task-id" type="text" value={fields.markCompleteTaskId} onChange={(e) => setField("markCompleteTaskId", e.target.value)} disabled={saving} />
        </>
      );

    case "pause_work":
      return (
        <>
          <label htmlFor="rec-modify-pause-reason">Reason</label>
          <textarea id="rec-modify-pause-reason" value={fields.pauseReason} onChange={(e) => setField("pauseReason", e.target.value)} rows={2} disabled={saving} />
          <label htmlFor="rec-modify-related-tasks">Related Task IDs (one per line)</label>
          <textarea id="rec-modify-related-tasks" value={fields.relatedTaskIdsText} onChange={(e) => setField("relatedTaskIdsText", e.target.value)} rows={2} disabled={saving} />
        </>
      );
  }
}
