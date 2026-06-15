import { describe, expect, it } from "vitest";
import type { BuiltInTemplateSummary } from "@orca/contracts";
import { groupCatalog } from "./groupCatalog";

// minimal valid fixture — only id and category matter to these tests
function s(id: string, category: string): BuiltInTemplateSummary {
  return { id, name: id, category, recommended: false, description: "d", bestFor: "b", stepCount: 3 };
}

describe("groupCatalog", () => {
  it("groups by category preserving first-seen order", () => {
    const out = groupCatalog([s("a", "Engineering"), s("b", "Product"), s("c", "Engineering")]);
    expect(out.map((g) => g.category)).toEqual(["Engineering", "Product"]);
    expect(out[0].templates.map((t) => t.id)).toEqual(["a", "c"]);
    expect(out[1].templates.map((t) => t.id)).toEqual(["b"]);
  });

  it("returns [] for empty input", () => {
    expect(groupCatalog([])).toEqual([]);
  });
});
