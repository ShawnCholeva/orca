import { access, constants } from "node:fs/promises";
import path from "node:path";

export type ResolveBinaryResult =
  | { resolvedPath: string }
  | { error: "not_found"; tried: string[] };

/** Injectable resolve function — accepts candidates, returns a result. Used by adapters for testability. */
export type ResolveFn = (candidates: string[]) => Promise<ResolveBinaryResult>;

export interface ResolveBinaryOpts {
  /** Override the environment used for PATH lookup (defaults to process.env). */
  env?: Record<string, string>;
  /** Override the access check (defaults to fs.access with X_OK). */
  accessFn?: (filePath: string, mode: number) => Promise<void>;
}

/**
 * Resolve the first executable binary from a priority-ordered list of candidates.
 *
 * Absolute paths are checked directly via accessFn.
 * Bare names are walked against each directory in PATH.
 */
export async function resolveBinary(
  candidates: string[],
  opts: ResolveBinaryOpts = {}
): Promise<ResolveBinaryResult> {
  const env = opts.env ?? (process.env as Record<string, string>);
  const checkAccess = opts.accessFn ?? ((p: string, mode: number) => access(p, mode));
  const tried: string[] = [];
  const pathDirs = (env["PATH"] ?? "").split(path.delimiter).filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (path.isAbsolute(candidate)) {
      tried.push(candidate);
      try {
        await checkAccess(candidate, constants.X_OK);
        return { resolvedPath: candidate };
      } catch { /* intentionally empty */ }
    } else {
      for (const dir of pathDirs) {
        const full = path.join(dir, candidate);
        tried.push(full);
        try {
          await checkAccess(full, constants.X_OK);
          return { resolvedPath: full };
        } catch { /* intentionally empty */ }
      }
    }
  }

  return { error: "not_found", tried };
}
