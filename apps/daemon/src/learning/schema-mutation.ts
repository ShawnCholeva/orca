import { WorkflowStepOutputSchema, type WorkflowStepOutputField } from "@orca/contracts";

// The ONE canonical serialization for schemas riding proposal before/after fields.
export function serializeSchema(s: WorkflowStepOutputSchema): string {
  return JSON.stringify(s, null, 2);
}

export function parseSchema(text: string): WorkflowStepOutputSchema | null {
  try {
    const parsed = WorkflowStepOutputSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// The whitelisted mutation operator for learned schema edits (spec §3.3).
// Tightening only: additions and strictenings. Anything that could break a
// downstream reader (splitter branchKey, gate context, delegate writes) or
// weaken the check is banned — enforced here, deterministically, never by prompt.
export function validateSchemaTightening(
  before: WorkflowStepOutputSchema, after: WorkflowStepOutputSchema,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  checkFields(before, after, "", errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function checkFields(before: readonly WorkflowStepOutputField[], after: readonly WorkflowStepOutputField[], path: string, errors: string[]): void {
  const afterByKey = new Map(after.map((f) => [f.key, f]));
  for (const b of before) {
    const at = path ? `${path}.${b.key}` : b.key;
    const a = afterByKey.get(b.key);
    if (!a) { errors.push(`field "${at}" was removed — removing or renaming fields is not allowed`); continue; }
    if (a.type !== b.type) errors.push(`field "${at}" changed type ${b.type}→${a.type} — type changes are not allowed`);
    if ((a.itemType ?? null) !== (b.itemType ?? null)) errors.push(`field "${at}" changed its item type — not allowed`);
    if (JSON.stringify(a.enum ?? null) !== JSON.stringify(b.enum ?? null)) errors.push(`field "${at}" changed its enum — altering allowed values is not allowed`);
    if (b.required && !a.required) errors.push(`field "${at}" became optional — weakening a check is not allowed`);
    const bDesc = b.description ?? "";
    const aDesc = a.description ?? "";
    if (bDesc && !aDesc.startsWith(bDesc)) errors.push(`field "${at}" shrank or replaced its description — only adding or extending is allowed`);
    if (b.fields || a.fields) checkFields(b.fields ?? [], a.fields ?? [], at, errors);
  }
  // New fields in `after` are always allowed; the contract schema bounds them.
}
