import { describe, expect, it } from "vitest";
import { MAX_DELEGATION_DEPTH, delegationTargets } from "./depth.js";

describe("depth/targets", () => {
  it("MAX_DELEGATION_DEPTH is 5", () => { expect(MAX_DELEGATION_DEPTH).toBe(5); });
  it("delegationTargets extracts child template refs from delegate nodes", () => {
    const tpl = { graph: { nodes: [
      { id: "s1", type: "step" }, { id: "d1", type: "delegate", childTemplateId: "child", childTemplateVersion: 2 },
    ] } } as never;
    expect(delegationTargets(tpl)).toEqual([{ childTemplateId: "child", version: 2 }]);
  });
});
