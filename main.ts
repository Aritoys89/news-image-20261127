// THE DAILY COMPASS — a one-page world news front page for Friday 27 November 2026,
// drawn entirely in code: my own rasteriser, my own stroke typeface, my own PNG encoder.
// Node standard library only. Deterministic: same bytes on every run.
//
// Run:  MAKEFUN_OUTPUT_DIR=out node main.ts     (writes out/entry.png)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* ================= PNG encoder (mine) ================= */

// CRC-32 (IEEE) table, built from the polynomial at startup.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// rgb: Uint8Array of w*h*3. Returns a Buffer holding a complete PNG file.
function encodePng(rgb, w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // filter: none
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), row + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ================= Canvas / rasteriser (mine) ================= */

const SS = 2; // supersample factor: draw at 2x, box-downsample for smooth edges

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.W = w * SS;
    this.H = h * SS;
    this.px = new Uint8Array(this.W * this.H * 3);
  }
  fillAll([r, g, b]) {
    for (let i = 0; i < this.px.length; i += 3) {
      this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b;
    }
  }
  set(x, y, [r, g, b]) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = (y * this.W + x) * 3;
    this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b;
  }
  // filled disc in output coordinates
  disc(cx, cy, rad, col) {
    cx *= SS; cy *= SS; rad *= SS;
    const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(this.W - 1, Math.ceil(cx + rad));
    const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(this.H - 1, Math.ceil(cy + rad));
    const r2 = rad * rad;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) this.set(x, y, col);
      }
    }
  }
  rect(x, y, w, h, col) {
    const X = Math.round(x * SS), Y = Math.round(y * SS);
    const X2 = Math.round((x + w) * SS), Y2 = Math.round((y + h) * SS);
    for (let yy = Math.max(0, Y); yy < Math.min(this.H, Y2); yy++)
      for (let xx = Math.max(0, X); xx < Math.min(this.W, X2); xx++) this.set(xx, yy, col);
  }
  // thick segment: discs stamped along the line
  seg(x0, y0, x1, y1, wdt, col) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(len / Math.max(0.35, wdt * 0.3)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.disc(x0 + dx * t, y0 + dy * t, wdt / 2, col);
    }
  }
  poly(points, wdt, col, close = false) {
    const n = close ? points.length : points.length - 1;
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      this.seg(a[0], a[1], b[0], b[1], wdt, col);
    }
  }
  // filled polygon, scanline even-odd
  fillPoly(points, col) {
    const pts = points.map(([x, y]) => [x * SS, y * SS]);
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of pts) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(this.H - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5;
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
          xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.floor(xs[k])), xb = Math.min(this.W - 1, Math.ceil(xs[k + 1]));
        for (let x = xa; x <= xb; x++) this.set(x, y, col);
      }
    }
  }
  // filled circle via disc; ring via two discs is wasteful — draw ring by stamping
  ring(cx, cy, rad, wdt, col) {
    const steps = Math.max(24, Math.ceil(rad * 8));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      this.disc(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, wdt / 2, col);
    }
  }
  // quadratic bezier, sampled
  quad(x0, y0, cx, cy, x1, y1, wdt, col) {
    let px = x0, py = y0;
    const N = 14;
    for (let i = 1; i <= N; i++) {
      const t = i / N, u = 1 - t;
      const x = u * u * x0 + 2 * u * t * cx + t * t * x1;
      const y = u * u * y0 + 2 * u * t * cy + t * t * y1;
      this.seg(px, py, x, y, wdt, col);
      px = x; py = y;
    }
  }
  // 2x box downsample to the final RGB buffer
  finish() {
    const out = new Uint8Array(this.w * this.h * 3);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < SS; dy++) {
          for (let dx = 0; dx < SS; dx++) {
            const i = ((y * SS + dy) * this.W + (x * SS + dx)) * 3;
            r += this.px[i]; g += this.px[i + 1]; b += this.px[i + 2];
          }
        }
        const o = (y * this.w + x) * 3, n = SS * SS;
        out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
      }
    }
    return out;
  }
}

/* ================= Stroke typeface (mine) =================
   Glyphs live on a unit grid: x grows right, y grows UP from the baseline.
   Cap height 14, x-height 10, descenders reach -4.
   Path mini-language (mine): M x,y = new stroke, L x,y = line, Q cx,cy x,y = curve.
   Each entry: [advanceUnits, "path"]                                        */

const FONT = {
  ' ': [6, ''],
  'A': [11, 'M0,0L5,14L10,0M2.1,4.7L7.9,4.7'],
  'B': [11, 'M1,0L1,14M1,14L5.5,14Q9.5,14 9.5,10.5Q9.5,7 5.5,7L1,7M1,7L6,7Q10,7 10,3.5Q10,0 6,0L1,0'],
  'C': [11, 'M9.5,11.5Q8,14 5,14Q1,14 1,7Q1,0 5,0Q8,0 9.5,2.5'],
  'D': [11, 'M1,0L1,14M1,14L5,14Q10,14 10,7Q10,0 5,0L1,0'],
  'E': [10, 'M9,14L1,14L1,0L9,0M1,7L7,7'],
  'F': [10, 'M9,14L1,14L1,0M1,7.2L7,7.2'],
  'G': [11, 'M9.5,11.5Q8,14 5,14Q1,14 1,7Q1,0 5,0Q9,0 9.5,3L9.5,6.5L5.5,6.5'],
  'H': [11, 'M1,0L1,14M9,0L9,14M1,7L9,7'],
  'I': [5.5, 'M2.5,0L2.5,14M0.3,14L4.7,14M0.3,0L4.7,0'],
  'J': [10, 'M4,14L10,14M7,14L7,4Q7,0 3.5,0Q0.5,0 0.5,3.5'],
  'K': [11, 'M1,0L1,14M9.5,14L1.6,6.4M3.2,8.2L9.5,0'],
  'L': [10, 'M1,14L1,0L9,0'],
  'M': [13, 'M0.5,0L0.5,14L6.5,5L12.5,14L12.5,0'],
  'N': [11, 'M1,0L1,14L9,0L9,14'],
  'O': [12, 'M6,14Q11.5,14 11.5,7Q11.5,0 6,0Q0.5,0 0.5,7Q0.5,14 6,14'],
  'P': [11, 'M1,0L1,14M1,14L6,14Q10,14 10,10.5Q10,7 6,7L1,7'],
  'Q': [12, 'M6,14Q11.5,14 11.5,7Q11.5,0 6,0Q0.5,0 0.5,7Q0.5,14 6,14M7,3L12,-2'],
  'R': [11, 'M1,0L1,14M1,14L6,14Q10,14 10,10.5Q10,7 6,7L1,7M6.5,7L10,0'],
  'S': [10, 'M9.2,11.8Q7.5,14.2 4.8,14Q1.2,13.8 1.4,10.4Q1.6,7.8 5,7Q8.8,6.2 8.8,3.4Q8.8,0.2 5,0Q2,0 0.8,2.2'],
  'T': [11, 'M0.5,14L10.5,14M5.5,14L5.5,0'],
  'U': [11, 'M1,14L1,4.5Q1,0 5.5,0Q10,0 10,4.5L10,14'],
  'V': [11, 'M0.5,14L5.5,0L10.5,14'],
  'W': [13.5, 'M0,14L2.8,0L6,11L9.2,0L12,14'],
  'X': [11, 'M1,14L10,0M1,0L10,14'],
  'Y': [11, 'M0.5,14L5.5,7L10.5,14M5.5,7L5.5,0'],
  'Z': [10, 'M1,14L9.5,14L1,0L9.5,0'],
  'a': [10, 'M9,10L9,0M9,6.5Q8,10 5,10Q1.2,10 1.2,5Q1.2,0 5,0Q8,0 9,3'],
  'b': [10, 'M1,14L1,0M1,3Q1,0 5,0Q9,0 9,5Q9,10 5,10Q1,10 1,7'],
  'c': [9, 'M8.5,7.5Q7.5,10 4.8,10Q1.2,10 1.2,5Q1.2,0 4.8,0Q7.5,0 8.5,2.5'],
  'd': [10, 'M9,14L9,0M9,3Q9,0 5,0Q1,0 1,5Q1,10 5,10Q9,10 9,7'],
  'e': [9.5, 'M1.2,5.5L8.8,5.5M8.8,5.5Q8.8,10 5,10Q1.2,10 1.2,5Q1.2,0 5,0Q7.8,0 8.8,2.2'],
  'f': [6.5, 'M7,13.5Q6,14.5 4.8,14Q3.2,13.5 3.2,10L3.2,0M0.8,9.8L6.5,9.8'],
  'g': [10, 'M9,10L9,3.5Q9,-3.5 5,-3.8Q1.8,-3.8 1.2,-1M9,7Q9,10 5,10Q1,10 1,5Q1,0 5,0Q9,0 9,3'],
  'h': [10, 'M1,14L1,0M1,6.5Q1,10 5,10Q9,10 9,6L9,0'],
  'i': [4.5, 'M2,10L2,0M2,13L2,13.01'],
  'j': [5, 'M3.4,10L3.4,1.8Q3.4,-3.4 1.2,-3.4Q0,-3.4 0.2,-1M3.4,13L3.4,13.01'],
  'k': [9.5, 'M1,14L1,0M8.8,10L1.6,4.6M3.4,6.2L9,0'],
  'l': [4.5, 'M2,14L2,0'],
  'm': [15, 'M1,10L1,0M1,6.8Q1,10 4.2,10Q7.4,10 7.4,6L7.4,0M7.4,6.8Q7.4,10 10.6,10Q13.8,10 13.8,6L13.8,0'],
  'n': [10, 'M1,10L1,0M1,6.8Q1,10 5,10Q9,10 9,6L9,0'],
  'o': [10, 'M5,10Q9.2,10 9.2,5Q9.2,0 5,0Q0.8,0 0.8,5Q0.8,10 5,10'],
  'p': [10, 'M1,10L1,-4M1,3Q1,0 5,0Q9,0 9,5Q9,10 5,10Q1,10 1,7'],
  'q': [10, 'M9,10L9,-4M9,3Q9,0 5,0Q1,0 1,5Q1,10 5,10Q9,10 9,7'],
  'r': [6.5, 'M1,10L1,0M1,6Q1,10 4.5,10Q6.5,10 6.8,8.5'],
  's': [8.5, 'M8,8.3Q6.8,10.2 4.2,10Q1,9.8 1.2,7.4Q1.4,5.4 4.4,4.8Q7.6,4.2 7.6,2.2Q7.6,0.1 4.2,0Q1.6,0 0.6,1.6'],
  't': [6.5, 'M3.2,13.8L3.2,2.8Q3.2,0.2 6,0.4M0.6,9.8L6.8,9.8'],
  'u': [10, 'M1,10L1,3.5Q1,0 5,0Q9,0 9,3.5M9,10L9,0'],
  'v': [10, 'M0.5,10L5,0L9.5,10'],
  'w': [13, 'M0,10L2.6,0L6,8L9.4,0L12,10'],
  'x': [9.5, 'M1,10L8.5,0M1,0L8.5,10'],
  'y': [10, 'M0.5,10L4.8,2M9.5,10L5.6,1.2Q3.5,-3.9 0.6,-3.5'],
  'z': [9, 'M1,10L8.5,10L1,0L8.5,0'],
  '0': [10.5, 'M5.2,14Q9.5,14 9.5,7Q9.5,0 5.2,0Q1,0 1,7Q1,14 5.2,14'],
  '1': [9, 'M1.5,10.5L5,14L5,0M2,0L8,0'],
  '2': [10, 'M1.2,11Q1.2,14 5,14Q8.8,14 8.8,10.5Q8.8,7 4,3.5L1,0L9.5,0'],
  '3': [10, 'M1.5,11.5Q3,14 5.5,14Q9,14 9,10.8Q9,8 5.5,7.4M5.5,7.4Q9.5,6.8 9.5,3.4Q9.5,0 5.5,0Q2.8,0 1.2,2.5'],
  '4': [10.5, 'M7,0L7,14M7,14L1,4.8L10.2,4.8'],
  '5': [10, 'M8.8,14L2.2,14L1.6,8.2Q3.5,9.8 6,9.6Q9.6,9.2 9.6,4.8Q9.6,0.4 5.4,0Q2.4,0 1,2.4'],
  '6': [10, 'M8.6,11.8Q6.5,14.2 4,13.4Q1.2,12.4 1.2,7Q1.2,2 3,0.6Q4.2,0 5.4,0Q9.4,0 9.4,4.6Q9.4,8.8 5.6,8.8Q2.6,8.8 1.4,6.2'],
  '7': [10, 'M1,14L9.5,14L4,0'],
  '8': [10, 'M5,7.2Q1.6,7.6 1.6,10.6Q1.6,14 5,14Q8.4,14 8.4,10.6Q8.4,7.6 5,7.2M5,7.2Q1.2,6.8 1.2,3.6Q1.2,0 5,0Q8.8,0 8.8,3.6Q8.8,6.8 5,7.2'],
  '9': [10, 'M1.4,2.2Q3.5,-0.2 6,0.6Q8.8,1.6 8.8,7Q8.8,12 7,13.4Q5.8,14 4.6,14Q0.6,14 0.6,9.4Q0.6,5.2 4.4,5.2Q7.4,5.2 8.6,7.8'],
  '.': [4, 'M1.8,0.9L1.8,0.91'],
  ',': [4, 'M2.2,1.2Q2.2,-1.8 0.8,-3'],
  "'": [3.5, 'M1.6,14L1.6,11'],
  '’': [3.5, 'M1.6,14L1.6,11'],
  '"': [6, 'M1.2,14L1.2,11M4.2,14L4.2,11'],
  '-': [7, 'M1,5L6,5'],
  '–': [10, 'M0.5,5L9.5,5'],
  '—': [12, 'M0.5,5L11.5,5'],
  ':': [4, 'M1.8,8L1.8,8.01M1.8,0.9L1.8,0.91'],
  ';': [4, 'M1.8,8L1.8,8.01M2.2,1.2Q2.2,-1.8 0.8,-3'],
  '!': [4.5, 'M2,14L2,4M2,0.9L2,0.91'],
  '?': [9.5, 'M1.2,11Q2,14.2 5.2,14Q8.8,14 8.8,10.2Q8.8,7 5.4,6Q3.8,5.4 3.8,3L3.8,2.4M3.8,0L3.8,0.01'],
  '(': [6, 'M5.5,13Q2,9.5 2,5Q2,0.5 5.5,-3'],
  ')': [6, 'M1.5,13Q5,9.5 5,5Q5,0.5 1.5,-3'],
  '/': [6, 'M0.5,-1L5.5,15'],
  '%': [13, 'M3,13.2Q5.2,13.2 5.2,11Q5.2,8.8 3,8.8Q0.8,8.8 0.8,11Q0.8,13.2 3,13.2M11.5,14.5L1.5,-0.5M10,5.2Q12.2,5.2 12.2,3Q12.2,0.8 10,0.8Q7.8,0.8 7.8,3Q7.8,5.2 10,5.2'],
  '$': [10, 'M9.2,11.8Q7.5,14.2 4.8,14Q1.2,13.8 1.4,10.4Q1.6,7.8 5,7Q8.8,6.2 8.8,3.4Q8.8,0.2 5,0Q2,0 0.8,2.2M5,-1.5L5,15.5'],
  '&': [11, 'M9.8,3.5Q7.5,0.4 5,0Q2.2,-0.4 1.8,1.6Q1.5,4.2 4.5,6.4Q7,8.2 7.6,10Q8.4,12.8 6,13.8Q3.8,14.6 2.5,12.6Q1,9.8 3.5,7'],
  '+': [9, 'M4.5,11L4.5,3M1,7L8,7'],
  '=': [9, 'M1,9.5L8,9.5M1,4.5L8,4.5'],
  '°': [6, 'M3,13.5Q5,13.5 5,11.5Q5,9.5 3,9.5Q1,9.5 1,11.5Q1,13.5 3,13.5'],
  '•': [5, 'M2.2,5L2.2,5.01'],
  '·': [4, 'M1.8,4L1.8,4.01'],
  '…': [11, 'M1.5,0.9L1.5,0.91M5.5,0.9L5.5,0.91M9.5,0.9L9.5,0.91'],
  '_': [8, 'M0.5,-2.5L7.5,-2.5'],
  '#': [10, 'M3.5,14.5L2.5,-1M7.5,14.5L6.5,-1M0.8,9L9.2,9M0.5,4L8.9,4'],
  '*': [8, 'M4,11L4,3M1.2,9.5L6.8,4.5M6.8,9.5L1.2,4.5'],
  '|': [4, 'M2,14.5L2,-1'],
};

// Parse one glyph path into strokes of ops {k:'M'|'L',x,y} / {k:'Q',cx,cy,x,y}.
// In my data a Q is written "Q cx,cy x,y": control pair first, then the end pair.
function parseGlyph(pathStr) {
  const strokes = [];
  if (!pathStr) return strokes;
  const re = /([MLQ])(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g;
  let m, cur = null;
  while ((m = re.exec(pathStr)) !== null) {
    const cmd = m[1], x = parseFloat(m[2]), y = parseFloat(m[3]);
    if (cmd === 'M') { cur = [{ k: 'M', x, y }]; strokes.push(cur); }
    else if (cmd === 'L') cur.push({ k: 'L', x, y });
    else if (cmd === 'Q') {
      const m2 = /\s*(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/y;
      m2.lastIndex = re.lastIndex;
      const mm = m2.exec(pathStr);
      re.lastIndex = m2.lastIndex;
      cur.push({ k: 'Q', cx: x, cy: y, x: parseFloat(mm[1]), y: parseFloat(mm[2]) });
    }
  }
  return strokes;
}

const GLYPHS = {};
for (const ch of Object.keys(FONT)) GLYPHS[ch] = { adv: FONT[ch][0], strokes: parseGlyph(FONT[ch][1]) };

function glyphOf(ch) {
  return GLYPHS[ch] || GLYPHS[ch.toUpperCase()] || { adv: 6, strokes: [] };
}

// width of a string at cap-height `size` px (unit = size/14)
function textWidth(str, size, tracking = 0) {
  const u = size / 14;
  let w = 0;
  for (const ch of str) w += glyphOf(ch).adv * u + tracking;
  return w - (str.length ? tracking : 0);
}

// Draw text. (x, baseY) = pen start at baseline, output px. align: 'left'|'center'|'right'.
// weight: stroke width in font units (1 = normal, ~1.7 = bold).
function drawText(cv, str, x, baseY, size, col, weight = 1.05, align = 'left', tracking = 0) {
  const u = size / 14;
  const w = textWidth(str, size, tracking);
  let penX = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const wdt = Math.max(0.7, weight * u * 1.55);
  for (const ch of str) {
    const g = glyphOf(ch);
    for (const stroke of g.strokes) {
      let px = 0, py = 0, started = false;
      for (const op of stroke) {
        const X = penX + op.x * u, Y = baseY - op.y * u;
        if (op.k === 'M') { px = X; py = Y; started = true; }
        else if (op.k === 'L') { cv.seg(px, py, X, Y, wdt, col); px = X; py = Y; }
        else if (op.k === 'Q') {
          cv.quad(px, py, penX + op.cx * u, baseY - op.cy * u, X, Y, wdt, col);
          px = X; py = Y;
        }
      }
      if (!started) { /* empty */ }
    }
    penX += g.adv * u + tracking;
  }
  return w;
}

// Greedy word wrap. Returns array of lines that fit maxW at the given size.
function wrapText(str, size, maxW, tracking = 0) {
  const words = str.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const trial = line ? line + ' ' + word : word;
    if (textWidth(trial, size, tracking) <= maxW || !line) line = trial;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

// Draw wrapped body copy; returns the y just below the last line.
function drawBody(cv, str, x, topY, size, col, maxW, lineGap = 1.5, weight = 0.95) {
  const lines = wrapText(str, size, maxW);
  let base = topY + size;
  for (const ln of lines) {
    drawText(cv, ln, x, base, size, col, weight);
    base += size * lineGap;
  }
  return base - size * lineGap + size * 0.35;
}

// Headline with automatic shrink-to-fit. lines: array of strings.
// Returns y below the block.
function drawHeadline(cv, lines, x, topY, size, col, maxW, weight = 1.8, lineGap = 1.16, align = 'left') {
  let s = size;
  while (s > 8 && lines.some((ln) => textWidth(ln, s) > maxW)) s -= 1;
  let base = topY + s;
  for (const ln of lines) {
    drawText(cv, ln, align === 'center' ? x + maxW / 2 : x, base, s, col, weight, align);
    base += s * lineGap;
  }
  return base - s * lineGap + s * 0.3;
}

/* ================= Palette ================= */
const PAPER = [246, 241, 227];
const INK = [26, 23, 18];
const SOFT = [107, 100, 85];
const RED = [163, 31, 31];
const BLUE = [31, 58, 95];
const TEAL = [30, 111, 106];
const PANEL = [233, 226, 207];
const SKY = [203, 216, 226];
const SEA = [120, 156, 178];
const GOLD = [222, 158, 24];
const WHITE = [250, 248, 240];

/* ================= Scene sketches (mine) ================= */

// Quadcopter drone over a radar dish, with an impact burst — lead-story art.
function drawDroneScene(cv, x, y, w, h) {
  cv.rect(x, y, w, h, SKY);
  cv.rect(x, y, w, 2, INK); cv.rect(x, y + h - 2, w, 2, INK);
  cv.rect(x, y, 2, h, INK); cv.rect(x + w - 2, y, 2, h, INK);
  const gy = y + h - 18; // ground line
  cv.rect(x + 2, gy, w - 4, y + h - 2 - gy, PANEL);
  cv.seg(x + 2, gy, x + w - 2, gy, 2, INK);
  // station building, right
  const bx0 = x + w - 104;
  cv.rect(bx0, gy - 20, 60, 20, WHITE);
  cv.rect(bx0, gy - 20, 60, 2.4, INK); cv.rect(bx0, gy - 20, 2.4, 20, INK); cv.rect(bx0 + 57.6, gy - 20, 2.4, 20, INK);
  cv.rect(bx0 + 24, gy - 12, 10, 12, INK); // door
  cv.rect(bx0 + 8, gy - 15, 9, 7, SEA); cv.rect(bx0 + 42, gy - 15, 9, 7, SEA); // windows
  // radar dish on a mast, left-centre
  const mx = x + 72;
  cv.seg(mx, gy, mx, gy - 32, 5, INK);
  cv.seg(mx - 12, gy, mx, gy - 20, 3, INK);
  cv.seg(mx + 12, gy, mx, gy - 20, 3, INK);
  cv.quad(mx - 36, gy - 60, mx, gy - 28, mx + 36, gy - 60, 6, INK); // the bowl
  cv.seg(mx, gy - 42, mx + 8, gy - 66, 3, INK); // feed arm
  cv.disc(mx + 9, gy - 68, 4, RED);
  // signal arcs above the dish
  for (const r of [14, 22, 30]) {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const a = -2.05 + (i / 10) * 0.95;
      pts.push([mx + 10 + Math.cos(a) * r, gy - 70 + Math.sin(a) * r]);
    }
    cv.poly(pts, 2.2, BLUE);
  }
  // drone, upper right
  const dx = x + w - 62, dy = y + 32;
  cv.fillPoly([[dx - 23, dy - 7], [dx + 23, dy - 7], [dx + 16, dy + 8], [dx - 16, dy + 8]], INK);
  for (const s of [-1, 1]) {
    cv.seg(dx + s * 18, dy - 4, dx + s * 36, dy - 13, 4, INK);
    cv.seg(dx + s * 27, dy - 15, dx + s * 45, dy - 15, 3, INK); // rotor bar
    cv.disc(dx + s * 36, dy - 15, 3, INK);
  }
  cv.disc(dx, dy + 12, 5, INK); // camera gimbal
  cv.disc(dx, dy + 12, 2, RED);
  // dashed flight path in from the top corner
  let px = x + w - 12, py = y + 8;
  for (let i = 0; i < 4; i++) {
    cv.seg(px, py, px - 11, py + 5, 2.2, SOFT);
    px -= 20; py += 9;
  }
  // impact burst between dish and drone
  const sx = mx + 76, sy = gy - 58;
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r1 = 5, r2 = i % 2 ? 12 : 18;
    cv.seg(sx + Math.cos(a) * r1, sy + Math.sin(a) * r1, sx + Math.cos(a) * r2, sy + Math.sin(a) * r2, 3, RED);
  }
  cv.disc(sx, sy, 5, GOLD);
}

// Storm cloud with rain and a lightning bolt.
function drawStormIcon(cv, cx, cy, s) {
  const pts = [];
  for (let i = 0; i <= 20; i++) { // top arc of cloud
    const a = Math.PI - (i / 20) * Math.PI;
    pts.push([cx + Math.cos(a) * s * 0.95, cy - Math.sin(a) * s * 0.55]);
  }
  cv.poly(pts, 3.4, INK);
  cv.seg(cx - s * 0.95, cy, cx + s * 0.95, cy, 3.4, INK);
  for (const off of [-0.62, -0.2, 0.22, 0.64]) {
    cv.seg(cx + off * s, cy + s * 0.16, cx + off * s - s * 0.14, cy + s * 0.48, 2.6, BLUE);
  }
  cv.fillPoly([
    [cx + s * 0.18, cy + s * 0.34], [cx - s * 0.22, cy + s * 0.86], [cx + s * 0.02, cy + s * 0.86],
    [cx - s * 0.14, cy + s * 1.22], [cx + s * 0.34, cy + s * 0.58], [cx + s * 0.08, cy + s * 0.58],
  ], GOLD);
  cv.poly([
    [cx + s * 0.18, cy + s * 0.34], [cx - s * 0.22, cy + s * 0.86], [cx + s * 0.02, cy + s * 0.86],
    [cx - s * 0.14, cy + s * 1.22], [cx + s * 0.34, cy + s * 0.58], [cx + s * 0.08, cy + s * 0.58],
  ], 1.6, INK, true);
}

// Scales of justice.
function drawScalesIcon(cv, cx, top, s) {
  const beamY = top + s * 0.16;
  cv.seg(cx, top, cx, top + s * 0.92, 3.4, INK);
  cv.disc(cx, top, 4, INK);
  cv.seg(cx - s * 0.52, beamY, cx + s * 0.52, beamY, 3.4, INK);
  for (const side of [-1, 1]) {
    const px = cx + side * s * 0.52;
    cv.seg(px, beamY, px - s * 0.17, top + s * 0.52, 2.2, INK);
    cv.seg(px, beamY, px + s * 0.17, top + s * 0.52, 2.2, INK);
    const pan = [];
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI;
      pan.push([px + Math.cos(a) * s * 0.19, top + s * 0.52 + Math.sin(a) * s * 0.10]);
    }
    cv.poly(pan, 2.6, INK);
  }
  cv.seg(cx - s * 0.3, top + s * 0.98, cx + s * 0.3, top + s * 0.98, 4.4, INK);
}

// Syringe.
function drawSyringeIcon(cv, x, y, w) {
  const cy = y + 16;
  cv.rect(x + 26, cy - 9, w - 52, 18, WHITE);
  cv.rect(x + 26, cy - 9, w - 52, 2.4, INK); cv.rect(x + 26, cy + 6.6, w - 52, 2.4, INK);
  cv.rect(x + 26, cy - 9, 2.4, 18, INK); cv.rect(x + w - 28.4, cy - 9, 2.4, 18, INK);
  for (let i = 1; i <= 4; i++) cv.rect(x + 26 + i * ((w - 52) / 5), cy - 9, 1.8, 6, SOFT);
  cv.rect(x + 30, cy - 5.5, (w - 60) * 0.55, 11, TEAL); // dose inside
  cv.seg(x + w - 26, cy, x + w - 2, cy, 2.6, INK); // needle
  cv.rect(x + 8, cy - 3, 18, 6, INK); // plunger rod
  cv.rect(x + 2, cy - 10, 6, 20, INK); // thumb rest
}

/* ================= The page ================= */

function rule(cv, x, y, w, col = INK, hgt = 2.4) { cv.rect(x, y, w, hgt, col); }

function kicker(cv, text, x, y, size = 14.5) {
  drawText(cv, text, x, y, size, RED, 1.75, 'left', 1.2);
}

function buildPage() {
  const W = 1024, H = 1024;
  const cv = new Canvas(W, H);
  cv.fillAll(PAPER);
  const M = 40; // page margin
  const RW = W - M * 2; // 944 usable width

  // frame: heavy outer rule + hairline inner rule
  cv.rect(M - 14, M - 14, RW + 28, H - 2 * M + 28, INK);
  cv.rect(M - 9, M - 9, RW + 18, H - 2 * M + 18, PAPER);
  cv.rect(M - 5, M - 5, RW + 10, H - 2 * M + 10, INK);
  cv.rect(M - 3, M - 3, RW + 6, H - 2 * M + 6, PAPER);

  // ---- masthead ----
  drawText(cv, 'EST. 2026 — INDEPENDENT', M + 2, 56, 11.5, SOFT, 1.1, 'left', 1);
  drawText(cv, 'ONE PAGE · THE WHOLE WORLD', W - M - 2, 56, 11.5, SOFT, 1.1, 'right', 1);
  drawText(cv, 'THE DAILY COMPASS', W / 2, 128, 64, INK, 2.0, 'center', 1.5);
  drawText(cv, 'ALL THE WORLD’S NEWS, SUMMED UP ON A SINGLE PAGE', W / 2, 156, 13, SOFT, 1.15, 'center', 2.2);

  // ---- date bar ----
  cv.rect(M, 168, RW, 38, INK);
  drawText(cv, 'LATE EDITION', M + 14, 193, 12.5, WHITE, 1.2, 'left', 1);
  drawText(cv, 'FRIDAY · 27 NOVEMBER 2026', W / 2, 195, 23, WHITE, 1.9, 'center', 2);
  drawText(cv, 'No. 27', W - M - 14, 193, 12.5, WHITE, 1.2, 'right', 1);

  // ---- lead story: Kuwait drone strike ----
  kicker(cv, 'MIDDLE EAST · KUWAIT', M + 2, 230);
  let y = drawHeadline(cv,
    ['DRONE STRIKE KILLS TWO ITALIANS', 'AT KUWAIT AIR-DEFENCE STATION'],
    M + 2, 238, 43, INK, RW - 4, 1.9);
  drawText(cv, 'Rome and Kuwait City blame Iran. Tehran denies any role and offers a joint inquiry.',
    M + 2, y + 20, 15.5, SOFT, 1.0);
  const leadTop = y + 32;
  const leadBody =
    'Two technicians working for Rheinmetall Italia died of their wounds after drones ' +
    'struck the surveillance station where they were maintaining Kuwaiti air-defence ' +
    'systems. A Kuwaiti officer and a Pakistani national were hurt by falling debris as ' +
    'the drones were intercepted. Foreign minister Antonio Tajani told the Senate the ' +
    'drones were made in Iran. Iran’s armed forces denied any operation in the region.';
  drawBody(cv, leadBody, M + 2, leadTop, 13.8, INK, 586, 1.5);
  drawDroneScene(cv, M + 624, leadTop, 318, 118);
  drawText(cv, 'AN AIR-DEFENCE STATION IN KUWAIT', M + 624, leadTop + 134, 10.5, SOFT, 1.0);
  rule(cv, M, 524, RW, INK, 3);
  rule(cv, M, 530, RW, INK, 1.1);

  // ---- three columns ----
  const colW = 296, gap = 28;
  const c1 = M + 2, c2 = c1 + colW + gap, c3 = c2 + colW + gap;
  const colTop = 544;

  // Column 1: US Thanksgiving storm
  kicker(cv, 'UNITED STATES · WEATHER', c1, colTop + 8, 13);
  let y1 = drawHeadline(cv, ['THANKSGIVING STORM', 'CUTS POWER TO', 'NEARLY A MILLION'], c1, colTop + 16, 19, INK, colW, 1.75, 1.38);
  y1 = drawBody(cv,
    'A coastal storm lashed the US East Coast with 70 mph gusts and flooding on the busiest ' +
    'travel weekend in years. By Thursday night 980,000 households had no power.',
    c1, y1 + 4, 12.4, INK, colW, 1.48);
  drawStormIcon(cv, c1 + 40, y1 + 36, 30);
  drawText(cv, '980K HOMES DARK', c1 + 88, y1 + 32, 13, INK, 1.6);
  drawText(cv, '2,200 DELAYED · 420 AXED', c1 + 88, y1 + 54, 13, INK, 1.6);
  drawText(cv, 'MACY’S PARADE PUT OFF', c1 + 88, y1 + 76, 13, RED, 1.6);

  // Column 2: NZ election deadlock + seat chart
  kicker(cv, 'NEW ZEALAND · POLITICS', c2, colTop + 8, 13);
  let y2 = drawHeadline(cv, ['DEADLOCK: FINAL COUNT', 'LEAVES NO BLOC WITH', 'A MAJORITY'], c2, colTop + 16, 19, INK, colW, 1.75, 1.38);
  y2 = drawBody(cv,
    'Friday’s count erased the coalition’s election-night lead. National, ACT and NZ First ' +
    'hold 65 of 130 seats, one short of 66; Opportunity holds the balance.',
    c2, y2 + 4, 12.4, INK, colW, 1.48);
  const rows = [
    ['COALITION', 65, BLUE], ['LABOUR BLOC', 58, RED], ['OPPORTUNITY', 7, TEAL],
  ];
  let ry = y2 + 8;
  for (const [label, seats, colr] of rows) {
    drawText(cv, label, c2, ry + 11, 10.5, INK, 1.5);
    drawText(cv, String(seats), c2 + colW, ry + 12, 13, INK, 1.7, 'right');
    const bw = (seats / 66) * 280;
    cv.rect(c2, ry + 16, bw, 9, colr);
    ry += 27;
  }
  for (let yy = y2 + 10; yy < ry - 4; yy += 5) cv.rect(c2 + 280, yy, 1.8, 3, INK); // 66-seat line
  drawText(cv, 'DASHED LINE: 66 SEATS TO GOVERN', c2, ry + 10, 9.5, SOFT, 1.1);

  // Column 3: Duterte ICC trial
  kicker(cv, 'THE HAGUE · JUSTICE', c3, colTop + 8, 13);
  let y3 = drawHeadline(cv, ['DUTERTE FACES TRIAL', 'AT THE ICC AS VICTIMS’', 'FAMILIES ARRIVE'], c3, colTop + 16, 19, INK, colW, 1.75, 1.38);
  y3 = drawBody(cv,
    'Former Philippine president Rodrigo Duterte, 81, goes on trial Monday at the ' +
    'International Criminal Court over his anti-drug campaign — the first former Asian ' +
    'leader to face it.',
    c3, y3 + 4, 12.4, INK, colW, 1.48);
  drawScalesIcon(cv, c3 + colW / 2, y3 + 12, 58);
  drawText(cv, 'TRIAL OPENS MONDAY · 500+ VICTIMS', c3 + colW / 2, y3 + 88, 10.5, SOFT, 1.3, 'center', 0.6);

  // column separators
  cv.rect(c1 + colW + gap / 2 - 1, colTop + 4, 1.6, 264, SOFT);
  cv.rect(c2 + colW + gap / 2 - 1, colTop + 4, 1.6, 264, SOFT);
  rule(cv, M, 834, RW, INK, 2.2);

  // ---- bottom row: two stories ----
  const bTop = 846, halfW = 452, b2 = M + halfW + 40;

  kicker(cv, 'SPAIN · SEA', M + 2, bTop + 8, 13);
  let yb = drawHeadline(cv, ['DIESEL TANKER CAPSIZES OFF IBIZA;', 'ONE SAILOR DIES'], M + 2, bTop + 16, 18.5, INK, halfW, 1.85, 1.26);
  drawBody(cv,
    'The Malta-flagged Med Emre, carrying 7,000 tonnes of diesel, keeled over off Ibiza. ' +
    'All 17 crew were rescued, but one died in hospital. Spain raised its pollution plan ' +
    'to level 2.',
    M + 2, yb + 4, 11.8, INK, halfW, 1.42);

  kicker(cv, 'AFRICA · HEALTH', b2, bTop + 8, 13);
  drawSyringeIcon(cv, b2 + 330, bTop + 2, 118);
  let yh = drawHeadline(cv, ['GENERIC HIV JAB AT $40', 'A YEAR REACHES ZAMBIA'], b2, bTop + 16, 18.5, INK, 322, 1.85, 1.26);
  drawBody(cv,
    'First generic shipments of lenacapavir, a twice-yearly HIV prevention jab, reached ' +
    'Zambia this week; Uganda follows within days. The original costs $28,000 a year ' +
    'in the US.',
    b2, yh + 4, 11.8, INK, halfW, 1.42);

  cv.rect(M + halfW + 19, bTop + 4, 1.6, 110, SOFT);

  // ---- footer ----
  rule(cv, M, 964, RW, INK, 2.2);
  drawText(cv, 'SOURCES: REUTERS · BBC · ASSOCIATED PRESS · ICC', M + 2, 982, 11, SOFT, 1.2, 'left', 0.6);
  drawText(cv, 'FRIDAY 27 NOVEMBER 2026', W / 2, 982, 11.5, INK, 1.5, 'center', 0.8);
  drawText(cv, 'DRAWN ENTIRELY IN CODE', W - M - 2, 982, 11, SOFT, 1.2, 'right', 0.6);

  return cv.finish();
}

/* ================= main ================= */

const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
fs.mkdirSync(outDir, { recursive: true });
const rgb = buildPage();
const png = encodePng(rgb, 1024, 1024);
const outFile = path.join(outDir, 'entry.png');
fs.writeFileSync(outFile, png);
console.log('wrote', outFile, png.length, 'bytes');
