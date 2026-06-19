// Conversational lead-ins to strip from the front of a line ("Okay, so …").
const CONV_LEAD = /^(ok(ay)?|sure|great|alright|now|so|right|perfect)\b[\s,:.\-]*/i;
// Whole-line throat-clearing with no outcome ("I now have a complete picture",
// "Here's my analysis and plan", "Let me look", "I'll start", …). A line that
// opens this way is treated as preamble and skipped when picking the summary.
const META_LEAD =
  /^(i\s+now\s+have|here'?s\b|here\s+is\b|let\s+me\b|i'?ll\b|i\s+will\b|i'?ve\b|i\s+have\b|looking\s+at\b|based\s+on\b|to\s+(start|begin)\b|first[,\s])/i;

function clean(line: string): string {
  // Strip markdown bullet/heading markers and any conversational lead-in.
  let out = line.replace(/^[#>*\-\s]+/, "").trim();
  while (CONV_LEAD.test(out)) out = out.replace(CONV_LEAD, "").trim();
  return out;
}

/** A one-line turn summary that reflects the work, not the agent's preamble.
 *  Picks the first substantive line, skipping conversational and meta
 *  throat-clearing ("I now have a complete picture. Here's my plan."). Falls
 *  back to the first non-empty line when every line is preamble. */
export function deriveTurnSummary(responseText: string): string {
  const lines = responseText
    .split(/\r\n?|\n/)
    .map(clean)
    .filter((l) => l.length > 0);
  const substantive = lines.find((l) => !META_LEAD.test(l));
  return (substantive ?? lines[0] ?? "").slice(0, 280);
}
