'use strict';
const { ipcRenderer } = require('electron');

let state = { queue: [], currentIndex: -1, playlists: [], activePlaylistId: null };

ipcRenderer.on('queue-state', (_, s) => {
  state = s;
  renderQueue();
});

function renderQueue() {
  const list = document.getElementById('queue-list');
  document.getElementById('queue-count').textContent = state.queue.length;
  const pl = state.playlists.find(p => p.id === state.activePlaylistId);
  document.getElementById('current-playlist-label').textContent = pl ? truncate(pl.name, 24) : 'Queue';

  if (!state.queue.length) {
    list.innerHTML = '<div class="empty-state">Your queue is empty</div>';
    return;
  }
  list.innerHTML = '';
  state.queue.forEach((video, i) => {
    const card = document.createElement('div');
    card.className = 'video-card' + (i === state.currentIndex ? ' now-playing' : '');
    card.innerHTML = `
      <img class="video-thumb" src="https://img.youtube.com/vi/${esc(video.videoId)}/mqdefault.jpg" alt="" loading="lazy">
      <div class="video-card-info">
        <div class="video-card-title">${escHtml(video.title || video.videoId)}</div>
        <div class="video-card-channel">${escHtml(video.channel || '')}</div>
      </div>
      <div class="video-card-btns">
        <button class="btn-icon remove-btn" title="Remove">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>`;
    card.addEventListener('click', () => ipcRenderer.send('popup-action', { type: 'play-from-queue', index: i }));
    card.querySelector('.remove-btn').addEventListener('click', e => {
      e.stopPropagation();
      ipcRenderer.send('popup-action', { type: 'remove-from-queue', index: i });
    });
    list.appendChild(card);
  });
}

document.getElementById('clear-queue-btn').addEventListener('click', () => {
  if (confirm('Clear the entire queue?')) ipcRenderer.send('popup-action', { type: 'clear-queue' });
});

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function esc(s) { return escHtml(s); }
function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
