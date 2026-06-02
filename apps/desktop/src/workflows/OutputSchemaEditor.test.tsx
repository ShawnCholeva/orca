import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { OutputSchemaEditor } from "./OutputSchemaEditor";

const baseSchema: WorkflowStepOutputSchema = [
  { key: "summary", type: "string", required: true },
  { key: "count", type: "number", required: false },
];

describe("OutputSchemaEditor", () => {
  it("renders existing fields", () => {
    render(<OutputSchemaEditor schema={baseSchema} onChange={vi.fn()} />);

    expect(screen.getByDisplayValue("summary")).toBeDefined();
    expect(screen.getByDisplayValue("count")).toBeDefined();
  });

  it("calls onChange with a new field when Add field is clicked", () => {
    const onChange = vi.fn();
    render(<OutputSchemaEditor schema={baseSchema} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /add field/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as WorkflowStepOutputSchema;
    expect(next.length).toBe(3);
    expect(next[2]).toMatchObject({ key: "field", type: "string", required: true });
  });

  it("calls onChange without removed field when Remove is clicked", () => {
    const onChange = vi.fn();
    render(<OutputSchemaEditor schema={baseSchema} onChange={onChange} />);

    const removeBtns = screen.getAllByTitle("Remove field");
    // Remove the second field ("count")
    fireEvent.click(removeBtns[1]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as WorkflowStepOutputSchema;
    expect(next.length).toBe(1);
    expect(next[0].key).toBe("summary");
  });

  it("does not allow removing when only one field remains", () => {
    const onChange = vi.fn();
    render(
      <OutputSchemaEditor
        schema={[{ key: "only", type: "string", required: true }]}
        onChange={onChange}
      />,
    );

    const removeBtn = screen.getByTitle("Remove field") as HTMLButtonElement;
    expect(removeBtn.disabled).toBe(true);
  });

  it("reveals itemType select when type is changed to array", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <OutputSchemaEditor schema={baseSchema} onChange={onChange} />,
    );

    // Change type of first field to "array"
    const typeSelects = screen.getAllByLabelText(/Field \d+ type/i);
    fireEvent.change(typeSelects[0], { target: { value: "array" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as WorkflowStepOutputSchema;

    // Rerender with updated schema to verify item type select appears
    rerender(
      <OutputSchemaEditor
        schema={next}
        onChange={onChange}
      />,
    );

    expect(screen.getByLabelText(/Field 1 item type/i)).toBeDefined();
  });

  it("hides Add field button and Remove buttons when disabled", () => {
    render(
      <OutputSchemaEditor
        schema={baseSchema}
        onChange={vi.fn()}
        disabled
      />,
    );

    expect(screen.queryByRole("button", { name: /add field/i })).toBeNull();
    expect(screen.queryByTitle("Remove field")).toBeNull();
  });
});
