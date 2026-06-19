/**
 * Pure transcript parser — no fs, no side-effects.
 * Extracts assistant text-block reasoning from a Claude Code JSONL transcript.
 *
 * Real shape confirmed from live transcripts:
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]},...}
 * Each JSONL line is one entry. text blocks are separate entries from tool_use blocks.
 */

const MIN_TEXT_LENGTH = 8;

export function extractReasoningSince(
  text: string,
  cursor: number,
): { notes: string[]; cursor: number } {
  const allTextBlocks: string[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      (entry as Record<string, unknown>)["type"] !== "assistant"
    ) {
      continue;
    }
    const message = (entry as Record<string, unknown>)["message"];
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>)["type"] === "text"
      ) {
        const raw = (block as Record<string, unknown>)["text"];
        if (typeof raw === "string") {
          const trimmedText = raw.trim();
          if (trimmedText.length >= MIN_TEXT_LENGTH) {
            allTextBlocks.push(trimmedText);
          }
        }
      }
    }
  }

  const notes = allTextBlocks.slice(cursor);
  return { notes, cursor: allTextBlocks.length };
}
