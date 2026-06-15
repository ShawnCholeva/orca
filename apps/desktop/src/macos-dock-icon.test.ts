// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression test for the macOS Dock icon size defect.
 *
 * macOS does not rescale third-party Dock icons by their visible body — it
 * scales by canvas size. Apple's Big Sur Dock icon grid expects the opaque
 * icon body to occupy ~824/1024 (80.5%) of the canvas, leaving a transparent
 * safe-area margin. Orca previously shipped full-bleed artwork (body filled
 * ~100% of the canvas), making the Dock icon render ~24% larger than
 * neighboring apps.
 *
 * The Dock renders icon.icns (declared in tauri.conf.json bundle.icon),
 * generated from icon-macos.png. This test asserts both the source PNG and
 * every PNG representation embedded in icon.icns include the safe-area margin.
 */

const ICONS_DIR = path.resolve(fileURLToPath(import.meta.url), '../../src-tauri/icons');

// Apple grid target is 824/1024 = 80.5% body fill. Allow 3% tolerance for
// anti-aliased edges / rounded-corner sampling.
const MAX_BODY_FILL = 0.835;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface DecodedPng {
  width: number;
  height: number;
  colorType: number;
  channels: number;
  data: Buffer; // unfiltered, 8-bit, row-major
}

/** Minimal decoder for 8-bit, non-interlaced PNGs (color types 0/2/4/6). */
function decodePng(buf: Buffer): DecodedPng {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let off = 8;
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0,
    interlace = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNG unsupported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : -1;
  if (channels < 0) throw new Error(`unsupported color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos++];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = rawByte;
          break;
        case 1:
          v = rawByte + a;
          break;
        case 2:
          v = rawByte + b;
          break;
        case 3:
          v = rawByte + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = rawByte + pr;
          break;
        }
        default:
          throw new Error(`unsupported filter ${filter}`);
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, colorType, channels, data: out };
}

/** Fraction of the canvas spanned by the opaque alpha bounding box (max of w/h). */
function bodyFill(img: DecodedPng): number {
  if (img.channels !== 4 && img.channels !== 2) return 1; // opaque artwork = full bleed
  const aOff = img.channels - 1;
  let minX = img.width,
    minY = img.height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const alpha = img.data[(y * img.width + x) * img.channels + aOff];
      if (alpha > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return 0;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  return Math.max(bw, bh) / Math.max(img.width, img.height);
}

/** Extract every embedded PNG stream from an .icns container. */
function extractIcnsPngs(buf: Buffer): Buffer[] {
  const iend = Buffer.from('IEND');
  const result: Buffer[] = [];
  let from = 0;
  for (;;) {
    const start = buf.indexOf(PNG_SIGNATURE, from);
    if (start < 0) break;
    const end = buf.indexOf(iend, start);
    if (end < 0) break;
    result.push(buf.subarray(start, end + 8)); // include IEND + CRC
    from = end + 8;
  }
  return result;
}

describe('macOS Dock icon safe-area margin', () => {
  it('icon-macos.png body fills no more than the Apple grid target', () => {
    const img = decodePng(fs.readFileSync(path.join(ICONS_DIR, 'icon-macos.png')));
    expect(bodyFill(img)).toBeLessThanOrEqual(MAX_BODY_FILL);
  });

  it('every PNG representation in icon.icns includes the safe-area margin', () => {
    const pngs = extractIcnsPngs(fs.readFileSync(path.join(ICONS_DIR, 'icon.icns')));
    expect(pngs.length).toBeGreaterThan(0);
    for (const png of pngs) {
      const img = decodePng(png);
      expect(bodyFill(img), `icns rep ${img.width}x${img.height}`).toBeLessThanOrEqual(MAX_BODY_FILL);
    }
  });
});
