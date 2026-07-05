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

function playCurrent(opts = {}) {
  const track = currentTrack();
  if (!track) return;
  audio.src = `/api/stream/${track.id}`;
  if (opts.autoplay !== false) {
    audio.play().catch(() => {});
    api.send('POST', '/api/events/play', { trackId: track.id }).catch(() => {});
  }
  updateNowPlaying();
  updateMediaSession(track);
  renderQueue();
  refreshPlayingRows();
  saveResume();
}

// ---- resume where you left off (per browser, via localStorage)

function saveResume() {
  if (state.queuePos < 0) return;
  try {
    localStorage.setItem('resume', JSON.stringify({
      queue: state.queue,
      currentId: state.queue[state.queuePos],
      time: audio.currentTime || 0,
      shuffle: state.shuffle,
      repeat: state.repeat,
    }));
  } catch { /* storage full/blocked */ }
}

function restoreSession() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem('resume')); } catch { return; }
  if (!saved || !Array.isArray(saved.queue)) return;
  const queue = saved.queue.filter((id) => state.tracks.has(id));
  if (!queue.length) return;
  state.queue = queue;
  const idx = queue.indexOf(saved.currentId);
  state.queuePos = idx >= 0 ? idx : 0;
  state.shuffle = !!saved.shuffle;
  state.repeat = saved.repeat === 'all' || saved.repeat === 'one' ? saved.repeat : 'off';
  syncTransportUi();
  const track = currentTrack();
  audio.src = `/api/stream/${track.id}`;
  const seekTo = Number(saved.time) || 0;
  if (seekTo > 1) {
    audio.addEventListener('loadedmetadata', function once() {
      audio.removeEventListener('loadedmetadata', once);
      if (seekTo < (audio.duration || Infinity) - 2) audio.currentTime = seekTo;
    });
  }
  updateNowPlaying();
  updateMediaSession(track);
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
audio.addEventListener('play', () => { $('#btn-play').textContent = '⏸'; $('#npf-play').textContent = '⏸'; });
audio.addEventListener('pause', () => { $('#btn-play').textContent = '▶'; $('#npf-play').textContent = '▶'; });
audio.addEventListener('timeupdate', () => {
  const dur = audio.duration || (currentTrack() && currentTrack().duration) || 0;
  $('#time-cur').textContent = fmtTime(audio.currentTime);
  $('#time-dur').textContent = fmtTime(dur);
  if (!seekDragging && dur > 0) $('#seek').value = Math.round((audio.currentTime / dur) * 1000);
  if (!$('#np-full').hidden && dur > 0) {
    $('#npf-cur').textContent = fmtTime(audio.currentTime);
    $('#npf-dur').textContent = fmtTime(dur);
    $('#npf-seek').value = Math.round((audio.currentTime / dur) * 1000);
  }
});
audio.addEventListener('loadedmetadata', () => {
  const track = currentTrack();
  if (track && isFinite(audio.duration) && audio.duration > 0 && Math.abs(audio.duration - track.duration) > 1) {
    track.duration = audio.duration;
    api.send('POST', `/api/tracks/${track.id}/duration`, { duration: audio.duration }).catch(() => {});
  }
});

let lastResumeSave = 0;
audio.addEventListener('timeupdate', () => {
  if (Date.now() - lastResumeSave > 5000) { lastResumeSave = Date.now(); saveResume(); }
});
audio.addEventListener('pause', saveResume);
window.addEventListener('beforeunload', saveResume);

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
  if (!$('#np-full').hidden) updateNpFull();
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

// ------------------------------------------------------------------ popup menu

let menuEl = null;

function closeMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
}

function showMenu(items, x, y) {
  closeMenu();
  menuEl = document.createElement('div');
  menuEl.className = 'ctx-menu';
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menuEl.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      item.action();
    });
    menuEl.appendChild(btn);
  }
  document.body.appendChild(menuEl);
  const rect = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + 'px';
  menuEl.style.top = Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + 'px';
}

document.addEventListener('click', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('scroll', closeMenu, true);
window.addEventListener('resize', closeMenu);

function openPlaylistChooser(trackId, x, y) {
  const items = state.playlists.map((p) => ({
    label: `♫ ${p.name}`,
    action: async () => {
      const updated = await api.send('POST', `/api/playlists/${p.id}/tracks`, { trackId });
      Object.assign(p, updated);
      if (state.view.name === 'playlist' && state.view.id === p.id) render();
    },
  }));
  if (items.length) items.push({ sep: true });
  items.push({
    label: '＋ New playlist…',
    action: async () => {
      const name = prompt('Playlist name:', 'My Playlist');
      if (!name) return;
      const playlist = await api.send('POST', '/api/playlists', { name });
      state.playlists.push(playlist);
      renderSidebarPlaylists();
      const updated = await api.send('POST', `/api/playlists/${playlist.id}/tracks`, { trackId });
      Object.assign(playlist, updated);
    },
  });
  showMenu(items, x, y);
}

function goToAlbum(t) {
  const album = state.albums.find((a) => a.name === t.album && a.artist === (t.albumArtist || t.artist));
  if (album) setView({ name: 'album', id: album.id });
}

function goToArtist(t) {
  const artist = state.artists.find((a) => a.name === (t.albumArtist || t.artist) || a.name === t.artist);
  if (artist) setView({ name: 'artist', id: artist.id });
}

function openTrackMenu(t, ctx, x, y) {
  const items = [
    { label: '▶  Play', action: () => playQueue(ctx.context, ctx.index) },
    { label: '⏭  Play next', action: () => addNext(t.id) },
    { label: '＋  Add to playlist', action: () => openPlaylistChooser(t.id, x, y) },
    { label: state.liked.has(t.id) ? '💔  Remove from Liked' : '💚  Add to Liked Songs', action: () => toggleLike(t.id) },
    { label: '⬇  Download', action: () => downloadTrack(t.id) },
    { sep: true },
    { label: '💿  Go to album', action: () => goToAlbum(t) },
    { label: '👤  Go to artist', action: () => goToArtist(t) },
  ];
  if (ctx.playlistId) {
    items.push({ sep: true });
    items.push({ label: '✕  Remove from this playlist', action: () => removeFromPlaylist(ctx.playlistId, t.id) });
  }
  showMenu(items, x, y);
}

async function removeFromPlaylist(playlistId, trackId) {
  const playlist = state.playlists.find((p) => p.id === playlistId);
  if (!playlist) return;
  const updated = await api.send('PUT', `/api/playlists/${playlistId}`, {
    trackIds: playlist.trackIds.filter((tid) => tid !== trackId),
  });
  Object.assign(playlist, updated);
  if (state.view.name === 'playlist' && state.view.id === playlistId) render();
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
  document.querySelectorAll('.nav-item, .tab-item').forEach((el) =>
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
  const playlistCards = state.playlists.length ? `<div class="card-grid">${state.playlists.map((p) => {
    const coverId = p.trackIds.find((id) => state.tracks.has(id));
    return `<div class="card" data-playlist-id="${p.id}">
      <img src="${coverId ? artUrl(coverId) : 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#333"/><text x="150" y="170" font-size="110" text-anchor="middle" fill="#777">♫</text></svg>')}" alt="" loading="lazy">
      <div class="card-title">${esc(p.name)}</div>
      <div class="card-sub">${p.trackIds.length} songs</div>
    </div>`;
  }).join('')}</div>` : '<div class="empty-note">No playlists yet — use ⋯ on any track.</div>';
  viewEl.innerHTML = `<div class="view-title">Your Library</div>
    <div class="section-title">Playlists</div>${playlistCards}
    <div class="section-title">Albums</div>${albumGrid(state.albums)}
    <div class="section-title">Artists</div>${artistGrid(state.artists)}
    <div class="section-title">All songs · ${state.tracks.size}</div>
    ${trackTable([...state.tracks.keys()])}`;
  bindTrackTables();
  bindCards();
  document.querySelectorAll('.card[data-playlist-id]').forEach((card) =>
    card.addEventListener('click', () => setView({ name: 'playlist', id: card.dataset.playlistId })));
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
    return `<tr class="track-row" draggable="true" data-id="${t.id}" data-idx="${i}">
      <td class="t-num">${opts.numbers && t.track ? t.track : i + 1}</td>
      <td class="t-title">${esc(t.title)}</td>
      <td class="t-artist" data-artist>${esc(t.artist)}</td>
      <td class="t-album" data-album>${esc(t.album)}</td>
      <td class="t-actions">
        <button data-act="like" class="${state.liked.has(t.id) ? 'liked' : ''}" title="Like">${state.liked.has(t.id) ? '💚' : '♡'}</button>
        <button data-act="menu" title="More options">⋯</button>
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

    table.addEventListener('click', (e) => {
      const row = e.target.closest('.track-row');
      if (!row) return;
      const id = row.dataset.id;
      const t = state.tracks.get(id);
      const btn = e.target.closest('button[data-act]');
      if (btn) {
        e.stopPropagation();
        if (btn.dataset.act === 'like') return toggleLike(id);
        if (btn.dataset.act === 'menu') {
          const r = btn.getBoundingClientRect();
          return openTrackMenu(t, { context, index: Number(row.dataset.idx), playlistId }, r.left, r.bottom + 4);
        }
        return;
      }
      if (e.target.closest('[data-artist]')) return goToArtist(t);
      if (e.target.closest('[data-album]')) return goToAlbum(t);
      playQueue(context, Number(row.dataset.idx));
    });

    table.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.track-row');
      if (!row) return;
      e.preventDefault();
      const t = state.tracks.get(row.dataset.id);
      openTrackMenu(t, { context, index: Number(row.dataset.idx), playlistId }, e.clientX, e.clientY);
    });

    // drag: onto a sidebar playlist (any table), or reorder (playlist view)
    table.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.track-row');
      if (!row) return;
      e.dataTransfer.setData('text/track-id', row.dataset.id);
      e.dataTransfer.setData('text/track-idx', row.dataset.idx);
      e.dataTransfer.effectAllowed = playlistId ? 'move' : 'copy';
      row.classList.add('dragging');
    });
    table.addEventListener('dragend', () => {
      table.querySelectorAll('.dragging, .drag-over').forEach((el) =>
        el.classList.remove('dragging', 'drag-over'));
    });
    if (playlistId) {
      table.addEventListener('dragover', (e) => {
        const row = e.target.closest('.track-row');
        if (!row) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        table.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
        row.classList.add('drag-over');
      });
      table.addEventListener('drop', async (e) => {
        const row = e.target.closest('.track-row');
        if (!row) return;
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/track-idx'));
        const to = Number(row.dataset.idx);
        if (!Number.isFinite(from) || from === to) return;
        const playlist = state.playlists.find((p) => p.id === playlistId);
        if (!playlist) return;
        const ids = [...playlist.trackIds];
        const [moved] = ids.splice(from, 1);
        ids.splice(to, 0, moved);
        const updated = await api.send('PUT', `/api/playlists/${playlistId}`, { trackIds: ids });
        Object.assign(playlist, updated);
        render();
      });
    }
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
  box.querySelectorAll('.pl-item').forEach((el) => {
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
    });
    // drop a track from any list straight onto a playlist
    el.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('text/track-id')) return;
      e.preventDefault();
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const trackId = e.dataTransfer.getData('text/track-id');
      if (!trackId) return;
      const playlist = state.playlists.find((p) => p.id === el.dataset.id);
      if (!playlist) return;
      const updated = await api.send('POST', `/api/playlists/${playlist.id}/tracks`, { trackId });
      Object.assign(playlist, updated);
      if (state.view.name === 'playlist' && state.view.id === playlist.id) render();
    });
  });
}


// ------------------------------------------------------------------ queue panel

function renderQueue() {
  const panel = $('#queue-panel');
  if (panel.hidden) return;
  const list = $('#queue-list');
  list.innerHTML = state.queue.map((id, i) => {
    const t = state.tracks.get(id);
    if (!t) return '';
    return `<div class="q-item ${i === state.queuePos ? 'playing' : ''}" draggable="true" data-idx="${i}">
      <div style="min-width:0">
        <div class="q-title">${esc(t.title)}</div>
        <div class="q-artist">${esc(t.artist)}</div>
      </div>
      <span class="q-artist">${fmtTime(t.duration)}</span>
    </div>`;
  }).join('') || '<div class="empty-note" style="padding:16px">Queue is empty.</div>';
  list.querySelectorAll('.q-item').forEach((el) => {
    el.addEventListener('click', () => { state.queuePos = Number(el.dataset.idx); playCurrent(); });
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/queue-idx', el.dataset.idx);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () =>
      list.querySelectorAll('.dragging, .drag-over').forEach((n) => n.classList.remove('dragging', 'drag-over')));
    el.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('text/queue-idx')) return;
      e.preventDefault();
      list.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
      el.classList.add('drag-over');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/queue-idx'));
      const to = Number(el.dataset.idx);
      if (!Number.isFinite(from) || from === to) return;
      const playingId = state.queue[state.queuePos];
      const [moved] = state.queue.splice(from, 1);
      state.queue.splice(to, 0, moved);
      state.queuePos = state.queue.indexOf(playingId);
      saveResume();
      renderQueue();
    });
  });
}

// ------------------------------------------------------------------ global bindings

document.querySelectorAll('.nav-item, .tab-item').forEach((el) =>
  el.addEventListener('click', () => setView({ name: el.dataset.view })));

function syncTransportUi() {
  ['#btn-shuffle', '#npf-shuffle'].forEach((sel) => $(sel).classList.toggle('on', state.shuffle));
  ['#btn-repeat', '#npf-repeat'].forEach((sel) => {
    $(sel).classList.toggle('on', state.repeat !== 'off');
    $(sel).textContent = state.repeat === 'one' ? '🔂' : '🔁';
  });
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  syncTransportUi();
  saveResume();
}

function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  syncTransportUi();
  saveResume();
}

$('#btn-play').addEventListener('click', togglePlay);
$('#btn-next').addEventListener('click', () => next(false));
$('#btn-prev').addEventListener('click', prev);
$('#btn-shuffle').addEventListener('click', toggleShuffle);
$('#btn-repeat').addEventListener('click', cycleRepeat);
$('#np-like').addEventListener('click', () => {
  const track = currentTrack();
  if (track) toggleLike(track.id);
});
$('#np-dl').addEventListener('click', () => {
  const track = currentTrack();
  if (track) downloadTrack(track.id);
});

// ---- full-screen now playing

function openNpFull() {
  if (!currentTrack()) return;
  updateNpFull();
  $('#np-full').hidden = false;
}

function updateNpFull() {
  const track = currentTrack();
  if (!track) { $('#np-full').hidden = true; return; }
  $('#npf-art').src = artUrl(track.id);
  $('#npf-title').textContent = track.title;
  $('#npf-artist').textContent = `${track.artist} · ${track.album}`;
  $('#npf-like').textContent = state.liked.has(track.id) ? '💚' : '♡';
  $('#npf-play').textContent = audio.paused ? '▶' : '⏸';
  syncTransportUi();
}

$('.now-playing').addEventListener('click', (e) => {
  if (e.target.closest('button')) return; // like/download keep their own actions
  openNpFull();
});
$('#npf-close').addEventListener('click', () => { $('#np-full').hidden = true; });
$('#npf-play').addEventListener('click', togglePlay);
$('#npf-next').addEventListener('click', () => next(false));
$('#npf-prev').addEventListener('click', prev);
$('#npf-shuffle').addEventListener('click', toggleShuffle);
$('#npf-repeat').addEventListener('click', cycleRepeat);
$('#npf-like').addEventListener('click', () => {
  const track = currentTrack();
  if (track) toggleLike(track.id).then(updateNpFull);
});
$('#npf-dl').addEventListener('click', () => {
  const track = currentTrack();
  if (track) downloadTrack(track.id);
});
$('#npf-seek').addEventListener('change', () => {
  const dur = audio.duration || (currentTrack() && currentTrack().duration) || 0;
  if (dur > 0) audio.currentTime = (Number($('#npf-seek').value) / 1000) * dur;
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
  else if (e.key === 'Escape') $('#np-full').hidden = true;
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

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

(async function boot() {
  audio.volume = Number(localStorage.getItem('volume') || 80) / 100;
  $('#volume').value = audio.volume * 100;
  await setupAuthUi();
  await loadLibrary();
  restoreSession();
  setView({ name: 'home' });
})();
