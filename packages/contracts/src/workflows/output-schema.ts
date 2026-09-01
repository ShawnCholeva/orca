import { z } from "zod";

const PrimitiveType = z.enum(["string", "number", "boolean", "array", "object"]);
const ItemType = z.enum(["string", "number", "boolean", "object"]);
const DisplayAudience = z.enum(["user", "agent"]);

export type WorkflowStepOutputField = {
  key: string;
  type: z.infer<typeof PrimitiveType>;
  required: boolean;
  description?: string;
  enum?: string[];
  itemType?: z.infer<typeof ItemType>;
  fields?: WorkflowStepOutputField[];
  /** Who this field is for on the step-completion confirm card.
   *  `user` means user AND agent — it renders on the card face.
   *  `agent` means agent only *on the card*: it folds behind the card's
   *  disclosure. It does NOT filter the field out of `priorStepOutputs` —
   *  downstream steps receive every field either way (step-input.ts).
   *  Absent ⇒ `agent`, because agent visibility is the baseline; putting a
   *  field in front of the human is the deliberate act. */
  display?: z.infer<typeof DisplayAudience>;
};

export const WorkflowStepOutputField: z.ZodType<WorkflowStepOutputField> = z.lazy(() =>
  z.object({
    key: z.string().min(1).max(64),
    type: PrimitiveType,
    required: z.boolean(),
    description: z.string().max(256).optional(),
    enum: z.array(z.string().min(1).max(128)).min(1).max(32).optional(),
    itemType: ItemType.optional(),
    fields: z.array(WorkflowStepOutputField).max(32).optional(),
    display: DisplayAudience.optional(),
  }).strict().superRefine((field, ctx) => {
    if (field.enum && field.type !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "enum is only supported for string fields",
        path: ["enum"],
      });
    }
  })
);

export const WorkflowStepOutputSchema = z.array(WorkflowStepOutputField).min(1).max(32);
export type WorkflowStepOutputSchema = z.infer<typeof WorkflowStepOutputSchema>;

// `display` is confirm-card routing metadata, not an output requirement — strip
// it (recursively, though the catalog never annotates nested fields) before an
// output schema reaches an LLM prompt, so it can't be mistaken for something to
// satisfy or de-prioritize.
export function stripFieldDisplay(field: WorkflowStepOutputField): WorkflowStepOutputField {
  const { display: _display, ...rest } = field;
  return rest.fields ? { ...rest, fields: rest.fields.map(stripFieldDisplay) } : rest;
}

export type ValidateResult = { ok: true } | { ok: false; errors: string[] };

function typeOf(value: unknown): "string" | "number" | "boolean" | "array" | "object" | "other" {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "other";
}

// depth controls recursion: validateStepOutput starts at 1 so top-level fields may
// recurse one level into nested object fields (2 levels total); deeper structures are
// accepted as opaque.
function checkField(
  field: WorkflowStepOutputField,
  value: unknown,
  path: string,
  depth: number,
  errors: string[]
): void {
  const actual = typeOf(value);
  if (actual !== field.type) {
    errors.push(`${path}: expected ${field.type}, got ${actual}`);
    return;
  }
  if (field.type === "string" && field.enum && !field.enum.includes(value as string)) {
    errors.push(`${path}: expected one of ${field.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  if (field.type === "array" && field.itemType) {
    (value as unknown[]).forEach((el, i) => {
      const elPath = `${path}[${i}]`;
      const elActual = typeOf(el);
      if (field.itemType === "object") {
        if (elActual !== "object") errors.push(`${elPath}: expected object, got ${elActual}`);
        else if (field.fields && depth > 0) checkObject(field.fields, el as Record<string, unknown>, elPath, depth - 1, errors);
      } else if (elActual !== field.itemType) {
        errors.push(`${elPath}: expected ${field.itemType}, got ${elActual}`);
      }
    });
  }
  if (field.type === "object" && field.fields && depth > 0) {
    checkObject(field.fields, value as Record<string, unknown>, path, depth - 1, errors);
  }
}

function checkObject(
  fields: WorkflowStepOutputField[],
  obj: Record<string, unknown>,
  path: string,
  depth: number,
  errors: string[]
): void {
  for (const field of fields) {
    const present = Object.prototype.hasOwnProperty.call(obj, field.key);
    const fieldPath = path ? `${path}.${field.key}` : field.key;
    if (!present) {
      if (field.required) errors.push(`${fieldPath}: required key missing`);
      continue;
    }
    checkField(field, obj[field.key], fieldPath, depth, errors);
  }
}

export function validateStepOutput(
  schema: WorkflowStepOutputSchema,
  output: unknown
): ValidateResult {
  if (typeOf(output) !== "object") return { ok: false, errors: ["output: expected object"] };
  const errors: string[] = [];
  checkObject(schema, output as Record<string, unknown>, "", 1, errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
