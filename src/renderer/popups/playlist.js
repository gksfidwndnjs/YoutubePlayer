'use strict';
const { ipcRenderer } = require('electron');
const { applyMetalTexture, applyFont } = require('../texture');
document.addEventListener('DOMContentLoaded', () => applyMetalTexture([document.getElementById('popup-frame')]));

ipcRenderer.on('apply-font', (_, f) => applyFont(f));
ipcRenderer.on('playlist-state', (_, state) => render(state));

// The warning marks a playlist whose origin is gone for good, not one that merely
// cannot be refreshed this instant. A Google playlist is always linked — its own id is
// the link — and simply loads its tracks the first time it is opened, so flagging an
// unopened one told the user something was wrong when nothing was.
const isUnlinked = (pl) => {
  if (pl.source === 'folder') return !pl.folderPath;
  if (pl.source === 'google') return false;
  return !pl.ytId;
};

// Refreshing is the narrower question: an unopened Google playlist is linked but has
// nothing to diff against yet, so the bulk-refresh count skips it.
const canRefresh = (pl) => {
  if (pl.source === 'google') return !!pl.loaded;
  return !isUnlinked(pl);
};

let current = { playlists: [], activePlaylistId: null };
let query = '';

const matches = (name) => !query || String(name).toLowerCase().includes(query);

function render(state) {
  current = state;
  renderHeader();
  renderList();
}

function renderHeader() {
  const btn = document.getElementById('pl-refresh');
  const n = current.playlists.filter(canRefresh).length;
  btn.disabled = !n;
  btn.innerHTML = `↻ <span>${n ? `전체 갱신 (${n})` : '갱신할 목록 없음'}</span>`;
}

function renderList() {
  const list = document.getElementById('playlist-list');
  list.innerHTML = '';

  // Queue is a playlist like any other as far as filtering goes.
  if (matches('queue')) {
    const queueItem = makeItem('Queue', null, !current.activePlaylistId, 0);
    queueItem.addEventListener('click', () => {
      ipcRenderer.send('popup-action', { type: 'switch-to-queue' });
      window.close();
    });
    list.appendChild(queueItem);
  }

  // Split into YouTube playlists (added by URL), on-disk folders, and Google-account lists.
  let shown = appendSection(list, '로컬 재생목록', current.playlists.filter(p => !p.source));
  shown += appendSection(list, '내 폴더', current.playlists.filter(p => p.source === 'folder'));
  shown += appendSection(list, 'Google 계정', current.playlists.filter(p => p.source === 'google'));

  if (!list.children.length) {
    const empty = document.createElement('div');
    empty.className = 'pl-empty';
    empty.textContent = `"${query}" 와(과) 일치하는 재생목록이 없습니다`;
    list.appendChild(empty);
  }
  return shown;
}

function appendSection(list, label, playlists) {
  const visible = playlists.filter(p => matches(p.name));
  if (!visible.length) return 0;

  const hdr = document.createElement('div');
  hdr.className = 'pl-category';
  hdr.textContent = label;
  list.appendChild(hdr);

  visible.forEach(pl => {
    const item = makeItem(pl.name, pl.id, current.activePlaylistId === pl.id, pl.tracks.length, !isUnlinked(pl));
    if (pl.folderPath) item.title = pl.folderPath;
    item.addEventListener('click', e => {
      if (e.target.closest('.delete-pl-btn')) return;
      ipcRenderer.send('popup-action', { type: 'switch-playlist', id: pl.id });
      window.close();
    });
    item.querySelector('.delete-pl-btn').addEventListener('click', e => {
      e.stopPropagation();
      ipcRenderer.send('popup-action', { type: 'delete-playlist', id: pl.id });
    });
    list.appendChild(item);
  });
  return visible.length;
}

function makeItem(name, id, active, count, refreshable = true) {
  const el = document.createElement('div');
  el.className = 'pl-item' + (active ? ' active' : '');
  el.innerHTML = `
    <span class="pl-item-name">${escHtml(name)}</span>
    <div class="pl-item-right">
      ${refreshable ? '' : '<span class="pl-nolink" title="원본 링크 없음 — 갱신하려면 URL로 다시 추가하세요">⚠</span>'}
      ${count > 0 ? `<span class="count-badge">${count}</span>` : ''}
      ${id ? `<button class="btn-icon btn-3d delete-pl-btn" title="Delete">×</button>` : ''}
    </div>`;
  return el;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.getElementById('pl-refresh').addEventListener('click', () => {
  ipcRenderer.send('popup-action', { type: 'refresh-playlists' });
  window.close();
});

// The folder picker is a modal dialog owned by the main window; close first so this
// popup isn't left hanging behind it.
document.getElementById('pl-add-folder').addEventListener('click', () => {
  ipcRenderer.send('popup-action', { type: 'add-folder' });
  window.close();
});

const search = document.getElementById('pl-search');
search.addEventListener('input', () => {
  query = search.value.trim().toLowerCase();
  renderList();
});
search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // First Escape clears the filter; a second one closes the popup.
    if (query) { search.value = ''; query = ''; renderList(); }
    else window.close();
  }
  // Enter opens the only remaining match — the fast path when searching.
  if (e.key === 'Enter') {
    const only = document.querySelectorAll('#playlist-list .pl-item');
    if (only.length === 1) only[0].click();
  }
});
// The popup exists to pick a playlist out of a long list; start ready to type.
document.addEventListener('DOMContentLoaded', () => search.focus());
