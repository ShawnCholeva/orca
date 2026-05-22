// Capture a semver-like or CalVer-like version from CLI `--version` output.
// Prefer a name-anchored match (`<product> <version>`) so unrelated numbers
// printed earlier (Node banner, build hash, path components) do not win.
//
// Supports: 1.2, 1.2.3, 2025.01.15, 1.2.3-beta.1, 1.2.3+build.5
const VERSION_TOKEN = String.raw`\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?`;

export function parseVersion(stdout: string, productName: string): string | undefined {
  const escaped = productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(
    String.raw`(?:^|\b)${escaped}[\s/]+v?(${VERSION_TOKEN})`,
    "i",
  ).exec(stdout);
  if (named) return named[1];

  // Fallback: last version-shaped token in stdout.
  const all = [...stdout.matchAll(new RegExp(String.raw`v?(${VERSION_TOKEN})`, "g"))];
  return all.length > 0 ? all[all.length - 1][1] : undefined;
}
