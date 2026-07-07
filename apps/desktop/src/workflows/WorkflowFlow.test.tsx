import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowGraph } from "@orca/contracts";
import { WorkflowFlow, edgePath, sourcePortFrac } from "./WorkflowFlow";

function makeGraph(overrides: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    nodes: [
      { id: "n1", type: "step", name: "Research" },
      { id: "n2", type: "gate", name: "Quality Gate" },
      { id: "n3", type: "step", name: "Build" },
    ],
    edges: [{ from: "n1", to: "n2" }],
    positions: {
      n1: { x: 40, y: 40 },
      n2: { x: 40, y: 160 },
      n3: { x: 40, y: 280 },
    },
    ...overrides,
  };
}

describe("edgePath", () => {
  // NODE_W=240, NODE_H=64
  // ax = a.x + 120, ay = a.y + 64, bx = b.x + 120, by = b.y

  it("forward edge: same-column target below source uses legacy cubic with no bow", () => {
    const a = { x: 40, y: 40 };  // ay = 104
    const b = { x: 40, y: 160 }; // by = 160
    const d = edgePath(a, b);
    // ax=160, ay=104, bx=160, by=160 — dy=max(28,(160-104)/2)=28
    expect(d).toBe("M 160 104 C 160 132, 160 132, 160 160");
    // control xs equal endpoint xs (no bow)
    expect(d).toContain("C 160 ");
  });

  it("forward edge: dy grows with vertical distance", () => {
    const a = { x: 40, y: 0 };   // ay = 64
    const b = { x: 40, y: 400 }; // by = 400 — dy=(400-64)/2=168
    const d = edgePath(a, b);
    expect(d).toBe("M 160 64 C 160 232, 160 232, 160 400");
  });

  it("backward edge: same-column target above source bows to the right", () => {
    const a = { x: 40, y: 200 }; // ay = 264
    const b = { x: 40, y: 40 };  // by = 40  — backward (40 < 264)
    const d = edgePath(a, b);
    // ax=160, bx=160 — bow = 90 + min(170,(264-40)/4) = 90 + 56 = 146
    // control points: (160+146)=306
    // starts at M 160 264, control x=306 (> ax=160) means it bows right
    expect(d).toContain("M 160 264");
    expect(d.endsWith("160 40")).toBe(true);
    // control x must be greater than ax (rightward bow)
    const match = d.match(/C (\d+(?:\.\d+)?) /);
    expect(match).not.toBeNull();
    const cx1 = Number(match![1]);
    expect(cx1).toBeGreaterThan(160); // bowed to the right
  });

  it("backward edge: longer loop gets a larger bow than a short loop", () => {
    const a = { x: 40, y: 0 };
    const shortTarget = { x: 40, y: -100 };   // ay=64, by=-100, diff=164
    const longTarget  = { x: 40, y: -800 };   // ay=64, by=-800, diff=864

    const shortD = edgePath(a, shortTarget);
    const longD  = edgePath(a, longTarget);

    const cx = (d: string) => Number(d.match(/C (\d+(?:\.\d+)?) /)![1]);
    expect(cx(longD)).toBeGreaterThan(cx(shortD));
  });

  it("starts at the source-port x when a source fraction is given", () => {
    const a = { x: 40, y: 40 };  // ay = 104
    const b = { x: 40, y: 160 };
    // splitter branch 1 of 2 → frac 1/3 → ax = 40 + 240/3 = 120
    const d = edgePath(a, b, 1 / 3);
    expect(d.startsWith("M 120 104 ")).toBe(true);
  });
});

describe("sourcePortFrac", () => {
  it("returns the branch-port fraction for a splitter edge", () => {
    const splitter = {
      id: "route", type: "splitter" as const, name: "Route",
      branches: ["go_a", "go_b"],
    };
    // ports render at (bi+1)/(count+1): 1/3 and 2/3
    expect(sourcePortFrac(splitter, "go_a")).toBeCloseTo(1 / 3);
    expect(sourcePortFrac(splitter, "go_b")).toBeCloseTo(2 / 3);
  });

  it("returns the gate-port fractions for approved/rejected", () => {
    const gate = { id: "g", type: "gate" as const, name: "Gate" };
    expect(sourcePortFrac(gate, "approved")).toBeCloseTo(0.33);
    expect(sourcePortFrac(gate, "rejected")).toBeCloseTo(0.67);
  });

  it("falls back to center for portless edges or unknown ports", () => {
    const step = { id: "s", type: "step" as const, name: "Step" };
    const splitter = {
      id: "route", type: "splitter" as const, name: "Route",
      branches: ["go_a", "go_b"],
    };
    expect(sourcePortFrac(step, undefined)).toBe(0.5);
    expect(sourcePortFrac(splitter, undefined)).toBe(0.5);
    expect(sourcePortFrac(splitter, "not_a_branch")).toBe(0.5);
  });
});

describe("splitter edge rendering", () => {
  it("renders splitter branch edges anchored at their branch ports, not the node center", () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "route", type: "splitter" as const, name: "Route", branches: ["go_a", "go_b"] },
        { id: "a", type: "step" as const, name: "A" },
        { id: "b", type: "step" as const, name: "B" },
      ],
      edges: [
        { from: "route", to: "a", port: "go_a" },
        { from: "route", to: "b", port: "go_b" },
      ],
      positions: {
        route: { x: 40, y: 40 },
        a: { x: 0, y: 200 },
        b: { x: 300, y: 200 },
      },
    };
    const { container } = render(
      <WorkflowFlow
        graph={graph}
        onGraphChange={vi.fn()}
        onOpenNode={vi.fn()}
        onAddNode={vi.fn()}
        onRemoveNode={vi.fn()}
        onResetLayout={vi.fn()}
      />,
    );
    // Splitter at x=40: go_a port at 40 + 240*(1/3) = 120, go_b at 40 + 240*(2/3) = 200.
    // Both edges starting at "M 160" (center) is the bug.
    const paths = Array.from(container.querySelectorAll("svg path"))
      .map((p) => p.getAttribute("d") ?? "")
      .filter((d) => d.startsWith("M "));
    expect(paths.some((d) => d.startsWith("M 120 104"))).toBe(true);
    expect(paths.some((d) => d.startsWith("M 200 104"))).toBe(true);
    expect(paths.some((d) => d.startsWith("M 160 "))).toBe(false);
  });
});

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
    // mouseup at the same position → not a drag → onOpenNode fires
    fireEvent.mouseUp(window, { clientX: 100, clientY: 60 });

    expect(onOpenNode).toHaveBeenCalledWith("n1");
  });

  it("does NOT call onOpenNode when mousedown then mousemove past 4px threshold then mouseup", () => {
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

    const nodeEl = container.querySelector("[data-node-id='n1']") as HTMLElement;
    expect(nodeEl).toBeTruthy();

    // mousedown to start drag
    fireEvent.mouseDown(nodeEl, { button: 0, clientX: 100, clientY: 60 });
    // mousemove past the 4px threshold
    fireEvent.mouseMove(window, { clientX: 110, clientY: 65 });
    // mouseup — moved, so onOpenNode should NOT fire
    fireEvent.mouseUp(window, { clientX: 110, clientY: 65 });

    expect(onOpenNode).not.toHaveBeenCalled();
  });

  it("calls onOpenNode when mousedown then mouseup with no move", () => {
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

    const nodeEl = container.querySelector("[data-node-id='n1']") as HTMLElement;
    expect(nodeEl).toBeTruthy();

    fireEvent.mouseDown(nodeEl, { button: 0, clientX: 100, clientY: 60 });
    fireEvent.mouseUp(window, { clientX: 100, clientY: 60 });

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

  it("zoom controls change the scale label", () => {
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

    const reset = screen.getByRole("button", { name: /reset zoom/i });
    expect(reset.textContent).toBe("100%");

    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    expect(reset.textContent).toBe("110%");

    fireEvent.click(screen.getByRole("button", { name: /reset zoom/i }));
    expect(reset.textContent).toBe("100%");

    fireEvent.click(screen.getByRole("button", { name: /zoom out/i }));
    expect(reset.textContent).toBe("91%");
  });

  it("exposes zoom controls even in readOnly mode", () => {
    render(
      <WorkflowFlow
        graph={makeGraph()}
        onGraphChange={vi.fn()}
        onOpenNode={vi.fn()}
        onAddNode={vi.fn()}
        onRemoveNode={vi.fn()}
        onResetLayout={vi.fn()}
        readOnly
      />,
    );
    expect(screen.getByRole("button", { name: /zoom in/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /zoom out/i })).toBeDefined();
    // editing affordances stay hidden
    expect(screen.queryByRole("button", { name: /add step/i })).toBeNull();
  });

  it("adds a splitter via the toolbar", () => {
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
    fireEvent.click(screen.getByRole("button", { name: /add splitter/i }));
    expect(onAddNode).toHaveBeenCalledWith("splitter");
  });

  it("renders one output port per splitter branch", () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "s0", type: "step" as const, name: "Triage" },
        { id: "route", type: "splitter" as const, name: "Route", branches: ["go_a", "go_b"] },
      ],
      edges: [{ from: "s0", to: "route" }],
      positions: { s0: { x: 110, y: 20 }, route: { x: 110, y: 112 } },
    };
    render(
      <WorkflowFlow
        graph={graph}
        onGraphChange={vi.fn()}
        onOpenNode={vi.fn()}
        onAddNode={vi.fn()}
        onRemoveNode={vi.fn()}
        onResetLayout={vi.fn()}
      />,
    );
    expect(screen.getByTitle(/connect go_a branch/i)).toBeInTheDocument();
    expect(screen.getByTitle(/connect go_b branch/i)).toBeInTheDocument();
  });
});
