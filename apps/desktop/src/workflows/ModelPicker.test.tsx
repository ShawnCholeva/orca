import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker, type CatalogEntry } from "./ModelPicker.js";

// Multi-adapter on purpose: GET /v1/model-catalog always returns all three
// adapters, and every earlier fixture mocked claude-code alone — which is why
// the picker could emit a codex model under the claude-code adapter unnoticed.
const CATALOG: CatalogEntry[] = [
  { adapterId: "claude-code", id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
    supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { adapterId: "claude-code", id: "claude-haiku-4-5", family: "haiku", displayName: "Haiku 4.5", contextWindow: 200_000,
    supports1mSuffix: false, pricingTier: "tier_1_5", advisorRank: 1,
    supportedEfforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { adapterId: "codex", id: "gpt-5.5", family: "gpt-5", displayName: "GPT-5.5", contextWindow: 400_000,
    supports1mSuffix: false, pricingTier: null, advisorRank: null,
    supportedEfforts: [], defaultEffort: null },
];
const PROFILES = [{ id: "reasoning", displayName: "Reasoning", requires: {}, rank: "strongest" as const }];

const pinned = { kind: "pinned" as const, adapterId: "claude-code" as const, modelId: "claude-opus-5", contextVariant: "default" as const, effort: "high" as const };

describe("ModelPicker", () => {
  it("lists models by display name, not by id", () => {
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "Opus 5" })).toBeInTheDocument();
  });

  it("offers a 1M context row only for a model that accepts the suffix", () => {
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "Opus 5 (1M context)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Haiku 4.5 (1M context)" })).not.toBeInTheDocument();
  });

  it("offers only the effort levels the chosen model supports", () => {
    render(<ModelPicker value={{ ...pinned, modelId: "claude-haiku-4-5", effort: "medium" }} catalog={CATALOG} profiles={PROFILES} onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "high" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "max" })).not.toBeInTheDocument();
  });

  it("emits the model and its variant as separate fields", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-code::claude-opus-5::1m" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ modelId: "claude-opus-5", contextVariant: "1m" }));
  });

  it("resets effort to the new model's default when the choice changes", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-code::claude-haiku-4-5::default" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ effort: "medium" }));
  });

  it("switches to a profile reference and hides the effort control", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /profile/i }));
    expect(onChange).toHaveBeenCalledWith({ kind: "profile", ref: "reasoning" });
  });

  it("emits the adapter the chosen model belongs to, not the one already pinned", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "codex::gpt-5.5::default" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "codex", modelId: "gpt-5.5" }));
  });

  it("pins the first row's own adapter when the pinned arm is selected", () => {
    const onChange = vi.fn();
    const codexFirst = [CATALOG[2], CATALOG[0]];
    render(<ModelPicker value={{ kind: "profile", ref: "reasoning" }} catalog={codexFirst} profiles={PROFILES} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /pinned model/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "codex", modelId: "gpt-5.5" }));
  });

  it("groups the models by family", () => {
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={() => {}} />);
    const select = screen.getByLabelText("Model");
    expect(within(select).getByRole("group", { name: "opus" })).toBeInTheDocument();
    expect(within(select).getByRole("group", { name: "gpt-5" })).toBeInTheDocument();
  });

  it("shows the profile's name when the node references one", () => {
    render(<ModelPicker value={{ kind: "profile", ref: "reasoning" }} catalog={CATALOG} profiles={PROFILES} onChange={() => {}} />);
    expect(screen.getByDisplayValue("Reasoning")).toBeInTheDocument();
    expect(screen.queryByLabelText("Effort")).not.toBeInTheDocument();
  });
});
