// Regenerate the PWA icons (zero-dependency PNG encoder + a matching SVG).
// Flat house mark in DESIGN.md brand-teal-deep (#001e2b) + brand-green (#00ed64).
//
//   node scripts/gen-icons.mjs
//
// Writes public/icon.svg and public/icons/*.png. Committed so a normal build
// just copies them; only re-run when the mark changes.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = resolve(fileURLToPath(new URL(".", import.meta.url)), "../public");

const TEAL = [0x00, 0x1e, 0x2b];
const GREEN = [0x00, 0xed, 0x64];
const SUPERSAMPLE = 4;

// --- house hit-tests in a 0..1 normalized box --------------------------
function houseHit(nx, ny) {
  // roof: apex at (0.5, 0.18), widening to a base at y=0.49
  if (ny >= 0.18 && ny <= 0.49) {
    const t = (ny - 0.18) / 0.31;
    if (Math.abs(nx - 0.5) <= 0.34 * t) return true;
  }
  // body
  return nx >= 0.24 && nx <= 0.76 && ny >= 0.465 && ny <= 0.82;
}
const doorHit = (nx, ny) =>
  nx >= 0.435 && nx <= 0.565 && ny >= 0.6 && ny <= 0.821;

function samplePixel(px, py, n, maskable) {
  // rounded corners for the non-maskable icon; maskable is full-bleed
  if (!maskable) {
    const r = 0.2 * n;
    const cx = Math.min(px, n - px);
    const cy = Math.min(py, n - py);
    if (cx < r && cy < r) {
      const dx = r - cx;
      const dy = r - cy;
      if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
    }
  }
  let nx = px / n;
  let ny = py / n;
  if (maskable) {
    // keep the mark inside the maskable safe zone
    nx = 0.5 + (nx - 0.5) / 0.8;
    ny = 0.5 + (ny - 0.5) / 0.8;
  }
  if (houseHit(nx, ny) && !doorHit(nx, ny)) return [...GREEN, 255];
  return [...TEAL, 255];
}

function render(n, maskable) {
  const out = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const [pr, pg, pb, pa] = samplePixel(
            x + (sx + 0.5) / SUPERSAMPLE,
            y + (sy + 0.5) / SUPERSAMPLE,
            n,
            maskable,
          );
          r += pr * pa;
          g += pg * pa;
          b += pb * pa;
          a += pa;
        }
      }
      const i = (y * n + x) * 4;
      if (a === 0) continue; // already zero-filled -> transparent
      out[i] = Math.round(r / a);
      out[i + 1] = Math.round(g / a);
      out[i + 2] = Math.round(b / a);
      out[i + 3] = Math.round(a / (SUPERSAMPLE * SUPERSAMPLE));
    }
  }
  return out;
}

// --- tiny PNG encoder (RGBA, 8-bit, no interlace) --------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const t = Buffer.from(type, "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- write ---------------------------------------------------------
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="102" fill="#001e2b"/>
  <path d="M256 92 430 251 389 251 389 420 123 420 123 251 82 251Z" fill="#00ed64"/>
  <rect x="223" y="307" width="66" height="113" fill="#001e2b"/>
</svg>
`;

mkdirSync(`${PUBLIC}/icons`, { recursive: true });
writeFileSync(`${PUBLIC}/icon.svg`, SVG);
console.log("wrote public/icon.svg");

for (const [name, size, maskable] of [
  ["icons/icon-192.png", 192, false],
  ["icons/icon-512.png", 512, false],
  ["icons/icon-maskable-512.png", 512, true],
  ["icons/apple-touch-icon-180.png", 180, true],
]) {
  writeFileSync(`${PUBLIC}/${name}`, encodePng(size, size, render(size, maskable)));
  console.log(`wrote public/${name}`);
}
