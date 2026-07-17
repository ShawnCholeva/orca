// Code-file extensions for write-set classification. Deliberately conservative;
// a file not matched here is treated as non-code output. Shared by scope.ts (2a)
// and metrics/composed-score.ts (2b) so both agree on what "code" means.
export const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".rb", ".c", ".h", ".cc", ".cpp", ".cs", ".php", ".swift", ".kt", ".scala", ".sh",
]);

export function isCodeFile(p: string): boolean {
  const dot = p.lastIndexOf(".");
  return dot >= 0 && CODE_EXTS.has(p.slice(dot).toLowerCase());
}
