import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const submitPermissionDecisionMock = vi.fn();
vi.mock("../api", () => ({
  submitPermissionDecision: (...args: unknown[]) => submitPermissionDecisionMock(...args),
}));

const pending = { approvalId: "a1", sessionId: "s1", toolName: "Bash", summary: "rm -rf build", detail: "rm -rf build --force" };

describe("PermissionApprovalCard", () => {
  beforeEach(() => {
    submitPermissionDecisionMock.mockReset();
    submitPermissionDecisionMock.mockResolvedValue(undefined);
  });

  it("renders the command summary", async () => {
    const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
    render(<PermissionApprovalCard goalId="g1" pending={pending} />);
    expect(screen.getByText("rm -rf build")).toBeInTheDocument();
  });

  it("calls submitPermissionDecision with allow when Allow is clicked", async () => {
    const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
    render(<PermissionApprovalCard goalId="g1" pending={pending} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => {
      expect(submitPermissionDecisionMock).toHaveBeenCalledWith("g1", "a1", "allow", false);
    });
  });

  it("calls submitPermissionDecision with allow + remember=true when Always allow is clicked", async () => {
    const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
    render(<PermissionApprovalCard goalId="g1" pending={pending} />);
    fireEvent.click(screen.getByText("Always allow"));
    await waitFor(() => {
      expect(submitPermissionDecisionMock).toHaveBeenCalledWith("g1", "a1", "allow", true);
    });
  });

  it("calls submitPermissionDecision with deny when Deny is clicked", async () => {
    const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
    render(<PermissionApprovalCard goalId="g1" pending={pending} />);
    fireEvent.click(screen.getByText("Deny"));
    await waitFor(() => {
      expect(submitPermissionDecisionMock).toHaveBeenCalledWith("g1", "a1", "deny", false);
    });
  });

  it("removes the card once a decision is submitted (ephemeral)", async () => {
    const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
    render(<PermissionApprovalCard goalId="g1" pending={pending} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
      expect(screen.queryByText("Deny")).toBeNull();
    });
  });

  it("shows an error and re-enables the buttons if the decision fails", async () => {
    submitPermissionDecisionMock.mockRejectedValueOnce(new Error("nope"));
    const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
    render(<PermissionApprovalCard goalId="g1" pending={pending} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByText(/could not be submitted/i)).toBeInTheDocument();
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides Always allow when the provider cannot persist (canRemember false)", async () => {
    const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
    render(<PermissionApprovalCard goalId="g1" pending={{ ...pending, canRemember: false }} />);
    expect(screen.getByText("Allow")).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
    expect(screen.queryByText("Always allow")).toBeNull();
  });

  it("shows Always allow when canRemember is true or absent (Claude unchanged)", async () => {
    const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
    const { rerender } = render(<PermissionApprovalCard goalId="g1" pending={{ ...pending, canRemember: true }} />);
    expect(screen.getByText("Always allow")).toBeInTheDocument();
    rerender(<PermissionApprovalCard goalId="g1" pending={pending} />); // absent
    expect(screen.getByText("Always allow")).toBeInTheDocument();
  });
});
