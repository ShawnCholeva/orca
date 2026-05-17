import { describe, expect, it } from "vitest";

import { SkillRegistry, skillRegistry } from "./skill-registry.js";
import type { SkillDescriptor } from "./types.js";

function makeSkill(descriptor: Partial<SkillDescriptor> & Pick<SkillDescriptor, "id">) {
  return {
    pluginId: "plugin.skills",
    extensionPoint: "goal.create",
    title: descriptor.id,
    description: "test skill",
    invoke: () => ({ ok: true }),
    ...descriptor,
  } satisfies SkillDescriptor;
}

describe("SkillRegistry", () => {
  it("registers skills and lists them sorted by id", () => {
    const registry = new SkillRegistry();

    const bSkill = makeSkill({ id: "skill.b" });
    const aSkill = makeSkill({ id: "skill.a" });

    registry.register(bSkill);
    registry.register(aSkill);

    expect(registry.list()).toEqual([aSkill, bSkill]);
  });

  it("throws when registering a duplicate id", () => {
    const registry = new SkillRegistry();
    const skill = makeSkill({ id: "skill.core" });

    registry.register(skill);

    expect(() => registry.register(skill)).toThrowError("Duplicate skill id: skill.core");
  });

  it("throws when registering after freeze", () => {
    const registry = new SkillRegistry();

    registry.freeze();

    expect(() => registry.register(makeSkill({ id: "skill.core" }))).toThrowError(
      "SkillRegistry is frozen"
    );
  });

  it("filters by extension point", () => {
    const registry = new SkillRegistry();
    const goalCreateSkill = makeSkill({ id: "skill.goal-create", extensionPoint: "goal.create" });

    registry.register(goalCreateSkill);

    expect(registry.byExtensionPoint("goal.create")).toEqual([goalCreateSkill]);
  });

  it("looks up skills by id", () => {
    const registry = new SkillRegistry();
    const skill = makeSkill({ id: "skill.match" });

    registry.register(skill);

    expect(registry.byId("skill.match")).toBe(skill);
    expect(registry.byId("skill.unknown")).toBeUndefined();
  });
});

describe("skillRegistry singleton", () => {
  it("exports a module-level instance", () => {
    expect(skillRegistry).toBeInstanceOf(SkillRegistry);
  });
});
