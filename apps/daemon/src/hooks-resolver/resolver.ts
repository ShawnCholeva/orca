import { readDiscoveryFile } from "../discovery/discovery-file.js";
import { enqueueSpool } from "../discovery/spool.js";

export interface ResolverResult {
  exitCode: number;
  stdout: string;
}

const DENY = '{"decision":"deny","reason":"orca daemon unreachable"}';

export async function resolveAndDeliver(args: {
  dataDir: string;
  relUrl: string;
  body: string;
  spoolable: boolean;
  now: () => string;
  fetchImpl?: typeof fetch;
}): Promise<ResolverResult> {
  const fetchFn = args.fetchImpl ?? fetch;
  const fallback = (): ResolverResult => {
    if (args.spoolable) {
      enqueueSpool(args.dataDir, { relUrl: args.relUrl, body: args.body }, args.now);
      return { exitCode: 0, stdout: "" };
    }
    return { exitCode: 0, stdout: DENY };
  };

  const disc = readDiscoveryFile(args.dataDir);
  if (!disc) return fallback();

  try {
    const res = await fetchFn(`${disc.url}${args.relUrl}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${disc.token}`, "content-type": "application/json" },
      body: args.body,
    });
    if (res.status < 200 || res.status >= 300) return fallback();
    return { exitCode: 0, stdout: await res.text() };
  } catch {
    return fallback();
  }
}
