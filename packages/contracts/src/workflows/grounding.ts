import { z } from "zod";

// Deterministic grounding checks: engine-owned verification of the checkable
// claims in a step's structured output (paths exist, references resolve,
// internal consistency), evaluated at the evidence gate. Declarative so
// template validation can cross-check selectors against the step's
// outputSchema and the learning loop can later propose them.
//
// Field selectors are dotted paths with `[]` for array traversal, depth <= 2
// (matching the completion validator's depth), e.g. "changes[].file".

const Selector = z.string().min(1).max(128);
const GroundingMode = z.enum(["enforce", "observe"]).default("enforce");
const LiteralValue = z.union([z.string().max(128), z.boolean()]);

export const GroundingCheck = z.discriminatedUnion("rule", [
  // Every string at `field` resolves to an existing path in the workspace.
  z.object({ rule: z.literal("paths_exist"), field: Selector, mode: GroundingMode }).strict(),
  // Every path at `field` appears in the workspace's git status/diff union OR
  // exists on disk — catches fabricated change lists, never proves a change.
  z.object({ rule: z.literal("paths_changed"), field: Selector, mode: GroundingMode }).strict(),
  // The value at `field` is one of the values at the `set` selector.
  z.object({ rule: z.literal("member_of"), field: Selector, set: Selector, mode: GroundingMode }).strict(),
  // When `when.field` equals `when.equals`, the `then` consequent must hold.
  z
    .object({
      rule: z.literal("implies"),
      when: z.object({ field: Selector, equals: LiteralValue }).strict(),
      then: z
        .object({
          field: Selector,
          nonEmpty: z.literal(true).optional(),
          equals: LiteralValue.optional(),
          excludes: z.array(z.string().max(128)).min(1).max(8).optional(),
        })
        .strict(),
      mode: GroundingMode,
    })
    .strict(),
  // Every value at `field` appears among the values collected from the named
  // prior steps' outputs.
  z
    .object({
      rule: z.literal("subset_of_prior"),
      field: Selector,
      prior: z.array(z.object({ stepId: Selector, field: Selector }).strict()).min(1).max(8),
      mode: GroundingMode,
    })
    .strict(),
]);
export type GroundingCheck = z.infer<typeof GroundingCheck>;
