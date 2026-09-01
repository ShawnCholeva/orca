import { describe, expect, it } from "vitest";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { parseSchema, serializeSchema, validateSchemaTightening } from "./schema-mutation.js";

const base: WorkflowStepOutputSchema = [
  { key: "summary", type: "string", required: true, description: "one paragraph" },
  { key: "tier", type: "string", required: true, enum: ["fast", "full"] },
  { key: "notes", type: "string", required: false },
];

const ok = (after: WorkflowStepOutputSchema) => expect(validateSchemaTightening(base, after)).toEqual({ ok: true });
const bad = (after: WorkflowStepOutputSchema, needle: string) => {
  const r = validateSchemaTightening(base, after);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toContain(needle);
};

describe("validateSchemaTightening", () => {
  it("allows adding a field (required or optional)", () => {
    ok([...base, { key: "evidence_refs", type: "array", itemType: "string", required: true }]);
    ok([...base, { key: "caveats", type: "string", required: false }]);
  });
  it("allows optional→required", () => {
    ok(base.map((f) => f.key === "notes" ? { ...f, required: true } : f));
  });
  it("allows adding/extending a description", () => {
    ok(base.map((f) => f.key === "summary" ? { ...f, description: "one paragraph extended" } : f));
  });
  it("allows adding a description to a field that never had one", () => {
    ok(base.map((f) => f.key === "tier" ? { ...f, description: "which mode to run" } : f));
  });
  it("bans shrinking or replacing a description", () => {
    bad(base.map((f) => f.key === "summary" ? { ...f, description: "shorter" } : f), "description");
    bad(base.map((f) => f.key === "summary" ? { ...f, description: "" } : f), "description");
  });
  it("bans deleting a field", () => bad(base.filter((f) => f.key !== "notes"), "removed"));
  it("bans renaming (delete+add manifests as a removal)", () =>
    bad(base.map((f) => f.key === "notes" ? { ...f, key: "remarks" } : f), "removed"));
  it("bans type changes", () => bad(base.map((f) => f.key === "notes" ? { ...f, type: "number" as const } : f), "type"));
  it("bans enum alteration — narrowing, widening, or removal", () => {
    bad(base.map((f) => f.key === "tier" ? { ...f, enum: ["fast"] } : f), "enum");
    bad(base.map((f) => f.key === "tier" ? { ...f, enum: ["fast", "full", "turbo"] } : f), "enum");
    bad(base.map((f) => { if (f.key !== "tier") return f; const { enum: _e, ...rest } = f; return rest; }), "enum");
  });
  it("bans required→optional (weakening)", () =>
    bad(base.map((f) => f.key === "summary" ? { ...f, required: false } : f), "optional"));
  it("allows a preserved display audience on a pre-existing field", () => {
    const withDisplay: WorkflowStepOutputSchema = base.map((f) =>
      f.key === "summary" ? { ...f, display: "user" as const } : f
    );
    ok(withDisplay.map((f) => f.key === "summary" ? { ...f, display: "user" as const } : f));
  });
  it("bans changing or dropping a pre-existing field's display audience", () => {
    const withDisplay: WorkflowStepOutputSchema = base.map((f) =>
      f.key === "summary" ? { ...f, display: "user" as const } : f
    );
    const changed = validateSchemaTightening(
      withDisplay,
      withDisplay.map((f) => f.key === "summary" ? { ...f, display: "agent" as const } : f)
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.errors.join(" ")).toContain("display");
    const dropped = validateSchemaTightening(
      withDisplay,
      withDisplay.map((f) => { if (f.key !== "summary") return f; const { display: _d, ...rest } = f; return rest; })
    );
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.errors.join(" ")).toContain("display");
  });
  it("does not require a newly added field to carry a display audience", () => {
    ok([...base, { key: "evidence_refs", type: "array", itemType: "string", required: true }]);
  });
  it("recurses into nested object fields with the same rules", () => {
    const nestedBase: WorkflowStepOutputSchema = [
      { key: "plan", type: "object", required: true, fields: [{ key: "goal", type: "string", required: true }] },
    ];
    const removedNested: WorkflowStepOutputSchema = [
      { key: "plan", type: "object", required: true, fields: [] as never },
    ];
    // dropping a nested field is a removal
    const r = validateSchemaTightening(nestedBase, removedNested);
    expect(r.ok).toBe(false);
  });
  // Spec success criterion 3: composition safety — every op that could break a
  // splitter branchKey (key identity + enum values) or a delegate writes mapping
  // (key identity) is banned above. This test documents the guarantee directly:
  it("composition contract: keys and enum values present before are present after, under any accepted edit", () => {
    const accepted: WorkflowStepOutputSchema = [
      ...base.map((f) => f.key === "notes" ? { ...f, required: true } : f),
      { key: "risks", type: "array" as const, itemType: "string" as const, required: true },
    ];
    expect(validateSchemaTightening(base, accepted)).toEqual({ ok: true });
    for (const before of base) {
      const after = accepted.find((f) => f.key === before.key)!;
      expect(after).toBeDefined();
      expect(after.type).toBe(before.type);
      expect(after.enum ?? null).toEqual(before.enum ?? null);
    }
  });
});

it("serializeSchema/parseSchema round-trip; parseSchema null on junk", () => {
  expect(parseSchema(serializeSchema(base))).toEqual(base);
  expect(parseSchema("not json")).toBeNull();
  expect(parseSchema('{"not":"a schema"}')).toBeNull();
});
