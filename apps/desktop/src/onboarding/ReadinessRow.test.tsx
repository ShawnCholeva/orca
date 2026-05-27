import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReadinessRow } from "./ReadinessRow";

const baseAgent = {
  id: "claude-code",
  name: "Claude Code",
  shortLabel: "Anthropic · CLI",
  description: "Deep planning",
  swatch: "#D97757",
  recommended: true,
  connected: true,
  sortOrder: 10,
  createdAt: "2026-05-22T00:00:00.000Z",
  updatedAt: "2026-05-22T00:00:00.000Z",
  readiness: null,
};

describe("ReadinessRow", () => {
  it("renders 'Checking' when status is checking", () => {
    render(<ReadinessRow agent={baseAgent} state="checking" onRetry={vi.fn()} onOpenUrl={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByText(/checking/i)).toBeInTheDocument();
  });

  it("renders 'Ready' with version on ready", () => {
    render(
      <ReadinessRow
        agent={{
          ...baseAgent,
          readiness: {
            agentId: "claude-code",
            status: "ready",
            steps: [],
            checkedAt: "2026-05-22T00:00:00.000Z",
            version: "1.2.3",
          },
        }}
        state="settled"
        onRetry={vi.fn()}
        onOpenUrl={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText(/ready/i)).toBeInTheDocument();
    expect(screen.getByText(/1\.2\.3/)).toBeInTheDocument();
  });

  it("renders Retry button on needs_auth", () => {
    const onRetry = vi.fn();
    render(
      <ReadinessRow
        agent={{
          ...baseAgent,
          readiness: {
            agentId: "claude-code",
            status: "needs_auth",
            steps: [],
            repair: { kind: "run_command", command: "claude auth login", label: "Sign in" },
            checkedAt: "2026-05-22T00:00:00.000Z",
          },
        }}
        state="settled"
        onRetry={onRetry}
        onOpenUrl={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledWith("claude-code");
  });

  it("Gemini ready row includes the 'configuration detected' qualifier", () => {
    render(
      <ReadinessRow
        agent={{
          ...baseAgent,
          id: "gemini-cli",
          name: "Gemini CLI",
          readiness: {
            agentId: "gemini-cli",
            status: "ready",
            steps: [
              {
                name: "authenticated",
                ok: true,
                authStatus: "ready",
                command: "gemini auth (configuration probe)",
                detail: "configuration detected; not smoke-tested (gemini_api_key)",
              },
            ],
            checkedAt: "2026-05-22T00:00:00.000Z",
          },
        }}
        state="settled"
        onRetry={vi.fn()}
        onOpenUrl={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText(/configuration detected; not smoke-tested/i)).toBeInTheDocument();
  });

  it("disables Retry with tooltip when requiresAppRestart is true", () => {
    render(
      <ReadinessRow
        agent={{
          ...baseAgent,
          id: "gemini-cli",
          readiness: {
            agentId: "gemini-cli",
            status: "needs_auth",
            steps: [],
            repair: {
              kind: "run_command",
              command: "export GEMINI_API_KEY=...",
              label: "Set API key",
              requiresAppRestart: true,
            },
            checkedAt: "2026-05-22T00:00:00.000Z",
          },
        }}
        state="settled"
        onRetry={vi.fn()}
        onOpenUrl={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const retry = screen.getByRole("button", { name: /retry/i });
    expect(retry).toBeDisabled();
  });
});
