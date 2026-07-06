'use strict';
/* Admin dashboard: upload audio files with metadata, edit track info,
 * manage artwork, delete tracks. */

const $ = (sel) => document.querySelector(sel);

let tracks = [];
const uploadQueue = []; // { file, fields: {…}, row, status }

function esc(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function fmtSize(bytes) {
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

async function apiJson(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  if (r.status === 403) { location.href = '/login?admin=1'; throw new Error('admin required'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${method} ${url}: ${r.status}`);
  return data;
}

// --------------------------------------------------------------- library

async function loadTracks() {
  const lib = await apiJson('GET', '/api/library');
  tracks = lib.tracks;
  $('#admin-stats').textContent =
    `${lib.tracks.length} tracks · ${lib.albums.length} albums · ${lib.artists.length} artists · folder: ${lib.musicDir}`;
  refreshVocabulary();
  renderManager();
}

// --------------------------------------------------------------- upload queue

// Guess metadata from a filename like "03 - Song Name.mp3"
function guessFields(file) {
  const base = file.name.replace(/\.[^.]+$/, '');
  const m = base.match(/^(\d{1,3})\s*[-._)\s]\s*(.+)$/);
  return {
    title: m ? m[2].trim() : base,
    artist: '',
    album: '',
    track: m ? String(parseInt(m[1], 10)) : '',
    year: '',
    genre: '',
    tags: '',
  };
}

const FIELD_DEFS = [
  ['title', 'TITLE'], ['artist', 'ARTIST'], ['album', 'ALBUM'],
  ['track', '#'], ['year', 'YEAR'], ['genre', 'GENRE'],
];

// ---- tag / genre vocabulary (starter set + everything already in the library)

const STARTER_TAGS = [
  'english', 'spanish', 'french', 'portuguese', 'italian', 'german',
  'hindi', 'arabic', 'korean', 'japanese', 'chinese',
  'chill', 'workout', 'party', 'focus', 'sleep', 'roadtrip',
  'romance', 'sad', 'happy', 'acoustic', 'instrumental', 'live', 'remix',
];
const STARTER_GENRES = [
  'Pop', 'Rock', 'Hip-Hop', 'R&B', 'Electronic', 'House', 'Jazz', 'Classical',
  'Country', 'Folk', 'Metal', 'Latin', 'Reggaeton', 'Reggae', 'Blues', 'Soul',
  'Ambient', 'Soundtrack',
];
const knownTags = new Set(STARTER_TAGS);
const knownGenres = new Set(STARTER_GENRES);

function refreshVocabulary() {
  for (const t of tracks) {
    for (const tag of t.tags || []) knownTags.add(tag);
    if (t.genre && t.genre.trim()) knownGenres.add(t.genre.trim());
  }
  const datalist = $('#genre-options');
  datalist.innerHTML = [...knownGenres].sort()
    .map((g) => `<option value="${esc(g)}"></option>`).join('');
}

// ---- lightweight popup menu (same look as the player's context menu)

let menuEl = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
function showMenu(items, x, y) {
  closeMenu();
  menuEl = document.createElement('div');
  menuEl.className = 'ctx-menu';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); item.action(); });
    menuEl.appendChild(btn);
  }
  document.body.appendChild(menuEl);
  const rect = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + 'px';
  menuEl.style.top = Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + 'px';
}
document.addEventListener('click', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ---- chip-based tag picker; reads/writes fields.tags as a comma string

function tagChipControl(container, fields, disabled) {
  const selected = () => (fields.tags || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const render = () => {
    container.innerHTML = '';
    const current = selected();
    for (const tag of current) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.innerHTML = `${esc(tag)}${disabled ? '' : ' <button title="Remove">✕</button>'}`;
      if (!disabled) {
        chip.querySelector('button').addEventListener('click', () => {
          fields.tags = current.filter((t) => t !== tag).join(', ');
          render();
        });
      }
      container.appendChild(chip);
    }
    if (!disabled) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'tag-add';
      add.textContent = '＋ tag';
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        const current = selected();
        const options = [...knownTags].filter((t) => !current.includes(t)).sort()
          .map((t) => ({ label: t, action: () => { fields.tags = [...current, t].join(', '); render(); } }));
        options.push({
          label: '＋ New tag…',
          action: () => {
            const tag = (prompt('New tag (e.g. spanish, workout):') || '').trim().toLowerCase();
            if (!tag) return;
            knownTags.add(tag);
            if (!current.includes(tag)) fields.tags = [...current, tag].join(', ');
            render();
          },
        });
        const r = add.getBoundingClientRect();
        showMenu(options, r.left, r.bottom + 4);
      });
      container.appendChild(add);
    }
  };
  render();
}

function addFiles(files) {
  for (const file of files) {
    if (!/\.(mp3|flac|ogg|oga|opus|wav|wave|m4a|aac|webm)$/i.test(file.name)) continue;
    if (uploadQueue.some((u) => u.file.name === file.name && u.file.size === file.size)) continue;
    const item = { file, fields: guessFields(file), status: 'pending' };
    // convenience: prefill artist/album from the previous row
    const prev = uploadQueue[uploadQueue.length - 1];
    if (prev) {
      item.fields.artist = item.fields.artist || prev.fields.artist;
      item.fields.album = item.fields.album || prev.fields.album;
      item.fields.year = item.fields.year || prev.fields.year;
      item.fields.genre = item.fields.genre || prev.fields.genre;
      item.fields.tags = item.fields.tags || prev.fields.tags;
    }
    uploadQueue.push(item);
  }
  renderQueue();
}

function renderQueue() {
  const box = $('#upload-queue');
  box.innerHTML = '';
  uploadQueue.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'up-row' + (item.status === 'done' ? ' done' : '');
    row.innerHTML = `
      <div class="up-file">
        <span class="up-name">${item.status === 'done' ? '✅ ' : '🎵 '}${esc(item.file.name)}</span>
        <span class="up-size">${fmtSize(item.file.size)}</span>
        ${uploadQueue.length > 1 && item.status === 'pending' ? '<button class="up-copy-all" title="Copy artist, album, year, genre and tags to every file below">⇊ apply to all</button>' : ''}
        <button class="up-remove" title="Remove">✕</button>
      </div>
      <div class="up-fields">
        ${FIELD_DEFS.map(([key, label]) => `
          <span><span class="field-label">${label}</span>
          <input data-field="${key}" ${key === 'genre' ? 'list="genre-options"' : ''} value="${esc(item.fields[key])}" placeholder="${label.toLowerCase()}" ${item.status !== 'pending' ? 'disabled' : ''}></span>`).join('')}
      </div>
      <div class="tag-row"><span class="field-label">TAGS</span><span class="tag-chips"></span></div>
      <div class="up-progress"><div></div></div>
      <div class="up-error" hidden></div>`;
    row.querySelectorAll('input[data-field]').forEach((input) =>
      input.addEventListener('input', () => { item.fields[input.dataset.field] = input.value; }));
    tagChipControl(row.querySelector('.tag-chips'), item.fields, item.status !== 'pending');
    const copyAll = row.querySelector('.up-copy-all');
    if (copyAll) {
      copyAll.addEventListener('click', () => {
        for (const other of uploadQueue) {
          if (other === item || other.status !== 'pending') continue;
          for (const key of ['artist', 'album', 'year', 'genre', 'tags']) other.fields[key] = item.fields[key];
        }
        renderQueue();
      });
    }
    row.querySelector('.up-remove').addEventListener('click', () => {
      uploadQueue.splice(idx, 1);
      renderQueue();
    });
    item.row = row;
    box.appendChild(row);
  });
  $('#upload-actions').hidden = uploadQueue.length === 0;
  const pending = uploadQueue.filter((u) => u.status === 'pending').length;
  $('#upload-all').disabled = pending === 0;
  $('#upload-status').textContent = pending ? `${pending} file${pending > 1 ? 's' : ''} ready` : '';
}

function uploadOne(item) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({ filename: item.file.name });
    for (const key of [...FIELD_DEFS.map(([k]) => k), 'tags']) {
      if (item.fields[key] && item.fields[key].trim()) params.set(key, item.fields[key].trim());
    }
    const xhr = new XMLHttpRequest(); // XHR for upload progress events
    xhr.open('POST', `/api/admin/upload?${params}`);
    const bar = item.row.querySelector('.up-progress');
    bar.classList.add('active');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) bar.firstElementChild.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onload = () => {
      if (xhr.status === 201) {
        item.status = 'done';
      } else {
        item.status = 'error';
        let message = `upload failed (${xhr.status})`;
        try { message = JSON.parse(xhr.responseText).error || message; } catch {}
        const errEl = item.row.querySelector('.up-error');
        errEl.textContent = message;
        errEl.hidden = false;
      }
      resolve();
    };
    xhr.onerror = () => {
      item.status = 'error';
      const errEl = item.row.querySelector('.up-error');
      errEl.textContent = 'network error';
      errEl.hidden = false;
      resolve();
    };
    xhr.send(item.file);
  });
}

$('#upload-all').addEventListener('click', async () => {
  $('#upload-all').disabled = true;
  const pending = uploadQueue.filter((u) => u.status === 'pending');
  let done = 0;
  for (const item of pending) {
    $('#upload-status').textContent = `Uploading ${done + 1} of ${pending.length}…`;
    await uploadOne(item);
    done++;
  }
  const failed = uploadQueue.filter((u) => u.status === 'error').length;
  $('#upload-status').textContent = failed
    ? `Done — ${done - failed} uploaded, ${failed} failed (fix and retry)`
    : `Done — ${done} uploaded`;
  for (const item of uploadQueue.filter((u) => u.status === 'error')) item.status = 'pending';
  for (let i = uploadQueue.length - 1; i >= 0; i--) {
    if (uploadQueue[i].status === 'done') uploadQueue.splice(i, 1);
  }
  renderQueue();
  if (failed === 0) $('#upload-status').textContent = `Done — ${done} uploaded`;
  await loadTracks();
});

$('#clear-queue').addEventListener('click', () => {
  uploadQueue.length = 0;
  renderQueue();
});

// drop zone
const dropzone = $('#dropzone');
dropzone.addEventListener('click', (e) => {
  if (!e.target.closest('label')) $('#file-input').click();
});
$('#file-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));

// --------------------------------------------------------------- track manager

let editingId = null;
const selected = new Set(); // track ids picked for bulk actions
let lastShown = [];         // tracks matching the current filter

function filteredTracks() {
  const filter = $('#admin-filter').value.toLowerCase().trim();
  const terms = filter.split(/\s+/).filter(Boolean);
  return tracks.filter((t) =>
    terms.every((term) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(term)));
}

function updateSelectionUi() {
  // drop selections that no longer exist in the library
  const valid = new Set(tracks.map((t) => t.id));
  for (const id of selected) if (!valid.has(id)) selected.delete(id);

  const btn = $('#tm-delete-selected');
  btn.disabled = selected.size === 0;
  btn.textContent = selected.size ? `Delete selected (${selected.size})` : 'Delete selected';
  $('#tm-selection-count').textContent = selected.size ? `${selected.size} of ${tracks.length} selected` : '';
  $('#tm-select-all-label').textContent = `Select all${lastShown.length !== tracks.length ? ` (${lastShown.length} filtered)` : ''}`;
  const all = $('#tm-select-all');
  all.checked = lastShown.length > 0 && lastShown.every((t) => selected.has(t.id));
  all.indeterminate = !all.checked && lastShown.some((t) => selected.has(t.id));
  document.querySelectorAll('.tm-row').forEach((row) => {
    const on = selected.has(row.dataset.id);
    row.classList.toggle('selected', on);
    const check = row.querySelector('.tm-check');
    if (check) check.checked = on;
  });
}

function renderManager() {
  const shown = filteredTracks();
  lastShown = shown;
  const box = $('#track-manager');
  box.innerHTML = shown.length ? '' : '<div class="empty-note">No tracks match.</div>';
  for (const t of shown.slice(0, 500)) {
    const row = document.createElement('div');
    row.className = 'tm-row';
    row.dataset.id = t.id;
    row.innerHTML = `
      <input type="checkbox" class="tm-check" title="Select">
      <img src="/api/artwork/${t.id}?v=${t.mtimeMs}" loading="lazy" alt="">
      <div class="tm-meta">
        <div class="tm-title">${esc(t.title)}</div>
        <div class="tm-sub">${esc(t.artist)} · ${esc(t.album)}${t.year ? ' · ' + esc(t.year) : ''} · <span class="muted">${esc(t.path)}</span></div>
      </div>
      <div class="tm-actions">
        <button data-act="edit">Edit</button>
        <button data-act="art">Artwork</button>
        <button data-act="delete" class="danger">Delete</button>
      </div>`;
    row.querySelector('.tm-check').addEventListener('change', (e) => {
      if (e.target.checked) selected.add(t.id); else selected.delete(t.id);
      updateSelectionUi();
    });
    row.querySelector('[data-act="edit"]').addEventListener('click', () => openEditor(t, row));
    row.querySelector('[data-act="art"]').addEventListener('click', () => pickArtwork(t, row));
    row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirm(`Delete "${t.title}" by ${t.artist}?\n\nThis removes the file from your music folder.`)) return;
      await apiJson('DELETE', `/api/admin/tracks/${t.id}`);
      selected.delete(t.id);
      await loadTracks();
    });
    box.appendChild(row);
  }
  if (shown.length > 500) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = `Showing first 500 of ${shown.length} — narrow the filter to see more.`;
    box.appendChild(note);
  }
  updateSelectionUi();
}

$('#tm-select-all').addEventListener('change', (e) => {
  // acts on everything matching the filter, not just the 500 rows shown
  for (const t of lastShown) {
    if (e.target.checked) selected.add(t.id); else selected.delete(t.id);
  }
  updateSelectionUi();
});

$('#tm-delete-selected').addEventListener('click', async () => {
  if (!selected.size) return;
  const names = tracks.filter((t) => selected.has(t.id)).slice(0, 5)
    .map((t) => `  • ${t.title} — ${t.artist}`).join('\n');
  const more = selected.size > 5 ? `\n  …and ${selected.size - 5} more` : '';
  if (!confirm(`Delete ${selected.size} song${selected.size > 1 ? 's' : ''} from your library?\n\n${names}${more}\n\nThis removes the files from your music folder.`)) return;
  const btn = $('#tm-delete-selected');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    const result = await apiJson('POST', '/api/admin/tracks/delete', { trackIds: [...selected] });
    selected.clear();
    await loadTracks();
    if (result.failed && result.failed.length) {
      alert(`Deleted ${result.deleted}, but ${result.failed.length} could not be removed (files may be locked or already gone).`);
    }
  } catch (err) {
    alert('Bulk delete failed: ' + err.message);
    await loadTracks();
  }
});

function openEditor(t, row) {
  if (editingId === t.id) return;
  document.querySelectorAll('.tm-edit').forEach((el) => el.remove());
  editingId = t.id;
  const editor = document.createElement('div');
  editor.className = 'tm-edit';
  const values = { title: t.title, artist: t.artist, album: t.album, track: t.track || '', year: t.year, genre: t.genre, tags: (t.tags || []).join(', ') };
  editor.innerHTML = `
    ${FIELD_DEFS.map(([key, label]) => `
      <span><span class="field-label">${label}</span>
      <input data-field="${key}" ${key === 'genre' ? 'list="genre-options"' : ''} value="${esc(values[key])}"></span>`).join('')}
    <div class="tag-row"><span class="field-label">TAGS</span><span class="tag-chips"></span></div>
    <div class="tm-edit-actions">
      <button class="accent-btn" data-act="save">Save</button>
      <button class="ghost-btn" data-act="cancel">Cancel</button>
    </div>`;
  tagChipControl(editor.querySelector('.tag-chips'), values, false);
  editor.querySelector('[data-act="cancel"]').addEventListener('click', () => {
    editor.remove();
    editingId = null;
  });
  editor.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const fields = { tags: values.tags || '' };
    editor.querySelectorAll('input[data-field]').forEach((input) => { fields[input.dataset.field] = input.value; });
    try {
      await apiJson('PATCH', `/api/admin/tracks/${t.id}`, fields);
      editingId = null;
      await loadTracks();
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  });
  row.appendChild(editor);
}

function pickArtwork(t, row) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp,image/gif';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const r = await fetch(`/api/admin/artwork/${t.id}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      return alert('Artwork upload failed: ' + (data.error || r.status));
    }
    row.querySelector('img').src = `/api/artwork/${t.id}?v=${Date.now()}`;
  };
  input.click();
}

$('#admin-filter').addEventListener('input', () => renderManager());

$('#admin-rescan').addEventListener('click', async () => {
  const btn = $('#admin-rescan');
  btn.textContent = '⟳ Scanning…';
  try {
    await apiJson('POST', '/api/rescan');
    await loadTracks();
  } finally {
    btn.textContent = '⟳ Rescan folder';
  }
});

loadTracks();
