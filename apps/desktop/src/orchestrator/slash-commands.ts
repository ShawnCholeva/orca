export interface SlashCommand {
  name: string;
  args: string;
  describe: string;
}

/** One entry today. Adding another is one object — no framework needed. */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "stuck",
    args: "[what's happening]",
    describe: "Tell Orca this step isn't going anywhere so it can restart the agent.",
  },
];

/** A known command and its argument text, or null if this is an ordinary message. */
export function parseSlashCommand(draft: string): { command: string; args: string } | null {
  const trimmed = draft.trim();
  if (!trimmed.startsWith("/")) return null;
  const [word, ...rest] = trimmed.slice(1).split(/\s+/);
  if (!word) return null;
  if (!SLASH_COMMANDS.some((c) => c.name === word)) return null;
  return { command: word, args: rest.join(" ").trim() };
}

/** Commands to offer for the current draft — only while the name is still being typed. */
export function matchSlashCommands(draft: string): SlashCommand[] {
  const trimmed = draft.trim();
  if (!trimmed.startsWith("/") || /\s/.test(trimmed)) return [];
  const prefix = trimmed.slice(1);
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}
