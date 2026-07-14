// Pure snapshot IO — no DB access, deliberately. Reading local files is
// execution-plane work: at Runner-Protocol extraction (FUTURE_ARCHITECTURE.md)
// snapshotFile moves runner-side (the control plane keeps metadata + hash only),
// while snapshotUrl may remain control-plane.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const SNAPSHOT_MAX_BYTES = 256 * 1024;
export const URL_FETCH_TIMEOUT_ATTACH_MS = 10_000;
export const URL_FETCH_TIMEOUT_REFRESH_MS = 5_000;

export type DocumentSnapshotErrorCode =
  | "invalid_ref"
  | "file_not_found"
  | "binary_file_unsupported"
  | "url_fetch_failed"
  | "url_fetch_timeout"
  | "unsupported_content_type";

export class DocumentSnapshotError extends Error {
  constructor(
    public readonly code: DocumentSnapshotErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentSnapshotError";
  }
}

export interface DocumentSnapshot {
  content: string;
  contentHash: string;
  contentBytes: number;
  truncated: boolean;
}

const BINARY_CONTENT_TYPES = /^(application\/pdf|image\/|audio\/|video\/|application\/octet-stream)/i;
const TEXTUAL_CONTENT_TYPES = /^(text\/|application\/json|application\/xml)|(\+json|\+xml)(;|$)/i;

function finalize(buf: Buffer): DocumentSnapshot {
  const truncated = buf.byteLength > SNAPSHOT_MAX_BYTES;
  const capped = truncated ? buf.subarray(0, SNAPSHOT_MAX_BYTES) : buf;
  const content = capped.toString("utf8");
  return {
    content,
    contentHash: createHash("sha256").update(capped).digest("hex"),
    contentBytes: Buffer.byteLength(content, "utf8"),
    truncated,
  };
}

export async function snapshotFile(ref: string): Promise<DocumentSnapshot> {
  if (!path.isAbsolute(ref)) {
    throw new DocumentSnapshotError("invalid_ref", `document path must be absolute: ${ref}`);
  }
  let buf: Buffer;
  try {
    buf = await readFile(path.resolve(ref));
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new DocumentSnapshotError(
      "file_not_found",
      `cannot read document at ${ref}${code ? ` (${code})` : ""}`,
    );
  }
  if (buf.subarray(0, 8 * 1024).includes(0)) {
    throw new DocumentSnapshotError("binary_file_unsupported", `document appears to be binary: ${ref}`);
  }
  return finalize(buf);
}

export async function snapshotUrl(ref: string, timeoutMs: number): Promise<DocumentSnapshot> {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    throw new DocumentSnapshotError("invalid_ref", `invalid URL: ${ref}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DocumentSnapshotError("invalid_ref", `only http(s) URLs are supported: ${ref}`);
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new DocumentSnapshotError("url_fetch_timeout", `timed out fetching ${ref}`);
    }
    throw new DocumentSnapshotError("url_fetch_failed", `failed to fetch ${ref}`);
  }
  if (!res.ok) {
    throw new DocumentSnapshotError("url_fetch_failed", `HTTP ${res.status} fetching ${ref}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (BINARY_CONTENT_TYPES.test(contentType) || (contentType !== "" && !TEXTUAL_CONTENT_TYPES.test(contentType))) {
    throw new DocumentSnapshotError(
      "unsupported_content_type",
      `unsupported content type "${contentType}" at ${ref}`,
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  const reader = res.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        total += value.byteLength;
        if (total > SNAPSHOT_MAX_BYTES) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new DocumentSnapshotError("url_fetch_timeout", `timed out reading ${ref}`);
      }
      throw new DocumentSnapshotError("url_fetch_failed", `failed reading body of ${ref}`);
    }
  }
  const snapshot = finalize(Buffer.concat(chunks));
  return truncated ? { ...snapshot, truncated: true } : snapshot;
}
