import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StepEditor, type WorkflowStepDraft } from "./StepEditor";

function makeStep(id: string, name: string): WorkflowStepDraft {
  return {
    id,
    ordinal: 0,
    name,
    instructions: "",
    outputSchema: [{ key: "result", type: "string", required: true }],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
  };
}

const baseSteps: WorkflowStepDraft[] = [
  makeStep("step-1", "Research"),
  makeStep("step-2", "Implement"),
];

describe("StepEditor", () => {
  it("renders a row per step with its name", () => {
    render(<StepEditor steps={baseSteps} onChange={vi.fn()} />);
    expect(screen.getByDisplayValue("Research")).toBeDefined();
    expect(screen.getByDisplayValue("Implement")).toBeDefined();
  });

  it("editing a name input calls onChange with updated name", () => {
    const onChange = vi.fn();
    render(<StepEditor steps={baseSteps} onChange={onChange} />);

    const input = screen.getByDisplayValue("Research");
    fireEvent.change(input, { target: { value: "Research v2" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next: WorkflowStepDraft[] = onChange.mock.calls[0][0];
    expect(next[0].name).toBe("Research v2");
    expect(next[1].name).toBe("Implement");
  });

  it("Add step calls onChange with one more step (with default outputSchema)", () => {
    const onChange = vi.fn();
    render(<StepEditor steps={baseSteps} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /add step/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next: WorkflowStepDraft[] = onChange.mock.calls[0][0];
    expect(next.length).toBe(3);
    expect(next[2].outputSchema).toEqual([{ key: "result", type: "string", required: true }]);
  });

  it("Remove calls onChange with that step gone", () => {
    const onChange = vi.fn();
    render(<StepEditor steps={baseSteps} onChange={onChange} />);

    const removeBtns = screen.getAllByTitle("Remove step");
    fireEvent.click(removeBtns[0]);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next: WorkflowStepDraft[] = onChange.mock.calls[0][0];
    expect(next.length).toBe(1);
    expect(next[0].id).toBe("step-2");
  });

  it("Move up reorders — first step of second row goes before first", () => {
    const onChange = vi.fn();
    render(<StepEditor steps={baseSteps} onChange={onChange} />);

    const moveUpBtns = screen.getAllByTitle("Move up");
    // Second step's "Move up"
    fireEvent.click(moveUpBtns[1]);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next: WorkflowStepDraft[] = onChange.mock.calls[0][0];
    expect(next[0].id).toBe("step-2");
    expect(next[1].id).toBe("step-1");
  });

  it("Move down reorders — first step moves to second position", () => {
    const onChange = vi.fn();
    render(<StepEditor steps={baseSteps} onChange={onChange} />);

    const moveDownBtns = screen.getAllByTitle("Move down");
    // First step's "Move down"
    fireEvent.click(moveDownBtns[0]);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next: WorkflowStepDraft[] = onChange.mock.calls[0][0];
    expect(next[0].id).toBe("step-2");
    expect(next[1].id).toBe("step-1");
  });

  it("expanding a row reveals instructions textarea and output schema editor", () => {
    render(<StepEditor steps={baseSteps} onChange={vi.fn()} />);

    // Initially the detail panel is collapsed — no instructions textareas visible
    expect(screen.queryByLabelText("Step 1 instructions")).toBeNull();

    // Expand first row
    const detailBtns = screen.getAllByTitle("Edit details");
    fireEvent.click(detailBtns[0]);

    expect(screen.getByLabelText("Step 1 instructions")).toBeDefined();
    // OutputSchemaEditor renders "Output Schema" label
    expect(screen.getByText(/output schema/i)).toBeDefined();
  });

  it("editing instructions calls onChange with updated value", () => {
    const onChange = vi.fn();
    render(<StepEditor steps={baseSteps} onChange={onChange} />);

    // Expand first row
    const detailBtns = screen.getAllByTitle("Edit details");
    fireEvent.click(detailBtns[0]);

    const textarea = screen.getByLabelText("Step 1 instructions");
    fireEvent.change(textarea, { target: { value: "Do the research." } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next: WorkflowStepDraft[] = onChange.mock.calls[0][0];
    expect(next[0].instructions).toBe("Do the research.");
  });

  it("disabled hides add/remove/move buttons and disables name inputs", () => {
    render(<StepEditor steps={baseSteps} onChange={vi.fn()} disabled />);

    expect(screen.queryByRole("button", { name: /add step/i })).toBeNull();
    expect(screen.queryByTitle("Remove step")).toBeNull();
    expect(screen.queryByTitle("Move up")).toBeNull();
    expect(screen.queryByTitle("Move down")).toBeNull();

    const nameInputs = screen.getAllByPlaceholderText("Step name") as HTMLInputElement[];
    for (const input of nameInputs) {
      expect(input.disabled).toBe(true);
    }
  });

  it("disabled still allows expanding to view details (read-only)", () => {
    const stepWithInstructions: WorkflowStepDraft[] = [
      { ...makeStep("step-1", "Research"), instructions: "Gather data." },
    ];
    render(<StepEditor steps={stepWithInstructions} onChange={vi.fn()} disabled />);

    const detailBtn = screen.getByTitle("Edit details");
    fireEvent.click(detailBtn);

    const textarea = screen.getByLabelText("Step 1 instructions") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Gather data.");
    expect(textarea.disabled).toBe(true);
  });
});
