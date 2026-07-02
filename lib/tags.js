'use strict';
// Lightweight audio metadata readers (no dependencies).
// Supports: MP3 (ID3v2/ID3v1 + duration), FLAC (STREAMINFO, Vorbis comments,
// PICTURE), OGG (Vorbis/Opus comments + granule-based duration), WAV (fmt +
// LIST/INFO tags). Anything else falls back to filename-derived metadata.

const fs = require('fs');
const path = require('path');

function readTags(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let meta = null;
  try {
    if (ext === '.mp3') meta = readMp3(filePath);
    else if (ext === '.flac') meta = readFlac(filePath);
    else if (ext === '.ogg' || ext === '.oga' || ext === '.opus') meta = readOgg(filePath);
    else if (ext === '.wav' || ext === '.wave') meta = readWav(filePath);
  } catch (err) {
    meta = null;
  }
  return withFallbacks(meta || {}, filePath);
}

function withFallbacks(meta, filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  if (!meta.title) {
    // "03 - Song Name" / "03. Song Name" -> track number + title
    const m = base.match(/^(\d{1,3})\s*[-._)\s]\s*(.+)$/);
    if (m) {
      if (!meta.track) meta.track = parseInt(m[1], 10);
      meta.title = m[2].trim();
    } else {
      meta.title = base;
    }
  }
  if (!meta.artist) {
    // Try parent-of-parent directory as artist (Artist/Album/Track layout)
    const albumDir = path.dirname(filePath);
    const artistDir = path.dirname(albumDir);
    const artistName = path.basename(artistDir);
    meta.artist = artistName && artistName !== '.' && artistName !== path.sep
      ? artistName : 'Unknown Artist';
  }
  if (!meta.album) {
    const albumName = path.basename(path.dirname(filePath));
    meta.album = albumName && albumName !== '.' ? albumName : 'Unknown Album';
  }
  return meta;
}

// ---------------------------------------------------------------- MP3 / ID3

const ID3_TEXT_FRAMES = {
  TIT2: 'title', TPE1: 'artist', TALB: 'album', TRCK: 'track',
  TYER: 'year', TDRC: 'year', TCON: 'genre', TPE2: 'albumArtist',
  // ID3v2.2 three-char equivalents
  TT2: 'title', TP1: 'artist', TAL: 'album', TRK: 'track', TYE: 'year', TCO: 'genre',
};

function syncsafe(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) |
         ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

function decodeText(buf) {
  if (buf.length === 0) return '';
  const enc = buf[0];
  let body = buf.subarray(1);
  let text;
  if (enc === 0) text = body.toString('latin1');
  else if (enc === 3) text = body.toString('utf8');
  else if (enc === 1) {
    if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
      body = body.subarray(2);
      text = swapBytes(body).toString('utf16le');
    } else {
      if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) body = body.subarray(2);
      text = body.toString('utf16le');
    }
  } else if (enc === 2) {
    text = swapBytes(body).toString('utf16le');
  } else {
    text = body.toString('latin1');
  }
  return text.replace(/\0+$/g, '').replace(/\0/g, ' / ').trim();
}

function swapBytes(buf) {
  const out = Buffer.alloc(buf.length - (buf.length % 2));
  for (let i = 0; i + 1 < buf.length; i += 2) { out[i] = buf[i + 1]; out[i + 1] = buf[i]; }
  return out;
}

function readMp3(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const meta = {};
    let audioStart = 0;

    const head = Buffer.alloc(10);
    if (fs.readSync(fd, head, 0, 10, 0) === 10 && head.toString('latin1', 0, 3) === 'ID3') {
      const version = head[3];
      const tagSize = syncsafe(head, 6);
      audioStart = 10 + tagSize + ((head[5] & 0x10) ? 10 : 0);
      const tag = Buffer.alloc(Math.min(tagSize, 2 * 1024 * 1024));
      fs.readSync(fd, tag, 0, tag.length, 10);
      parseId3v2Frames(tag, version, meta);
    }

    // ID3v1 fallback for anything still missing
    if ((!meta.title || !meta.artist || !meta.album) && stat.size > 128) {
      const v1 = Buffer.alloc(128);
      fs.readSync(fd, v1, 0, 128, stat.size - 128);
      if (v1.toString('latin1', 0, 3) === 'TAG') {
        const str = (a, b) => v1.toString('latin1', a, b).replace(/\0.*$/, '').trim();
        if (!meta.title) meta.title = str(3, 33) || undefined;
        if (!meta.artist) meta.artist = str(33, 63) || undefined;
        if (!meta.album) meta.album = str(63, 93) || undefined;
        if (!meta.year) meta.year = str(93, 97) || undefined;
      }
    }

    meta.duration = mp3Duration(fd, stat.size, audioStart);
    return meta;
  } finally {
    fs.closeSync(fd);
  }
}

function parseId3v2Frames(tag, version, meta) {
  const idLen = version === 2 ? 3 : 4;
  const headerLen = version === 2 ? 6 : 10;
  let off = 0;
  while (off + headerLen <= tag.length) {
    const id = tag.toString('latin1', off, off + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let size;
    if (version === 2) size = (tag[off + 3] << 16) | (tag[off + 4] << 8) | tag[off + 5];
    else if (version === 4) size = syncsafe(tag, off + 4);
    else size = tag.readUInt32BE(off + 4);
    if (size <= 0 || off + headerLen + size > tag.length) break;
    const body = tag.subarray(off + headerLen, off + headerLen + size);
    const field = ID3_TEXT_FRAMES[id];
    if (field && !meta[field]) {
      const text = decodeText(body);
      if (text) {
        if (field === 'track') meta.track = parseInt(text, 10) || undefined;
        else if (field === 'year') meta.year = (text.match(/\d{4}/) || [text])[0];
        else meta[field] = text;
      }
    } else if ((id === 'APIC' || id === 'PIC') && !meta.picture) {
      meta.picture = parseApic(body, id === 'PIC');
    }
    off += headerLen + size;
  }
}

function parseApic(body, isV22) {
  try {
    const enc = body[0];
    let off = 1;
    let mime;
    if (isV22) {
      mime = 'image/' + body.toString('latin1', 1, 4).toLowerCase();
      off = 4;
    } else {
      const end = body.indexOf(0, off);
      if (end < 0) return null;
      mime = body.toString('latin1', off, end);
      off = end + 1;
    }
    off += 1; // picture type
    if (enc === 1 || enc === 2) { // utf16 description: double-null terminated
      while (off + 1 < body.length && !(body[off] === 0 && body[off + 1] === 0)) off += 2;
      off += 2;
    } else {
      const end = body.indexOf(0, off);
      if (end < 0) return null;
      off = end + 1;
    }
    if (off >= body.length) return null;
    return { mime: mime || 'image/jpeg', data: Buffer.from(body.subarray(off)) };
  } catch {
    return null;
  }
}

const MP3_BITRATES = { // [MPEG1 LayerIII, MPEG2/2.5 LayerIII] kbps by index
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Duration(fd, fileSize, audioStart) {
  const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(0, fileSize - audioStart)));
  if (chunk.length < 4) return 0;
  fs.readSync(fd, chunk, 0, chunk.length, audioStart);
  for (let i = 0; i + 4 <= chunk.length; i++) {
    if (chunk[i] !== 0xff || (chunk[i + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (chunk[i + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layerBits = (chunk[i + 1] >> 1) & 0x03;
    if (versionBits === 1 || layerBits === 0) continue;
    const bitrateIdx = (chunk[i + 2] >> 4) & 0x0f;
    const srIdx = (chunk[i + 2] >> 2) & 0x03;
    if (bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) continue;
    const mpeg1 = versionBits === 3;
    const sampleRate = MP3_SAMPLE_RATES[versionBits] && MP3_SAMPLE_RATES[versionBits][srIdx];
    if (!sampleRate) continue;
    const bitrate = MP3_BITRATES[mpeg1 ? 1 : 2][bitrateIdx] * 1000;
    const samplesPerFrame = mpeg1 ? 1152 : 576;

    // Xing/Info VBR header gives an exact frame count
    const xingOff = i + 4 + (mpeg1 ? 32 : 17);
    if (xingOff + 12 <= chunk.length) {
      const tagName = chunk.toString('latin1', xingOff, xingOff + 4);
      if (tagName === 'Xing' || tagName === 'Info') {
        const flags = chunk.readUInt32BE(xingOff + 4);
        if (flags & 0x01) {
          const frames = chunk.readUInt32BE(xingOff + 8);
          return (frames * samplesPerFrame) / sampleRate;
        }
      }
    }
    // CBR estimate
    return ((fileSize - audioStart) * 8) / bitrate;
  }
  return 0;
}

// -------------------------------------------------------------------- FLAC

function readFlac(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const sig = Buffer.alloc(4);
    fs.readSync(fd, sig, 0, 4, 0);
    if (sig.toString('latin1') !== 'fLaC') return null;
    const meta = {};
    let pos = 4;
    for (let guard = 0; guard < 64; guard++) {
      const bh = Buffer.alloc(4);
      if (fs.readSync(fd, bh, 0, 4, pos) !== 4) break;
      const last = (bh[0] & 0x80) !== 0;
      const type = bh[0] & 0x7f;
      const size = (bh[1] << 16) | (bh[2] << 8) | bh[3];
      const bodyPos = pos + 4;
      if (type === 0 && size >= 34) { // STREAMINFO
        const b = Buffer.alloc(34);
        fs.readSync(fd, b, 0, 34, bodyPos);
        const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
        const totalSamples = ((b[13] & 0x0f) * 2 ** 32) + b.readUInt32BE(14);
        if (sampleRate > 0) meta.duration = totalSamples / sampleRate;
      } else if (type === 4 && size < 4 * 1024 * 1024) { // VORBIS_COMMENT
        const b = Buffer.alloc(size);
        fs.readSync(fd, b, 0, size, bodyPos);
        parseVorbisComments(b, meta);
      } else if (type === 6 && size < 16 * 1024 * 1024 && !meta.picture) { // PICTURE
        const b = Buffer.alloc(size);
        fs.readSync(fd, b, 0, size, bodyPos);
        meta.picture = parseFlacPicture(b);
      }
      pos = bodyPos + size;
      if (last) break;
    }
    return meta;
  } finally {
    fs.closeSync(fd);
  }
}

function parseFlacPicture(b) {
  try {
    let off = 4; // picture type
    const mimeLen = b.readUInt32BE(off); off += 4;
    const mime = b.toString('utf8', off, off + mimeLen); off += mimeLen;
    const descLen = b.readUInt32BE(off); off += 4 + descLen;
    off += 16; // width, height, depth, colors
    const dataLen = b.readUInt32BE(off); off += 4;
    if (off + dataLen > b.length) return null;
    return { mime: mime || 'image/jpeg', data: Buffer.from(b.subarray(off, off + dataLen)) };
  } catch {
    return null;
  }
}

const VORBIS_FIELDS = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', DATE: 'year',
  TRACKNUMBER: 'track', GENRE: 'genre', ALBUMARTIST: 'albumArtist',
};

function parseVorbisComments(b, meta) {
  let off = 0;
  const vendorLen = b.readUInt32LE(off); off += 4 + vendorLen;
  if (off + 4 > b.length) return;
  const count = b.readUInt32LE(off); off += 4;
  for (let i = 0; i < count && off + 4 <= b.length; i++) {
    const len = b.readUInt32LE(off); off += 4;
    if (off + len > b.length) break;
    const entry = b.toString('utf8', off, off + len); off += len;
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).toUpperCase();
    const value = entry.slice(eq + 1).trim();
    const field = VORBIS_FIELDS[key];
    if (field && value && !meta[field]) {
      if (field === 'track') meta.track = parseInt(value, 10) || undefined;
      else if (field === 'year') meta.year = (value.match(/\d{4}/) || [value])[0];
      else meta[field] = value;
    }
  }
}

// --------------------------------------------------------- OGG Vorbis/Opus

function readOgg(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const head = Buffer.alloc(Math.min(128 * 1024, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    if (head.toString('latin1', 0, 4) !== 'OggS') return null;
    const meta = {};
    let sampleRate = 0;
    let preskip = 0;
    let isOpus = false;

    const vorbisId = head.indexOf(Buffer.from('\x01vorbis', 'latin1'));
    if (vorbisId >= 0 && vorbisId + 16 <= head.length) {
      sampleRate = head.readUInt32LE(vorbisId + 12);
    } else {
      const opusId = head.indexOf(Buffer.from('OpusHead', 'latin1'));
      if (opusId >= 0 && opusId + 12 <= head.length) {
        isOpus = true;
        preskip = head.readUInt16LE(opusId + 10);
        sampleRate = 48000; // Opus granule positions are always 48 kHz
      }
    }

    // Comments
    let cOff = head.indexOf(Buffer.from('\x03vorbis', 'latin1'));
    if (cOff >= 0) cOff += 7;
    else {
      cOff = head.indexOf(Buffer.from('OpusTags', 'latin1'));
      if (cOff >= 0) cOff += 8;
    }
    if (cOff >= 0 && cOff < head.length) {
      try { parseVorbisComments(head.subarray(cOff), meta); } catch {}
    }

    // Duration: granule position of the last page
    if (sampleRate > 0) {
      const tailLen = Math.min(256 * 1024, stat.size);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, stat.size - tailLen);
      let idx = tail.lastIndexOf(Buffer.from('OggS', 'latin1'));
      while (idx >= 0) {
        if (idx + 14 <= tail.length) {
          const granule = tail.readBigUInt64LE(idx + 6);
          if (granule > 0n && granule < 0xffffffffffffffffn) {
            meta.duration = Number(granule - BigInt(isOpus ? preskip : 0)) / sampleRate;
            break;
          }
        }
        idx = tail.lastIndexOf(Buffer.from('OggS', 'latin1'), idx - 1);
      }
    }
    return meta;
  } finally {
    fs.closeSync(fd);
  }
}

// --------------------------------------------------------------------- WAV

const WAV_INFO_FIELDS = { INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'year', IGNR: 'genre', ITRK: 'track', IPRT: 'track' };

function readWav(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) !== 12) return null;
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return null;
    const meta = {};
    let byteRate = 0;
    let pos = 12;
    while (pos + 8 <= stat.size) {
      const ch = Buffer.alloc(8);
      if (fs.readSync(fd, ch, 0, 8, pos) !== 8) break;
      const id = ch.toString('latin1', 0, 4);
      const size = ch.readUInt32LE(4);
      if (id === 'fmt ') {
        const b = Buffer.alloc(Math.min(size, 16));
        fs.readSync(fd, b, 0, b.length, pos + 8);
        byteRate = b.readUInt32LE(8);
      } else if (id === 'data') {
        if (byteRate > 0) meta.duration = size / byteRate;
      } else if (id === 'LIST' && size < 1024 * 1024) {
        const b = Buffer.alloc(size);
        fs.readSync(fd, b, 0, size, pos + 8);
        if (b.toString('latin1', 0, 4) === 'INFO') parseWavInfo(b.subarray(4), meta);
      }
      pos += 8 + size + (size % 2);
    }
    return meta;
  } finally {
    fs.closeSync(fd);
  }
}

function parseWavInfo(b, meta) {
  let off = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('latin1', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (off + 8 + size > b.length) break;
    const value = b.toString('utf8', off + 8, off + 8 + size).replace(/\0+$/g, '').trim();
    const field = WAV_INFO_FIELDS[id];
    if (field && value && !meta[field]) {
      if (field === 'track') meta.track = parseInt(value, 10) || undefined;
      else meta[field] = value;
    }
    off += 8 + size + (size % 2);
  }
}

module.exports = { readTags };
