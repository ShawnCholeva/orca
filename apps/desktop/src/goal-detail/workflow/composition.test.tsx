import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowGraph } from "@orca/contracts";
import { WorkflowFlow } from "../../workflows/WorkflowFlow";
import { WorkflowRunPanel } from "./WorkflowRunPanel";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

// ---- WorkflowFlow delegate node tests ----

describe("WorkflowFlow delegate node", () => {
  it("renders delegate node with child template label and R/W counts", () => {
    const graph: WorkflowGraph = {
      nodes: [
        {
          id: "del-1",
          type: "delegate",
          name: "Deploy",
          childTemplateId: "orca/ci",
          childTemplateVersion: 2,
          reads: { a: "b" },
          writes: { c: "d" },
        },
      ],
      edges: [],
      positions: { "del-1": { x: 40, y: 40 } },
    };
    render(
      <WorkflowFlow
        graph={graph}
        onGraphChange={vi.fn()}
        onOpenNode={vi.fn()}
        onAddNode={vi.fn()}
        onRemoveNode={vi.fn()}
        onResetLayout={vi.fn()}
        readOnly
      />,
    );
    expect(screen.getByText(/orca\/ci/)).toBeInTheDocument();
    expect(screen.getByText(/v2/)).toBeInTheDocument();
    // R:1 and W:1 badges
    expect(screen.getByText("R:1")).toBeInTheDocument();
    expect(screen.getByText("W:1")).toBeInTheDocument();
  });

  it("renders status chip for delegate node when nodeStatuses provided", () => {
    const graph: WorkflowGraph = {
      nodes: [
        {
          id: "del-1",
          type: "delegate",
          name: "Deploy",
          childTemplateId: "orca/ci",
          childTemplateVersion: 2,
          reads: {},
          writes: {},
        },
      ],
      edges: [],
      positions: { "del-1": { x: 40, y: 40 } },
    };
    render(
      <WorkflowFlow
        graph={graph}
        onGraphChange={vi.fn()}
        onOpenNode={vi.fn()}
        onAddNode={vi.fn()}
        onRemoveNode={vi.fn()}
        onResetLayout={vi.fn()}
        readOnly
        nodeStatuses={{ "del-1": "active" }}
      />,
    );
    expect(screen.getByText("Delegating…")).toBeInTheDocument();
  });

  it("renders completed status chip", () => {
    const graph: WorkflowGraph = {
      nodes: [
        {
          id: "del-1",
          type: "delegate",
          name: "Deploy",
          childTemplateId: "orca/ci",
          childTemplateVersion: 1,
          reads: {},
          writes: {},
        },
      ],
      edges: [],
      positions: { "del-1": { x: 40, y: 40 } },
    };
    render(
      <WorkflowFlow
        graph={graph}
        onGraphChange={vi.fn()}
        onOpenNode={vi.fn()}
        onAddNode={vi.fn()}
        onRemoveNode={vi.fn()}
        onResetLayout={vi.fn()}
        readOnly
        nodeStatuses={{ "del-1": "completed" }}
      />,
    );
    expect(screen.getByText("Joined")).toBeInTheDocument();
  });
});

// ---- WorkflowRunPanel composition/breadcrumb tests ----

const now = "2026-01-01T00:00:00.000Z";

const apiMocks = vi.hoisted(() => ({
  listWorkflowRuns: vi.fn(),
  getWorkflowRun: vi.fn(),
  listWorkflowDecisions: vi.fn(),
  listOrchestrationAttempts: vi.fn(),
  listWorkflowRunArtifacts: vi.fn(),
  getWorkflowStepRun: vi.fn(),
  getOrchestrationWorker: vi.fn(),
  getWorkflowRunLedger: vi.fn(),
  submitHumanReviewDecision: vi.fn(),
  listTasks: vi.fn(),
  listSessions: vi.fn(),
  listContextPackages: vi.fn(),
  listWorkflowRunCompositions: vi.fn(),
  toErrorMessage: vi.fn((err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback,
  ),
}));

vi.mock("../../api", () => apiMocks);

function setupBaseApiMocks() {
  apiMocks.listWorkflowDecisions.mockResolvedValue({ decisions: [] });
  apiMocks.listWorkflowRunArtifacts.mockResolvedValue({ artifacts: [] });
  apiMocks.listTasks.mockResolvedValue({ tasks: [], generations: [] });
  apiMocks.listSessions.mockResolvedValue({ sessions: [] });
  apiMocks.listContextPackages.mockResolvedValue({ packages: [], assemblies: [] });
  apiMocks.listOrchestrationAttempts.mockResolvedValue({ attempts: [] });
  apiMocks.getWorkflowRunLedger.mockResolvedValue(null);
}

describe("WorkflowRunPanel delegation breadcrumb", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows delegation breadcrumb when parent run is delegating with an active child", async () => {
    const parentRun = {
      id: "parent-run",
      goalId: "goal-1",
      templateId: "orca/parent",
      templateVersion: 1,
      status: "delegating",
      currentStepRunId: null,
      startedAt: now,
      finishedAt: null,
      blockedReason: null,
      parentCompositionId: null,
    };
    const childRun = {
      id: "child-run",
      goalId: "goal-1",
      templateId: "orca/child",
      templateVersion: 1,
      status: "active",
      currentStepRunId: null,
      startedAt: now,
      finishedAt: null,
      blockedReason: null,
      parentCompositionId: "comp-1",
    };

    apiMocks.listWorkflowRuns.mockResolvedValue({ runs: [parentRun, childRun] });
    apiMocks.getWorkflowRun.mockResolvedValue({ run: parentRun });
    apiMocks.listWorkflowRunCompositions.mockResolvedValue({
      compositions: [
        {
          id: "comp-1",
          goalId: "goal-1",
          parentRunId: "parent-run",
          childRunId: "child-run",
          delegateNodeId: "del-1",
          spawnSeq: 0,
          reads: {},
          writes: {},
          depth: 1,
          status: "active",
          costRollupUsd: null,
          createdAt: now,
          finishedAt: null,
        },
      ],
    });
    setupBaseApiMocks();

    render(<WorkflowRunPanel goalId="goal-1" initialRunId="parent-run" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Delegation")).toBeInTheDocument();
    });

    expect(screen.getAllByText("orca/parent").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("orca/child").length).toBeGreaterThanOrEqual(1);
  });

  it("shows delegation breadcrumb when child run is selected (parentCompositionId set)", async () => {
    const parentRun = {
      id: "parent-run",
      goalId: "goal-1",
      templateId: "orca/parent",
      templateVersion: 1,
      status: "delegating",
      currentStepRunId: null,
      startedAt: now,
      finishedAt: null,
      blockedReason: null,
      parentCompositionId: null,
    };
    const childRun = {
      id: "child-run",
      goalId: "goal-1",
      templateId: "orca/child",
      templateVersion: 1,
      status: "active",
      currentStepRunId: null,
      startedAt: now,
      finishedAt: null,
      blockedReason: null,
      parentCompositionId: "comp-1",
    };

    apiMocks.listWorkflowRuns.mockResolvedValue({ runs: [parentRun, childRun] });
    apiMocks.getWorkflowRun.mockResolvedValue({ run: childRun });
    apiMocks.listWorkflowRunCompositions.mockResolvedValue({
      compositions: [
        {
          id: "comp-1",
          goalId: "goal-1",
          parentRunId: "parent-run",
          childRunId: "child-run",
          delegateNodeId: "del-1",
          spawnSeq: 0,
          reads: {},
          writes: {},
          depth: 1,
          status: "active",
          costRollupUsd: null,
          createdAt: now,
          finishedAt: null,
        },
      ],
    });
    setupBaseApiMocks();

    render(<WorkflowRunPanel goalId="goal-1" initialRunId="child-run" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Delegation")).toBeInTheDocument();
    });

    expect(screen.getAllByText("orca/parent").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("orca/child").length).toBeGreaterThanOrEqual(1);
  });

  it("clicking parent breadcrumb crumb triggers navigation to parent run", async () => {
    const parentRun = {
      id: "parent-run",
      goalId: "goal-1",
      templateId: "orca/parent",
      templateVersion: 1,
      status: "delegating",
      currentStepRunId: null,
      startedAt: now,
      finishedAt: null,
      blockedReason: null,
      parentCompositionId: null,
    };
    const childRun = {
      id: "child-run",
      goalId: "goal-1",
      templateId: "orca/child",
      templateVersion: 1,
      status: "active",
      currentStepRunId: null,
      startedAt: now,
      finishedAt: null,
      blockedReason: null,
      parentCompositionId: "comp-1",
    };

    apiMocks.listWorkflowRuns.mockResolvedValue({ runs: [parentRun, childRun] });
    // Initially load the child run (child is selected)
    apiMocks.getWorkflowRun.mockResolvedValue({ run: childRun });
    apiMocks.listWorkflowRunCompositions.mockResolvedValue({
      compositions: [
        {
          id: "comp-1",
          goalId: "goal-1",
          parentRunId: "parent-run",
          childRunId: "child-run",
          delegateNodeId: "del-1",
          spawnSeq: 0,
          reads: {},
          writes: {},
          depth: 1,
          status: "active",
          costRollupUsd: null,
          createdAt: now,
          finishedAt: null,
        },
      ],
    });
    setupBaseApiMocks();

    render(<WorkflowRunPanel goalId="goal-1" initialRunId="child-run" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Delegation")).toBeInTheDocument();
    });

    // After clicking parent crumb, getWorkflowRun should be called again
    // with parent-run. Set up parent mock for next load.
    apiMocks.getWorkflowRun.mockResolvedValue({ run: parentRun });

    const parentCrumb = screen.getAllByText("orca/parent")[0];
    fireEvent.click(parentCrumb);

    await waitFor(() => {
      // getWorkflowRun should have been called with parent-run ID
      const calls = apiMocks.getWorkflowRun.mock.calls;
      expect(calls.some((call: string[]) => call[1] === "parent-run")).toBe(true);
    });
  });
});
