import { describe, expect, it } from "vitest";

import {
  CommittedLedger,
  LedgerVersionEntry,
  WorkflowRunLedgerResponse,
} from "../workflows/index.js";

const now = "2026-06-14T00:00:00.000Z";

const representativeResponse = {
  committed: {
    version: 2,
    records: [
      {
        id: "rec-abc123",
        recordType: "requirement",
        status: "satisfied",
        note: "requirement met",
        evidenceRefs: ["ev-1"],
        relatedRecordIds: [],
        firstVersion: 1,
        lastVersion: 2,
        updatedAt: now,
      },
    ],
  },
  versions: [
    { version: 1, sourceStepRunId: "sr-1", traversalSeq: 1, createdAt: "2026-06-14T00:00:01.000Z" },
    { version: 2, sourceStepRunId: "sr-2", traversalSeq: 2, createdAt: "2026-06-14T00:00:02.000Z" },
  ],
};

describe("CommittedLedger", () => {
  it("round-trips a committed ledger with version 0 and no records", () => {
    const result = CommittedLedger.parse({ version: 0, records: [] });
    expect(result).toEqual({ version: 0, records: [] });
  });

  it("rejects unknown keys (.strict())", () => {
    expect(() => CommittedLedger.parse({ version: 1, records: [], extra: true })).toThrow();
  });
});

describe("LedgerVersionEntry", () => {
  it("round-trips an entry with null sourceStepRunId", () => {
    const entry = { version: 0, sourceStepRunId: null, traversalSeq: 0, createdAt: now };
    expect(LedgerVersionEntry.parse(entry)).toEqual(entry);
  });

  it("rejects unknown keys (.strict())", () => {
    expect(() =>
      LedgerVersionEntry.parse({ version: 1, sourceStepRunId: null, traversalSeq: 1, createdAt: now, extra: true })
    ).toThrow();
  });
});

describe("WorkflowRunLedgerResponse", () => {
  it("round-trips a representative ledger response (1 record, 2 version entries)", () => {
    const result = WorkflowRunLedgerResponse.parse(representativeResponse);
    expect(result.committed.version).toBe(2);
    expect(result.committed.records).toHaveLength(1);
    expect(result.committed.records[0]!.id).toBe("rec-abc123");
    expect(result.versions).toHaveLength(2);
    expect(result.versions[0]!.sourceStepRunId).toBe("sr-1");
    expect(result.versions[1]!.traversalSeq).toBe(2);
  });

  it("rejects unknown keys at top level (.strict())", () => {
    expect(() =>
      WorkflowRunLedgerResponse.parse({ ...representativeResponse, extra: true })
    ).toThrow();
  });

  it("accepts version 0 with no records and no versions", () => {
    const result = WorkflowRunLedgerResponse.parse({
      committed: { version: 0, records: [] },
      versions: [],
    });
    expect(result.committed.version).toBe(0);
    expect(result.versions).toHaveLength(0);
  });
});
