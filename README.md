# Local Spotify

A private, self-contained music streaming app that runs **entirely on your machine**.
No accounts, no telemetry, no network calls to anyone — just Node.js (18+), your music
folder, and a browser. Zero npm dependencies.

```
node tools/generate-samples.js   # optional: create 10 synthesized demo tracks
node server.js                   # serve ./music on http://127.0.0.1:8888
```

Then open <http://127.0.0.1:8888>. To use your real library:

```
MUSIC_DIR=~/Music node server.js
```

| Env var          | Default     | Meaning                                        |
|------------------|-------------|------------------------------------------------|
| `MUSIC_DIR`      | `./music`   | Folder scanned (recursively) for audio          |
| `DATA_DIR`       | `./data`    | Where the index, playlists, history live        |
| `PORT`           | `8888`      | Port                                            |
| `HOST`           | `127.0.0.1` | Bind address (`0.0.0.0` to allow other devices) |
| `PASSWORD`       | —           | Listener password (share this one)              |
| `ADMIN_PASSWORD` | —           | Admin password (guards `/admin` + admin API)    |
| `REQUIRE_AUTH`   | —           | `1` forces login even on localhost              |
| `TLS_CERT`/`TLS_KEY` | —       | PEM cert/key paths to serve HTTPS directly      |
| `TRUST_PROXY`    | —           | `1` when behind a reverse proxy/tunnel (trusts `X-Forwarded-*`) |

Supported formats: MP3, FLAC, OGG (Vorbis/Opus), WAV, plus M4A/AAC/WebM for
streaming (metadata falls back to file/folder names for those).

## Features

- **Library** — recursive scan with ID3v2/ID3v1, FLAC/OGG Vorbis-comment, and
  WAV INFO tag parsing; albums, artists, durations, embedded cover art
- **Streaming** — HTTP Range requests, so seeking is instant and the browser
  buffers progressively
- **Search** — instant multi-term search across songs, albums, artists
- **Playlists** — create, rename, reorder, delete; persisted to disk
- **Liked Songs** — one keystroke away, like the real thing
- **Home feed** — recently played, most played, recently added, driven by a
  local play-event log
- **Player** — queue panel, shuffle, repeat (off/all/one), seek, volume,
  Media Session API (OS media keys and lock-screen controls), keyboard
  shortcuts (`Space` play/pause, `Shift+←/→` prev/next, `/` search)
- **Admin dashboard** (<http://127.0.0.1:8888/admin>) — drag-and-drop upload
  with per-file metadata (files are filed into `Artist/Album/NN - Title.ext`),
  inline editing of title/artist/album/track/year/genre, custom cover-art
  upload, and track deletion. Manual edits are stored as overrides in the
  library index, so they win over file tags and survive rescans.

## How this maps to Spotify's real architecture

Spotify runs on hundreds of microservices, a global CDN, and a Kafka event
pipeline. This project collapses each of those concerns into a local
equivalent:

| Spotify (production)                                   | This app (local)                                        |
|--------------------------------------------------------|---------------------------------------------------------|
| Microservices for metadata, search, playlists, events   | Modules in `lib/` behind one HTTP server (`server.js`)  |
| Content ingestion + transcoding pipeline                | `lib/scanner.js` — walks `MUSIC_DIR`, parses tags, incremental mtime-based reindex |
| Cassandra / PostgreSQL / GCS storage                    | Your filesystem + JSON files in `DATA_DIR`              |
| CDN edge nodes streaming Ogg Vorbis with range requests | `GET /api/stream/:id` with HTTP Range support straight off disk |
| Adaptive bitrate tiers (96/160/320 kbps)                | Unnecessary — localhost has no bandwidth constraint; files stream at native quality |
| Kafka playback-event pipeline → recommendations         | `POST /api/events/play` → play log powering Recently/Most Played |
| Search service with distributed indexes                 | In-memory index over the scanned library (`/api/search`) |
| Playlist service with its own database                  | `lib/store.js` persisting to `data/state.json`          |
| Web/desktop client with local caching                   | `public/` single-page app; browser handles buffering/cache |

The privacy model is the architecture: everything binds to `127.0.0.1` by
default, all state lives in `DATA_DIR`, and there is no code path that talks
to the internet.

## Sharing outside your network

The app has everything it needs to go public: password login with sessions
(a shareable **listener** password plus a separate **admin** password),
login rate-limiting, native HTTPS, and reverse-proxy awareness. Auth turns
on automatically the moment the server binds to anything other than
localhost — if you haven't set a password yet, one is generated and printed
at startup.

Set your passwords once (stored as scrypt hashes in `data/auth.json`):

```
node tools/set-password.js            # listener password — share this one
node tools/set-password.js --admin    # admin password — keep to yourself
```

Then pick a route to the outside world, easiest first:

**1. Cloudflare Tunnel (recommended — free, HTTPS, no router changes)**

```
# one-time: install cloudflared, then
cloudflared tunnel --url http://127.0.0.1:8888
```

You get a public `https://….trycloudflare.com` URL immediately. For a
permanent URL on your own (sub)domain, create a named tunnel
(`cloudflared tunnel create music` + a DNS route — see Cloudflare's docs).
Run the server with `TRUST_PROXY=1 node server.js`.

**2. Tailscale (private-by-invitation rather than fully public)**

Install Tailscale on your machine and your friends' devices, share your
node, and they reach `http://your-machine:8888` over an encrypted mesh —
nothing is exposed to the open internet. `tailscale funnel 8888` upgrades
that to a real public HTTPS URL if you want one.

**3. Port forwarding + your own domain**

Forward TCP 443 on your router to this machine, point a DNS record at your
IP, and either terminate TLS in a reverse proxy (Caddy makes this two
lines) or hand the certs straight to the app:

```
# Caddyfile                          # …or native TLS, no proxy:
music.example.com {                  TLS_CERT=fullchain.pem TLS_KEY=privkey.pem \
    reverse_proxy 127.0.0.1:8888     HOST=0.0.0.0 PORT=443 node server.js
}
# then: TRUST_PROXY=1 HOST=127.0.0.1 node server.js
```

Never expose the plain-HTTP port directly to the internet — the startup log
warns you if you try, because passwords would travel unencrypted.

One legal note: this is your server, so what you share is on you. Streaming
your own recordings or licensed-for-sharing music to others is fine;
opening your ripped-CD collection to the whole internet generally isn't.
The listener password is the line between "friends & family" and "anyone."

## API

| Method & path                        | Purpose                                  |
|--------------------------------------|------------------------------------------|
| `GET  /api/library`                  | Full library: tracks, albums, artists, playlists, liked |
| `GET  /api/search?q=`                | Search songs/albums/artists              |
| `GET  /api/home`                     | Recently played / most played / recently added |
| `GET  /api/stream/:trackId`          | Audio stream (supports `Range`)          |
| `GET  /api/artwork/:trackId`         | Embedded cover art, or generated SVG     |
| `POST /api/rescan`                   | Incremental library rescan               |
| `GET/POST /api/playlists`            | List / create playlists                  |
| `GET/PUT/DELETE /api/playlists/:id`  | Read / update (rename, reorder) / delete |
| `POST /api/playlists/:id/tracks`     | Add a track                              |
| `PUT/DELETE /api/liked/:trackId`     | Like / unlike                            |
| `POST /api/events/play`              | Record a playback event                  |
| `POST /api/admin/upload?filename=&title=&artist=&album=&track=&year=&genre=` | Upload an audio file (raw body); filed into the music folder |
| `PATCH /api/admin/tracks/:id`        | Edit metadata (persisted as overrides)   |
| `DELETE /api/admin/tracks/:id`       | Delete the track's file from disk        |
| `POST/DELETE /api/admin/artwork/:id` | Upload / remove custom cover art (raw image body) |

## Layout

```
server.js               HTTP(S) server: API, range streaming, uploads, auth gate
lib/tags.js             MP3/FLAC/OGG/WAV metadata readers (pure JS)
lib/scanner.js          Library scan + incremental index + metadata overrides
lib/store.js            Playlists, likes, play history (data/state.json)
lib/auth.js             Passwords (scrypt), sessions, login rate limiting
public/                 Player SPA (index.html, app.js, styles.css)
public/admin.*          Admin dashboard (upload, edit info, artwork, delete)
public/login.html       Sign-in page
tools/generate-samples.js  Synthesizes a small demo library into ./music
tools/set-password.js   Set/reset listener and admin passwords
```
