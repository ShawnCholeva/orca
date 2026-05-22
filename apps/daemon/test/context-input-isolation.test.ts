/**
 * Tail isolation static check.
 *
 * Asserts that context assembly modules (input.ts, selection.ts, assembler.ts,
 * renderer.ts) do NOT import from session output-tail/transcript modules.
 * Fails fast if any future edit introduces such an import, enforcing the
 * session output-isolation rule at the code-organization level.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_DIR = path.resolve(__dirname, '../src/context');

// Files that must never import session output-tail or transcript modules.
// Files that do not exist yet (e.g., selection.ts, renderer.ts in later tasks)
// are skipped automatically.
const CHECKED_FILES = ['input.ts', 'selection.ts', 'assembler.ts', 'renderer.ts'];

// Patterns matching forbidden session output-tail / transcript imports.
// Only match actual import/require statements (not comments or plain text).
const BANNED_IMPORT_PATTERNS: RegExp[] = [
  /^import\b.*from\s+['"]\.\.\/sessions\/output-store/m,
  /^import\b.*from\s+['"]\.\.\/pty\//m,
  /^import\b.*from\s+['"]\S*output-tail/m,
  /^import\b.*from\s+['"]\S*output-store/m,
  /require\s*\(\s*['"][^'"]*output-store['"\s]*\)/,
  /require\s*\(\s*['"][^'"]*output-tail['"\s]*\)/,
  /^import\b.*from\s+['"]\.\.\/pty\/manager/m,
];

describe('context module tail-isolation', () => {
  for (const filename of CHECKED_FILES) {
    const filePath = path.join(CONTEXT_DIR, filename);

    it(`${filename} does not import session output-tail or transcript modules`, () => {
      if (!existsSync(filePath)) {
        // File not yet created by the current context work - pass.
        return;
      }

      const source = readFileSync(filePath, 'utf8');

      for (const pattern of BANNED_IMPORT_PATTERNS) {
        const match = source.match(pattern);
        expect(
          match,
          `${filename} contains a forbidden import matching ${pattern}: "${match?.[0]}"`
        ).toBeNull();
      }
    });
  }
});
