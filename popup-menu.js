'use strict';
const { ipcRenderer } = require('electron');
const { applyMetalTexture } = require('./texture');
document.addEventListener('DOMContentLoaded', () => applyMetalTexture([document.getElementById('popup-frame')]));

let apiKey = '';

ipcRenderer.on('init-state', (_, state) => {
  apiKey = state.apiKey || '';
  el('search-no-key').classList.toggle('hidden', !!apiKey);
});

// ── URL add ──
el('url-add-btn').addEventListener('click', () => {
  const url = el('url-input').value.trim();
  if (!url) return;
  el('url-input').value = '';
  ipcRenderer.send('popup-action', { type: 'add-url', url });
});
el('url-input').addEventListener('keydown', e => { if (e.key === 'Enter') el('url-add-btn').click(); });

// ── Search ──
el('search-btn').addEventListener('click', doSearch);
el('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

function doSearch() {
  const q = el('search-input').value.trim();
  if (!q) return;
  if (!apiKey) { el('search-no-key').classList.remove('hidden'); return; }
  el('search-results').innerHTML = '<div class="loading-row"><div class="spinner"></div></div>';
  ipcRenderer.send('popup-search-request', q);
}

ipcRenderer.on('search-results', (_, items) => {
  const box = el('search-results');
  if (!items || !items.length) {
    box.innerHTML = '<div class="empty-state">No results</div>';
    return;
  }
  box.innerHTML = '';
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.innerHTML = `
      <img class="video-thumb" src="https://img.youtube.com/vi/${esc(item.videoId)}/mqdefault.jpg" alt="" loading="lazy">
      <div class="video-card-info">
        <div class="video-card-title">${escHtml(item.title)}</div>
        <div class="video-card-channel">${escHtml(item.channel)}</div>
      </div>
      <div class="video-card-btns">
        <button class="btn-icon play-btn" title="Play now">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <button class="btn-icon queue-btn" title="Add to queue">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>`;
    card.querySelector('.play-btn').addEventListener('click', e => {
      e.stopPropagation();
      ipcRenderer.send('popup-action', { type: 'add-to-queue', video: item, playNow: true });
    });
    card.querySelector('.queue-btn').addEventListener('click', e => {
      e.stopPropagation();
      ipcRenderer.send('popup-action', { type: 'add-to-queue', video: item, playNow: false });
    });
    card.addEventListener('click', () => {
      ipcRenderer.send('popup-action', { type: 'add-to-queue', video: item, playNow: true });
    });
    box.appendChild(card);
  });
});

ipcRenderer.on('search-error', () => {
  el('search-results').innerHTML = '<div class="empty-state">Search failed</div>';
});

function el(id) { return document.getElementById(id); }
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function esc(s) { return escHtml(s); }
