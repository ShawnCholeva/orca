import { describe, expect, it } from "vitest";
import {
  LedgerUpdate,
  StepCompletionEnvelope,
  LedgerOperation,
  LedgerRecordType,
  LedgerRecord,
} from "./index.js";

describe("LedgerUpdate", () => {
  it("parses a create proposal with a local ref", () => {
    const u = LedgerUpdate.parse({
      operation: "create",
      record_id: "local:req-1",
      record_type: "requirement",
      status: "open",
      evidence_refs: [],
      note: "first requirement",
    });
    expect(u.operation).toBe("create");
    expect(u).toStrictEqual({ operation: "create", record_id: "local:req-1", record_type: "requirement", status: "open", evidence_refs: [], note: "first requirement" });
  });

  it("rejects an unknown operation", () => {
    expect(() =>
      LedgerUpdate.parse({ operation: "destroy", record_id: "x", record_type: "finding", status: "open", evidence_refs: [], note: "" }),
    ).toThrow();
  });
});

describe("StepCompletionEnvelope", () => {
  it("parses an envelope with output + ledger_updates", () => {
    const e = StepCompletionEnvelope.parse({
      output: { summary: "done" },
      ledger_updates: [
        { operation: "update", record_id: "REQ-1", record_type: "requirement", status: "satisfied", evidence_refs: ["ev-1"], note: "met" },
      ],
    });
    expect(e.ledger_updates).toHaveLength(1);
  });

  it("defaults ledger_updates to [] when absent", () => {
    const e = StepCompletionEnvelope.parse({ output: { summary: "x" } });
    expect(e.ledger_updates).toEqual([]);
  });
});

describe("enum coverage", () => {
  it("exposes the operation + record-type options", () => {
    expect(LedgerOperation.options).toEqual(["create", "update", "link"]);
    expect(LedgerRecordType.options).toContain("requirement");
  });
});

describe("LedgerRecord", () => {
  it("parses a valid read-model record", () => {
    const r = LedgerRecord.parse({
      id: "REC-1",
      recordType: "requirement",
      status: "open",
      note: "",
      evidenceRefs: [],
      relatedRecordIds: [],
      firstVersion: 1,
      lastVersion: 1,
      updatedAt: "t",
    });
    expect(r).toStrictEqual({
      id: "REC-1",
      recordType: "requirement",
      status: "open",
      note: "",
      evidenceRefs: [],
      relatedRecordIds: [],
      firstVersion: 1,
      lastVersion: 1,
      updatedAt: "t",
    });
  });

  it("rejects a record missing id", () => {
    expect(() =>
      LedgerRecord.parse({
        recordType: "requirement",
        status: "open",
        note: "",
        evidenceRefs: [],
        relatedRecordIds: [],
        firstVersion: 1,
        lastVersion: 1,
        updatedAt: "t",
      }),
    ).toThrow();
  });
});
