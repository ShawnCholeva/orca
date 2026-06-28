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

  it("reflects the current mode (ask) as the selected option", async () => {
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={false} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("ask");
  });

  it("switches to auto and calls setWorkerPermissionMode when Auto-run selected", async () => {
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={false} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "auto" } });
    await waitFor(() => {
      expect(setWorkerPermissionModeMock).toHaveBeenCalledWith("g1", "auto");
    });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("auto");
  });

  it("reverts the optimistic mode if the api call fails", async () => {
    setWorkerPermissionModeMock.mockRejectedValueOnce(new Error("nope"));
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={false} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "auto" } });
    await waitFor(() => {
      expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("ask");
    });
  });

  it("disables the dropdown when disabled", async () => {
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={true} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
  });

  it("re-syncs to the mode prop when it changes (server truth wins)", async () => {
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    const { rerender } = render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={false} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("ask");
    rerender(<WorkerPermissionToggle goalId="g1" mode="auto" disabled={false} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("auto");
  });
});
