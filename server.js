#!/usr/bin/env node
'use strict';
// Local, private music streaming server — a single-machine take on Spotify's
// architecture. Zero dependencies; Node 18+.
//
//   node server.js            serve ./music on http://127.0.0.1:8888
//   MUSIC_DIR=~/Music node server.js
//   PORT=9000 HOST=0.0.0.0 node server.js   (expose on your LAN — optional)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const { Library } = require('./lib/scanner');
const { Store } = require('./lib/store');
const { readTags } = require('./lib/tags');

const ROOT = __dirname;
const MUSIC_DIR = path.resolve(expandHome(process.env.MUSIC_DIR || path.join(ROOT, 'music')));
const DATA_DIR = path.resolve(expandHome(process.env.DATA_DIR || path.join(ROOT, 'data')));
const PORT = parseInt(process.env.PORT || '8888', 10);
const HOST = process.env.HOST || '127.0.0.1'; // private by default

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

fs.mkdirSync(MUSIC_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const library = new Library(MUSIC_DIR, DATA_DIR);
const store = new Store(DATA_DIR);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json',
};
const AUDIO_MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.wav': 'audio/wav', '.wave': 'audio/wav',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'audio/webm',
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function notFound(res) {
  json(res, 404, { error: 'not found' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ---- streaming with HTTP Range support (the local "CDN edge") ------------

function streamTrack(req, res, track) {
  const filePath = library.absPath(track);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return notFound(res);
  }
  const mime = AUDIO_MIME[track.ext] || 'application/octet-stream';
  const range = req.headers.range;
  let start = 0;
  let end = stat.size - 1;
  let status = 200;

  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = parseInt(m[1], 10);
        if (m[2]) end = Math.min(parseInt(m[2], 10), stat.size - 1);
      } else {
        start = Math.max(0, stat.size - parseInt(m[2], 10));
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      status = 206;
    }
  }

  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Cache-Control': 'private, max-age=3600',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath, { start, end });
  stream.pipe(res);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
}

// ---- artwork: embedded art with an in-memory cache, SVG fallback ---------

const artCache = new Map(); // trackId -> { mime, data } | null
const ART_CACHE_MAX = 200;

function placeholderSvg(seed, label) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const hue2 = (hue + 40) % 360;
  const initial = (label || '?').trim().charAt(0).toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},45%,32%)"/><stop offset="1" stop-color="hsl(${hue2},50%,16%)"/>
</linearGradient></defs>
<rect width="300" height="300" fill="url(#g)"/>
<text x="150" y="150" font-family="sans-serif" font-size="120" font-weight="700"
 fill="rgba(255,255,255,0.85)" text-anchor="middle" dominant-baseline="central">${initial}</text>
</svg>`;
}

function serveArtwork(res, track) {
  if (track.hasArt) {
    let art = artCache.get(track.id);
    if (art === undefined) {
      const tags = readTags(library.absPath(track));
      art = tags.picture || null;
      if (artCache.size >= ART_CACHE_MAX) artCache.delete(artCache.keys().next().value);
      artCache.set(track.id, art);
    }
    if (art) {
      res.writeHead(200, { 'Content-Type': art.mime, 'Content-Length': art.data.length, 'Cache-Control': 'private, max-age=86400' });
      return res.end(art.data);
    }
  }
  const svg = placeholderSvg(track.album + track.albumArtist, track.album);
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=86400' });
  res.end(svg);
}

// ---- API routing ----------------------------------------------------------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, id, sub] = parts;

  if (resource === 'library' && req.method === 'GET') {
    return json(res, 200, {
      tracks: library.list(),
      albums: library.albums(),
      artists: library.artists(),
      playlists: store.state.playlists,
      liked: store.state.liked,
      musicDir: MUSIC_DIR,
    });
  }

  if (resource === 'search' && req.method === 'GET') {
    return json(res, 200, library.search(url.searchParams.get('q') || ''));
  }

  if (resource === 'home' && req.method === 'GET') {
    const has = (tid) => library.get(tid);
    const recent = store.state.history.filter((h) => has(h.trackId)).slice(0, 20)
      .map((h) => ({ ...library.get(h.trackId), playedAt: h.at }));
    const top = Object.entries(store.state.playCounts)
      .filter(([tid]) => has(tid))
      .sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([tid, count]) => ({ ...library.get(tid), playCount: count }));
    const added = library.list().sort((a, b) => b.addedAt - a.addedAt).slice(0, 20);
    return json(res, 200, { recentlyPlayed: recent, mostPlayed: top, recentlyAdded: added });
  }

  if (resource === 'stream' && id && (req.method === 'GET' || req.method === 'HEAD')) {
    const track = library.get(id);
    if (!track) return notFound(res);
    return streamTrack(req, res, track);
  }

  if (resource === 'artwork' && id && req.method === 'GET') {
    const track = library.get(id);
    if (!track) return notFound(res);
    return serveArtwork(res, track);
  }

  if (resource === 'rescan' && req.method === 'POST') {
    const result = library.scan();
    store.pruneMissing((tid) => !!library.get(tid));
    artCache.clear();
    return json(res, 200, result);
  }

  if (resource === 'playlists') {
    if (req.method === 'GET' && !id) return json(res, 200, store.state.playlists);
    if (req.method === 'POST' && !id) {
      const body = await readBody(req);
      return json(res, 201, store.createPlaylist(body.name));
    }
    if (id) {
      if (req.method === 'GET') {
        const playlist = store.getPlaylist(id);
        return playlist ? json(res, 200, playlist) : notFound(res);
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const playlist = store.updatePlaylist(id, body);
        return playlist ? json(res, 200, playlist) : notFound(res);
      }
      if (req.method === 'POST' && sub === 'tracks') {
        const body = await readBody(req);
        if (!library.get(body.trackId)) return json(res, 400, { error: 'unknown track' });
        const playlist = store.addToPlaylist(id, body.trackId);
        return playlist ? json(res, 200, playlist) : notFound(res);
      }
      if (req.method === 'DELETE') {
        return store.deletePlaylist(id) ? json(res, 200, { ok: true }) : notFound(res);
      }
    }
  }

  if (resource === 'liked' && id) {
    if (req.method === 'PUT') { store.like(id); return json(res, 200, { liked: store.state.liked }); }
    if (req.method === 'DELETE') { store.unlike(id); return json(res, 200, { liked: store.state.liked }); }
  }

  if (resource === 'events' && id === 'play' && req.method === 'POST') {
    const body = await readBody(req);
    if (library.get(body.trackId)) store.recordPlay(body.trackId);
    return json(res, 200, { ok: true });
  }

  if (resource === 'tracks' && id && sub === 'duration' && req.method === 'POST') {
    const body = await readBody(req);
    library.reportDuration(id, Number(body.duration) || 0);
    return json(res, 200, { ok: true });
  }

  return notFound(res);
}

// ---- static files ----------------------------------------------------------

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const publicDir = path.join(ROOT, 'public');
  const filePath = path.normalize(path.join(publicDir, rel));
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== path.join(publicDir, 'index.html')) {
    return notFound(res);
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return notFound(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      if (!res.headersSent) json(res, 400, { error: err.message });
      else res.destroy();
    });
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(res, url.pathname);
  } else {
    json(res, 405, { error: 'method not allowed' });
  }
});

const scanResult = library.scan();
store.pruneMissing((tid) => !!library.get(tid));

server.listen(PORT, HOST, () => {
  console.log(`♫ local-spotify`);
  console.log(`  music dir : ${MUSIC_DIR}`);
  console.log(`  library   : ${scanResult.total} tracks (${scanResult.added} added, ${scanResult.removed} removed, scanned in ${scanResult.ms} ms)`);
  console.log(`  listening : http://${HOST}:${PORT}`);
  if (scanResult.total === 0) {
    console.log(`  tip       : drop audio files into ${MUSIC_DIR} (or set MUSIC_DIR=~/Music),`);
    console.log(`              or run "node tools/generate-samples.js" for demo tracks.`);
  }
});

process.on('SIGINT', () => { store.flush(); process.exit(0); });
process.on('SIGTERM', () => { store.flush(); process.exit(0); });
