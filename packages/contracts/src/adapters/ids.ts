import { z } from "zod";

export const AdapterId = z.enum(["claude-code", "codex"]);
export type AdapterId = z.infer<typeof AdapterId>;
