import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LedgerPanel } from "./LedgerPanel";

const record = {
  id: "deliv-abc",
  recordType: "deliverable" as const,
  status: "done",
  note: "Shipped X",
  evidenceRefs: ["a.ts"],
  relatedRecordIds: [],
  firstVersion: 1,
  lastVersion: 3,
  updatedAt: "t",
};

describe("LedgerPanel", () => {
  it("renders record fields and version count", () => {
    render(
      <LedgerPanel
        committed={{ version: 3, records: [record] }}
        versionCount={3}
      />,
    );

    expect(screen.getByText(/Ledger · v3/)).toBeInTheDocument();
    expect(screen.getByText("deliverable")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText("Shipped X")).toBeInTheDocument();
  });

  it("renders empty-state line when there are no records", () => {
    render(
      <LedgerPanel
        committed={{ version: 0, records: [] }}
        versionCount={0}
      />,
    );

    expect(screen.getByText(/No ledger records/)).toBeInTheDocument();
  });
});
