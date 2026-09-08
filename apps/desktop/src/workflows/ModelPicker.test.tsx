import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CatalogModel } from "@orca/contracts";
import { ModelPicker } from "./ModelPicker.js";

const CATALOG: CatalogModel[] = [
  { id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
    supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { id: "claude-haiku-4-5", family: "haiku", displayName: "Haiku 4.5", contextWindow: 200_000,
    supports1mSuffix: false, pricingTier: "tier_1_5", advisorRank: 1,
    supportedEfforts: ["low", "medium", "high"], defaultEffort: "medium" },
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
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-opus-5::1m" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ modelId: "claude-opus-5", contextVariant: "1m" }));
  });

  it("resets effort to the new model's default when the choice changes", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-haiku-4-5::default" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ effort: "medium" }));
  });

  it("switches to a profile reference and hides the effort control", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /profile/i }));
    expect(onChange).toHaveBeenCalledWith({ kind: "profile", ref: "reasoning" });
  });

  it("shows the profile's name when the node references one", () => {
    render(<ModelPicker value={{ kind: "profile", ref: "reasoning" }} catalog={CATALOG} profiles={PROFILES} onChange={() => {}} />);
    expect(screen.getByDisplayValue("Reasoning")).toBeInTheDocument();
    expect(screen.queryByLabelText("Effort")).not.toBeInTheDocument();
  });
});
