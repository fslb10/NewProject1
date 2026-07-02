'use strict';
// User-state store: playlists, liked songs, and the playback-event log
// (recently played + play counts). Persisted to data/state.json with a
// debounced write. Local stand-in for Spotify's playlist service and its
// Kafka playback-event pipeline.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HISTORY_LIMIT = 500;

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json');
    this.state = { playlists: [], liked: [], history: [], playCounts: {} };
    this._writeTimer = null;
    try {
      Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      /* first run */
    }
  }

  _persist() {
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
    }, 250);
  }

  flush() {
    clearTimeout(this._writeTimer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  // ---- playlists

  createPlaylist(name) {
    const playlist = {
      id: crypto.randomBytes(8).toString('hex'),
      name: (name || 'New Playlist').slice(0, 120),
      trackIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.state.playlists.push(playlist);
    this._persist();
    return playlist;
  }

  getPlaylist(id) {
    return this.state.playlists.find((p) => p.id === id);
  }

  updatePlaylist(id, { name, trackIds }) {
    const playlist = this.getPlaylist(id);
    if (!playlist) return null;
    if (typeof name === 'string' && name.trim()) playlist.name = name.trim().slice(0, 120);
    if (Array.isArray(trackIds)) playlist.trackIds = trackIds.filter((t) => typeof t === 'string');
    playlist.updatedAt = Date.now();
    this._persist();
    return playlist;
  }

  addToPlaylist(id, trackId) {
    const playlist = this.getPlaylist(id);
    if (!playlist) return null;
    if (!playlist.trackIds.includes(trackId)) {
      playlist.trackIds.push(trackId);
      playlist.updatedAt = Date.now();
      this._persist();
    }
    return playlist;
  }

  deletePlaylist(id) {
    const idx = this.state.playlists.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.state.playlists.splice(idx, 1);
    this._persist();
    return true;
  }

  // ---- liked songs

  like(trackId) {
    if (!this.state.liked.includes(trackId)) {
      this.state.liked.unshift(trackId);
      this._persist();
    }
  }

  unlike(trackId) {
    const idx = this.state.liked.indexOf(trackId);
    if (idx >= 0) {
      this.state.liked.splice(idx, 1);
      this._persist();
    }
  }

  // ---- playback events

  recordPlay(trackId) {
    this.state.history = this.state.history.filter((h) => h.trackId !== trackId);
    this.state.history.unshift({ trackId, at: Date.now() });
    if (this.state.history.length > HISTORY_LIMIT) this.state.history.length = HISTORY_LIMIT;
    this.state.playCounts[trackId] = (this.state.playCounts[trackId] || 0) + 1;
    this._persist();
  }

  pruneMissing(hasTrack) {
    for (const playlist of this.state.playlists) {
      playlist.trackIds = playlist.trackIds.filter(hasTrack);
    }
    this.state.liked = this.state.liked.filter(hasTrack);
    this.state.history = this.state.history.filter((h) => hasTrack(h.trackId));
    this._persist();
  }
}

module.exports = { Store };
