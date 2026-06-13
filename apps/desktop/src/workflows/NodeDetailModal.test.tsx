import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { NodeDetailModal, type NodeDetail } from "./NodeDetailModal";

const schema: WorkflowStepOutputSchema = [
  { key: "summary", type: "string", required: true },
];

function makeGateDetail(
  onChange = vi.fn(),
): Extract<NodeDetail, { kind: "gate" }> {
  return {
    kind: "gate",
    name: "Quality Gate",
    instructions: "output.score > 0.8",
    onChange,
  };
}

function makeStepDetail(
  onChange = vi.fn(),
): Extract<NodeDetail, { kind: "step" }> {
  return {
    kind: "step",
    name: "Research",
    instructions: "Investigate the codebase.",
    outputSchema: schema,
    onChange,
  };
}

describe("NodeDetailModal — gate", () => {
  it("renders the instructions textarea with the current value", () => {
    render(
      <NodeDetailModal
        detail={makeGateDetail()}
        index={0}
        total={3}
        onPrev={null}
        onNext={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/approve only when/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe("output.score > 0.8");
  });

  it("calls onChange with instructions patch when textarea changes", () => {
    const onChange = vi.fn();
    render(
      <NodeDetailModal
        detail={makeGateDetail(onChange)}
        index={0}
        total={3}
        onPrev={null}
        onNext={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/approve only when/i);
    fireEvent.change(textarea, { target: { value: "output.pass === true" } });
    expect(onChange).toHaveBeenCalledWith({ instructions: "output.pass === true" });
  });

  it("shows the gate hint text", () => {
    render(
      <NodeDetailModal
        detail={makeGateDetail()}
        index={0}
        total={3}
        onPrev={null}
        onNext={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText(/approved/i)).toBeDefined();
  });
});

describe("NodeDetailModal — step", () => {
  it("renders the instructions textarea", () => {
    render(
      <NodeDetailModal
        detail={makeStepDetail()}
        index={1}
        total={3}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/what this step should accomplish/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Investigate the codebase.");
  });

  it("calls onChange with instructions patch", () => {
    const onChange = vi.fn();
    render(
      <NodeDetailModal
        detail={makeStepDetail(onChange)}
        index={1}
        total={3}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/what this step should accomplish/i);
    fireEvent.change(textarea, { target: { value: "Updated instructions." } });
    expect(onChange).toHaveBeenCalledWith({ instructions: "Updated instructions." });
  });

  it("renders the output schema editor (key input present)", () => {
    render(
      <NodeDetailModal
        detail={makeStepDetail()}
        index={1}
        total={3}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const keyInput = screen.getByDisplayValue("summary");
    expect(keyInput).toBeDefined();
  });

  it("does NOT render any role UI", () => {
    render(
      <NodeDetailModal
        detail={makeStepDetail()}
        index={1}
        total={3}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    // The prototype had "Assigned role" text; it must not appear here
    expect(screen.queryByText(/assigned role/i)).toBeNull();
  });
});

describe("NodeDetailModal — navigation and actions", () => {
  it("Prev button is disabled when onPrev is null", () => {
    render(
      <NodeDetailModal
        detail={makeGateDetail()}
        index={0}
        total={3}
        onPrev={null}
        onNext={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const prevBtn = screen.getByRole("button", { name: /prev/i }) as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
  });

  it("Next button is disabled when onNext is null", () => {
    render(
      <NodeDetailModal
        detail={makeGateDetail()}
        index={2}
        total={3}
        onPrev={vi.fn()}
        onNext={null}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const nextBtn = screen.getByRole("button", { name: /next/i }) as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
  });

  it("calls onDelete when Delete button is clicked", () => {
    const onDelete = vi.fn();
    render(
      <NodeDetailModal
        detail={makeGateDetail()}
        index={0}
        total={3}
        onPrev={null}
        onNext={vi.fn()}
        onClose={vi.fn()}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Esc is pressed", () => {
    const onClose = vi.fn();
    render(
      <NodeDetailModal
        detail={makeGateDetail()}
        index={0}
        total={3}
        onPrev={null}
        onNext={vi.fn()}
        onClose={onClose}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Done button is clicked", () => {
    const onClose = vi.fn();
    render(
      <NodeDetailModal
        detail={makeGateDetail()}
        index={0}
        total={3}
        onPrev={null}
        onNext={vi.fn()}
        onClose={onClose}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onPrev when ArrowLeft is pressed", () => {
    const onPrev = vi.fn();
    render(
      <NodeDetailModal
        detail={makeGateDetail()}
        index={1}
        total={3}
        onPrev={onPrev}
        onNext={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("calls onNext when ArrowRight is pressed", () => {
    const onNext = vi.fn();
    render(
      <NodeDetailModal
        detail={makeGateDetail()}
        index={1}
        total={3}
        onPrev={vi.fn()}
        onNext={onNext}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});

it("edits gate instructions", () => {
  const onChange = vi.fn();
  render(
    <NodeDetailModal
      detail={{ kind: "gate", name: "Gate", instructions: "", onChange }}
      index={0} total={1} onPrev={null} onNext={null} onClose={() => {}} onDelete={() => {}}
    />
  );
  fireEvent.change(screen.getByPlaceholderText(/approve/i), { target: { value: "approve when validation passed" } });
  expect(onChange).toHaveBeenCalledWith({ instructions: "approve when validation passed" });
});

it("toggles a step terminal flag", () => {
  const onChange = vi.fn();
  render(
    <NodeDetailModal
      detail={{ kind: "step", name: "Done", instructions: "", outputSchema: [], terminal: false, onChange }}
      index={0} total={1} onPrev={null} onNext={null} onClose={() => {}} onDelete={() => {}}
    />
  );
  fireEvent.click(screen.getByLabelText(/terminal step/i));
  expect(onChange).toHaveBeenCalledWith({ terminal: true });
});
