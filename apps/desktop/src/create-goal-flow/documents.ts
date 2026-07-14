// Shared helpers for reference-document inputs: a single text field accepts
// either a URL or a local file path; kind is auto-detected.

export function detectDocumentKind(ref: string): "file" | "url" {
  return /^https?:\/\//i.test(ref.trim()) ? "url" : "file";
}

export function defaultDocumentName(kind: "file" | "url", ref: string): string {
  const trimmed = ref.trim();
  if (kind === "file") {
    const base = trimmed.split("/").filter(Boolean).pop();
    return (base ?? trimmed).slice(0, 100);
  }
  try {
    const url = new URL(trimmed);
    const last = url.pathname.split("/").filter(Boolean).pop();
    return (last ?? url.host).slice(0, 100);
  } catch {
    return trimmed.slice(0, 100);
  }
}
