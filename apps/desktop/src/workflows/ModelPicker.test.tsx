import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@orca/contracts";
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

function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id" | "name" | "sortOrder" | "connected">): Agent {
  return {
    shortLabel: "",
    description: "",
    swatch: "#000000",
    recommended: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Claude Code and Codex CLI connected; Antigravity present but not connected —
// exercises the "connected AND has models" filter on both axes.
const AGENTS: Agent[] = [
  makeAgent({ id: "claude-code", name: "Claude Code", sortOrder: 10, connected: true }),
  makeAgent({ id: "codex", name: "Codex CLI", sortOrder: 20, connected: true }),
  makeAgent({ id: "antigravity", name: "Antigravity", sortOrder: 30, connected: false }),
];

const pinned = { kind: "pinned" as const, adapterId: "claude-code" as const, modelId: "claude-opus-5", contextVariant: "default" as const, effort: "high" as const };

describe("ModelPicker", () => {
  it("lists models by display name, not by id", () => {
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={AGENTS} onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "Opus 5" })).toBeInTheDocument();
  });

  it("offers a 1M context row only for a model that accepts the suffix", () => {
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={AGENTS} onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "Opus 5 (1M context)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Haiku 4.5 (1M context)" })).not.toBeInTheDocument();
  });

  it("offers only the effort levels the chosen model supports", () => {
    render(<ModelPicker value={{ ...pinned, modelId: "claude-haiku-4-5", effort: "medium" }} catalog={CATALOG} profiles={PROFILES} agents={AGENTS} onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "high" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "max" })).not.toBeInTheDocument();
  });

  it("emits the model and its variant as separate fields", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={AGENTS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-code::claude-opus-5::1m" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ modelId: "claude-opus-5", contextVariant: "1m" }));
  });

  it("resets effort to the new model's default when the choice changes", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={AGENTS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-code::claude-haiku-4-5::default" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ effort: "medium" }));
  });

  it("switches to a profile reference and hides the effort control", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={AGENTS} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /profile/i }));
    expect(onChange).toHaveBeenCalledWith({ kind: "profile", ref: "reasoning" });
  });

  it("groups the models by family", () => {
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={AGENTS} onChange={() => {}} />);
    const select = screen.getByLabelText("Model");
    expect(within(select).getByRole("group", { name: "opus" })).toBeInTheDocument();
  });

  it("shows the profile's name when the node references one", () => {
    render(<ModelPicker value={{ kind: "profile", ref: "reasoning" }} catalog={CATALOG} profiles={PROFILES} agents={AGENTS} onChange={() => {}} />);
    expect(screen.getByDisplayValue("Reasoning")).toBeInTheDocument();
    expect(screen.queryByLabelText("Effort")).not.toBeInTheDocument();
  });

  // ── Provider dropdown ─────────────────────────────────────────────────────

  it("lists only connected adapters that ship at least one catalog model, in sortOrder, labelled by the agent's own name", () => {
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={AGENTS} onChange={() => {}} />);
    const providerSelect = screen.getByLabelText("Provider");
    const optionNames = within(providerSelect).getAllByRole("option").map((o) => o.textContent);
    expect(optionNames).toEqual(["Claude Code", "Codex CLI"]);
  });

  it("excludes a connected adapter that ships no catalog model", () => {
    const claudeOnlyCatalog = CATALOG.filter((m) => m.adapterId === "claude-code");
    render(<ModelPicker value={pinned} catalog={claudeOnlyCatalog} profiles={PROFILES} agents={AGENTS} onChange={() => {}} />);
    const providerSelect = screen.getByLabelText("Provider");
    expect(within(providerSelect).queryByRole("option", { name: "Codex CLI" })).not.toBeInTheDocument();
  });

  it("filters the model list to the selected provider's models", () => {
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={AGENTS} onChange={() => {}} />);
    const modelSelect = screen.getByLabelText("Model");
    expect(within(modelSelect).getByRole("option", { name: "Opus 5" })).toBeInTheDocument();
    expect(within(modelSelect).queryByRole("option", { name: "GPT-5.5" })).not.toBeInTheDocument();
  });

  it("switching provider emits a pinned choice naming the new provider's adapter and one of its own models", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={AGENTS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "codex" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pinned", adapterId: "codex", modelId: "gpt-5.5", effort: null }),
    );
    // Never a model from the previous provider left behind under the new adapter.
    const call = onChange.mock.calls[0][0];
    expect(CATALOG.find((m) => m.id === call.modelId)?.adapterId).toBe("codex");
  });

  it("keeps a saved choice whose provider is now disconnected visible, marked unavailable, and does not rewrite it on mount", () => {
    const onChange = vi.fn();
    const agentsWithClaudeDisconnected: Agent[] = [
      makeAgent({ id: "claude-code", name: "Claude Code", sortOrder: 10, connected: false }),
      makeAgent({ id: "codex", name: "Codex CLI", sortOrder: 20, connected: true }),
    ];
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={agentsWithClaudeDisconnected} onChange={onChange} />);

    // Still shown, not silently rewritten.
    expect(onChange).not.toHaveBeenCalled();
    const providerSelect = screen.getByLabelText("Provider") as HTMLSelectElement;
    expect(providerSelect.value).toBe("claude-code");
    expect(screen.getByRole("option", { name: /claude code.*not connected/i })).toBeInTheDocument();
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("claude-code::claude-opus-5::default");

    // Marked unavailable with an explanation.
    expect(screen.getByText(/won't dispatch/i)).toBeInTheDocument();
  });

  it("pins the first connected provider's own first model when switching from profile to pinned mode", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={{ kind: "profile", ref: "reasoning" }} catalog={CATALOG} profiles={PROFILES} agents={AGENTS} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /pinned model/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5" }));
  });

  it("disables the controls and explains why when no agents are connected", () => {
    const noneConnected: Agent[] = [
      makeAgent({ id: "claude-code", name: "Claude Code", sortOrder: 10, connected: false }),
      makeAgent({ id: "codex", name: "Codex CLI", sortOrder: 20, connected: false }),
    ];
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={noneConnected} onChange={() => {}} />);

    expect(screen.getByText(/no agents are connected/i)).toBeInTheDocument();
    expect(screen.getByText(/settings/i)).toBeInTheDocument();
    expect((screen.getByRole("radio", { name: /pinned model/i }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Provider") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Model") as HTMLSelectElement).disabled).toBe(true);
  });

  // ── Three distinguishable "unavailable" states ────────────────────────────
  // Never collapse these into one another — each says something different,
  // and only the first one may ever use the word "not connected".

  it("state 1 — genuinely disconnected in Settings: labelled unavailable, points at the agent toggle", () => {
    const agentsWithClaudeDisconnected: Agent[] = [
      makeAgent({ id: "claude-code", name: "Claude Code", sortOrder: 10, connected: false }),
      makeAgent({ id: "codex", name: "Codex CLI", sortOrder: 20, connected: true }),
    ];
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={agentsWithClaudeDisconnected} onChange={() => {}} />);

    expect(screen.getByRole("option", { name: "Claude Code (not connected)" })).toBeInTheDocument();
    expect(screen.getByText(/won't dispatch until claude code is enabled in\s*settings/i)).toBeInTheDocument();
  });

  it("state 2 — connected but the catalog has no models for it: never says 'not connected', points at the catalog instead", () => {
    // Reproduces the reviewer's repro: both agents connected, catalog empty.
    const bothConnected: Agent[] = [
      makeAgent({ id: "claude-code", name: "Claude Code", sortOrder: 10, connected: true }),
      makeAgent({ id: "codex", name: "Codex CLI", sortOrder: 20, connected: true }),
    ];
    render(<ModelPicker value={pinned} catalog={[]} profiles={PROFILES} agents={bothConnected} onChange={() => {}} />);

    // The provider is shown plainly — never labelled "(not connected)" when it is connected.
    expect(screen.getByRole("option", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /not connected/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/won't dispatch/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/is enabled in settings/i)).not.toBeInTheDocument();

    // Says something true about the catalog instead, pointing at the Models
    // section (not the agent toggle).
    expect(screen.getByText(/no models available.*models section in settings/i)).toBeInTheDocument();
  });

  it("state 3 — agents not yet loaded: claims nothing, never guesses '(not connected)'", () => {
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={null} onChange={() => {}} />);

    // No status claim of any kind while we don't yet know who's connected.
    expect(screen.queryByRole("option", { name: /not connected/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/won't dispatch/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no agents are connected/i)).not.toBeInTheDocument();

    // The Provider control itself is disabled until the list is known, rather
    // than let the user act on an incomplete guess.
    expect((screen.getByLabelText("Provider") as HTMLSelectElement).disabled).toBe(true);
  });

  it("does not emit onChange when a late-arriving agent list turns a rerender into a real state change", () => {
    // No useEffect exists in ModelPicker for exactly this reason: a rerender
    // must never itself trigger a "fix up the value" onChange call, no matter
    // what changed about `agents` between renders. This is the structural
    // guarantee behind "a template is never silently rewritten by opening it".
    const onChange = vi.fn();
    const { rerender } = render(
      <ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={null} onChange={onChange} />,
    );
    expect(onChange).not.toHaveBeenCalled();

    rerender(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={AGENTS} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();

    // Also cover the case where the value's own provider turns out, once
    // agents finally load, to be disconnected — still no onChange.
    const claudeDisconnected: Agent[] = [
      makeAgent({ id: "claude-code", name: "Claude Code", sortOrder: 10, connected: false }),
      makeAgent({ id: "codex", name: "Codex CLI", sortOrder: 20, connected: true }),
    ];
    rerender(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} agents={claudeDisconnected} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });
});
