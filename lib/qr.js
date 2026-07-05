'use strict';
// Minimal QR code generator (byte mode, error-correction level M,
// versions 1-10 → up to ~200 chars). No dependencies. Returns a boolean
// matrix; qrSvg() renders it as a scannable SVG.

// ---- GF(256) / Reed-Solomon -------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a, b) {
  return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}

function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse(); // highest degree first
}

function rsRemainder(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const buf = [...data, ...new Array(ecLen).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (!factor) continue;
    for (let j = 1; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], factor);
  }
  return buf.slice(data.length);
}

// ---- version tables (EC level M) --------------------------------------------

// [ecCodewordsPerBlock, [data codewords of each block]]
const VERSIONS = [null,
  [10, [16]],
  [16, [28]],
  [26, [44]],
  [18, [32, 32]],
  [24, [43, 43]],
  [16, [27, 27, 27, 27]],
  [18, [31, 31, 31, 31]],
  [22, [38, 38, 39, 39]],
  [22, [36, 36, 36, 37, 37]],
  [26, [43, 43, 43, 43, 44]],
];

const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const dataCw = VERSIONS[v][1].reduce((a, b) => a + b, 0);
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    if (headerBits + byteLen * 8 <= dataCw * 8) return v;
  }
  throw new Error('text too long for QR (max ~200 chars)');
}

// ---- bit packing -------------------------------------------------------------

function buildCodewords(bytes, version) {
  const [ecPerBlock, blocks] = VERSIONS[version];
  const dataCw = blocks.reduce((a, b) => a + b, 0);
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCw * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }
  const pads = [0xec, 0x11];
  for (let i = 0; data.length < dataCw; i++) data.push(pads[i % 2]);

  // split into blocks, compute EC, interleave
  const dataBlocks = [];
  const ecBlocks = [];
  let off = 0;
  for (const len of blocks) {
    const block = data.slice(off, off + len);
    off += len;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecPerBlock));
  }
  const out = [];
  const maxLen = Math.max(...blocks);
  for (let i = 0; i < maxLen; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
}

// ---- matrix ------------------------------------------------------------------

function buildMatrix(version, codewords, mask) {
  const size = 17 + 4 * version;
  const grid = Array.from({ length: size }, () => new Array(size).fill(null));
  const isFunc = Array.from({ length: size }, () => new Array(size).fill(false));

  const set = (r, c, v) => { grid[r][c] = v; isFunc[r][c] = true; };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, on ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // timing
  for (let i = 8; i < size - 8; i++) {
    if (!isFunc[6][i]) set(6, i, i % 2 === 0 ? 1 : 0);
    if (!isFunc[i][6]) set(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // alignment (skip only the three combos that sit on finder corners —
  // centers on the timing pattern are legitimate and must be drawn)
  const pos = ALIGNMENT[version];
  const last = pos.length - 1;
  for (let pi = 0; pi < pos.length; pi++) {
    for (let pj = 0; pj < pos.length; pj++) {
      if ((pi === 0 && pj === 0) || (pi === 0 && pj === last) || (pi === last && pj === 0)) continue;
      const r0 = pos[pi];
      const c0 = pos[pj];
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const on = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          set(r0 + r, c0 + c, on ? 1 : 0);
        }
      }
    }
  }

  set(4 * version + 9, 8, 1); // dark module

  // reserve format areas (filled later)
  for (let i = 0; i < 9; i++) {
    if (!isFunc[8][i]) set(8, i, 0);
    if (!isFunc[i][8]) set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunc[8][size - 1 - i]) set(8, size - 1 - i, 0);
    if (!isFunc[size - 1 - i][8]) set(size - 1 - i, 8, 0);
  }

  // version info (v >= 7)
  if (version >= 7) {
    let d = version << 12;
    for (let i = 17; i >= 12; i--) if ((d >> i) & 1) d ^= 0x1f25 << (i - 12);
    const bitsV = (version << 12) | d;
    for (let i = 0; i < 18; i++) {
      const bit = (bitsV >> i) & 1;
      set(Math.floor(i / 3), size - 11 + (i % 3), bit);
      set(size - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }

  // data placement: zigzag from bottom-right, skipping column 6
  const maskFns = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const maskFn = maskFns[mask];
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (isFunc[r][c]) continue;
        let bit = bitIdx < totalBits ? (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1 : 0;
        bitIdx++;
        if (maskFn(r, c)) bit ^= 1;
        grid[r][c] = bit;
      }
    }
    upward = !upward;
  }

  // format info: EC level M (00) + mask, BCH(15,5), xor mask
  let fmt = (0b00 << 3) | mask;
  let rem = fmt << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  const fmtBits = ((fmt << 10) | (rem & 0x3ff)) ^ 0x5412;
  const fbit = (i) => (fmtBits >> i) & 1;
  // copy 1, around the top-left finder: bit 14 at (8,0) … bit 0 at (0,8)
  for (let i = 0; i <= 5; i++) grid[8][i] = fbit(14 - i);
  grid[8][7] = fbit(8);
  grid[8][8] = fbit(7);
  grid[7][8] = fbit(6);
  for (let i = 0; i <= 5; i++) grid[i][8] = fbit(i);
  // copy 2: bits 14..8 up the bottom-left column, bits 7..0 along the
  // top-right row
  for (let j = 0; j <= 6; j++) grid[size - 1 - j][8] = fbit(14 - j);
  for (let k = 0; k <= 7; k++) grid[8][size - 8 + k] = fbit(7 - k);
  grid[size - 8][8] = 1; // dark module stays dark

  return grid;
}

// ---- mask selection ----------------------------------------------------------

function penalty(grid) {
  const size = grid.length;
  let score = 0;
  // N1: runs of 5+ in rows and columns
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const cur = axis ? grid[j][i] : grid[i][j];
        const prev = axis ? grid[j - 1][i] : grid[i][j - 1];
        if (cur === prev) {
          run++;
          if (j === size - 1 && run >= 5) score += run - 2;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
    }
  }
  // N2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }
  // N3: finder-like patterns
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j <= size - 11; j++) {
        let m1 = true;
        let m2 = true;
        for (let k = 0; k < 11; k++) {
          const v = axis ? grid[j + k][i] : grid[i][j + k];
          if (v !== pat1[k]) m1 = false;
          if (v !== pat2[k]) m2 = false;
        }
        if (m1) score += 40;
        if (m2) score += 40;
      }
    }
  }
  // N4: dark proportion
  let dark = 0;
  for (const row of grid) for (const v of row) dark += v;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

// ---- public API ----------------------------------------------------------------

function qrMatrix(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = pickVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = buildMatrix(version, codewords, mask);
    const s = penalty(grid);
    if (s < bestScore) { bestScore = s; best = grid; }
  }
  return best;
}

function qrSvg(text, { module = 8, quiet = 4, dark = '#000', light = '#fff' } = {}) {
  const grid = qrMatrix(text);
  const size = grid.length + quiet * 2;
  const px = size * module;
  let rects = '';
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid.length; c++) {
      if (grid[r][c]) {
        rects += `<rect x="${(c + quiet) * module}" y="${(r + quiet) * module}" width="${module}" height="${module}"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">` +
    `<rect width="${px}" height="${px}" fill="${light}"/><g fill="${dark}">${rects}</g></svg>`;
}

module.exports = { qrMatrix, qrSvg };
