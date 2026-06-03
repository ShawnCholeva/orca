import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { OutputSchemaEditor } from "./OutputSchemaEditor";

const baseSchema: WorkflowStepOutputSchema = [
  { key: "summary", type: "string", required: true },
  { key: "count", type: "number", required: false },
];

function getTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Output Schema") as HTMLTextAreaElement;
}

describe("OutputSchemaEditor", () => {
  it("seeds the text area from the schema", () => {
    render(<OutputSchemaEditor schema={baseSchema} onChange={vi.fn()} />);
    expect(getTextarea().value).toBe("summary,\ncount?: number");
  });

  it("emits onChange with the parsed schema on valid edits", () => {
    const onChange = vi.fn();
    render(<OutputSchemaEditor schema={baseSchema} onChange={onChange} />);

    fireEvent.change(getTextarea(), { target: { value: "goal, audience" } });

    expect(onChange).toHaveBeenLastCalledWith([
      { key: "goal", type: "string", required: true },
      { key: "audience", type: "string", required: true },
    ]);
  });

  it("shows an error and suppresses onChange on invalid input", () => {
    const onChange = vi.fn();
    render(<OutputSchemaEditor schema={baseSchema} onChange={onChange} />);

    fireEvent.change(getTextarea(), { target: { value: "goal, goal" } });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Duplicate key 'goal'/)).toBeDefined();
  });

  it("reports validity changes", () => {
    const onValidityChange = vi.fn();
    render(
      <OutputSchemaEditor schema={baseSchema} onChange={vi.fn()} onValidityChange={onValidityChange} />,
    );

    fireEvent.change(getTextarea(), { target: { value: "a {" } });
    expect(onValidityChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(getTextarea(), { target: { value: "a" } });
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it("renders read-only when disabled", () => {
    render(<OutputSchemaEditor schema={baseSchema} onChange={vi.fn()} disabled />);
    expect(getTextarea().readOnly).toBe(true);
  });
});
