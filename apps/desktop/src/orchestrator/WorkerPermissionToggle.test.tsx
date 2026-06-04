import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setWorkerPermissionModeMock = vi.fn();
vi.mock("../api", () => ({
  setWorkerPermissionMode: (...args: unknown[]) => setWorkerPermissionModeMock(...args),
}));

describe("WorkerPermissionToggle", () => {
  beforeEach(() => {
    setWorkerPermissionModeMock.mockReset();
    setWorkerPermissionModeMock.mockResolvedValue(undefined);
  });

  it("reflects the current mode (ask) as the active option", async () => {
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={false} />);
    const ask = screen.getByRole("button", { name: /Ask-in-chat/ });
    expect(ask.getAttribute("aria-pressed")).toBe("true");
    const auto = screen.getByRole("button", { name: /Auto-run/ });
    expect(auto.getAttribute("aria-pressed")).toBe("false");
  });

  it("switches to auto and calls setWorkerPermissionMode when Auto-run clicked", async () => {
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Auto-run/ }));
    await waitFor(() => {
      expect(setWorkerPermissionModeMock).toHaveBeenCalledWith("g1", "auto");
    });
    expect(screen.getByRole("button", { name: /Auto-run/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not call the api when clicking the already-active mode", async () => {
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="auto" disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Auto-run/ }));
    expect(setWorkerPermissionModeMock).not.toHaveBeenCalled();
  });

  it("reverts the optimistic mode if the api call fails", async () => {
    setWorkerPermissionModeMock.mockRejectedValueOnce(new Error("nope"));
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Auto-run/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Ask-in-chat/ }).getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("disables both options when disabled", async () => {
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={true} />);
    expect((screen.getByRole("button", { name: /Auto-run/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Ask-in-chat/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("re-syncs to the mode prop when it changes (server truth wins)", async () => {
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    const { rerender } = render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={false} />);
    expect(screen.getByRole("button", { name: /Ask-in-chat/ }).getAttribute("aria-pressed")).toBe("true");
    rerender(<WorkerPermissionToggle goalId="g1" mode="auto" disabled={false} />);
    expect(screen.getByRole("button", { name: /Auto-run/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Ask-in-chat/ }).getAttribute("aria-pressed")).toBe("false");
  });
});
