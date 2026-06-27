import { describe, expect, it } from "vitest";
import { detectStateConflicts } from "./detect.js";

const entry = (kind: string, ref: string) => ({ kind, ref } as any);

describe("detectStateConflicts", () => {
  it("flags write-write overlap on the same ref", () => {
    const c = detectStateConflicts({
      self: { read_set: [], write_set: [entry("file","src/x.ts")], version_deps: [] },
      priors: [{ transitionId: "t-prev", read_set: [], write_set: [entry("file","src/x.ts")] }],
      currentVersions: new Map(),
    });
    expect(c.find((x) => x.kind === "write_write")?.refs).toContain("src/x.ts");
    expect(c.find((x) => x.kind === "write_write")?.with_transition_id).toBe("t-prev");
  });
  it("flags read-stale when self read a ref a prior wrote", () => {
    const c = detectStateConflicts({
      self: { read_set: [entry("memory_item","m1")], write_set: [], version_deps: [] },
      priors: [{ transitionId: "t2", read_set: [], write_set: [entry("memory_item","m1")] }],
      currentVersions: new Map(),
    });
    expect(c.some((x) => x.kind === "read_stale")).toBe(true);
  });
  it("flags belief-divergence when observed != current version", () => {
    const c = detectStateConflicts({
      self: { read_set: [], write_set: [], version_deps: [{ ref: "ws1", observed_version: "main:false" }] },
      priors: [], currentVersions: new Map([["ws1", "main:true"]]),
    });
    expect(c.some((x) => x.kind === "belief_divergence")).toBe(true);
  });
  it("returns [] when no overlap and versions match", () => {
    expect(detectStateConflicts({
      self: { read_set: [entry("file","a")], write_set: [entry("file","b")], version_deps: [{ ref:"ws1", observed_version:"v" }] },
      priors: [{ transitionId: "t", read_set: [], write_set: [entry("file","c")] }],
      currentVersions: new Map([["ws1","v"]]),
    })).toEqual([]);
  });
  it("discriminates by kind: a file and a memory_item at the same ref do not collide", () => {
    // self writes file:x; prior writes memory_item:x and reads file:x. Same ref
    // string, different kinds -> neither write_write nor read_stale.
    const c = detectStateConflicts({
      self: { read_set: [entry("file", "x")], write_set: [entry("file", "x")], version_deps: [] },
      priors: [
        {
          transitionId: "t",
          read_set: [entry("file", "x")],
          write_set: [entry("memory_item", "x")],
        },
      ],
      currentVersions: new Map(),
    });
    expect(c).toEqual([]);
  });

  it("treats an absent current version as divergence (the ref vanished under the step)", () => {
    const c = detectStateConflicts({
      self: { read_set: [], write_set: [], version_deps: [{ ref: "ws1", observed_version: "main:false" }] },
      priors: [],
      currentVersions: new Map(), // ws1 absent -> get() is undefined !== observed
    });
    expect(c.find((x) => x.kind === "belief_divergence")?.refs).toContain("ws1");
  });

  it("a refuting judge drops candidates", () => {
    const c = detectStateConflicts({
      self: { read_set: [], write_set: [entry("file","x")], version_deps: [] },
      priors: [{ transitionId: "t", read_set: [], write_set: [entry("file","x")] }],
      currentVersions: new Map(),
      judge: { judge: () => "false_positive" },
    });
    expect(c).toEqual([]);
  });
});
