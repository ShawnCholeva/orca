import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NoReadyAgentsBanner } from "./NoReadyAgentsBanner";

describe("NoReadyAgentsBanner", () => {
  it("is hidden when at least one connected agent is ready", () => {
    render(
      <NoReadyAgentsBanner
        agents={[
          // @ts-expect-error partial test fixture
          { id: "claude-code", connected: true, readiness: { status: "ready" } },
        ]}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is visible when zero connected agents are ready", () => {
    render(
      <NoReadyAgentsBanner
        agents={[
          // @ts-expect-error partial test fixture
          { id: "claude-code", connected: true, readiness: { status: "needs_auth" } },
        ]}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/no agents are ready/i);
  });

  it("dismiss hides the banner this session", () => {
    const onDismiss = vi.fn();
    render(
      <NoReadyAgentsBanner
        agents={[
          // @ts-expect-error partial test fixture
          { id: "claude-code", connected: true, readiness: { status: "missing" } },
        ]}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
