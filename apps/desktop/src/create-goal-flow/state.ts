import type {
  GuidedRefinementOutput,
  InspectWorkspacePreview,
  OrchestratorModelChoice,
} from "@orca/contracts";

export type RefinementField = "successCriteria" | "constraints" | "assumptions";

export type PendingWorkspace = {
  inputPath: string;
  name: string;
  path: string;
  workspaceType: InspectWorkspacePreview["workspaceType"];
  branch: string | null;
  isDirty: boolean | null;
  gitProbe: InspectWorkspacePreview["gitProbe"];
};

type RoughState = {
  phase: "rough";
  title: string;
  description: string;
  orchestratorModel: OrchestratorModelChoice | null;
  error?: string;
};

type RefiningState = {
  phase: "refining";
  title: string;
  description: string;
  orchestratorModel: OrchestratorModelChoice | null;
};

type ReviewState = {
  phase: "review";
  title: string;
  description: string;
  orchestratorModel: OrchestratorModelChoice | null;
  draft: GuidedRefinementOutput;
};

type WorkspacesState = {
  phase: "workspaces";
  title: string;
  description: string;
  orchestratorModel: OrchestratorModelChoice | null;
  draft: GuidedRefinementOutput;
  pendingWorkspaces: PendingWorkspace[];
  inspecting?: boolean;
  error?: string;
};

type SubmittingState = {
  phase: "submitting";
  title: string;
  description: string;
  orchestratorModel: OrchestratorModelChoice | null;
  draft: GuidedRefinementOutput;
  pendingWorkspaces: PendingWorkspace[];
};

type DoneState = {
  phase: "done";
  goalId: string;
};

export type FlowState =
  | RoughState
  | RefiningState
  | ReviewState
  | WorkspacesState
  | SubmittingState
  | DoneState;

export const initialState: FlowState = {
  phase: "rough",
  title: "",
  description: "",
  orchestratorModel: null,
};

export type FlowAction =
  | { type: "setTitle"; title: string }
  | { type: "setDescription"; description: string }
  | { type: "setOrchestratorModel"; orchestratorModel: OrchestratorModelChoice | null }
  | { type: "refineRequested" }
  | { type: "refineSucceeded"; draft: GuidedRefinementOutput }
  | { type: "refineFailed"; error: string }
  | { type: "editArrayItem"; field: RefinementField; index: number; value: string }
  | { type: "addArrayItem"; field: RefinementField }
  | { type: "removeArrayItem"; field: RefinementField; index: number }
  | { type: "backToRough" }
  | { type: "proceedToWorkspaces" }
  | { type: "inspectRequested" }
  | { type: "inspectSucceeded"; preview: InspectWorkspacePreview; inputPath: string; name: string }
  | { type: "inspectFailed"; error: string }
  | { type: "removePending"; index: number }
  | { type: "editPendingName"; index: number; name: string }
  | { type: "backToReview" }
  | { type: "submitRequested" }
  | { type: "submitSucceeded"; goalId: string }
  | { type: "submitFailed"; error: string };

function updateDraftArray(
  draft: GuidedRefinementOutput,
  field: RefinementField,
  fn: (arr: string[]) => string[],
): GuidedRefinementOutput {
  return { ...draft, [field]: fn([...draft[field]]) };
}

export function reducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "setTitle":
      if (state.phase === "rough") {
        return { ...state, title: action.title, error: undefined };
      }
      return state;

    case "setDescription":
      if (state.phase === "rough") {
        return { ...state, description: action.description };
      }
      return state;

    case "setOrchestratorModel":
      if (state.phase === "rough") {
        return { ...state, orchestratorModel: action.orchestratorModel };
      }
      return state;

    case "refineRequested":
      if (state.phase === "rough") {
        return {
          phase: "refining",
          title: state.title,
          description: state.description,
          orchestratorModel: state.orchestratorModel,
        };
      }
      return state;

    case "refineSucceeded":
      if (state.phase === "refining") {
        return {
          phase: "review",
          title: state.title,
          description: state.description,
          orchestratorModel: state.orchestratorModel,
          draft: action.draft,
        };
      }
      return state;

    case "refineFailed":
      if (state.phase === "refining") {
        return {
          phase: "rough",
          title: state.title,
          description: state.description,
          orchestratorModel: state.orchestratorModel,
          error: action.error,
        };
      }
      return state;

    case "editArrayItem":
      if (state.phase === "review") {
        const draft = updateDraftArray(state.draft, action.field, (arr) => {
          const next = [...arr];
          next[action.index] = action.value;
          return next;
        });
        return { ...state, draft };
      }
      return state;

    case "addArrayItem":
      if (state.phase === "review") {
        const draft = updateDraftArray(state.draft, action.field, (arr) => [...arr, ""]);
        return { ...state, draft };
      }
      return state;

    case "removeArrayItem":
      if (state.phase === "review") {
        const draft = updateDraftArray(state.draft, action.field, (arr) =>
          arr.filter((_, i) => i !== action.index),
        );
        return { ...state, draft };
      }
      return state;

    case "backToRough":
      if (state.phase === "review") {
        return {
          phase: "rough",
          title: state.title,
          description: state.description,
          orchestratorModel: state.orchestratorModel,
        };
      }
      return state;

    case "proceedToWorkspaces":
      if (state.phase === "review") {
        return {
          phase: "workspaces",
          title: state.title,
          description: state.description,
          orchestratorModel: state.orchestratorModel,
          draft: state.draft,
          pendingWorkspaces: [],
        };
      }
      return state;

    case "inspectRequested":
      if (state.phase === "workspaces") {
        return { ...state, inspecting: true, error: undefined };
      }
      return state;

    case "inspectSucceeded":
      if (state.phase === "workspaces") {
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
      if (state.phase === "workspaces") {
        return { ...state, inspecting: false, error: action.error };
      }
      return state;

    case "removePending":
      if (state.phase === "workspaces") {
        return {
          ...state,
          pendingWorkspaces: state.pendingWorkspaces.filter((_, i) => i !== action.index),
        };
      }
      return state;

    case "editPendingName":
      if (state.phase === "workspaces") {
        const pendingWorkspaces = state.pendingWorkspaces.map((ws, i) =>
          i === action.index ? { ...ws, name: action.name } : ws,
        );
        return { ...state, pendingWorkspaces };
      }
      return state;

    case "backToReview":
      if (state.phase === "workspaces") {
        return {
          phase: "review",
          title: state.title,
          description: state.description,
          orchestratorModel: state.orchestratorModel,
          draft: state.draft,
        };
      }
      return state;

    case "submitRequested":
      if (state.phase === "workspaces") {
        return {
          phase: "submitting",
          title: state.title,
          description: state.description,
          orchestratorModel: state.orchestratorModel,
          draft: state.draft,
          pendingWorkspaces: state.pendingWorkspaces,
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
          phase: "workspaces",
          title: state.title,
          description: state.description,
          orchestratorModel: state.orchestratorModel,
          draft: state.draft,
          pendingWorkspaces: state.pendingWorkspaces,
          error: action.error,
        };
      }
      return state;
  }
}
