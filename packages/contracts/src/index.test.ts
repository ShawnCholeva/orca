import { describe, expect, it } from "vitest";

import {
  AttachWorkspaceRequest,
  AttachWorkspaceResponse,
  CreateGoalRequest,
  GitProbe,
  Goal,
  GoalDetailResponse,
  GoalRefinement,
  GuidedRefinementInput,
  GuidedRefinementOutput,
  InspectWorkspacePreview,
  InspectWorkspaceRequest,
  InspectWorkspaceResponse,
  M3ErrorCode,
  RefineGoalRequest,
  RefineGoalResponse,
  SkillExtensionPoint,
  Workspace,
  WorkspaceType,
  DomainEventType
} from "./index.js";

const now = "2026-01-01T00:00:00.000Z";

const goalFixture = Goal.parse({
  id: "goal-1",
  title: "Launch M3",
  description: "Ship refinement and workspace support",
  status: "active",
  autonomyLevel: 1,
  createdAt: now,
  updatedAt: now,
  archivedAt: null
});

const workspaceFixture = Workspace.parse({
  id: "ws-1",
  goalId: "goal-1",
  path: "/home/user/repo",
  name: "repo",
  workspaceType: "repo",
  branch: "main",
  isDirty: false,
  gitProbe: "ok",
  attachedAt: now
});

const guidedOutputFixture = GuidedRefinementOutput.parse({
  skillId: "guided-goal-refinement",
  title: "Launch M3",
  description: "Implement deterministic refinement",
  successCriteria: ["Goal detail shows refinement"],
  constraints: ["No AI calls"],
  assumptions: ["Local filesystem available"]
});

function expectRoundTrip<T>(
  parse: (input: unknown) => T,
  input: unknown,
  expected: T
): void {
  const parsed = parse(input);
  expect(parsed).toEqual(expected);
  expect(JSON.parse(JSON.stringify(parsed)) as T).toEqual(expected);
}

describe("M3 contracts", () => {
  it("extends domain event type and skill extension point literals", () => {
    expect(DomainEventType.parse("goal.refined")).toBe("goal.refined");
    expect(DomainEventType.parse("workspace.attached")).toBe("workspace.attached");
    expect(DomainEventType.parse("workspace.removed")).toBe("workspace.removed");
    expect(SkillExtensionPoint.parse("goal.refine")).toBe("goal.refine");

    expect(() => DomainEventType.parse("workspace.patched")).toThrow();
    expect(() => SkillExtensionPoint.parse("goal.rethink")).toThrow();
  });

  it("parses WorkspaceType and GitProbe literals", () => {
    expect(WorkspaceType.parse("repo")).toBe("repo");
    expect(WorkspaceType.parse("folder")).toBe("folder");
    expect(GitProbe.parse("ok")).toBe("ok");
    expect(GitProbe.parse("not_a_repo")).toBe("not_a_repo");

    expect(() => WorkspaceType.parse("archive")).toThrow();
    expect(() => GitProbe.parse("timeout")).toThrow();
  });

  it("parses Workspace and rejects invalid workspace shape", () => {
    expectRoundTrip(Workspace.parse, workspaceFixture, workspaceFixture);
    expect(() => Workspace.parse({ ...workspaceFixture, workspaceType: "archive" })).toThrow();
  });

  it("parses GoalRefinement and rejects non-array fields", () => {
    const refinement = {
      goalId: "goal-1",
      skillId: "guided-goal-refinement",
      successCriteria: ["a"],
      constraints: ["b"],
      assumptions: ["c"],
      refinedAt: now
    };

    expectRoundTrip(GoalRefinement.parse, refinement, refinement);
    expect(() => GoalRefinement.parse({ ...refinement, constraints: "not-array" })).toThrow();
  });

  it("parses GuidedRefinementInput with default and rejects blank title", () => {
    expectRoundTrip(GuidedRefinementInput.parse, { title: "Goal" }, { title: "Goal", description: "" });
    expect(() => GuidedRefinementInput.parse({ title: "" })).toThrow();
  });

  it("parses GuidedRefinementOutput and rejects wrong skill id", () => {
    expectRoundTrip(GuidedRefinementOutput.parse, guidedOutputFixture, guidedOutputFixture);
    expect(() => GuidedRefinementOutput.parse({ ...guidedOutputFixture, skillId: "quick-goal" })).toThrow();
  });

  it("keeps M1/M2 create request body valid and supports additive M3 fields", () => {
    expectRoundTrip(CreateGoalRequest.parse, { title: "Legacy create", description: "" }, { title: "Legacy create", description: "" });

    const request = {
      title: "M3 create",
      description: "",
      refined: guidedOutputFixture,
      workspaces: [{ inputPath: "/tmp/ws", name: "workspace" }]
    };
    expectRoundTrip(CreateGoalRequest.parse, request, request);
    expect(() => CreateGoalRequest.parse({ ...request, workspaces: [{ inputPath: "", name: "x" }] })).toThrow();
  });

  it("parses RefineGoalRequest strictly and rejects unknown keys", () => {
    expectRoundTrip(RefineGoalRequest.parse, { title: "Refine me" }, { title: "Refine me", description: "" });
    expect(() => RefineGoalRequest.parse({ title: "Refine me", description: "", skillId: "x" })).toThrow();
  });

  it("parses RefineGoalResponse and rejects invalid draft", () => {
    expectRoundTrip(RefineGoalResponse.parse, { draft: guidedOutputFixture }, { draft: guidedOutputFixture });
    expect(() => RefineGoalResponse.parse({ draft: { ...guidedOutputFixture, constraints: [""] } })).toThrow();
  });

  it("parses InspectWorkspaceRequest strictly and rejects unknown keys", () => {
    expectRoundTrip(InspectWorkspaceRequest.parse, { inputPath: "/tmp/ws" }, { inputPath: "/tmp/ws" });
    expect(() => InspectWorkspaceRequest.parse({ inputPath: "/tmp/ws", extra: true })).toThrow();
  });

  it("parses InspectWorkspacePreview and response", () => {
    const preview = {
      path: workspaceFixture.path,
      name: workspaceFixture.name,
      workspaceType: workspaceFixture.workspaceType,
      branch: workspaceFixture.branch,
      isDirty: workspaceFixture.isDirty,
      gitProbe: workspaceFixture.gitProbe
    };

    expectRoundTrip(InspectWorkspacePreview.parse, preview, preview);
    expectRoundTrip(InspectWorkspaceResponse.parse, { preview }, { preview });

    expect(() => InspectWorkspacePreview.parse({ ...preview, gitProbe: "bad" })).toThrow();
    expect(() => InspectWorkspaceResponse.parse({ preview: { path: "/tmp" } })).toThrow();
  });

  it("parses AttachWorkspaceRequest strictly and AttachWorkspaceResponse", () => {
    expectRoundTrip(AttachWorkspaceRequest.parse, { inputPath: "/tmp/ws" }, { inputPath: "/tmp/ws" });
    expect(() => AttachWorkspaceRequest.parse({ inputPath: "/tmp/ws", unknown: "x" })).toThrow();

    const response = { workspace: workspaceFixture };
    expectRoundTrip(AttachWorkspaceResponse.parse, response, response);
    expect(() => AttachWorkspaceResponse.parse({ workspace: { ...workspaceFixture, id: 1 } })).toThrow();
  });

  it("parses GoalDetailResponse and rejects invalid nested structures", () => {
    const detail = {
      goal: goalFixture,
      refinement: {
        goalId: "goal-1",
        skillId: "guided-goal-refinement",
        successCriteria: ["a"],
        constraints: ["b"],
        assumptions: ["c"],
        refinedAt: now
      },
      workspaces: [workspaceFixture]
    };

    expectRoundTrip(GoalDetailResponse.parse, detail, detail);
    expect(() => GoalDetailResponse.parse({ ...detail, workspaces: [{ ...workspaceFixture, path: 1 }] })).toThrow();
  });

  it("parses M3ErrorCode and rejects unknown literals", () => {
    expect(M3ErrorCode.parse("workspace_duplicate")).toBe("workspace_duplicate");
    expect(() => M3ErrorCode.parse("permission_denied")).toThrow();
  });

  it("keeps existing Goal schema compatible", () => {
    expectRoundTrip(Goal.parse, goalFixture, goalFixture);
  });
});
