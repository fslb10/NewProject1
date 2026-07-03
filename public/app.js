'use strict';
/* Local Spotify — single-page client. Talks to the local API, streams audio
 * via <audio> with HTTP Range requests, and keeps playback state (queue,
 * shuffle, repeat) entirely in the browser. */

const audio = document.getElementById('audio');
const $ = (sel) => document.querySelector(sel);

const state = {
  tracks: new Map(),
  albums: [],
  artists: [],
  playlists: [],
  liked: new Set(),
  view: { name: 'home' },
  queue: [],          // array of track ids (play order)
  queuePos: -1,
  shuffle: false,
  repeat: 'off',      // off | all | one
  searchQuery: '',
};

function authCheck(r) {
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  return r;
}

const api = {
  async get(path) { const r = authCheck(await fetch(path)); if (!r.ok) throw new Error(`GET ${path}: ${r.status}`); return r.json(); },
  async send(method, path, body) {
    const r = authCheck(await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }));
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
    return r.json();
  },
};

// ------------------------------------------------------------------ helpers

function fmtTime(s) {
  if (!isFinite(s) || s <= 0) return '0:00';
  s = Math.round(s);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function esc(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function artUrl(trackId) { return `/api/artwork/${trackId}`; }

function currentTrack() {
  return state.queuePos >= 0 ? state.tracks.get(state.queue[state.queuePos]) : null;
}

// ------------------------------------------------------------------ data

async function loadLibrary() {
  const lib = await api.get('/api/library');
  state.tracks = new Map(lib.tracks.map((t) => [t.id, t]));
  state.albums = lib.albums;
  state.artists = lib.artists;
  state.playlists = lib.playlists;
  state.liked = new Set(lib.liked);
  state.musicDir = lib.musicDir;
  renderSidebarPlaylists();
}

// ------------------------------------------------------------------ playback

function playQueue(trackIds, startIndex = 0) {
  state.queue = [...trackIds];
  if (state.shuffle) {
    const first = state.queue.splice(startIndex, 1)[0];
    shuffleArray(state.queue);
    state.queue.unshift(first);
    state.queuePos = 0;
  } else {
    state.queuePos = startIndex;
  }
  playCurrent();
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function playCurrent() {
  const track = currentTrack();
  if (!track) return;
  audio.src = `/api/stream/${track.id}`;
  audio.play().catch(() => {});
  api.send('POST', '/api/events/play', { trackId: track.id }).catch(() => {});
  updateNowPlaying();
  updateMediaSession(track);
  renderQueue();
  refreshPlayingRows();
}

function next(auto = false) {
  if (!state.queue.length) return;
  if (auto && state.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (state.queuePos + 1 < state.queue.length) {
    state.queuePos++;
    playCurrent();
  } else if (state.repeat === 'all') {
    state.queuePos = 0;
    playCurrent();
  } else if (!auto) {
    state.queuePos = 0;
    playCurrent();
  }
}

function prev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  state.queuePos = state.queuePos > 0 ? state.queuePos - 1 : 0;
  playCurrent();
}

function togglePlay() {
  if (!audio.src) {
    const all = [...state.tracks.keys()];
    if (all.length) playQueue(all, 0);
    return;
  }
  if (audio.paused) audio.play(); else audio.pause();
}

function addNext(trackId) {
  if (state.queuePos < 0) return playQueue([trackId], 0);
  state.queue.splice(state.queuePos + 1, 0, trackId);
  renderQueue();
}

audio.addEventListener('ended', () => next(true));
audio.addEventListener('play', () => { $('#btn-play').textContent = '⏸'; });
audio.addEventListener('pause', () => { $('#btn-play').textContent = '▶'; });
audio.addEventListener('timeupdate', () => {
  const dur = audio.duration || (currentTrack() && currentTrack().duration) || 0;
  $('#time-cur').textContent = fmtTime(audio.currentTime);
  $('#time-dur').textContent = fmtTime(dur);
  if (!seekDragging && dur > 0) $('#seek').value = Math.round((audio.currentTime / dur) * 1000);
});
audio.addEventListener('loadedmetadata', () => {
  const track = currentTrack();
  if (track && isFinite(audio.duration) && audio.duration > 0 && Math.abs(audio.duration - track.duration) > 1) {
    track.duration = audio.duration;
    api.send('POST', `/api/tracks/${track.id}/duration`, { duration: audio.duration }).catch(() => {});
  }
});

let seekDragging = false;
$('#seek').addEventListener('input', () => { seekDragging = true; });
$('#seek').addEventListener('change', () => {
  const dur = audio.duration || (currentTrack() && currentTrack().duration) || 0;
  if (dur > 0) audio.currentTime = (Number($('#seek').value) / 1000) * dur;
  seekDragging = false;
});
$('#volume').addEventListener('input', () => {
  audio.volume = Number($('#volume').value) / 100;
  localStorage.setItem('volume', $('#volume').value);
});

function updateNowPlaying() {
  const track = currentTrack();
  const art = $('#np-art');
  const likeBtn = $('#np-like');
  const dlBtn = $('#np-dl');
  if (!track) {
    $('#np-title').textContent = 'Nothing playing';
    $('#np-artist').textContent = '';
    art.hidden = true;
    likeBtn.hidden = true;
    dlBtn.hidden = true;
    return;
  }
  $('#np-title').textContent = track.title;
  $('#np-artist').textContent = track.artist;
  art.src = artUrl(track.id);
  art.hidden = false;
  likeBtn.hidden = false;
  dlBtn.hidden = false;
  likeBtn.textContent = state.liked.has(track.id) ? '💚' : '♡';
  document.title = `${track.title} · ${track.artist} — Local Spotify`;
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork: [{ src: location.origin + artUrl(track.id), sizes: '300x300' }],
  });
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', prev);
  navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
}

function downloadTrack(trackId) {
  // A temporary <a download> keeps playback running while the file saves.
  const a = document.createElement('a');
  a.href = `/api/download/${trackId}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ------------------------------------------------------------------ likes

async function toggleLike(trackId) {
  if (state.liked.has(trackId)) {
    state.liked.delete(trackId);
    await api.send('DELETE', `/api/liked/${trackId}`).catch(() => state.liked.add(trackId));
  } else {
    state.liked.add(trackId);
    await api.send('PUT', `/api/liked/${trackId}`).catch(() => state.liked.delete(trackId));
  }
  updateNowPlaying();
  if (state.view.name === 'liked') render(); else refreshLikeButtons();
}

// ------------------------------------------------------------------ views

const viewEl = $('#view');

function setView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((el) =>
    el.classList.toggle('active', el.dataset.view === view.name));
  render();
}

function render() {
  const v = state.view;
  if (v.name === 'home') renderHome();
  else if (v.name === 'search') renderSearch();
  else if (v.name === 'library') renderLibrary();
  else if (v.name === 'liked') renderLiked();
  else if (v.name === 'album') renderAlbum(v.id);
  else if (v.name === 'artist') renderArtist(v.id);
  else if (v.name === 'playlist') renderPlaylist(v.id);
}

async function renderHome() {
  if (state.tracks.size === 0) {
    viewEl.innerHTML = `<div class="view-title">Home</div>
      <div class="empty-note">
        Your library is empty.<br><br>
        Drop audio files (MP3, FLAC, OGG, WAV…) into <code>${esc(state.musicDir || './music')}</code>
        and click <b>⟳ Rescan library</b> in the sidebar.<br>
        Or run <code>node tools/generate-samples.js</code> to create demo tracks.
      </div>`;
    return;
  }
  const home = await api.get('/api/home');
  const section = (title, tracks, extra) => tracks.length ? `
    <div class="section-title">${title}</div>
    ${trackTable(tracks.map((t) => t.id), { context: tracks.map((t) => t.id), extra })}` : '';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  for (const t of [...home.recentlyPlayed, ...home.mostPlayed, ...home.recentlyAdded]) {
    if (!state.tracks.has(t.id)) state.tracks.set(t.id, t);
  }
  viewEl.innerHTML = `<div class="view-title">${greeting}</div>
    ${section('Recently played', home.recentlyPlayed)}
    ${section('Most played', home.mostPlayed)}
    ${section('Recently added', home.recentlyAdded)}`;
  bindTrackTables();
}

function renderSearch() {
  viewEl.innerHTML = `<div class="view-title">Search</div>
    <input id="search-input" type="search" placeholder="What do you want to listen to?" value="${esc(state.searchQuery)}">
    <div id="search-results"></div>`;
  const input = $('#search-input');
  input.focus();
  let timer;
  input.addEventListener('input', () => {
    state.searchQuery = input.value;
    clearTimeout(timer);
    timer = setTimeout(runSearch, 180);
  });
  if (state.searchQuery) runSearch();

  async function runSearch() {
    const q = state.searchQuery.trim();
    const box = $('#search-results');
    if (!box) return;
    if (!q) { box.innerHTML = ''; return; }
    const r = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
    for (const t of r.tracks) if (!state.tracks.has(t.id)) state.tracks.set(t.id, t);
    box.innerHTML = `
      ${r.tracks.length ? `<div class="section-title">Songs</div>${trackTable(r.tracks.map((t) => t.id))}` : ''}
      ${r.albums.length ? `<div class="section-title">Albums</div>${albumGrid(r.albums)}` : ''}
      ${r.artists.length ? `<div class="section-title">Artists</div>${artistGrid(r.artists)}` : ''}
      ${!r.tracks.length && !r.albums.length && !r.artists.length ? '<div class="empty-note">No results.</div>' : ''}`;
    bindTrackTables();
    bindCards();
  }
}

function renderLibrary() {
  viewEl.innerHTML = `<div class="view-title">Your Library</div>
    <div class="section-title">Albums</div>${albumGrid(state.albums)}
    <div class="section-title">Artists</div>${artistGrid(state.artists)}
    <div class="section-title">All songs · ${state.tracks.size}</div>
    ${trackTable([...state.tracks.keys()])}`;
  bindTrackTables();
  bindCards();
}

function renderLiked() {
  const ids = [...state.liked].filter((id) => state.tracks.has(id));
  viewEl.innerHTML = `
    <div class="detail-head">
      <img src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#3822a5"/><text x="150" y="165" font-size="110" text-anchor="middle" fill="white">💚</text></svg>')}" alt="">
      <div>
        <div class="dh-type">PLAYLIST</div>
        <h1>Liked Songs</h1>
        <div class="dh-sub">${ids.length} songs</div>
      </div>
    </div>
    <div class="detail-actions">${ids.length ? '<button class="big-play" id="detail-play">▶</button>' : ''}</div>
    ${ids.length ? trackTable(ids) : '<div class="empty-note">Songs you like will appear here. Click ♡ on any track.</div>'}`;
  if (ids.length) $('#detail-play').addEventListener('click', () => playQueue(ids, 0));
  bindTrackTables();
}

function renderAlbum(albumId) {
  const album = state.albums.find((a) => a.id === albumId);
  if (!album) return setView({ name: 'library' });
  viewEl.innerHTML = `
    <div class="detail-head">
      <img src="${artUrl(album.coverTrackId)}" alt="">
      <div>
        <div class="dh-type">ALBUM</div>
        <h1>${esc(album.name)}</h1>
        <div class="dh-sub">${esc(album.artist)}${album.year ? ' · ' + esc(album.year) : ''} · ${album.trackIds.length} songs, ${fmtTime(album.duration)}</div>
      </div>
    </div>
    <div class="detail-actions"><button class="big-play" id="detail-play">▶</button></div>
    ${trackTable(album.trackIds, { numbers: true })}`;
  $('#detail-play').addEventListener('click', () => playQueue(album.trackIds, 0));
  bindTrackTables();
}

function renderArtist(artistId) {
  const artist = state.artists.find((a) => a.id === artistId);
  if (!artist) return setView({ name: 'library' });
  const albums = state.albums.filter((a) => a.artist === artist.name);
  const trackIds = [...state.tracks.values()]
    .filter((t) => (t.albumArtist || t.artist) === artist.name)
    .map((t) => t.id);
  viewEl.innerHTML = `
    <div class="detail-head">
      <img src="${trackIds.length ? artUrl(trackIds[0]) : ''}" alt="" style="border-radius:50%">
      <div>
        <div class="dh-type">ARTIST</div>
        <h1>${esc(artist.name)}</h1>
        <div class="dh-sub">${artist.trackCount} songs · ${artist.albumCount} albums</div>
      </div>
    </div>
    <div class="detail-actions"><button class="big-play" id="detail-play">▶</button></div>
    <div class="section-title">Albums</div>${albumGrid(albums)}
    <div class="section-title">Songs</div>${trackTable(trackIds)}`;
  $('#detail-play').addEventListener('click', () => playQueue(trackIds, 0));
  bindTrackTables();
  bindCards();
}

function renderPlaylist(playlistId) {
  const playlist = state.playlists.find((p) => p.id === playlistId);
  if (!playlist) return setView({ name: 'home' });
  const ids = playlist.trackIds.filter((id) => state.tracks.has(id));
  const duration = ids.reduce((sum, id) => sum + (state.tracks.get(id).duration || 0), 0);
  viewEl.innerHTML = `
    <div class="detail-head">
      <img src="${ids.length ? artUrl(ids[0]) : 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#333"/><text x="150" y="170" font-size="110" text-anchor="middle" fill="#777">♫</text></svg>')}" alt="">
      <div>
        <div class="dh-type">PLAYLIST</div>
        <h1>${esc(playlist.name)}</h1>
        <div class="dh-sub">${ids.length} songs${duration ? ', ' + fmtTime(duration) : ''}</div>
      </div>
    </div>
    <div class="detail-actions">
      ${ids.length ? '<button class="big-play" id="detail-play">▶</button>' : ''}
      <button class="ghost-btn" id="pl-rename">Rename</button>
    </div>
    ${ids.length ? trackTable(ids, { playlistId }) : '<div class="empty-note">Empty playlist — use the ＋ button on any track to add songs.</div>'}`;
  if (ids.length) $('#detail-play').addEventListener('click', () => playQueue(ids, 0));
  $('#pl-rename').addEventListener('click', async () => {
    const name = prompt('Playlist name:', playlist.name);
    if (name && name.trim()) {
      const updated = await api.send('PUT', `/api/playlists/${playlist.id}`, { name });
      Object.assign(playlist, updated);
      renderSidebarPlaylists();
      render();
    }
  });
  bindTrackTables();
}

// ------------------------------------------------------------------ shared renderers

function trackTable(trackIds, opts = {}) {
  const rows = trackIds.map((id, i) => {
    const t = state.tracks.get(id);
    if (!t) return '';
    return `<tr class="track-row" data-id="${t.id}" data-idx="${i}">
      <td class="t-num">${opts.numbers && t.track ? t.track : i + 1}</td>
      <td class="t-title">${esc(t.title)}</td>
      <td class="t-artist" data-artist>${esc(t.artist)}</td>
      <td class="t-album" data-album>${esc(t.album)}</td>
      <td class="t-actions">
        <button data-act="like" class="${state.liked.has(t.id) ? 'liked' : ''}" title="Like">${state.liked.has(t.id) ? '💚' : '♡'}</button>
        <button data-act="next" title="Play next">⏭</button>
        <button data-act="add" title="Add to playlist">＋</button>
        <button data-act="dl" title="Download">⬇</button>
        ${opts.playlistId ? '<button data-act="remove" title="Remove from playlist">✕</button>' : ''}
      </td>
      <td class="t-dur">${fmtTime(t.duration)}</td>
    </tr>`;
  }).join('');
  return `<table class="track-table" data-context="${trackIds.join(',')}" ${opts.playlistId ? `data-playlist="${opts.playlistId}"` : ''}>
    <thead><tr><th>#</th><th>TITLE</th><th>ARTIST</th><th>ALBUM</th><th></th><th style="text-align:right">⏱</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function bindTrackTables() {
  document.querySelectorAll('.track-table').forEach((table) => {
    const context = table.dataset.context ? table.dataset.context.split(',') : [];
    const playlistId = table.dataset.playlist;
    table.addEventListener('click', async (e) => {
      const row = e.target.closest('.track-row');
      if (!row) return;
      const id = row.dataset.id;
      const btn = e.target.closest('button[data-act]');
      if (btn) {
        e.stopPropagation();
        if (btn.dataset.act === 'like') return toggleLike(id);
        if (btn.dataset.act === 'next') return addNext(id);
        if (btn.dataset.act === 'add') return addToPlaylistPrompt(id);
        if (btn.dataset.act === 'dl') return downloadTrack(id);
        if (btn.dataset.act === 'remove' && playlistId) {
          const playlist = state.playlists.find((p) => p.id === playlistId);
          const trackIds = playlist.trackIds.filter((t) => t !== id);
          const updated = await api.send('PUT', `/api/playlists/${playlistId}`, { trackIds });
          Object.assign(playlist, updated);
          return render();
        }
        return;
      }
      if (e.target.closest('[data-artist]')) {
        const artist = state.artists.find((a) => a.name === state.tracks.get(id).artist || a.name === state.tracks.get(id).albumArtist);
        if (artist) return setView({ name: 'artist', id: artist.id });
      }
      if (e.target.closest('[data-album]')) {
        const t = state.tracks.get(id);
        const album = state.albums.find((a) => a.name === t.album && a.artist === (t.albumArtist || t.artist));
        if (album) return setView({ name: 'album', id: album.id });
      }
      playQueue(context, Number(row.dataset.idx));
    });
  });
  refreshPlayingRows();
}

function refreshPlayingRows() {
  const track = currentTrack();
  document.querySelectorAll('.track-row').forEach((row) =>
    row.classList.toggle('playing', !!track && row.dataset.id === track.id));
}

function refreshLikeButtons() {
  document.querySelectorAll('.track-row').forEach((row) => {
    const btn = row.querySelector('button[data-act="like"]');
    if (!btn) return;
    const liked = state.liked.has(row.dataset.id);
    btn.textContent = liked ? '💚' : '♡';
    btn.classList.toggle('liked', liked);
  });
}

function albumGrid(albums) {
  if (!albums.length) return '<div class="empty-note">No albums.</div>';
  return `<div class="card-grid">${albums.map((a) => `
    <div class="card" data-album-id="${a.id}">
      <img src="${artUrl(a.coverTrackId)}" alt="" loading="lazy">
      <button class="card-play" data-play-album="${a.id}" title="Play">▶</button>
      <div class="card-title">${esc(a.name)}</div>
      <div class="card-sub">${esc(a.artist)}${a.year ? ' · ' + esc(a.year) : ''}</div>
    </div>`).join('')}</div>`;
}

function artistGrid(artists) {
  if (!artists.length) return '<div class="empty-note">No artists.</div>';
  return `<div class="card-grid">${artists.map((a) => {
    const track = [...state.tracks.values()].find((t) => (t.albumArtist || t.artist) === a.name);
    return `<div class="card" data-artist-id="${a.id}">
      <img src="${track ? artUrl(track.id) : ''}" alt="" loading="lazy" style="border-radius:50%">
      <div class="card-title">${esc(a.name)}</div>
      <div class="card-sub">${a.trackCount} songs</div>
    </div>`;
  }).join('')}</div>`;
}

function bindCards() {
  document.querySelectorAll('[data-play-album]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const album = state.albums.find((a) => a.id === btn.dataset.playAlbum);
      if (album) playQueue(album.trackIds, 0);
    }));
  document.querySelectorAll('.card[data-album-id]').forEach((card) =>
    card.addEventListener('click', () => setView({ name: 'album', id: card.dataset.albumId })));
  document.querySelectorAll('.card[data-artist-id]').forEach((card) =>
    card.addEventListener('click', () => setView({ name: 'artist', id: card.dataset.artistId })));
}

// ------------------------------------------------------------------ playlists UI

function renderSidebarPlaylists() {
  const box = $('#playlist-list');
  box.innerHTML = state.playlists.map((p) => `
    <button class="pl-item" data-id="${p.id}">
      <span>${esc(p.name)}</span>
      <span class="pl-del" data-del="${p.id}" title="Delete">✕</span>
    </button>`).join('');
  box.querySelectorAll('.pl-item').forEach((el) =>
    el.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        if (!confirm('Delete this playlist?')) return;
        await api.send('DELETE', `/api/playlists/${del.dataset.del}`);
        state.playlists = state.playlists.filter((p) => p.id !== del.dataset.del);
        renderSidebarPlaylists();
        if (state.view.name === 'playlist' && state.view.id === del.dataset.del) setView({ name: 'home' });
        return;
      }
      setView({ name: 'playlist', id: el.dataset.id });
    }));
}

async function addToPlaylistPrompt(trackId) {
  if (!state.playlists.length) {
    const name = prompt('No playlists yet. Name for a new playlist:', 'My Playlist');
    if (!name) return;
    const playlist = await api.send('POST', '/api/playlists', { name });
    state.playlists.push(playlist);
    renderSidebarPlaylists();
    await api.send('POST', `/api/playlists/${playlist.id}/tracks`, { trackId });
    playlist.trackIds.push(trackId);
    return;
  }
  const names = state.playlists.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
  const answer = prompt(`Add to which playlist?\n${names}\n\nEnter a number (or a new name to create one):`);
  if (!answer) return;
  const idx = parseInt(answer, 10) - 1;
  let playlist = state.playlists[idx];
  if (!playlist) {
    playlist = await api.send('POST', '/api/playlists', { name: answer });
    state.playlists.push(playlist);
    renderSidebarPlaylists();
  }
  const updated = await api.send('POST', `/api/playlists/${playlist.id}/tracks`, { trackId });
  Object.assign(playlist, updated);
  if (state.view.name === 'playlist' && state.view.id === playlist.id) render();
}

// ------------------------------------------------------------------ queue panel

function renderQueue() {
  const panel = $('#queue-panel');
  if (panel.hidden) return;
  const list = $('#queue-list');
  list.innerHTML = state.queue.map((id, i) => {
    const t = state.tracks.get(id);
    if (!t) return '';
    return `<div class="q-item ${i === state.queuePos ? 'playing' : ''}" data-idx="${i}">
      <div style="min-width:0">
        <div class="q-title">${esc(t.title)}</div>
        <div class="q-artist">${esc(t.artist)}</div>
      </div>
      <span class="q-artist">${fmtTime(t.duration)}</span>
    </div>`;
  }).join('') || '<div class="empty-note" style="padding:16px">Queue is empty.</div>';
  list.querySelectorAll('.q-item').forEach((el) =>
    el.addEventListener('click', () => { state.queuePos = Number(el.dataset.idx); playCurrent(); }));
}

// ------------------------------------------------------------------ global bindings

document.querySelectorAll('.nav-item').forEach((el) =>
  el.addEventListener('click', () => setView({ name: el.dataset.view })));

$('#btn-play').addEventListener('click', togglePlay);
$('#btn-next').addEventListener('click', () => next(false));
$('#btn-prev').addEventListener('click', prev);
$('#btn-shuffle').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  $('#btn-shuffle').classList.toggle('on', state.shuffle);
});
$('#btn-repeat').addEventListener('click', () => {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  const btn = $('#btn-repeat');
  btn.classList.toggle('on', state.repeat !== 'off');
  btn.textContent = state.repeat === 'one' ? '🔂' : '🔁';
});
$('#np-like').addEventListener('click', () => {
  const track = currentTrack();
  if (track) toggleLike(track.id);
});
$('#np-dl').addEventListener('click', () => {
  const track = currentTrack();
  if (track) downloadTrack(track.id);
});
$('#btn-queue').addEventListener('click', () => {
  const panel = $('#queue-panel');
  panel.hidden = !panel.hidden;
  renderQueue();
});
$('#queue-close').addEventListener('click', () => { $('#queue-panel').hidden = true; });

$('#new-playlist').addEventListener('click', async () => {
  const name = prompt('Playlist name:', 'My Playlist');
  if (!name) return;
  const playlist = await api.send('POST', '/api/playlists', { name });
  state.playlists.push(playlist);
  renderSidebarPlaylists();
  setView({ name: 'playlist', id: playlist.id });
});

$('#rescan').addEventListener('click', async () => {
  const btn = $('#rescan');
  btn.textContent = '⟳ Scanning…';
  try {
    await api.send('POST', '/api/rescan');
    await loadLibrary();
    render();
  } finally {
    btn.textContent = '⟳ Rescan library';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowRight' && e.shiftKey) next(false);
  else if (e.code === 'ArrowLeft' && e.shiftKey) prev();
  else if (e.key === '/') { e.preventDefault(); setView({ name: 'search' }); }
});

// ------------------------------------------------------------------ boot

async function setupAuthUi() {
  try {
    const me = await api.get('/api/auth/me');
    if (!me.authEnabled) return;
    if (me.adminConfigured && me.role !== 'admin') $('#admin-link').hidden = true;
    const signOut = document.createElement('button');
    signOut.id = 'sign-out';
    signOut.textContent = '⏻ Sign out';
    signOut.addEventListener('click', async () => {
      await api.send('POST', '/api/auth/logout');
      location.href = '/login';
    });
    document.querySelector('.sidebar-footer').appendChild(signOut);
  } catch { /* redirecting to /login */ }
}

(async function boot() {
  audio.volume = Number(localStorage.getItem('volume') || 80) / 100;
  $('#volume').value = audio.volume * 100;
  await setupAuthUi();
  await loadLibrary();
  setView({ name: 'home' });
})();
