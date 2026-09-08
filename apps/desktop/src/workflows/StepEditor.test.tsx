import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogProfile } from "../api";
import type { CatalogEntry } from "./ModelPicker";
import { StepEditor, type WorkflowStepDraft } from "./StepEditor";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const CATALOG: CatalogEntry[] = [
  { adapterId: "claude-code", id: "claude-haiku-4-5", family: "haiku", displayName: "Haiku 4.5", contextWindow: 200_000,
    supports1mSuffix: false, pricingTier: "tier_1_5", advisorRank: 1,
    supportedEfforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { adapterId: "claude-code", id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
    supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
];

const PROFILES: ModelCatalogProfile[] = [{ id: "reasoning", displayName: "Reasoning" }];

function makeStep(id: string, name: string): WorkflowStepDraft {
  return {
    id,
    ordinal: 0,
    name,
    instructions: "",
    outputSchema: [{ key: "result", type: "string", required: true }],
    agentPreference: [
      {
        kind: "pinned" as const,
        adapterId: "claude-code" as const,
        modelId: "claude-haiku-4-5",
        contextVariant: "default" as const,
        effort: null,
      },
    ],
  };
}

const baseSteps: WorkflowStepDraft[] = [
  makeStep("step-1", "Research"),
  makeStep("step-2", "Implement"),
];

describe("StepEditor", () => {
  it("renders a row per step with its name", () => {
    render(<StepEditor steps={baseSteps} onChange={vi.fn()} catalog={CATALOG} profiles={PROFILES} />);
    expect(screen.getByDisplayValue("Research")).toBeDefined();
    expect(screen.getByDisplayValue("Implement")).toBeDefined();
  });

  it("editing a name input calls onChange with updated name", () => {
    const onChange = vi.fn();
    render(<StepEditor steps={baseSteps} onChange={onChange} catalog={CATALOG} profiles={PROFILES} />);

    const input = screen.getByDisplayValue("Research");
    fireEvent.change(input, { target: { value: "Research v2" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next: WorkflowStepDraft[] = onChange.mock.calls[0][0];
    expect(next[0].name).toBe("Research v2");
    expect(next[1].name).toBe("Implement");
  });

  it("Add step calls onChange with one more step (with default outputSchema)", () => {
    const onChange = vi.fn();
    render(<StepEditor steps={baseSteps} onChange={onChange} catalog={CATALOG} profiles={PROFILES} />);

    fireEvent.click(screen.getByRole("button", { name: /add step/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next: WorkflowStepDraft[] = onChange.mock.calls[0][0];
    expect(next.length).toBe(3);
    expect(next[2].outputSchema).toEqual([{ key: "result", type: "string", required: true }]);
  });

  it("Remove calls onChange with that step gone", () => {
    const onChange = vi.fn();
    render(<StepEditor steps={baseSteps} onChange={onChange} catalog={CATALOG} profiles={PROFILES} />);

    const removeBtns = screen.getAllByTitle("Remove step");
    fireEvent.click(removeBtns[0]);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next: WorkflowStepDraft[] = onChange.mock.calls[0][0];
    expect(next.length).toBe(1);
    expect(next[0].id).toBe("step-2");
  });

  it("Move up reorders — first step of second row goes before first", () => {
    const onChange = vi.fn();
    render(<StepEditor steps={baseSteps} onChange={onChange} catalog={CATALOG} profiles={PROFILES} />);

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
    render(<StepEditor steps={baseSteps} onChange={onChange} catalog={CATALOG} profiles={PROFILES} />);

    const moveDownBtns = screen.getAllByTitle("Move down");
    // First step's "Move down"
    fireEvent.click(moveDownBtns[0]);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next: WorkflowStepDraft[] = onChange.mock.calls[0][0];
    expect(next[0].id).toBe("step-2");
    expect(next[1].id).toBe("step-1");
  });

  it("expanding a row reveals instructions textarea and output schema editor", () => {
    render(<StepEditor steps={baseSteps} onChange={vi.fn()} catalog={CATALOG} profiles={PROFILES} />);

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
    render(<StepEditor steps={baseSteps} onChange={onChange} catalog={CATALOG} profiles={PROFILES} />);

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
    render(<StepEditor steps={baseSteps} onChange={vi.fn()} disabled catalog={CATALOG} profiles={PROFILES} />);

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
    render(<StepEditor steps={stepWithInstructions} onChange={vi.fn()} disabled catalog={CATALOG} profiles={PROFILES} />);

    const detailBtn = screen.getByTitle("Edit details");
    fireEvent.click(detailBtn);

    const textarea = screen.getByLabelText("Step 1 instructions") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Gather data.");
    expect(textarea.disabled).toBe(true);
  });

  it("renders a model picker for a step", () => {
    render(<StepEditor steps={baseSteps} onChange={vi.fn()} catalog={CATALOG} profiles={PROFILES} />);

    fireEvent.click(screen.getAllByTitle("Edit details")[0]);

    const group = screen.getByRole("group", { name: "Step 1 model" });
    expect(within(group).getByLabelText("Model")).toBeDefined();
  });

  it("choosing a different model updates agentPreference[0] and preserves the fallback entries behind it", () => {
    const onChange = vi.fn();
    const stepWithFallback: WorkflowStepDraft[] = [
      {
        ...makeStep("step-1", "Research"),
        agentPreference: [
          { kind: "pinned" as const, adapterId: "claude-code" as const, modelId: "claude-haiku-4-5",
            contextVariant: "default" as const, effort: null },
          { kind: "pinned" as const, adapterId: "codex" as const, modelId: "gpt-5",
            contextVariant: "default" as const, effort: null },
        ],
      },
    ];
    render(<StepEditor steps={stepWithFallback} onChange={onChange} catalog={CATALOG} profiles={PROFILES} />);

    fireEvent.click(screen.getByTitle("Edit details"));
    const group = screen.getByRole("group", { name: "Step 1 model" });
    const modelSelect = within(group).getByLabelText("Model");

    fireEvent.change(modelSelect, { target: { value: "claude-code::claude-opus-5::default" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next: WorkflowStepDraft[] = onChange.mock.calls[0][0];
    expect(next[0].agentPreference[0]).toMatchObject({ modelId: "claude-opus-5", contextVariant: "default" });
    expect(next[0].agentPreference[1]).toEqual(stepWithFallback[0].agentPreference[1]);
  });

  it("still renders instructions and output schema when the catalog is empty", () => {
    const onChange = vi.fn();
    render(<StepEditor steps={baseSteps} onChange={onChange} catalog={[]} profiles={[]} />);
    fireEvent.click(screen.getAllByTitle("Edit details")[0]);

    const textarea = screen.getByLabelText("Step 1 instructions");
    fireEvent.change(textarea, { target: { value: "Still works." } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/output schema/i)).toBeDefined();
  });

  it("an empty model list disables the Pinned control, shows why, and never lets onChange emit an empty modelId", () => {
    const onChange = vi.fn();
    render(<StepEditor steps={baseSteps} onChange={onChange} catalog={[]} profiles={PROFILES} />);
    fireEvent.click(screen.getAllByTitle("Edit details")[0]);

    const group = screen.getByRole("group", { name: "Step 1 model" });
    const pinnedRadio = within(group).getByRole("radio", { name: /pinned model/i }) as HTMLInputElement;
    const modelSelect = within(group).getByLabelText("Model") as HTMLSelectElement;

    expect(pinnedRadio.disabled).toBe(true);
    expect(modelSelect.disabled).toBe(true);
    expect(within(group).getByText(/no models available/i)).toBeDefined();
    // The model select has nothing to offer — no options for a user to pick,
    // so there is no route to an empty-modelId onChange through this control.
    expect(modelSelect.options.length).toBe(0);

    // A disabled radio does not respond to a user click — no onChange call,
    // let alone one carrying an empty modelId.
    fireEvent.click(pinnedRadio);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("an empty profile list disables the Profile control and never lets onChange emit an empty ref", () => {
    const onChange = vi.fn();
    render(<StepEditor steps={baseSteps} onChange={onChange} catalog={CATALOG} profiles={[]} />);
    fireEvent.click(screen.getAllByTitle("Edit details")[0]);

    const group = screen.getByRole("group", { name: "Step 1 model" });
    const profileRadio = within(group).getByRole("radio", { name: /^profile$/i }) as HTMLInputElement;

    expect(profileRadio.disabled).toBe(true);
    expect(within(group).getByText(/no profiles available/i)).toBeDefined();

    // A disabled radio does not respond to a user click — no onChange call,
    // let alone one carrying an empty ref.
    fireEvent.click(profileRadio);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a populated catalog keeps both the Pinned and Profile controls enabled", () => {
    render(<StepEditor steps={baseSteps} onChange={vi.fn()} catalog={CATALOG} profiles={PROFILES} />);
    fireEvent.click(screen.getAllByTitle("Edit details")[0]);

    const group = screen.getByRole("group", { name: "Step 1 model" });
    const pinnedRadio = within(group).getByRole("radio", { name: /pinned model/i }) as HTMLInputElement;
    const profileRadio = within(group).getByRole("radio", { name: /^profile$/i }) as HTMLInputElement;
    const modelSelect = within(group).getByLabelText("Model") as HTMLSelectElement;

    expect(pinnedRadio.disabled).toBe(false);
    expect(profileRadio.disabled).toBe(false);
    expect(modelSelect.disabled).toBe(false);
    expect(within(group).queryByText(/no models available/i)).toBeNull();
    expect(within(group).queryByText(/no profiles available/i)).toBeNull();
  });
});
