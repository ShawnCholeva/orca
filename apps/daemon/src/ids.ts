import { randomFillSync } from 'node:crypto';

let lastMs = -1;
let seq = 0; // 12-bit monotonic counter, resets each millisecond

/**
 * RFC 9562 UUIDv7: time-sortable. A per-process monotonic counter in the
 * `rand_a` field guarantees that IDs minted in the same millisecond still
 * sort in creation order — so `ORDER BY id` reflects "what happened first".
 * `nowMs` is injectable for deterministic tests.
 */
export function uuidv7(nowMs = Date.now()): string {
  if (nowMs > lastMs) {
    lastMs = nowMs;
    seq = 0;
  } else {
    // same millisecond, or the clock moved backwards: pin to lastMs and bump
    // the counter so IDs stay strictly monotonic within this process.
    nowMs = lastMs;
    seq = (seq + 1) & 0xfff;
    if (seq === 0) nowMs = ++lastMs; // >4096 IDs in 1ms: borrow the next ms
  }

  const b = new Uint8Array(16);
  b[0] = (nowMs / 2 ** 40) & 0xff; // 48-bit big-endian timestamp
  b[1] = (nowMs / 2 ** 32) & 0xff;
  b[2] = (nowMs / 2 ** 24) & 0xff;
  b[3] = (nowMs / 2 ** 16) & 0xff;
  b[4] = (nowMs / 2 ** 8) & 0xff;
  b[5] = nowMs & 0xff;
  b[6] = 0x70 | ((seq >> 8) & 0x0f); // version 7 + high 4 bits of seq
  b[7] = seq & 0xff; // low 8 bits of seq
  randomFillSync(b.subarray(8)); // 62 bits of randomness
  b[8] = (b[8] & 0x3f) | 0x80; // variant

  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h.slice(10).join('')}`;
}
