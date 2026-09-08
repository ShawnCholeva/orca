/**
 * Walk from `start`, returning the balanced `{...}` slice or null if it never
 * closes. String literals are tracked so a brace inside a value cannot end the
 * object early — the reason this is a scanner and not a regex.
 */
function balancedSlice(src: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let quote = "";
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

export function extractObjectLiterals(haystack: string, startMarker: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(startMarker, from);
    if (at === -1) return out;
    const slice = balancedSlice(haystack, at);
    if (slice) { out.push(slice); from = at + slice.length; }
    else from = at + startMarker.length;
  }
}

/**
 * Convert a JS object literal to JSON, then parse it. Rewrites happen only
 * outside string literals: unquoted keys gain quotes, `!0`/`!1` become
 * booleans, and single-quoted strings are reopened as double-quoted ones.
 * Returns null when the result is not valid JSON — a literal using any other
 * JS syntax is skipped rather than guessed at.
 */
export function jsLiteralToJson(src: string): unknown {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === "\\") { out += ch + (src[++i] ?? ""); continue; }
      // A single-quoted literal is being reopened as a double-quoted one, so
      // the CLOSING quote must be rewritten too — emitting it verbatim left
      // `"value'` behind, which never parsed. A raw `"` inside such a literal
      // is escaped for the same reason.
      if (ch === quote) { out += '"'; inString = false; continue; }
      out += ch === '"' ? '\\"' : ch;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += '"'; continue; }
    if (ch === "!" && (src[i + 1] === "0" || src[i + 1] === "1")) {
      out += src[i + 1] === "0" ? "true" : "false";
      i++;
      continue;
    }
    // An identifier in key position: quote it. Anything else falls through.
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (src[j] === ":") { out += `"${word}"`; i = j - 1; continue; }
      out += word;
      i = j - 1;
      continue;
    }
    out += ch;
  }
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
