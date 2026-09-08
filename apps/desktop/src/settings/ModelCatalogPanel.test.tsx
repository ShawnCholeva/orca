import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelCatalogPanel } from "./ModelCatalogPanel.js";

const adapters = [
  { adapterId: "claude-code", adapterVersion: "2.1.263", source: "extracted", models: [{ id: "claude-opus-5", displayName: "Opus 5" }] },
  { adapterId: "codex", adapterVersion: null, source: "seed", models: [] },
];

describe("ModelCatalogPanel", () => {
  it("names the CLI version the catalog was read from", () => {
    render(<ModelCatalogPanel adapters={adapters} onRefresh={() => {}} />);
    expect(screen.getByText(/2\.1\.263/)).toBeInTheDocument();
  });

  it("says plainly when a catalog came from the built-in seed rather than the CLI", () => {
    render(<ModelCatalogPanel adapters={adapters} onRefresh={() => {}} />);
    expect(screen.getByText(/built-in fallback/i)).toBeInTheDocument();
  });

  it("distinguishes a freshly read catalog from a cached one", () => {
    render(<ModelCatalogPanel adapters={[{ ...adapters[0], source: "cached" }]} onRefresh={() => {}} />);
    expect(screen.getByText(/cached/i)).toBeInTheDocument();
  });

  it("lists the models it found", () => {
    render(<ModelCatalogPanel adapters={adapters} onRefresh={() => {}} />);
    expect(screen.getByText("Opus 5")).toBeInTheDocument();
  });

  it("offers a refresh control", () => {
    render(<ModelCatalogPanel adapters={adapters} onRefresh={() => {}} />);
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
  });

  it("says when an adapter found no models", () => {
    render(<ModelCatalogPanel adapters={[adapters[1]]} onRefresh={() => {}} />);
    expect(screen.getByText(/no models/i)).toBeInTheDocument();
  });

  it("disables the refresh control while a refresh is pending", () => {
    render(<ModelCatalogPanel adapters={adapters} onRefresh={() => {}} refreshing />);
    expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
  });
});
