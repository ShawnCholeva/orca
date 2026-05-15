import { z } from "zod";

export const GoalStatus = z.enum(["active", "archived"]);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const Goal = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: GoalStatus,
  autonomyLevel: z.number().int().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable()
});
export type Goal = z.infer<typeof Goal>;

export const CreateGoalRequest = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default("")
});
export type CreateGoalRequest = z.infer<typeof CreateGoalRequest>;

export const CreateGoalResponse = z.object({
  goal: Goal
});
export type CreateGoalResponse = z.infer<typeof CreateGoalResponse>;

export const UpdateGoalRequest = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional()
  })
  .refine((data) => data.title !== undefined || data.description !== undefined, {
    message: "at least one of title or description must be provided"
  });
export type UpdateGoalRequest = z.infer<typeof UpdateGoalRequest>;

export const UpdateGoalResponse = z.object({
  goal: Goal
});
export type UpdateGoalResponse = z.infer<typeof UpdateGoalResponse>;

export const ArchiveGoalResponse = z.object({
  goal: Goal
});
export type ArchiveGoalResponse = z.infer<typeof ArchiveGoalResponse>;

export const ListGoalsResponse = z.object({
  goals: z.array(Goal)
});
export type ListGoalsResponse = z.infer<typeof ListGoalsResponse>;

export const HealthResponse = z.object({
  status: z.literal("ok"),
  version: z.string(),
  startedAt: z.string()
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const DomainEventType = z.enum([
  "goal.created",
  "goal.updated",
  "goal.archived"
]);
export type DomainEventType = z.infer<typeof DomainEventType>;

export const DomainEvent = z.object({
  seq: z.number().int(),
  id: z.string(),
  type: DomainEventType,
  goalId: z.string().nullable(),
  payload: z.record(z.unknown()),
  createdAt: z.string().datetime()
});
export type DomainEvent = z.infer<typeof DomainEvent>;
