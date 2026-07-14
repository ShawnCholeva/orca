import type { SkillDescriptor } from "../registry/types.js";
import { ValidationError } from "../goals.js";

export const quickGoalSkill: SkillDescriptor<
  { title: string; intent?: string },
  { title: string; intent: string }
> = {
  id: "quick-goal",
  pluginId: "orca.default-skills",
  extensionPoint: "goal.create",
  version: "0.1.0",
  category: "public",
  invocation: "http",
  title: "Quick Goal",
  description: "Deterministic normalization of Goal creation input. No AI.",

  invoke(input, _ctx) {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof (input as Record<string, unknown>).title !== "string"
    ) {
      throw new ValidationError([{ path: ["title"], message: "title must be a string" }]);
    }

    const raw = input as { title: string; intent?: string };
    const title = raw.title.trim();
    const intent = (raw.intent ?? "").trim();

    if (title.length < 1 || title.length > 200) {
      throw new ValidationError([
        { path: ["title"], message: "title must be 1..200 chars after trim" },
      ]);
    }

    if (intent.length < 1 || intent.length > 4000) {
      throw new ValidationError([
        { path: ["intent"], message: "intent must be 1..4000 chars after trim" },
      ]);
    }

    return { title, intent };
  },
};
