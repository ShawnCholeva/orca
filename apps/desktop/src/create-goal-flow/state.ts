import type {
  InspectWorkspacePreview,
  OrchestratorModelChoice,
} from "@orca/contracts";

export type PendingWorkspace = {
  inputPath: string;
  name: string;
  path: string;
  workspaceType: InspectWorkspacePreview["workspaceType"];
  branch: string | null;
  isDirty: boolean | null;
  gitProbe: InspectWorkspacePreview["gitProbe"];
};

export type PendingDocument = {
  kind: "file" | "url";
  ref: string;
  name: string;
};

type RoughState = {
  phase: "rough";
  title: string;
  intent: string;
  successCriteria: string[];
  error?: string;
};

type CoordinateState = {
  phase: "coordinate";
  title: string;
  intent: string;
  successCriteria: string[];
  pendingWorkspaces: PendingWorkspace[];
  pendingDocuments: PendingDocument[];
  orchestratorModel: OrchestratorModelChoice | null;
  workflowTemplateId: string | null;
  inspecting?: boolean;
  error?: string;
};

type SubmittingState = {
  phase: "submitting";
  title: string;
  intent: string;
  successCriteria: string[];
  pendingWorkspaces: PendingWorkspace[];
  pendingDocuments: PendingDocument[];
  orchestratorModel: OrchestratorModelChoice | null;
  workflowTemplateId: string | null;
  /** Set when goal was already created; skip createGoal on retry. */
  goalId?: string;
  /** Set when workflow run was already created; skip startWorkflowRun on retry. */
  workflowRunId?: string;
};

export type WorkflowFailedState = {
  phase: "workflowFailed";
  goalId: string;
  /** Set if startWorkflowRun succeeded before the failure. Skip it on retry. */
  workflowRunId?: string;
  title: string;
  intent: string;
  successCriteria: string[];
  pendingWorkspaces: PendingWorkspace[];
  pendingDocuments: PendingDocument[];
  orchestratorModel: OrchestratorModelChoice | null;
  workflowTemplateId: string;
  error: string;
};

type DoneState = {
  phase: "done";
  goalId: string;
};

export type FlowState =
  | RoughState
  | CoordinateState
  | SubmittingState
  | WorkflowFailedState
  | DoneState;

export const initialState: FlowState = {
  phase: "rough",
  title: "",
  intent: "",
  successCriteria: [""],
};

export type FlowAction =
  | { type: "setTitle"; title: string }
  | { type: "setIntent"; intent: string }
  | { type: "addSuccessCriterion" }
  | { type: "editSuccessCriterion"; index: number; value: string }
  | { type: "removeSuccessCriterion"; index: number }
  | { type: "proceedToCoordinate" }
  | { type: "backToDescribe" }
  | { type: "setOrchestratorModel"; orchestratorModel: OrchestratorModelChoice | null }
  | { type: "setWorkflowTemplateId"; workflowTemplateId: string | null }
  | { type: "inspectRequested" }
  | { type: "inspectSucceeded"; preview: InspectWorkspacePreview; inputPath: string; name: string }
  | { type: "inspectFailed"; error: string }
  | { type: "removePending"; index: number }
  | { type: "editPendingName"; index: number; name: string }
  | { type: "addDocument"; document: PendingDocument }
  | { type: "removeDocument"; index: number }
  | { type: "submitRequested" }
  | { type: "submitSucceeded"; goalId: string }
  | { type: "submitFailed"; error: string }
  | { type: "workflowBootstrapFailed"; goalId: string; workflowRunId?: string; error: string }
  | { type: "retryWorkflowStart" };

export function reducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "setTitle":
      if (state.phase === "rough") {
        return { ...state, title: action.title, error: undefined };
      }
      return state;

    case "setIntent":
      if (state.phase === "rough") {
        return { ...state, intent: action.intent };
      }
      return state;

    case "addSuccessCriterion":
      if (state.phase === "rough") {
        return { ...state, successCriteria: [...state.successCriteria, ""] };
      }
      return state;

    case "editSuccessCriterion":
      if (state.phase === "rough") {
        return {
          ...state,
          successCriteria: state.successCriteria.map((c, i) => (i === action.index ? action.value : c)),
        };
      }
      return state;

    case "removeSuccessCriterion":
      if (state.phase === "rough") {
        // keep at least one row so the UI always shows an input
        const next = state.successCriteria.filter((_, i) => i !== action.index);
        return { ...state, successCriteria: next.length > 0 ? next : [""] };
      }
      return state;

    case "proceedToCoordinate":
      if (state.phase === "rough") {
        return {
          phase: "coordinate",
          title: state.title,
          intent: state.intent,
          successCriteria: state.successCriteria,
          pendingWorkspaces: [],
          pendingDocuments: [],
          orchestratorModel: null,
          workflowTemplateId: null,
        };
      }
      return state;

    case "backToDescribe":
      if (state.phase === "coordinate") {
        return {
          phase: "rough",
          title: state.title,
          intent: state.intent,
          successCriteria: state.successCriteria,
        };
      }
      return state;

    case "setOrchestratorModel":
      if (state.phase === "coordinate") {
        return { ...state, orchestratorModel: action.orchestratorModel };
      }
      return state;

    case "setWorkflowTemplateId":
      if (state.phase === "coordinate") {
        return { ...state, workflowTemplateId: action.workflowTemplateId };
      }
      return state;

    case "inspectRequested":
      if (state.phase === "coordinate") {
        return { ...state, inspecting: true, error: undefined };
      }
      return state;

    case "inspectSucceeded":
      if (state.phase === "coordinate") {
        const pending: PendingWorkspace = {
          inputPath: action.inputPath,
          name: action.name,
          path: action.preview.path,
          workspaceType: action.preview.workspaceType,
          branch: action.preview.branch,
          isDirty: action.preview.isDirty,
          gitProbe: action.preview.gitProbe,
        };
        return {
          ...state,
          inspecting: false,
          pendingWorkspaces: [...state.pendingWorkspaces, pending],
        };
      }
      return state;

    case "inspectFailed":
      if (state.phase === "coordinate") {
        return { ...state, inspecting: false, error: action.error };
      }
      return state;

    case "removePending":
      if (state.phase === "coordinate") {
        return {
          ...state,
          pendingWorkspaces: state.pendingWorkspaces.filter((_, i) => i !== action.index),
        };
      }
      return state;

    case "editPendingName":
      if (state.phase === "coordinate") {
        const pendingWorkspaces = state.pendingWorkspaces.map((ws, i) =>
          i === action.index ? { ...ws, name: action.name } : ws,
        );
        return { ...state, pendingWorkspaces };
      }
      return state;

    case "addDocument":
      if (state.phase === "coordinate") {
        return {
          ...state,
          error: undefined,
          pendingDocuments: [...state.pendingDocuments, action.document],
        };
      }
      return state;

    case "removeDocument":
      if (state.phase === "coordinate") {
        return {
          ...state,
          pendingDocuments: state.pendingDocuments.filter((_, i) => i !== action.index),
        };
      }
      return state;

    case "submitRequested":
      if (state.phase === "coordinate") {
        return {
          phase: "submitting",
          title: state.title,
          intent: state.intent,
          successCriteria: state.successCriteria,
          pendingWorkspaces: state.pendingWorkspaces,
          pendingDocuments: state.pendingDocuments,
          orchestratorModel: state.orchestratorModel,
          workflowTemplateId: state.workflowTemplateId,
        };
      }
      return state;

    case "submitSucceeded":
      if (state.phase === "submitting") {
        return { phase: "done", goalId: action.goalId };
      }
      return state;

    case "submitFailed":
      if (state.phase === "submitting") {
        return {
          phase: "coordinate",
          title: state.title,
          intent: state.intent,
          successCriteria: state.successCriteria,
          pendingWorkspaces: state.pendingWorkspaces,
          pendingDocuments: state.pendingDocuments,
          orchestratorModel: state.orchestratorModel,
          workflowTemplateId: state.workflowTemplateId,
          error: action.error,
        };
      }
      return state;

    case "workflowBootstrapFailed":
      if (state.phase === "submitting") {
        return {
          phase: "workflowFailed",
          goalId: action.goalId,
          workflowRunId: action.workflowRunId,
          title: state.title,
          intent: state.intent,
          successCriteria: state.successCriteria,
          pendingWorkspaces: state.pendingWorkspaces,
          pendingDocuments: state.pendingDocuments,
          orchestratorModel: state.orchestratorModel,
          workflowTemplateId: state.workflowTemplateId ?? "",
          error: action.error,
        };
      }
      return state;

    case "retryWorkflowStart":
      if (state.phase === "workflowFailed") {
        return {
          phase: "submitting",
          title: state.title,
          intent: state.intent,
          successCriteria: state.successCriteria,
          pendingWorkspaces: state.pendingWorkspaces,
          pendingDocuments: state.pendingDocuments,
          orchestratorModel: state.orchestratorModel,
          workflowTemplateId: state.workflowTemplateId,
          goalId: state.goalId,
          workflowRunId: state.workflowRunId,
        };
      }
      return state;
  }
}
