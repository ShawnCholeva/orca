import { describe, expect, it } from "vitest";
import {
  reducer,
  initialState,
  type FlowState,
  type FlowAction,
} from "./state";

const draft = {
  skillId: "guided-goal-refinement" as const,
  title: "Ship guided goal flow",
  description: "The refined description",
  successCriteria: ["Detail view renders"],
  constraints: ["Deterministic only"],
  assumptions: ["Local daemon running"],
};

const preview = {
  path: "/home/user/project",
  name: "project",
  workspaceType: "repo" as const,
  branch: "main",
  isDirty: false,
  gitProbe: "ok" as const,
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

  it("refineRequested transitions rough → refining preserving title/description", () => {
    const rough: FlowState = { phase: "rough", title: "My Goal", description: "some desc" };
    const s = dispatch(rough, { type: "refineRequested" });
    expect(s).toEqual({ phase: "refining", title: "My Goal", description: "some desc" });
  });

  it("setTitle is no-op in non-rough phase", () => {
    const refining: FlowState = { phase: "refining", title: "T", description: "" };
    expect(dispatch(refining, { type: "setTitle", title: "X" })).toBe(refining);
  });
});

describe("reducer — refining phase", () => {
  const refining: FlowState = { phase: "refining", title: "Ship guided goal flow", description: "desc" };

  it("refineSucceeded → review with draft", () => {
    const s = dispatch(refining, { type: "refineSucceeded", draft });
    expect(s).toEqual({ phase: "review", title: "Ship guided goal flow", description: "desc", draft });
  });

  it("refineFailed → rough preserving typed input with error", () => {
    const s = dispatch(refining, { type: "refineFailed", error: "network error" });
    expect(s).toMatchObject({
      phase: "rough",
      title: "Ship guided goal flow",
      description: "desc",
      error: "network error",
    });
  });

  it("refineRequested in refining is no-op", () => {
    expect(dispatch(refining, { type: "refineRequested" })).toBe(refining);
  });
});

describe("reducer — review phase", () => {
  const review: FlowState = { phase: "review", title: "T", description: "D", draft };

  it("editArrayItem updates successCriteria item", () => {
    const s = dispatch(review, {
      type: "editArrayItem",
      field: "successCriteria",
      index: 0,
      value: "Updated criterion",
    });
    if (s.phase !== "review") throw new Error("expected review");
    expect(s.draft.successCriteria[0]).toBe("Updated criterion");
    expect(s.draft.constraints).toEqual(draft.constraints);
  });

  it("editArrayItem updates constraints item", () => {
    const s = dispatch(review, {
      type: "editArrayItem",
      field: "constraints",
      index: 0,
      value: "New constraint",
    });
    if (s.phase !== "review") throw new Error("expected review");
    expect(s.draft.constraints[0]).toBe("New constraint");
  });

  it("editArrayItem updates assumptions item", () => {
    const s = dispatch(review, {
      type: "editArrayItem",
      field: "assumptions",
      index: 0,
      value: "New assumption",
    });
    if (s.phase !== "review") throw new Error("expected review");
    expect(s.draft.assumptions[0]).toBe("New assumption");
  });

  it("addArrayItem appends empty string to field", () => {
    const s = dispatch(review, { type: "addArrayItem", field: "successCriteria" });
    if (s.phase !== "review") throw new Error("expected review");
    expect(s.draft.successCriteria).toHaveLength(2);
    expect(s.draft.successCriteria[1]).toBe("");
  });

  it("removeArrayItem removes item by index", () => {
    const s = dispatch(review, { type: "removeArrayItem", field: "constraints", index: 0 });
    if (s.phase !== "review") throw new Error("expected review");
    expect(s.draft.constraints).toHaveLength(0);
  });

  it("backToRough preserves title/description, no draft", () => {
    const s = dispatch(review, { type: "backToRough" });
    expect(s).toMatchObject({ phase: "rough", title: "T", description: "D" });
    expect("draft" in s).toBe(false);
  });

  it("proceedToWorkspaces → workspaces with empty pending list", () => {
    const s = dispatch(review, { type: "proceedToWorkspaces" });
    expect(s).toMatchObject({ phase: "workspaces", pendingWorkspaces: [] });
  });

  it("editArrayItem is no-op outside review phase", () => {
    const rough = initialState;
    expect(dispatch(rough, { type: "editArrayItem", field: "constraints", index: 0, value: "x" })).toBe(rough);
  });

  it("original draft arrays are not mutated by editArrayItem", () => {
    const before = [...draft.successCriteria];
    dispatch(review, { type: "editArrayItem", field: "successCriteria", index: 0, value: "changed" });
    expect(draft.successCriteria).toEqual(before);
  });
});

describe("reducer — workspaces phase", () => {
  const workspaces: FlowState = {
    phase: "workspaces",
    title: "T",
    description: "D",
    draft,
    pendingWorkspaces: [],
  };

  it("inspectRequested sets inspecting=true and clears error", () => {
    const s = dispatch(
      { ...workspaces, error: "old error" },
      { type: "inspectRequested" },
    );
    expect(s).toMatchObject({ phase: "workspaces", inspecting: true, error: undefined });
  });

  it("inspectSucceeded adds workspace to pendingWorkspaces and clears inspecting", () => {
    const s = dispatch(
      { ...workspaces, inspecting: true },
      { type: "inspectSucceeded", preview, inputPath: "/home/user/project", name: "project" },
    );
    if (s.phase !== "workspaces") throw new Error("expected workspaces");
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
      { ...workspaces, inspecting: true },
      { type: "inspectFailed", error: "not_a_directory" },
    );
    expect(s).toMatchObject({ phase: "workspaces", inspecting: false, error: "not_a_directory" });
  });

  it("removePending removes workspace at index", () => {
    const pending = [
      { inputPath: "/a", name: "a", path: "/a", workspaceType: "folder" as const, branch: null, isDirty: null, gitProbe: "not_a_repo" as const },
      { inputPath: "/b", name: "b", path: "/b", workspaceType: "folder" as const, branch: null, isDirty: null, gitProbe: "not_a_repo" as const },
    ];
    const s = dispatch(
      { ...workspaces, pendingWorkspaces: pending },
      { type: "removePending", index: 0 },
    );
    if (s.phase !== "workspaces") throw new Error("expected workspaces");
    expect(s.pendingWorkspaces).toHaveLength(1);
    expect(s.pendingWorkspaces[0]!.name).toBe("b");
  });

  it("editPendingName updates the name of a pending workspace", () => {
    const pending = [
      { inputPath: "/a", name: "a", path: "/a", workspaceType: "folder" as const, branch: null, isDirty: null, gitProbe: "not_a_repo" as const },
    ];
    const s = dispatch(
      { ...workspaces, pendingWorkspaces: pending },
      { type: "editPendingName", index: 0, name: "renamed" },
    );
    if (s.phase !== "workspaces") throw new Error("expected workspaces");
    expect(s.pendingWorkspaces[0]!.name).toBe("renamed");
  });

  it("backToReview returns to review preserving draft", () => {
    const s = dispatch(workspaces, { type: "backToReview" });
    expect(s).toMatchObject({ phase: "review", draft, title: "T", description: "D" });
  });

  it("submitRequested transitions to submitting", () => {
    const s = dispatch(workspaces, { type: "submitRequested" });
    expect(s).toMatchObject({ phase: "submitting", pendingWorkspaces: [] });
  });

  it("inspectRequested is no-op outside workspaces phase", () => {
    expect(dispatch(initialState, { type: "inspectRequested" })).toBe(initialState);
  });
});

describe("reducer — submitting phase", () => {
  const submitting: FlowState = {
    phase: "submitting",
    title: "T",
    description: "D",
    draft,
    pendingWorkspaces: [],
  };

  it("submitSucceeded → done with goalId", () => {
    const s = dispatch(submitting, { type: "submitSucceeded", goalId: "g-123" });
    expect(s).toEqual({ phase: "done", goalId: "g-123" });
  });

  it("submitFailed → workspaces with error, preserving pendingWorkspaces", () => {
    const s = dispatch(submitting, { type: "submitFailed", error: "server error" });
    expect(s).toMatchObject({
      phase: "workspaces",
      error: "server error",
      pendingWorkspaces: [],
      draft,
    });
  });
});

describe("reducer — cross-phase no-ops", () => {
  it("refineSucceeded in non-refining phase is no-op", () => {
    expect(dispatch(initialState, { type: "refineSucceeded", draft })).toBe(initialState);
  });

  it("submitSucceeded in non-submitting phase is no-op", () => {
    expect(dispatch(initialState, { type: "submitSucceeded", goalId: "x" })).toBe(initialState);
  });

  it("backToReview in non-workspaces phase is no-op", () => {
    const review: FlowState = { phase: "review", title: "T", description: "D", draft };
    expect(dispatch(review, { type: "backToReview" })).toBe(review);
  });
});
