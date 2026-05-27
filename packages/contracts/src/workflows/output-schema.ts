import { z } from "zod";

const PrimitiveType = z.enum(["string", "number", "boolean", "array", "object"]);
const ItemType = z.enum(["string", "number", "boolean", "object"]);

export type WorkflowStepOutputField = {
  key: string;
  type: z.infer<typeof PrimitiveType>;
  required: boolean;
  description?: string;
  itemType?: z.infer<typeof ItemType>;
  fields?: WorkflowStepOutputField[];
};

export const WorkflowStepOutputField: z.ZodType<WorkflowStepOutputField> = z.lazy(() =>
  z.object({
    key: z.string().min(1).max(64),
    type: PrimitiveType,
    required: z.boolean(),
    description: z.string().max(256).optional(),
    itemType: ItemType.optional(),
    fields: z.array(WorkflowStepOutputField).max(32).optional(),
  }).strict()
);

export const WorkflowStepOutputSchema = z.array(WorkflowStepOutputField).min(1).max(32);
export type WorkflowStepOutputSchema = z.infer<typeof WorkflowStepOutputSchema>;

export type ValidateResult = { ok: true } | { ok: false; errors: string[] };

function typeOf(value: unknown): "string" | "number" | "boolean" | "array" | "object" | "other" {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "other";
}

// depth: remaining nesting levels to validate (cap 2 total => start at 1 for nested call)
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
