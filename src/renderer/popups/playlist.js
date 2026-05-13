'use strict';
const { ipcRenderer } = require('electron');
const { applyMetalTexture } = require('../texture');
document.addEventListener('DOMContentLoaded', () => applyMetalTexture([document.getElementById('popup-frame')]));

ipcRenderer.on('playlist-state', (_, state) => render(state));

function render({ playlists, activePlaylistId }) {
  const list = document.getElementById('playlist-list');
  list.innerHTML = '';

  // Queue option
  const queueItem = makeItem('Queue', null, !activePlaylistId, 0);
  queueItem.addEventListener('click', () => {
    ipcRenderer.send('popup-action', { type: 'switch-to-queue' });
    window.close();
  });
  list.appendChild(queueItem);

  if (playlists.length) {
    const div = document.createElement('div');
    div.className = 'pl-divider';
    list.appendChild(div);
  }

  playlists.forEach(pl => {
    const item = makeItem(pl.name, pl.id, activePlaylistId === pl.id, pl.tracks.length);
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

function makeItem(name, id, active, count) {
  const el = document.createElement('div');
  el.className = 'pl-item' + (active ? ' active' : '');
  el.innerHTML = `
    <span class="pl-item-name">${escHtml(name)}</span>
    <div class="pl-item-right">
      ${count > 0 ? `<span class="count-badge">${count}</span>` : ''}
      ${id ? `<button class="btn-icon btn-3d delete-pl-btn" title="Delete">×</button>` : ''}
    </div>`;
  return el;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
