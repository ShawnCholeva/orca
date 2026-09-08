import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CatalogModel, NodeModelSelection, WorkflowStepOutputSchema } from "@orca/contracts";
import type { ModelCatalogProfile } from "../api";
import { NodeDetailModal, type NodeDetail } from "./NodeDetailModal";

const schema: WorkflowStepOutputSchema = [
  { key: "summary", type: "string", required: true },
];

const AGENT_PREFERENCE: NodeModelSelection[] = [
  { kind: "pinned", adapterId: "claude-code", modelId: "claude-haiku-4-5", contextVariant: "default", effort: null },
];

const CATALOG: CatalogModel[] = [
  { id: "claude-haiku-4-5", family: "haiku", displayName: "Haiku 4.5", contextWindow: 200_000,
    supports1mSuffix: false, pricingTier: "tier_1_5", advisorRank: 1,
    supportedEfforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
    supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
];

const PROFILES: ModelCatalogProfile[] = [{ id: "reasoning", displayName: "Reasoning" }];

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
    agentPreference: AGENT_PREFERENCE,
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
      detail={{ kind: "step", name: "Done", instructions: "", outputSchema: [], terminal: false, agentPreference: AGENT_PREFERENCE, onChange }}
      index={0} total={1} onPrev={null} onNext={null} onClose={() => {}} onDelete={() => {}}
    />
  );
  fireEvent.click(screen.getByLabelText(/terminal step/i));
  expect(onChange).toHaveBeenCalledWith({ terminal: true });
});

function makeSplitterDetail(onChange = vi.fn()): Extract<NodeDetail, { kind: "splitter" }> {
  return { kind: "splitter", name: "Route", instructions: "Pick the entry tier", branches: ["go_a", "go_b"], onChange };
}

it("renames a branch label", () => {
  const onChange = vi.fn();
  render(<NodeDetailModal detail={makeSplitterDetail(onChange)} index={0} total={3} onPrev={null} onNext={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} />);
  const input = screen.getByDisplayValue("go_a");
  fireEvent.change(input, { target: { value: "clarify_first" } });
  expect(onChange).toHaveBeenCalledWith({ branches: ["clarify_first", "go_b"] });
});

it("adds a branch", () => {
  const onChange = vi.fn();
  render(<NodeDetailModal detail={makeSplitterDetail(onChange)} index={0} total={3} onPrev={null} onNext={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} />);
  fireEvent.click(screen.getByText(/add branch/i));
  expect(onChange).toHaveBeenCalledWith({ branches: ["go_a", "go_b", expect.any(String)] });
});

it("edits splitter instructions", () => {
  const onChange = vi.fn();
  render(<NodeDetailModal detail={makeSplitterDetail(onChange)} index={0} total={3} onPrev={null} onNext={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} />);
  fireEvent.change(screen.getByPlaceholderText(/route to/i), { target: { value: "If vague, go clarify" } });
  expect(onChange).toHaveBeenCalledWith({ instructions: "If vague, go clarify" });
});

describe("NodeDetailModal — model picker", () => {
  it("a step node renders the picker", () => {
    render(
      <NodeDetailModal
        detail={makeStepDetail()}
        index={0} total={1} onPrev={null} onNext={null} onClose={vi.fn()} onDelete={vi.fn()}
        catalog={CATALOG} profiles={PROFILES}
      />,
    );
    expect(screen.getByRole("group", { name: "Step model" })).toBeDefined();
  });

  it("a gate node with evalSubstrate 'worker' renders the picker", () => {
    render(
      <NodeDetailModal
        detail={{ ...makeGateDetail(), agentPreference: AGENT_PREFERENCE, evalSubstrate: "worker" }}
        index={0} total={1} onPrev={null} onNext={null} onClose={vi.fn()} onDelete={vi.fn()}
        catalog={CATALOG} profiles={PROFILES}
      />,
    );
    expect(screen.getByRole("group", { name: "Gate model" })).toBeDefined();
  });

  it("a gate node with evalSubstrate 'shadow' does NOT render the picker", () => {
    render(
      <NodeDetailModal
        detail={{ ...makeGateDetail(), evalSubstrate: "shadow" }}
        index={0} total={1} onPrev={null} onNext={null} onClose={vi.fn()} onDelete={vi.fn()}
        catalog={CATALOG} profiles={PROFILES}
      />,
    );
    expect(screen.queryByRole("group", { name: "Gate model" })).toBeNull();
  });

  it("a splitter node does NOT render the picker", () => {
    render(
      <NodeDetailModal
        detail={makeSplitterDetail()}
        index={0} total={1} onPrev={null} onNext={null} onClose={vi.fn()} onDelete={vi.fn()}
        catalog={CATALOG} profiles={PROFILES}
      />,
    );
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  it("changing the model calls onChange with the new agentPreference and preserves entries behind the primary choice", () => {
    const onChange = vi.fn();
    const fallback: NodeModelSelection = { kind: "pinned", adapterId: "codex", modelId: "gpt-5", contextVariant: "default", effort: null };
    const detail = makeStepDetail(onChange);
    render(
      <NodeDetailModal
        detail={{ ...detail, agentPreference: [AGENT_PREFERENCE[0], fallback] }}
        index={0} total={1} onPrev={null} onNext={null} onClose={vi.fn()} onDelete={vi.fn()}
        catalog={CATALOG} profiles={PROFILES}
      />,
    );
    const group = screen.getByRole("group", { name: "Step model" });
    fireEvent.change(within(group).getByLabelText("Model"), { target: { value: "claude-opus-5::default" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const patch = onChange.mock.calls[0][0];
    expect(patch.agentPreference[0]).toMatchObject({ modelId: "claude-opus-5", contextVariant: "default" });
    expect(patch.agentPreference[1]).toEqual(fallback);
  });

  it("readOnly disables the picker", () => {
    render(
      <NodeDetailModal
        detail={makeStepDetail()}
        index={0} total={1} onPrev={null} onNext={null} onClose={vi.fn()} onDelete={vi.fn()}
        catalog={CATALOG} profiles={PROFILES} readOnly
      />,
    );
    const group = screen.getByRole("group", { name: "Step model" });
    expect((within(group).getByLabelText("Model") as HTMLSelectElement).disabled).toBe(true);
  });
});
