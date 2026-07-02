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

| Env var     | Default       | Meaning                                   |
|-------------|---------------|-------------------------------------------|
| `MUSIC_DIR` | `./music`     | Folder scanned (recursively) for audio     |
| `DATA_DIR`  | `./data`      | Where the index, playlists, history live   |
| `PORT`      | `8888`        | HTTP port                                  |
| `HOST`      | `127.0.0.1`   | Bind address (`0.0.0.0` to allow your LAN) |

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
server.js               HTTP server: API, range streaming, uploads, static files
lib/tags.js             MP3/FLAC/OGG/WAV metadata readers (pure JS)
lib/scanner.js          Library scan + incremental index + metadata overrides
lib/store.js            Playlists, likes, play history (data/state.json)
public/                 Player SPA (index.html, app.js, styles.css)
public/admin.*          Admin dashboard (upload, edit info, artwork, delete)
tools/generate-samples.js  Synthesizes a small demo library into ./music
```
