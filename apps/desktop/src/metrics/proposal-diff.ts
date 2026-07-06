// Presentation helpers for proposal review. Set-membership line diff — adequate for
// instruction texts; not a minimal edit script and doesn't need to be.
export type DiffLine = { kind: "kept" | "removed" | "added"; text: string };
export function diffLines(before: string, after: string): DiffLine[] {
  const b = before.split("\n"), a = after.split("\n");
  const aSet = new Set(a), bSet = new Set(b);
  const out: DiffLine[] = [];
  for (const line of b) out.push({ kind: aSet.has(line) ? "kept" : "removed", text: line });
  for (const line of a) if (!bSet.has(line)) out.push({ kind: "added", text: line });
  return out;
}

type Field = { key: string; type: string; required: boolean; itemType?: string };
const TYPE_LABEL: Record<string, string> = { string: "text", number: "number", boolean: "yes/no", array: "list", object: "group" };
function describeType(f: Field): string {
  if (f.type === "array") return `list of ${f.itemType ?? "string"}s`;
  return TYPE_LABEL[f.type] ?? f.type;
}
export type SchemaChip = { kind: "added" | "strictened"; label: string };
export function schemaChips(beforeJson: string, afterJson: string): SchemaChip[] {
  let before: Field[], after: Field[];
  try { before = JSON.parse(beforeJson); after = JSON.parse(afterJson); } catch { return []; }
  if (!Array.isArray(before) || !Array.isArray(after)) return [];
  const beforeByKey = new Map(before.map((f) => [f.key, f]));
  const chips: SchemaChip[] = [];
  for (const f of after) {
    const b = beforeByKey.get(f.key);
    if (!b) chips.push({ kind: "added", label: `+ ${f.key} (${describeType(f)}${f.required ? ", required" : ""})` });
    else if (!b.required && f.required) chips.push({ kind: "strictened", label: `${f.key}: now required` });
  }
  return chips;
}
