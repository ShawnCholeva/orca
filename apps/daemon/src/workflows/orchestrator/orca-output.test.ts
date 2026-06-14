import { describe, expect, it } from "vitest";
import {
  augmentInstructionsWithOutputConvention,
  extractOrcaStepCompleteBlock,
  parseOrcaOutputBlock,
  parseStepCompletionEnvelope,
} from "./orca-output.js";

describe("augmentInstructionsWithOutputConvention", () => {
  it("appends the orca-output convention exactly once", () => {
    const out = augmentInstructionsWithOutputConvention("Do the thing.");
    expect(out).toMatch(/```orca-output/);
    expect(out.indexOf("```orca-output")).toBe(out.lastIndexOf("```orca-output"));
  });
  it("is idempotent if convention is already present", () => {
    const first = augmentInstructionsWithOutputConvention("x");
    const second = augmentInstructionsWithOutputConvention(first);
    expect(second).toBe(first);
  });
});

describe("parseOrcaOutputBlock", () => {
  it("extracts the LAST orca-output block as JSON", () => {
    const text = [
      "noise",
      "```orca-output",
      '{"a":1}',
      "```",
      "more noise",
      "```orca-output",
      '{"a":2}',
      "```",
      "trailing",
    ].join("\n");
    expect(parseOrcaOutputBlock(text)).toEqual({ a: 2 });
  });
  it("returns null when no block is present", () => {
    expect(parseOrcaOutputBlock("nothing here")).toBeNull();
  });
  it("returns null when the block is not valid JSON", () => {
    expect(parseOrcaOutputBlock("```orca-output\nnot json\n```")).toBeNull();
  });
});

describe("extractOrcaStepCompleteBlock", () => {
  it("returns null when no block present", () => {
    expect(extractOrcaStepCompleteBlock("nothing here")).toBeNull();
  });
  it("extracts the last orca:step-complete block", () => {
    expect(extractOrcaStepCompleteBlock("```orca:step-complete\n{\"a\":1}\n```")).toEqual({ a: 1 });
  });
  it("returns the last block when multiple present", () => {
    const text = "```orca:step-complete\n{\"a\":1}\n```\nmore\n```orca:step-complete\n{\"a\":2}\n```";
    expect(extractOrcaStepCompleteBlock(text)).toEqual({ a: 2 });
  });
  it("returns null on invalid JSON", () => {
    expect(extractOrcaStepCompleteBlock("```orca:step-complete\nnot json\n```")).toBeNull();
  });
});

describe("parseStepCompletionEnvelope", () => {
  it("splits an envelope into output + ledgerUpdates", () => {
    const r = parseStepCompletionEnvelope({ output: { summary: "x" }, ledger_updates: [{ operation: "create", record_id: "local:a", record_type: "finding", status: "open", evidence_refs: [], note: "" }] });
    expect(r.output).toEqual({ summary: "x" });
    expect(r.ledgerUpdates).toHaveLength(1);
  });

  it("treats a bare output (no envelope keys) as output with empty ledger updates", () => {
    const r = parseStepCompletionEnvelope({ summary: "legacy" });
    expect(r.output).toEqual({ summary: "legacy" });
    expect(r.ledgerUpdates).toEqual([]);
  });

  it("treats { output } with no ledger_updates as empty updates", () => {
    const r = parseStepCompletionEnvelope({ output: { a: 1 } });
    expect(r.ledgerUpdates).toEqual([]);
  });
});
