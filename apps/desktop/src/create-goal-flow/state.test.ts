import { describe, expect, it } from "vitest";
import {
  reducer,
  initialState,
  type FlowState,
  type FlowAction,
} from "./state";

const preview = {
  path: "/home/user/project",
  name: "project",
  workspaceType: "repo" as const,
  branch: "main",
  isDirty: false,
  gitProbe: "ok" as const,
};

const orchestratorModel = {
  providerId: "orca/openai" as const,
  modelId: "gpt-5",
};

function dispatch(state: FlowState, action: FlowAction): FlowState {
  return reducer(state, action);
}

describe("reducer — rough phase", () => {
  it("setTitle updates title and clears error", () => {
    const s = dispatch(
      { phase: "rough", title: "", description: "", error: "oops" },
      { type: "setTitle", title: "New Title" },
    );
    expect(s).toMatchObject({ phase: "rough", title: "New Title", error: undefined });
  });

  it("setDescription updates description", () => {
    const s = dispatch(initialState, { type: "setDescription", description: "desc" });
    expect(s).toMatchObject({ phase: "rough", description: "desc" });
  });

  it("proceedToCoordinate transitions rough → coordinate with empty workspaces", () => {
    const rough: FlowState = { phase: "rough", title: "My Goal", description: "some desc" };
    const s = dispatch(rough, { type: "proceedToCoordinate" });
    expect(s).toEqual({
      phase: "coordinate",
      title: "My Goal",
      description: "some desc",
      pendingWorkspaces: [],
    pendingDocuments: [],
      orchestratorModel: null,
      workflowTemplateId: null,
    });
  });

  it("setTitle is no-op in non-rough phase", () => {
    const coord: FlowState = {
      phase: "coordinate",
      title: "T",
      description: "",
      pendingWorkspaces: [],
    pendingDocuments: [],
      orchestratorModel: null,
      workflowTemplateId: null,
    };
    expect(dispatch(coord, { type: "setTitle", title: "X" })).toBe(coord);
  });
});

describe("reducer — coordinate phase", () => {
  const coordinate: FlowState = {
    phase: "coordinate",
    title: "T",
    description: "D",
    pendingWorkspaces: [],
    pendingDocuments: [],
    orchestratorModel: null,
    workflowTemplateId: null,
  };

  it("backToDescribe returns to rough preserving title/description", () => {
    const s = dispatch(coordinate, { type: "backToDescribe" });
    expect(s).toMatchObject({ phase: "rough", title: "T", description: "D" });
    expect("pendingWorkspaces" in s).toBe(false);
  });

  it("setOrchestratorModel stores the selected provider/model", () => {
    const s = dispatch(coordinate, { type: "setOrchestratorModel", orchestratorModel });
    expect(s).toMatchObject({ phase: "coordinate", orchestratorModel });
  });

  it("setWorkflowTemplateId stores the selected workflow", () => {
    const s = dispatch(coordinate, { type: "setWorkflowTemplateId", workflowTemplateId: "wf-1" });
    expect(s).toMatchObject({ phase: "coordinate", workflowTemplateId: "wf-1" });
  });

  it("inspectRequested sets inspecting=true and clears error", () => {
    const s = dispatch(
      { ...coordinate, error: "old error" },
      { type: "inspectRequested" },
    );
    expect(s).toMatchObject({ phase: "coordinate", inspecting: true, error: undefined });
  });

  it("inspectSucceeded adds workspace to pendingWorkspaces and clears inspecting", () => {
    const s = dispatch(
      { ...coordinate, inspecting: true },
      { type: "inspectSucceeded", preview, inputPath: "/home/user/project", name: "project" },
    );
    if (s.phase !== "coordinate") throw new Error("expected coordinate");
    expect(s.inspecting).toBe(false);
    expect(s.pendingWorkspaces).toHaveLength(1);
    expect(s.pendingWorkspaces[0]).toMatchObject({
      inputPath: "/home/user/project",
      name: "project",
      path: "/home/user/project",
      branch: "main",
    });
  });

  it("inspectFailed sets error and clears inspecting", () => {
    const s = dispatch(
      { ...coordinate, inspecting: true },
      { type: "inspectFailed", error: "not_a_directory" },
    );
    expect(s).toMatchObject({ phase: "coordinate", inspecting: false, error: "not_a_directory" });
  });

  it("removePending removes workspace at index", () => {
    const pending = [
      { inputPath: "/a", name: "a", path: "/a", workspaceType: "folder" as const, branch: null, isDirty: null, gitProbe: "not_a_repo" as const },
      { inputPath: "/b", name: "b", path: "/b", workspaceType: "folder" as const, branch: null, isDirty: null, gitProbe: "not_a_repo" as const },
    ];
    const s = dispatch(
      { ...coordinate, pendingWorkspaces: pending },
      { type: "removePending", index: 0 },
    );
    if (s.phase !== "coordinate") throw new Error("expected coordinate");
    expect(s.pendingWorkspaces).toHaveLength(1);
    expect(s.pendingWorkspaces[0]!.name).toBe("b");
  });

  it("editPendingName updates the name of a pending workspace", () => {
    const pending = [
      { inputPath: "/a", name: "a", path: "/a", workspaceType: "folder" as const, branch: null, isDirty: null, gitProbe: "not_a_repo" as const },
    ];
    const s = dispatch(
      { ...coordinate, pendingWorkspaces: pending },
      { type: "editPendingName", index: 0, name: "renamed" },
    );
    if (s.phase !== "coordinate") throw new Error("expected coordinate");
    expect(s.pendingWorkspaces[0]!.name).toBe("renamed");
  });

  it("submitRequested transitions to submitting", () => {
    const s = dispatch(
      { ...coordinate, orchestratorModel, workflowTemplateId: "wf-1" },
      { type: "submitRequested" },
    );
    expect(s).toMatchObject({
      phase: "submitting",
      orchestratorModel,
      workflowTemplateId: "wf-1",
      pendingWorkspaces: [],
      pendingDocuments: [],
    });
  });

  it("addDocument appends a pending document and clears error", () => {
    const doc = { kind: "file" as const, ref: "/docs/plan.md", name: "plan.md" };
    const s = dispatch({ ...coordinate, error: "old" }, { type: "addDocument", document: doc });
    if (s.phase !== "coordinate") throw new Error("expected coordinate");
    expect(s.pendingDocuments).toEqual([doc]);
    expect(s.error).toBeUndefined();
  });

  it("removeDocument removes the document at index", () => {
    const docs = [
      { kind: "file" as const, ref: "/a.md", name: "a.md" },
      { kind: "url" as const, ref: "https://x.test/b", name: "b" },
    ];
    const s = dispatch(
      { ...coordinate, pendingDocuments: docs },
      { type: "removeDocument", index: 0 },
    );
    if (s.phase !== "coordinate") throw new Error("expected coordinate");
    expect(s.pendingDocuments).toEqual([docs[1]]);
  });

  it("addDocument is no-op outside coordinate phase", () => {
    expect(
      dispatch(initialState, { type: "addDocument", document: { kind: "file", ref: "/a", name: "a" } }),
    ).toBe(initialState);
  });

  it("submitRequested carries pendingDocuments into submitting, and submitFailed brings them back", () => {
    const docs = [{ kind: "url" as const, ref: "https://x.test/spec", name: "spec" }];
    const submitting = dispatch(
      { ...coordinate, pendingDocuments: docs, workflowTemplateId: "wf-1" },
      { type: "submitRequested" },
    );
    expect(submitting).toMatchObject({ phase: "submitting", pendingDocuments: docs });
    const back = dispatch(submitting, { type: "submitFailed", error: "boom" });
    expect(back).toMatchObject({ phase: "coordinate", pendingDocuments: docs, error: "boom" });
  });

  it("inspectRequested is no-op outside coordinate phase", () => {
    expect(dispatch(initialState, { type: "inspectRequested" })).toBe(initialState);
  });
});

describe("reducer — submitting phase", () => {
  const submitting: FlowState = {
    phase: "submitting",
    title: "T",
    description: "D",
    orchestratorModel,
    workflowTemplateId: "wf-1",
    pendingWorkspaces: [],
    pendingDocuments: [],
  };

  it("submitSucceeded → done with goalId", () => {
    const s = dispatch(submitting, { type: "submitSucceeded", goalId: "g-123" });
    expect(s).toEqual({ phase: "done", goalId: "g-123" });
  });

  it("submitFailed → coordinate with error, preserving pendingWorkspaces", () => {
    const s = dispatch(submitting, { type: "submitFailed", error: "server error" });
    expect(s).toMatchObject({
      phase: "coordinate",
      orchestratorModel,
      error: "server error",
      pendingWorkspaces: [],
    pendingDocuments: [],
    });
  });
});

describe("reducer — workflowFailed phase", () => {
  const submittingNoRun: FlowState = {
    phase: "submitting",
    title: "T",
    description: "D",
    orchestratorModel,
    workflowTemplateId: "wf-1",
    pendingWorkspaces: [],
    pendingDocuments: [],
  };

  it("workflowBootstrapFailed from submitting → workflowFailed (no runId)", () => {
    const s = dispatch(submittingNoRun, {
      type: "workflowBootstrapFailed",
      goalId: "g-1",
      error: "template not found",
    });
    expect(s).toMatchObject({
      phase: "workflowFailed",
      goalId: "g-1",
      workflowTemplateId: "wf-1",
      error: "template not found",
    });
    if (s.phase === "workflowFailed") {
      expect(s.workflowRunId).toBeUndefined();
    }
  });

  it("workflowBootstrapFailed with workflowRunId stores it", () => {
    const s = dispatch(submittingNoRun, {
      type: "workflowBootstrapFailed",
      goalId: "g-1",
      workflowRunId: "r-1",
      error: "orchestrator error",
    });
    if (s.phase === "workflowFailed") {
      expect(s.workflowRunId).toBe("r-1");
    } else {
      throw new Error("expected workflowFailed");
    }
  });

  it("retryWorkflowStart from workflowFailed → submitting with goalId (no runId)", () => {
    const failed: FlowState = {
      phase: "workflowFailed",
      goalId: "g-1",
      title: "T",
      description: "D",
      pendingWorkspaces: [],
    pendingDocuments: [],
      orchestratorModel,
      workflowTemplateId: "wf-1",
      error: "oops",
    };
    const s = dispatch(failed, { type: "retryWorkflowStart" });
    expect(s).toMatchObject({
      phase: "submitting",
      goalId: "g-1",
      workflowTemplateId: "wf-1",
    });
    if (s.phase === "submitting") {
      expect(s.workflowRunId).toBeUndefined();
    }
  });

  it("retryWorkflowStart from workflowFailed with runId → submitting with both ids", () => {
    const failed: FlowState = {
      phase: "workflowFailed",
      goalId: "g-1",
      workflowRunId: "r-1",
      title: "T",
      description: "D",
      pendingWorkspaces: [],
    pendingDocuments: [],
      orchestratorModel,
      workflowTemplateId: "wf-1",
      error: "oops",
    };
    const s = dispatch(failed, { type: "retryWorkflowStart" });
    if (s.phase === "submitting") {
      expect(s.goalId).toBe("g-1");
      expect(s.workflowRunId).toBe("r-1");
    } else {
      throw new Error("expected submitting");
    }
  });

  it("workflowBootstrapFailed is no-op outside submitting phase", () => {
    expect(
      dispatch(initialState, { type: "workflowBootstrapFailed", goalId: "g-1", error: "x" })
    ).toBe(initialState);
  });

  it("retryWorkflowStart is no-op outside workflowFailed phase", () => {
    expect(dispatch(initialState, { type: "retryWorkflowStart" })).toBe(initialState);
  });

  it("submitRequested from coordinate with workflowTemplateId null still transitions (guard is in UI, not reducer)", () => {
    const coord: FlowState = {
      phase: "coordinate",
      title: "T",
      description: "D",
      pendingWorkspaces: [],
    pendingDocuments: [],
      orchestratorModel: null,
      workflowTemplateId: null,
    };
    const s = dispatch(coord, { type: "submitRequested" });
    expect(s.phase).toBe("submitting");
  });
});

describe("reducer — cross-phase no-ops", () => {
  it("submitSucceeded in non-submitting phase is no-op", () => {
    expect(dispatch(initialState, { type: "submitSucceeded", goalId: "x" })).toBe(initialState);
  });

  it("backToDescribe in non-coordinate phase is no-op", () => {
    expect(dispatch(initialState, { type: "backToDescribe" })).toBe(initialState);
  });

  it("proceedToCoordinate in non-rough phase is no-op", () => {
    const coord: FlowState = {
      phase: "coordinate",
      title: "T",
      description: "D",
      pendingWorkspaces: [],
    pendingDocuments: [],
      orchestratorModel: null,
      workflowTemplateId: null,
    };
    expect(dispatch(coord, { type: "proceedToCoordinate" })).toBe(coord);
  });
});
