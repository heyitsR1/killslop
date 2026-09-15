/**
 * Generates the extension icons. No dependencies: writes PNGs directly.
 *
 * The mark is the same geometry as the inline SVG in the popup (viewBox
 * 0 0 24 24): a square with 6-unit corners, and on it a ring of radius 6
 * struck through by a diagonal, both stroked 2.4 wide with round ends. It is
 * drawn as geometry and sampled 5x5 per pixel, so the ring stays round at 16px.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [10, 10, 10]; // #0a0a0a
const FG = [255, 255, 255];
const SS = 5;

const CORNER = 6;
const RING = 6;
const HALF_STROKE = 1.2;
const SLASH = [7.76, 7.76, 16.24, 16.24];

function inSquare(x, y) {
  if (x < 0 || y < 0 || x > 24 || y > 24) return false;
  const cx = Math.min(Math.max(x, CORNER), 24 - CORNER);
  const cy = Math.min(Math.max(y, CORNER), 24 - CORNER);
  return (x - cx) ** 2 + (y - cy) ** 2 <= CORNER ** 2;
}

function inGlyph(x, y) {
  if (Math.abs(Math.hypot(x - 12, y - 12) - RING) <= HALF_STROKE) return true;
  const [ax, ay, bx, by] = SLASH;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= HALF_STROKE;
}

/** Colour and alpha of one pixel: how much of it the square and glyph cover. */
function pixel(px, py, scale, pad) {
  let square = 0;
  let glyph = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = (px - pad + (sx + 0.5) / SS) * scale;
      const y = (py - pad + (sy + 0.5) / SS) * scale;
      if (!inSquare(x, y)) continue;
      square++;
      if (inGlyph(x, y)) glyph++;
    }
  }
  if (!square) return [0, 0, 0, 0];
  const t = glyph / square;
  return [...BG.map((c, i) => Math.round(c + (FG[i] - c) * t)), Math.round((255 * square) / (SS * SS))];
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** `pad` is transparent margin in pixels on each side. */
function png(size, pad = 0) {
  const scale = 24 / (size - 2 * pad);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, scale, pad);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Chrome asks for 96px of artwork inside the 128px icon, 16px clear each side;
// the toolbar sizes use the whole square so the mark stays legible.
const PADDING = { 16: 0, 32: 0, 48: 0, 128: 16 };

mkdirSync(new URL('../extension/icons/', import.meta.url), { recursive: true });
for (const [size, pad] of Object.entries(PADDING)) {
  const out = new URL(`../extension/icons/icon${size}.png`, import.meta.url);
  writeFileSync(out, png(Number(size), pad));
  console.log('wrote', `icon${size}.png`);
}
