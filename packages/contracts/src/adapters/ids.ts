import { z } from "zod";

export const AdapterId = z.enum(["shell-manual", "claude-code", "opencode", "codex", "gemini-cli"]);
export type AdapterId = z.infer<typeof AdapterId>;
