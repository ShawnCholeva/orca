import type { BuiltInTemplateSummary } from "@orca/contracts";

export interface CatalogGroup {
  category: string;
  templates: BuiltInTemplateSummary[];
}

// Group templates by category, preserving the order each category is first seen.
export function groupCatalog(list: BuiltInTemplateSummary[]): CatalogGroup[] {
  const order: string[] = [];
  const byCategory: Record<string, BuiltInTemplateSummary[]> = {};
  for (const t of list) {
    if (!byCategory[t.category]) {
      byCategory[t.category] = [];
      order.push(t.category);
    }
    byCategory[t.category].push(t);
  }
  return order.map((category) => ({ category, templates: byCategory[category] }));
}
