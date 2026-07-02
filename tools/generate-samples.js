#!/usr/bin/env node
'use strict';
// Generates a small demo library of synthesized WAV tracks (with LIST/INFO
// tags) so the app is playable out of the box without any copyrighted audio.
//
//   node tools/generate-samples.js [outputDir]   (default: ./music)

const fs = require('fs');
const path = require('path');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'music'));
const SAMPLE_RATE = 22050;

// note name -> frequency helper (A4 = 440)
const NOTE_OFFSETS = { C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2 };
function freq(note, octave) {
  return 440 * 2 ** ((NOTE_OFFSETS[note] + (octave - 4) * 12) / 12);
}

// Each "song" is a chord progression rendered as soft synth pads + arpeggio.
const CATALOG = [
  {
    artist: 'The Sine Waves', album: 'Pure Tones', year: '2024', genre: 'Ambient',
    songs: [
      { title: 'First Light', prog: [['C', 'E', 'G'], ['A', 'C', 'E'], ['F', 'A', 'C'], ['G', 'B', 'D']], bpm: 70 },
      { title: 'Golden Hour', prog: [['F', 'A', 'C'], ['G', 'B', 'D'], ['A', 'C', 'E'], ['F', 'A', 'C']], bpm: 64 },
      { title: 'Afterglow', prog: [['D', 'F#', 'A'], ['B', 'D', 'F#'], ['G', 'B', 'D'], ['A', 'C#', 'E']], bpm: 58 },
    ],
  },
  {
    artist: 'Sawtooth Society', album: 'Harmonic Motion', year: '2025', genre: 'Electronic',
    songs: [
      { title: 'Velocity', prog: [['A', 'C', 'E'], ['F', 'A', 'C'], ['C', 'E', 'G'], ['G', 'B', 'D']], bpm: 118, bright: true },
      { title: 'Circuit Dreams', prog: [['E', 'G', 'B'], ['C', 'E', 'G'], ['D', 'F#', 'A'], ['B', 'D', 'F#']], bpm: 126, bright: true },
      { title: 'Neon Rain', prog: [['D', 'F', 'A'], ['A#', 'D', 'F'], ['C', 'E', 'G'], ['D', 'F', 'A']], bpm: 110, bright: true },
      { title: 'Afterimage', prog: [['G', 'A#', 'D'], ['D#', 'G', 'A#'], ['F', 'A', 'C'], ['G', 'A#', 'D']], bpm: 96, bright: true },
    ],
  },
  {
    artist: 'Quiet Fourier', album: 'Series & Sums', year: '2023', genre: 'Classical',
    songs: [
      { title: 'Prelude in C', prog: [['C', 'E', 'G'], ['G', 'B', 'D'], ['A', 'C', 'E'], ['F', 'A', 'C']], bpm: 84 },
      { title: 'Nocturne for Waves', prog: [['A', 'C', 'E'], ['E', 'G#', 'B'], ['F', 'A', 'C'], ['E', 'G#', 'B']], bpm: 66 },
      { title: 'Transform', prog: [['F', 'A', 'C'], ['C', 'E', 'G'], ['A#', 'D', 'F'], ['C', 'E', 'G']], bpm: 76 },
    ],
  },
];

function synthesize(song) {
  const beatSec = 60 / song.bpm;
  const barSec = beatSec * 4;
  const bars = song.prog.length * 2; // play the progression twice
  const totalSec = bars * barSec + 1.5;
  const n = Math.floor(totalSec * SAMPLE_RATE);
  const samples = new Float32Array(n);

  for (let bar = 0; bar < bars; bar++) {
    const chord = song.prog[bar % song.prog.length];
    const start = bar * barSec;
    // pad: sustained chord
    for (const [ci, note] of chord.entries()) {
      addTone(samples, freq(note, 3 + (ci === 2 ? 1 : 0)), start, barSec, 0.12, song.bright);
    }
    // arpeggio: one note per half-beat
    for (let step = 0; step < 8; step++) {
      const note = chord[step % chord.length];
      addTone(samples, freq(note, 5), start + step * (beatSec / 2), beatSec / 2 * 0.9, 0.10, song.bright);
    }
    // simple bass on beats 1 and 3
    addTone(samples, freq(chord[0], 2), start, beatSec * 0.9, 0.16, false);
    addTone(samples, freq(chord[0], 2), start + 2 * beatSec, beatSec * 0.9, 0.14, false);
  }

  // gentle master fade in/out
  const fade = Math.floor(0.4 * SAMPLE_RATE);
  for (let i = 0; i < fade && i < n; i++) samples[i] *= i / fade;
  for (let i = 0; i < SAMPLE_RATE && i < n; i++) samples[n - 1 - i] *= i / SAMPLE_RATE;

  // clip-safe convert to 16-bit PCM
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE(Math.round(v * 32767 * 0.9), i * 2);
  }
  return pcm;
}

function addTone(samples, frequency, startSec, durSec, gain, bright) {
  const start = Math.floor(startSec * SAMPLE_RATE);
  const len = Math.floor(durSec * SAMPLE_RATE);
  const attack = Math.min(Math.floor(0.02 * SAMPLE_RATE), len >> 2);
  for (let i = 0; i < len && start + i < samples.length; i++) {
    const t = i / SAMPLE_RATE;
    let v = Math.sin(2 * Math.PI * frequency * t);
    if (bright) {
      v += 0.4 * Math.sin(4 * Math.PI * frequency * t) + 0.2 * Math.sin(6 * Math.PI * frequency * t);
      v /= 1.6;
    }
    let env = 1;
    if (i < attack) env = i / attack;
    else env = Math.exp(-1.8 * (t - attack / SAMPLE_RATE) / durSec);
    samples[start + i] += v * env * gain;
  }
}

function infoChunk(id, text) {
  const data = Buffer.from(text + '\0', 'utf8');
  const padded = data.length % 2 ? Buffer.concat([data, Buffer.alloc(1)]) : data;
  const head = Buffer.alloc(8);
  head.write(id, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, padded]);
}

function writeWav(filePath, pcm, tags) {
  const info = Buffer.concat([
    Buffer.from('INFO', 'latin1'),
    infoChunk('INAM', tags.title),
    infoChunk('IART', tags.artist),
    infoChunk('IPRD', tags.album),
    infoChunk('ICRD', tags.year),
    infoChunk('IGNR', tags.genre),
    infoChunk('ITRK', String(tags.track)),
  ]);
  const listHead = Buffer.alloc(8);
  listHead.write('LIST', 0, 'latin1');
  listHead.writeUInt32LE(info.length, 4);

  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);              // PCM
  fmt.writeUInt16LE(1, 10);             // mono
  fmt.writeUInt32LE(SAMPLE_RATE, 12);
  fmt.writeUInt32LE(SAMPLE_RATE * 2, 16); // byte rate
  fmt.writeUInt16LE(2, 20);             // block align
  fmt.writeUInt16LE(16, 22);            // bits

  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0, 'latin1');
  dataHead.writeUInt32LE(pcm.length, 4);

  const bodyLen = 4 + fmt.length + listHead.length + info.length + dataHead.length + pcm.length;
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(bodyLen, 4);
  riff.write('WAVE', 8, 'latin1');

  fs.writeFileSync(filePath, Buffer.concat([riff, fmt, listHead, info, dataHead, pcm]));
}

let count = 0;
for (const album of CATALOG) {
  const dir = path.join(OUT, album.artist, album.album);
  fs.mkdirSync(dir, { recursive: true });
  album.songs.forEach((song, i) => {
    const file = path.join(dir, `${String(i + 1).padStart(2, '0')} - ${song.title}.wav`);
    writeWav(file, synthesize(song), {
      title: song.title, artist: album.artist, album: album.album,
      year: album.year, genre: album.genre, track: i + 1,
    });
    count++;
    console.log('  wrote', path.relative(process.cwd(), file));
  });
}
console.log(`\nGenerated ${count} demo tracks in ${OUT}`);
console.log('Start the app with: node server.js');
