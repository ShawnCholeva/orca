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
