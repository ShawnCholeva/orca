import { describe, expect, it } from "vitest";
import { reviewAndNormalizeLedgerUpdates } from "./review.js";

const committed = { version: 1, records: [{ id: "REQ-1", recordType: "requirement" as const, status: "open", note: "", evidenceRefs: [], relatedRecordIds: [], firstVersion: 1, lastVersion: 1, updatedAt: "t" }] };

describe("reviewAndNormalizeLedgerUpdates", () => {
  it("keeps valid creates and updates to known records", async () => {
    const r = await reviewAndNormalizeLedgerUpdates({}, {
      committed,
      proposals: [
        { operation: "update", record_id: "REQ-1", record_type: "requirement", status: "satisfied", evidence_refs: ["e"], note: "" },
        { operation: "create", record_id: "local:x", record_type: "finding", status: "open", evidence_refs: [], note: "" },
      ],
    });
    expect(r.accepted).toHaveLength(2);
    expect(r.rejected).toHaveLength(0);
  });

  it("rejects an update to an unknown canonical record", async () => {
    const r = await reviewAndNormalizeLedgerUpdates({}, {
      committed,
      proposals: [{ operation: "update", record_id: "REQ-NOPE", record_type: "requirement", status: "x", evidence_refs: [], note: "" }],
    });
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toMatch(/unknown/i);
  });
});
