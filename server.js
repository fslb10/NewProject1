#!/usr/bin/env node
'use strict';
// Local, private music streaming server — a single-machine take on Spotify's
// architecture. Zero dependencies; Node 18+.
//
//   node server.js            serve ./music on http://127.0.0.1:8888
//   MUSIC_DIR=~/Music node server.js
//   HOST=0.0.0.0 node server.js             expose beyond localhost (auth
//                                           turns on automatically)
//   TLS_CERT=cert.pem TLS_KEY=key.pem ...   serve HTTPS directly
// See README "Sharing outside your network" for tunnels / reverse proxies.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const { Library } = require('./lib/scanner');
const { Store } = require('./lib/store');
const { readTags } = require('./lib/tags');
const { Auth, generatePassword } = require('./lib/auth');

const ROOT = __dirname;
const MUSIC_DIR = path.resolve(expandHome(process.env.MUSIC_DIR || path.join(ROOT, 'music')));
const DATA_DIR = path.resolve(expandHome(process.env.DATA_DIR || path.join(ROOT, 'data')));
const PORT = parseInt(process.env.PORT || '8888', 10);
const HOST = process.env.HOST || '127.0.0.1'; // private by default
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
// Trust X-Forwarded-* headers (set when running behind a reverse proxy/tunnel)
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

fs.mkdirSync(MUSIC_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const library = new Library(MUSIC_DIR, DATA_DIR);
const store = new Store(DATA_DIR);
const auth = new Auth(DATA_DIR);

// Passwords from env are applied (and persisted as hashes) at boot.
if (process.env.PASSWORD) auth.setPassword('listener', process.env.PASSWORD);
if (process.env.ADMIN_PASSWORD) auth.setPassword('admin', process.env.ADMIN_PASSWORD);

const LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
// Auth is on whenever a password exists or the server is reachable beyond
// this machine. Plain localhost with no passwords stays friction-free.
let AUTH_ENABLED = !LOOPBACK || auth.hasPassword('listener') || auth.hasPassword('admin') || process.env.REQUIRE_AUTH === '1';

let generatedPassword = null;
if (AUTH_ENABLED && !auth.hasPassword('listener') && !auth.hasPassword('admin')) {
  generatedPassword = generatePassword();
  auth.setPassword('listener', generatedPassword);
}

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

// ---- auth gate -------------------------------------------------------------

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isSecure(req) {
  return !!req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
}

function sessionCookie(req, token, maxAge) {
  return `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
    (isSecure(req) ? '; Secure' : '');
}

// Paths reachable without a session (login page and its assets).
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/login.js', '/styles.css', '/api/auth/login', '/api/auth/me']);

// Returns the session (or null) and handles the response itself when access
// is denied. Callers stop when it returns undefined.
function gate(req, res, url) {
  const session = auth.getSession(parseCookies(req).session) || null;
  if (!AUTH_ENABLED) return { role: 'admin', open: true };
  const p = url.pathname;
  if (PUBLIC_PATHS.has(p)) return session || { role: null };
  if (!session) {
    if (p.startsWith('/api/')) { json(res, 401, { error: 'unauthorized' }); return undefined; }
    res.writeHead(302, { Location: '/login' });
    res.end();
    return undefined;
  }
  // admin surface needs the admin role once an admin password exists
  const wantsAdmin = p === '/admin' || p === '/admin.html' || p.startsWith('/api/admin/');
  if (wantsAdmin && auth.hasPassword('admin') && session.role !== 'admin') {
    if (p.startsWith('/api/')) { json(res, 403, { error: 'admin access required' }); return undefined; }
    res.writeHead(302, { Location: '/login?admin=1' });
    res.end();
    return undefined;
  }
  return session;
}

async function handleAuthApi(req, res, url, action, session) {
  if (action === 'login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (auth.blocked(ip)) return json(res, 429, { error: 'too many attempts — try again in a few minutes' });
    const body = await readBody(req);
    const role = auth.verify(body.password);
    if (!role) {
      auth.recordFail(ip);
      return json(res, 401, { error: 'wrong password' });
    }
    auth.clearFails(ip);
    const token = auth.createSession(role);
    res.setHeader('Set-Cookie', sessionCookie(req, token, 30 * 24 * 3600));
    return json(res, 200, { ok: true, role });
  }
  if (action === 'logout' && req.method === 'POST') {
    auth.destroySession(parseCookies(req).session);
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return json(res, 200, { ok: true });
  }
  if (action === 'me' && req.method === 'GET') {
    return json(res, 200, {
      authEnabled: AUTH_ENABLED,
      role: session && session.role ? session.role : null,
      adminConfigured: auth.hasPassword('admin'),
    });
  }
  return notFound(res);
}

// ---- streaming with HTTP Range support (the local "CDN edge") ------------

function streamTrack(req, res, track, opts = {}) {
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
  if (opts.download) {
    const nice = `${track.artist} - ${track.title}${track.ext}`;
    const ascii = nice.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    headers['Content-Disposition'] =
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nice)}`;
  }
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath, { start, end });
  stream.pipe(res);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
}

// ---- artwork: custom uploads > embedded art > generated SVG --------------

const ART_DIR = path.join(DATA_DIR, 'artwork');
const ART_EXTS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const ART_MIMES = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

function customArtPath(trackId) {
  for (const ext of Object.keys(ART_MIMES)) {
    const p = path.join(ART_DIR, trackId + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const customArtIds = new Set();
try {
  for (const f of fs.readdirSync(ART_DIR)) customArtIds.add(path.basename(f, path.extname(f)));
} catch { /* no artwork dir yet */ }

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
  const custom = customArtPath(track.id);
  if (custom) {
    const data = fs.readFileSync(custom);
    res.writeHead(200, { 'Content-Type': ART_MIMES[path.extname(custom)], 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    return res.end(data);
  }
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

// ---- admin: uploads and library management --------------------------------

const UPLOAD_EXTS = new Set(['.mp3', '.flac', '.ogg', '.oga', '.opus', '.wav', '.wave', '.m4a', '.aac', '.webm']);
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // 2 GB

// A path segment safe on every filesystem (used for Artist/Album/file names).
function safeSegment(name, fallback) {
  const cleaned = String(name || '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function receiveUpload(req, res, url) {
  const params = url.searchParams;
  const origName = params.get('filename') || 'upload';
  const ext = path.extname(origName).toLowerCase();
  if (!UPLOAD_EXTS.has(ext)) return json(res, 400, { error: `unsupported file type "${ext}"` });

  const artist = safeSegment(params.get('artist'), 'Unknown Artist');
  const album = safeSegment(params.get('album'), 'Unknown Album');
  const trackNum = parseInt(params.get('track') || '0', 10) || 0;
  const title = safeSegment(params.get('title'), safeSegment(path.basename(origName, ext), 'Untitled'));
  const baseName = (trackNum ? String(trackNum).padStart(2, '0') + ' - ' : '') + title;

  const dir = path.join(MUSIC_DIR, artist, album);
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, baseName + ext);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${baseName} (${i})${ext}`);

  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let failed = false;

  const abort = (status, message) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(tmp, { force: true }, () => {});
    if (!res.headersSent) json(res, status, { error: message });
    req.destroy();
  };

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD) return abort(413, 'file too large');
    if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
  });
  req.on('error', () => abort(400, 'upload interrupted'));
  out.on('error', (err) => abort(500, err.message));
  req.on('end', () => {
    if (failed) return;
    out.end(() => {
      try {
        fs.renameSync(tmp, dest);
      } catch (err) {
        return abort(500, err.message);
      }
      library.scan();
      const rel = path.relative(MUSIC_DIR, dest);
      const id = require('./lib/scanner').trackId(rel);
      // The form fields are authoritative: store them as edits so they win
      // over whatever tags (or lack of tags) the file itself carries.
      const edits = {};
      for (const key of ['title', 'artist', 'album', 'year', 'genre']) {
        const value = params.get(key);
        if (value && value.trim()) edits[key] = value.trim();
      }
      if (trackNum) edits.track = trackNum;
      const track = Object.keys(edits).length ? library.updateTrack(id, edits) : library.get(id);
      json(res, 201, { ok: true, track });
    });
  });
}

function receiveArtwork(req, res, track) {
  const ext = ART_EXTS[(req.headers['content-type'] || '').split(';')[0].trim()];
  if (!ext) return json(res, 400, { error: 'send an image (jpeg, png, webp, or gif) as the request body' });
  fs.mkdirSync(ART_DIR, { recursive: true });
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) { json(res, 413, { error: 'image too large (10 MB max)' }); req.destroy(); }
    else chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    if (!size) return json(res, 400, { error: 'empty body' });
    const existing = customArtPath(track.id);
    if (existing) fs.rmSync(existing, { force: true });
    fs.writeFileSync(path.join(ART_DIR, track.id + ext), Buffer.concat(chunks));
    artCache.delete(track.id);
    customArtIds.add(track.id);
    json(res, 200, { ok: true });
  });
}

// ---- API routing ----------------------------------------------------------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, id, sub] = parts;

  if (resource === 'admin') {
    if (id === 'upload' && req.method === 'POST') return receiveUpload(req, res, url);
    if (id === 'tracks' && sub === 'delete' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.trackIds) ? body.trackIds.slice(0, 5000) : [];
      let deleted = 0;
      const failed = [];
      for (const tid of ids) {
        const track = library.get(tid);
        if (!track) { failed.push(tid); continue; }
        try {
          fs.rmSync(library.absPath(track));
        } catch {
          failed.push(tid);
          continue;
        }
        const art = customArtPath(tid);
        if (art) fs.rmSync(art, { force: true });
        artCache.delete(tid);
        customArtIds.delete(tid);
        deleted++;
      }
      library.scan();
      store.pruneMissing((tid) => !!library.get(tid));
      return json(res, 200, { ok: true, deleted, failed });
    }
    if (id === 'tracks' && sub) {
      const track = library.get(sub);
      if (!track) return notFound(res);
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        return json(res, 200, library.updateTrack(sub, body));
      }
      if (req.method === 'DELETE') {
        try {
          fs.rmSync(library.absPath(track));
        } catch (err) {
          return json(res, 500, { error: err.message });
        }
        const art = customArtPath(sub);
        if (art) fs.rmSync(art, { force: true });
        artCache.delete(sub);        customArtIds.delete(sub);
        library.scan();
        store.pruneMissing((tid) => !!library.get(tid));
        return json(res, 200, { ok: true });
      }
    }
    if (id === 'artwork' && sub) {
      const track = library.get(sub);
      if (!track) return notFound(res);
      if (req.method === 'POST') return receiveArtwork(req, res, track);
      if (req.method === 'DELETE') {
        const art = customArtPath(sub);
        if (art) fs.rmSync(art, { force: true });
        artCache.delete(sub);        customArtIds.delete(sub);
        return json(res, 200, { ok: true });
      }
    }
    return notFound(res);
  }

  if (resource === 'library' && req.method === 'GET') {
    const albums = library.albums();
    for (const album of albums) {
      const custom = album.trackIds.find((tid) => customArtIds.has(tid));
      if (custom) album.coverTrackId = custom;
    }
    return json(res, 200, {
      tracks: library.list(),
      albums,
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

  if (resource === 'download' && id && req.method === 'GET') {
    const track = library.get(id);
    if (!track) return notFound(res);
    return streamTrack(req, res, track, { download: true });
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
  if (pathname === '/admin') pathname = '/admin.html';
  if (pathname === '/login') pathname = '/login.html';
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

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const session = gate(req, res, url);
  if (session === undefined) return; // gate already responded

  if (url.pathname.startsWith('/api/auth/')) {
    const action = url.pathname.split('/')[3];
    handleAuthApi(req, res, url, action, session).catch((err) => {
      if (!res.headersSent) json(res, 400, { error: err.message });
      else res.destroy();
    });
  } else if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      if (!res.headersSent) json(res, 400, { error: err.message });
      else res.destroy();
    });
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(res, url.pathname);
  } else {
    json(res, 405, { error: 'method not allowed' });
  }
}

const server = TLS_CERT && TLS_KEY
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handleRequest)
  : http.createServer(handleRequest);

const scanResult = library.scan();
store.pruneMissing((tid) => !!library.get(tid));

server.listen(PORT, HOST, () => {
  const scheme = TLS_CERT && TLS_KEY ? 'https' : 'http';
  console.log(`♫ local-spotify`);
  console.log(`  music dir : ${MUSIC_DIR}`);
  console.log(`  library   : ${scanResult.total} tracks (${scanResult.added} added, ${scanResult.removed} removed, scanned in ${scanResult.ms} ms)`);
  console.log(`  listening : ${scheme}://${HOST}:${PORT}`);
  if (AUTH_ENABLED) {
    console.log(`  auth      : on (listener${auth.hasPassword('admin') ? ' + admin' : ''} password)`);
    if (generatedPassword) {
      console.log(`  password  : ${generatedPassword}`);
      console.log(`              (generated now, shown only once — reset with "node tools/set-password.js")`);
    }
    if (!auth.hasPassword('admin')) {
      console.log(`  note      : no separate admin password — every login can use /admin.`);
      console.log(`              set one with "node tools/set-password.js --admin" before sharing.`);
    }
    if (scheme === 'http' && !LOOPBACK && !TRUST_PROXY) {
      console.log(`  warning   : plain HTTP beyond localhost — passwords travel unencrypted.`);
      console.log(`              use a tunnel/reverse proxy (see README) or set TLS_CERT/TLS_KEY.`);
    }
  } else {
    console.log(`  auth      : off (localhost only)`);
  }
  if (scanResult.total === 0) {
    console.log(`  tip       : drop audio files into ${MUSIC_DIR} (or set MUSIC_DIR=~/Music),`);
    console.log(`              or run "node tools/generate-samples.js" for demo tracks.`);
  }
});

process.on('SIGINT', () => { store.flush(); process.exit(0); });
process.on('SIGTERM', () => { store.flush(); process.exit(0); });
