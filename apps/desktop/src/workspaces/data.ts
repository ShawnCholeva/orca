import type { GoalStatus } from "@orca/contracts";

export const GOAL_STATE_META: Record<GoalStatus, { label: string; tone: "run" | "warn" | "neutral" }> = {
  active: { label: "Active", tone: "run" },
  completed: { label: "Completed", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};

export const GOAL_STATE_ORDER: GoalStatus[] = ["active", "completed", "archived"];

export function slugify(value: string): string {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
