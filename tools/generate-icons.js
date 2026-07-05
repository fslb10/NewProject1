#!/usr/bin/env node
'use strict';
// Generates the PWA icons (public/icon-192.png, public/icon-512.png) with no
// dependencies: raw RGBA pixels encoded as PNG via zlib + hand-rolled CRC32.
// Design: green disc on the app's dark background with three white
// equalizer bars.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- minimal PNG encoder ----------------------------------------------------

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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // filter byte (0) at the start of each scanline
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawing ----------------------------------------------------------------

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };

  const c = size / 2;
  const discR = size * 0.46;
  // equalizer bars: x-offset (relative), half-width, half-height (relative)
  const bars = [
    { dx: -0.17, hw: 0.055, hh: 0.10 },
    { dx: 0.00, hw: 0.055, hh: 0.19 },
    { dx: 0.17, hw: 0.055, hh: 0.13 },
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      if (dx * dx + dy * dy <= discR * discR) {
        let onBar = false;
        for (const bar of bars) {
          const bx = Math.abs(dx - bar.dx * size);
          const by = Math.abs(dy);
          const hw = bar.hw * size;
          const hh = bar.hh * size;
          // rounded bar ends
          if (bx <= hw && (by <= hh || (by <= hh + hw && bx * bx + (by - hh) * (by - hh) <= hw * hw))) {
            onBar = true;
            break;
          }
        }
        if (onBar) put(x, y, 18, 18, 18);
        else put(x, y, 29, 185, 84); // #1db954
      } else {
        put(x, y, 18, 18, 18); // #121212
      }
    }
  }
  return px;
}

for (const size of [192, 512]) {
  const out = path.join(__dirname, '..', 'public', `icon-${size}.png`);
  fs.writeFileSync(out, encodePng(size, drawIcon(size)));
  console.log('wrote', out);
}
