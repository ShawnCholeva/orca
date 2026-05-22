import type {
  PublicSkillDescriptor,
  PublicSkillExtensionPoint,
  SkillDescriptor,
} from "./types.js";

function isPublicSkill(skill: SkillDescriptor): skill is PublicSkillDescriptor {
  if (skill.category === "internal") return false;
  return skill.extensionPoint === "goal.create" || skill.extensionPoint === "goal.refine";
}

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

    this.skills.set(skill.id, Object.freeze({ ...skill }) as SkillDescriptor);
  }

  freeze(): void {
    this.frozen = true;
  }

  list(): SkillDescriptor[] {
    return [...this.skills.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  listPublic(): PublicSkillDescriptor[] {
    return this.list().filter(isPublicSkill);
  }

  byId(id: string): SkillDescriptor | undefined {
    return this.skills.get(id);
  }

  byExtensionPoint(extensionPoint: PublicSkillExtensionPoint): PublicSkillDescriptor[] {
    return this.listPublic().filter((skill) => skill.extensionPoint === extensionPoint);
  }
}

export const skillRegistry = new SkillRegistry();
