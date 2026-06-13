import {
  ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES,
  type SessionOutputSnapshot,
} from "@orca/contracts";

function decodeChunks(
  chunks: SessionOutputSnapshot["chunks"],
  maxBytes: number
): string {
  const ordered = [...chunks].sort((left, right) => left.seq - right.seq);
  const buffer = Buffer.concat(
    ordered.map((chunk) => Buffer.from(chunk.dataBase64, "base64"))
  );
  const bounded =
    buffer.length > maxBytes ? buffer.subarray(buffer.length - maxBytes) : buffer;
  return bounded.toString("utf8");
}

export function decodeSessionTail(
  snapshot: SessionOutputSnapshot,
  maxBytes: number = ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES
): string {
  return decodeChunks(snapshot.chunks, maxBytes);
}

export function decodeSessionTailFromSeq(
  snapshot: SessionOutputSnapshot,
  firstSeq: number,
  maxBytes: number = ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES
): string {
  return decodeChunks(
    snapshot.chunks.filter((chunk) => chunk.seq >= firstSeq),
    maxBytes
  );
}
