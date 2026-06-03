import type { WorkflowStepOutputField, WorkflowStepOutputSchema } from "@orca/contracts";

const pad = (depth: number) => "  ".repeat(depth);

function renderField(f: WorkflowStepOutputField, depth: number): string {
  const opt = f.required ? "" : "?";
  if (f.type === "object" && f.fields) {
    return `${pad(depth)}${f.key}${opt} {\n${renderFields(f.fields, depth + 1)}\n${pad(depth)}}`;
  }
  if (f.type === "array" && f.itemType === "object" && f.fields) {
    return `${pad(depth)}${f.key}${opt}[] {\n${renderFields(f.fields, depth + 1)}\n${pad(depth)}}`;
  }
  let typ = "";
  if (f.type === "array") {
    typ = f.itemType ? `: ${f.itemType}[]` : "[]";
  } else if (f.type !== "string") {
    typ = `: ${f.type}`;
  }
  const desc = f.description ? `  # ${f.description}` : "";
  return `${pad(depth)}${f.key}${opt}${typ}${desc}`;
}

function renderFields(fields: WorkflowStepOutputField[], depth: number): string {
  return fields.map((f) => renderField(f, depth)).join(",\n");
}

export function serializeOutputSchema(schema: WorkflowStepOutputSchema): string {
  return renderFields(schema, 0);
}
