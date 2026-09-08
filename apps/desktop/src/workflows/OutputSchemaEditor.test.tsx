import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { OutputSchemaEditor } from "./OutputSchemaEditor";

const baseSchema: WorkflowStepOutputSchema = [
  { key: "summary", type: "string", required: true, display: "user" },
  { key: "count", type: "number", required: false },
];

const nestedSchema: WorkflowStepOutputSchema = [
  { key: "summary", type: "string", required: true, display: "user" },
  {
    key: "approaches", type: "array", itemType: "object", required: true, display: "user",
    fields: [
      { key: "name", type: "string", required: true },
      { key: "tradeoffs", type: "string", required: true },
    ],
  },
];

const name = (path: string) => screen.getByLabelText(`Field ${path} name`) as HTMLInputElement;
const type = (path: string) => screen.getByLabelText(`Field ${path} type`) as HTMLSelectElement;
const required = (path: string) => screen.getByLabelText(`Field ${path} required`) as HTMLInputElement;
const shownTo = (path: string, who: "User" | "Agent") =>
  within(screen.getByRole("radiogroup", { name: `Field ${path} shown to` })).getByRole("radio", { name: who });

describe("OutputSchemaEditor", () => {
  it("renders one row per field seeded from the schema", () => {
    render(<OutputSchemaEditor schema={baseSchema} onChange={vi.fn()} />);
    expect(name("1").value).toBe("summary");
    expect(type("1").value).toBe("string");
    expect(required("1").checked).toBe(true);
    expect(shownTo("1", "User")).toHaveAttribute("aria-checked", "true");

    expect(name("2").value).toBe("count");
    expect(type("2").value).toBe("number");
    expect(required("2").checked).toBe(false);
    // Absent display means agent.
    expect(shownTo("2", "Agent")).toHaveAttribute("aria-checked", "true");
  });

  it("renaming a field emits the schema with every other property intact", () => {
    const onChange = vi.fn();
    render(<OutputSchemaEditor schema={nestedSchema} onChange={onChange} />);

    fireEvent.change(name("1"), { target: { value: "headline" } });

    expect(onChange).toHaveBeenLastCalledWith([
      { ...nestedSchema[0], key: "headline" },
      nestedSchema[1],
    ]);
  });

  it("switches the audience between user and agent", () => {
    const onChange = vi.fn();
    render(<OutputSchemaEditor schema={baseSchema} onChange={onChange} />);

    fireEvent.click(shownTo("2", "User"));
    expect(onChange).toHaveBeenLastCalledWith([baseSchema[0], { ...baseSchema[1], display: "user" }]);

    fireEvent.click(shownTo("1", "Agent"));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...baseSchema[0], display: "agent" },
      { ...baseSchema[1], display: "user" },
    ]);
  });

  it("toggles required", () => {
    const onChange = vi.fn();
    render(<OutputSchemaEditor schema={baseSchema} onChange={onChange} />);
    fireEvent.click(required("2"));
    expect(onChange).toHaveBeenLastCalledWith([baseSchema[0], { ...baseSchema[1], required: true }]);
  });

  it("maps the type select onto type and itemType, dropping options that no longer apply", () => {
    const onChange = vi.fn();
    const withEnum: WorkflowStepOutputSchema = [
      { key: "tier", type: "string", required: true, enum: ["a", "b"] },
    ];
    render(<OutputSchemaEditor schema={withEnum} onChange={onChange} />);

    fireEvent.change(type("1"), { target: { value: "string[]" } });
    expect(onChange).toHaveBeenLastCalledWith([
      { key: "tier", type: "array", itemType: "string", required: true },
    ]);

    fireEvent.change(type("1"), { target: { value: "boolean" } });
    expect(onChange).toHaveBeenLastCalledWith([{ key: "tier", type: "boolean", required: true }]);
  });

  it("adds a new row that is invalid until it has a name", () => {
    const onChange = vi.fn();
    const onValidityChange = vi.fn();
    render(<OutputSchemaEditor schema={baseSchema} onChange={onChange} onValidityChange={onValidityChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    expect(name("3").value).toBe("");
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(name("3"), { target: { value: "notes" } });
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
    expect(onChange).toHaveBeenLastCalledWith([
      ...baseSchema,
      { key: "notes", type: "string", required: true },
    ]);
  });

  it("flags duplicate names and suppresses onChange", () => {
    const onChange = vi.fn();
    const onValidityChange = vi.fn();
    render(<OutputSchemaEditor schema={baseSchema} onChange={onChange} onValidityChange={onValidityChange} />);

    fireEvent.change(name("2"), { target: { value: "summary" } });

    expect(onChange).not.toHaveBeenCalled();
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByText(/Duplicate key 'summary'/)).toBeDefined();
  });

  it("removes a row", () => {
    const onChange = vi.fn();
    render(<OutputSchemaEditor schema={baseSchema} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove field 1" }));
    expect(onChange).toHaveBeenLastCalledWith([baseSchema[1]]);
  });

  it("edits nested fields of an object list", () => {
    const onChange = vi.fn();
    render(<OutputSchemaEditor schema={nestedSchema} onChange={onChange} />);

    expect(name("2.1").value).toBe("name");
    expect(name("2.2").value).toBe("tradeoffs");

    fireEvent.change(name("2.2"), { target: { value: "risks" } });
    expect(onChange).toHaveBeenLastCalledWith([
      nestedSchema[0],
      {
        ...nestedSchema[1],
        fields: [
          { key: "name", type: "string", required: true },
          { key: "risks", type: "string", required: true },
        ],
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Add field to approaches" }));
    fireEvent.change(name("2.3"), { target: { value: "cost" } });
    expect(onChange).toHaveBeenLastCalledWith([
      nestedSchema[0],
      {
        ...nestedSchema[1],
        fields: [
          { key: "name", type: "string", required: true },
          { key: "risks", type: "string", required: true },
          { key: "cost", type: "string", required: true },
        ],
      },
    ]);
  });

  it("nested rows carry no audience control", () => {
    render(<OutputSchemaEditor schema={nestedSchema} onChange={vi.fn()} />);
    expect(screen.queryByRole("radiogroup", { name: "Field 2.1 shown to" })).toBeNull();
  });

  it("edits allowed values and description behind the options toggle", () => {
    const onChange = vi.fn();
    render(<OutputSchemaEditor schema={baseSchema} onChange={onChange} />);

    expect(screen.queryByLabelText("Field 1 allowed values")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Field 1 options" }));

    fireEvent.change(screen.getByLabelText("Field 1 allowed values"), { target: { value: "low, high" } });
    expect(onChange).toHaveBeenLastCalledWith([
      { ...baseSchema[0], enum: ["low", "high"] },
      baseSchema[1],
    ]);

    fireEvent.change(screen.getByLabelText("Field 1 description"), { target: { value: "one line" } });
    expect(onChange).toHaveBeenLastCalledWith([
      { ...baseSchema[0], enum: ["low", "high"], description: "one line" },
      baseSchema[1],
    ]);

    fireEvent.change(screen.getByLabelText("Field 1 allowed values"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith([
      { ...baseSchema[0], description: "one line" },
      baseSchema[1],
    ]);
  });

  it("only offers allowed values for string fields", () => {
    render(<OutputSchemaEditor schema={baseSchema} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Field 2 options" }));
    expect(screen.getByLabelText("Field 2 description")).toBeDefined();
    expect(screen.queryByLabelText("Field 2 allowed values")).toBeNull();
  });

  it("re-seeds when the schema prop changes from outside", () => {
    const { rerender } = render(<OutputSchemaEditor schema={baseSchema} onChange={vi.fn()} />);
    rerender(<OutputSchemaEditor schema={[{ key: "other", type: "boolean", required: true }]} onChange={vi.fn()} />);
    expect(name("1").value).toBe("other");
    expect(screen.queryByLabelText("Field 2 name")).toBeNull();
  });

  it("renders read-only when disabled", () => {
    render(<OutputSchemaEditor schema={baseSchema} onChange={vi.fn()} disabled />);
    expect(name("1").disabled).toBe(true);
    expect(type("1").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Add field" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove field 1" })).toBeNull();
  });
});
