import type { SkillDescriptor, SkillExtensionPoint } from "./types.js";

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDescriptor>();
  private frozen = false;

  register(skill: SkillDescriptor): void {
    if (this.frozen) {
      throw new Error("SkillRegistry is frozen");
    }

    if (this.skills.has(skill.id)) {
      throw new Error(`Duplicate skill id: ${skill.id}`);
    }

    this.skills.set(skill.id, skill);
  }

  freeze(): void {
    this.frozen = true;
  }

  list(): SkillDescriptor[] {
    return [...this.skills.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  byId(id: string): SkillDescriptor | undefined {
    return this.skills.get(id);
  }

  byExtensionPoint(extensionPoint: SkillExtensionPoint): SkillDescriptor[] {
    return this.list().filter((skill) => skill.extensionPoint === extensionPoint);
  }
}

export const skillRegistry = new SkillRegistry();
