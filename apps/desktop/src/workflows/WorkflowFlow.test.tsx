import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowGraph } from "@orca/contracts";
import { WorkflowFlow } from "./WorkflowFlow";

function makeGraph(overrides: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    nodes: [
      { id: "n1", type: "step", name: "Research" },
      { id: "n2", type: "gate", name: "Quality Gate" },
      { id: "n3", type: "step", name: "Build" },
    ],
    edges: [["n1", "n2"]],
    positions: {
      n1: { x: 40, y: 40 },
      n2: { x: 40, y: 160 },
      n3: { x: 40, y: 280 },
    },
    ...overrides,
  };
}

describe("WorkflowFlow", () => {
  it("renders node names from the graph", () => {
    render(
      <WorkflowFlow
        graph={makeGraph()}
        onGraphChange={vi.fn()}
        onOpenNode={vi.fn()}
        onAddNode={vi.fn()}
        onRemoveNode={vi.fn()}
        onResetLayout={vi.fn()}
      />,
    );

    expect(screen.getByText("Research")).toBeDefined();
    expect(screen.getByText("Quality Gate")).toBeDefined();
    expect(screen.getByText("Build")).toBeDefined();
  });

  it("calls onAddNode('step') when Add step is clicked", () => {
    const onAddNode = vi.fn();
    render(
      <WorkflowFlow
        graph={makeGraph()}
        onGraphChange={vi.fn()}
        onOpenNode={vi.fn()}
        onAddNode={onAddNode}
        onRemoveNode={vi.fn()}
        onResetLayout={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /add step/i }));
    expect(onAddNode).toHaveBeenCalledWith("step");
  });

  it("calls onAddNode('gate') when Add gate is clicked", () => {
    const onAddNode = vi.fn();
    render(
      <WorkflowFlow
        graph={makeGraph()}
        onGraphChange={vi.fn()}
        onOpenNode={vi.fn()}
        onAddNode={onAddNode}
        onRemoveNode={vi.fn()}
        onResetLayout={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /add gate/i }));
    expect(onAddNode).toHaveBeenCalledWith("gate");
  });

  it("calls onResetLayout when Reset layout is clicked", () => {
    const onResetLayout = vi.fn();
    render(
      <WorkflowFlow
        graph={makeGraph()}
        onGraphChange={vi.fn()}
        onOpenNode={vi.fn()}
        onAddNode={vi.fn()}
        onRemoveNode={vi.fn()}
        onResetLayout={onResetLayout}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reset layout/i }));
    expect(onResetLayout).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenNode when a node is clicked without dragging (mousedown + mouseup on same spot)", () => {
    const onOpenNode = vi.fn();
    const { container } = render(
      <WorkflowFlow
        graph={makeGraph()}
        onGraphChange={vi.fn()}
        onOpenNode={onOpenNode}
        onAddNode={vi.fn()}
        onRemoveNode={vi.fn()}
        onResetLayout={vi.fn()}
      />,
    );

    // Simulate a non-drag click: mousedown on the node div, then mouseup immediately
    const nodeEl = container.querySelector("[data-node-id='n1']") as HTMLElement;
    expect(nodeEl).toBeTruthy();

    fireEvent.mouseDown(nodeEl, { button: 0, clientX: 100, clientY: 60 });
    // No mousemove means drag.moved stays false → onOpenNode fires on mouseup
    fireEvent.mouseUp(window);

    expect(onOpenNode).toHaveBeenCalledWith("n1");
  });

  it("calls onRemoveNode when the delete button is clicked", () => {
    const onRemoveNode = vi.fn();
    const { container } = render(
      <WorkflowFlow
        graph={makeGraph()}
        onGraphChange={vi.fn()}
        onOpenNode={vi.fn()}
        onAddNode={vi.fn()}
        onRemoveNode={onRemoveNode}
        onResetLayout={vi.fn()}
      />,
    );

    // Each node has a "Remove node" button
    const removeBtns = container.querySelectorAll("[title='Remove node']");
    expect(removeBtns.length).toBe(3);

    fireEvent.click(removeBtns[0]);
    expect(onRemoveNode).toHaveBeenCalledWith("n1");
  });
});
