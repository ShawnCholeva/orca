import {
  ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES,
  type SessionOutputSnapshot,
} from "@orca/contracts";

export function decodeSessionTail(
  snapshot: SessionOutputSnapshot,
  maxBytes: number = ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES
): string {
  const ordered = [...snapshot.chunks].sort((a, b) => a.seq - b.seq);
  const buf = Buffer.concat(ordered.map((c) => Buffer.from(c.dataBase64, "base64")));
  const sliced = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
  return sliced.toString("utf8");
}
