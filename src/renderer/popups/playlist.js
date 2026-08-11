'use strict';
const { ipcRenderer } = require('electron');
const { applyMetalTexture, applyFont } = require('../texture');
document.addEventListener('DOMContentLoaded', () => applyMetalTexture([document.getElementById('popup-frame')]));

ipcRenderer.on('apply-font', (_, f) => applyFont(f));
ipcRenderer.on('playlist-state', (_, state) => render(state));

// Mirrors app.js: a playlist can only be refreshed if we still know its source.
const canRefresh = (pl) => (pl.source === 'google' ? !!pl.loaded : !!pl.ytId);

function render({ playlists, activePlaylistId }) {
  const list = document.getElementById('playlist-list');
  list.innerHTML = '';

  const refreshable = playlists.filter(canRefresh).length;
  const bar = document.createElement('div');
  bar.className = 'pl-refresh-row';
  bar.innerHTML = `<button class="pl-refresh-btn btn-3d" ${refreshable ? '' : 'disabled'}>
    ↻ <span>${refreshable ? `전체 갱신 (${refreshable})` : '갱신할 목록 없음'}</span>
  </button>`;
  bar.querySelector('.pl-refresh-btn').addEventListener('click', () => {
    ipcRenderer.send('popup-action', { type: 'refresh-playlists' });
    window.close();
  });
  list.appendChild(bar);

  // Queue option
  const queueItem = makeItem('Queue', null, !activePlaylistId, 0);
  queueItem.addEventListener('click', () => {
    ipcRenderer.send('popup-action', { type: 'switch-to-queue' });
    window.close();
  });
  list.appendChild(queueItem);

  // Split into local (added by URL) and Google-account playlists.
  appendSection(list, '로컬 재생목록', playlists.filter(p => p.source !== 'google'), activePlaylistId);
  appendSection(list, 'Google 계정', playlists.filter(p => p.source === 'google'), activePlaylistId);
}

function appendSection(list, label, playlists, activePlaylistId) {
  if (!playlists.length) return;
  const hdr = document.createElement('div');
  hdr.className = 'pl-category';
  hdr.textContent = label;
  list.appendChild(hdr);

  playlists.forEach(pl => {
    const item = makeItem(pl.name, pl.id, activePlaylistId === pl.id, pl.tracks.length, canRefresh(pl));
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
