import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import * as api from "../api";
import { SettingsModal } from "./SettingsModal";
import { ThemeProvider } from "../theme/ThemeProvider";

function renderModal() {
  return render(
    <ThemeProvider>
      <SettingsModal onClose={() => {}} agents={[]} onToggleAgent={() => {}} />
    </ThemeProvider>,
  );
}

describe("SettingsModal supervision", () => {
  beforeEach(() => {
    vi.spyOn(api, "getSettings").mockResolvedValue({ supervisionMode: "supervised" });
    vi.spyOn(api, "putSettings").mockResolvedValue({ supervisionMode: "unsupervised" });
    vi.spyOn(api, "getModelCatalog").mockResolvedValue({ adapters: [], profiles: [] });
  });

  it("shows the current mode and persists a change", async () => {
    renderModal();
    fireEvent.click(screen.getByText("Orchestration"));
    await waitFor(() => screen.getByTestId("supervision-supervised"));
    fireEvent.click(screen.getByTestId("supervision-unsupervised"));
    await waitFor(() =>
      expect(api.putSettings).toHaveBeenCalledWith({ supervisionMode: "unsupervised" })
    );
  });
});

describe("SettingsModal model catalog", () => {
  const catalog = {
    adapters: [
      {
        adapterId: "claude-code" as const,
        adapterVersion: "2.1.263",
        source: "extracted" as const,
        models: [
          {
            id: "claude-opus-5",
            family: "opus",
            displayName: "Opus 5",
            contextWindow: 200000,
            supports1mSuffix: true,
            pricingTier: "tier_5_25",
            advisorRank: 1,
            supportedEfforts: [],
            defaultEffort: null,
          },
        ],
      },
    ],
    profiles: [],
  };

  beforeEach(() => {
    vi.spyOn(api, "getSettings").mockResolvedValue({ supervisionMode: "supervised" });
  });

  it("reaches the model catalog through Manage Agents and shows where it came from", async () => {
    vi.spyOn(api, "getModelCatalog").mockResolvedValue(catalog);
    renderModal();
    fireEvent.click(screen.getByText("Manage Agents"));
    await waitFor(() => screen.getByText("Opus 5"));
    expect(screen.getByText(/2\.1\.263/)).toBeInTheDocument();
    expect(screen.getByText(/read from the installed cli/i)).toBeInTheDocument();
  });

  it("refreshes the catalog on demand without breaking the panel on failure", async () => {
    vi.spyOn(api, "getModelCatalog").mockResolvedValue(catalog);
    const refreshSpy = vi.spyOn(api, "refreshModelCatalog").mockRejectedValue(new Error("boom"));
    renderModal();
    fireEvent.click(screen.getByText("Manage Agents"));
    await waitFor(() => screen.getByText("Opus 5"));
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
    expect(screen.getByText("Opus 5")).toBeInTheDocument();
  });

  it("does not break the rest of settings when the catalog fails to load", async () => {
    vi.spyOn(api, "getModelCatalog").mockRejectedValue(new Error("network down"));
    renderModal();
    fireEvent.click(screen.getByText("Manage Agents"));
    await waitFor(() => screen.getByText(/couldn't load the model catalog/i));
    fireEvent.click(screen.getByText("Appearance"));
    expect(screen.getByText("Theme")).toBeInTheDocument();
  });
});
