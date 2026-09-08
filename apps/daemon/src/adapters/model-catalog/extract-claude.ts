import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EffortLevel } from "@orca/contracts";
import { extractObjectLiterals, jsLiteralToJson } from "./parse-records.js";
import type { CatalogModel } from "./types.js";

const execFileAsync = promisify(execFile);
const RECORD_MARKER = '{id:"claude-';
const STRINGS_MAX_BUFFER = 512 * 1024 * 1024;

interface RawRecord {
  id?: unknown;
  family?: unknown;
  display_name?: unknown;
  pricing?: unknown;
  advisor_rank?: unknown;
  default_effort?: unknown;
  capabilities?: unknown;
  context?: { window?: unknown; supports_1m_suffix?: unknown };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * The bundle's `default_effort` is an untyped string from a third-party binary.
 * A future CLI shipping a level Orca does not know would otherwise be cast
 * straight through to `--effort <bogus>`; drop it to null instead and let
 * settleEffort pick a level the model actually declares.
 */
function effortOrNull(raw: string | null): EffortLevel | null {
  return raw && EffortLevel.safeParse(raw).success ? (raw as EffortLevel) : null;
}

/**
 * Effort support is declared by capability flag, not by an explicit list:
 * "effort" unlocks low/medium/high, then xhigh and max are gated separately.
 */
function effortsFrom(capabilities: unknown): EffortLevel[] {
  if (!Array.isArray(capabilities)) return [];
  const caps = new Set(capabilities.filter((c): c is string => typeof c === "string"));
  if (!caps.has("effort")) return [];
  const out: EffortLevel[] = ["low", "medium", "high"];
  if (caps.has("xhigh_effort")) out.push("xhigh");
  if (caps.has("max_effort")) out.push("max");
  return out;
}

export function parseClaudeCatalog(blob: string): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const literal of extractObjectLiterals(blob, RECORD_MARKER)) {
    const raw = jsLiteralToJson(literal) as RawRecord | null;
    if (!raw) continue;
    const id = str(raw.id);
    const displayName = str(raw.display_name);
    // A record without both is a partial or a decoy, not a model.
    if (!id || id === "claude-" || !displayName || seen.has(id)) continue;
    seen.add(id);
    const effort = str(raw.default_effort);
    out.push({
      id,
      family: str(raw.family) ?? "",
      displayName,
      contextWindow: typeof raw.context?.window === "number" ? raw.context.window : 0,
      supports1mSuffix: raw.context?.supports_1m_suffix === true,
      pricingTier: str(raw.pricing),
      advisorRank: typeof raw.advisor_rank === "number" ? raw.advisor_rank : null,
      supportedEfforts: effortsFrom(raw.capabilities),
      defaultEffort: effortOrNull(effort),
    });
  }
  return out;
}

/**
 * Read the catalog out of an installed claude-code binary. Returns [] on any
 * failure — the caller (Task 5) falls back to cache then seed, so a changed
 * bundle degrades visibly rather than throwing on a boot path.
 *
 * Undeclared external dependency: `strings(1)`. It ships with macOS developer
 * tools and binutils on Linux, but nothing installs it for us — an absent
 * `strings` is one of the failures that degrades to the seed.
 *
 * Cost: the current claude-code binary yields ~46 MB of stdout against a 512 MB
 * maxBuffer, i.e. a transient spike of roughly 100 MB (the buffer plus the
 * string) while parsing. That is paid once per CLI version, since the result is
 * cached by `adapter_version`.
 */
export async function extractClaudeCatalog(binaryPath: string): Promise<CatalogModel[]> {
  try {
    const { stdout } = await execFileAsync("strings", ["-a", binaryPath], {
      maxBuffer: STRINGS_MAX_BUFFER,
    });
    return parseClaudeCatalog(stdout);
  } catch {
    return [];
  }
}
