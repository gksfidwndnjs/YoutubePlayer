'use strict';
const { ipcRenderer } = require('electron');
const { applyMetalTexture, applyFont } = require('../texture');
document.addEventListener('DOMContentLoaded', () => {
  applyMetalTexture([document.getElementById('popup-frame')]);
  ipcRenderer.invoke('app-version').then(v => { el('menu-version').textContent = 'v' + v; }).catch(() => {});
});

ipcRenderer.on('apply-font', (_, f) => applyFont(f));

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

let lastResults = null; // cache so the playlist "back" button can restore results

function doSearch() {
  const q = el('search-input').value.trim();
  if (!q) return;
  if (!apiKey) { el('search-no-key').classList.remove('hidden'); return; }
  setScreen('<div class="loading-row"><div class="spinner"></div></div>');
  ipcRenderer.send('popup-search-request', q);
}

function setScreen(html) { el('search-results').innerHTML = html; }

const PLAY_SVG  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PLUS_SVG  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const OPEN_SVG  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg>';

// ── Search results (official audio + playlists) ──
ipcRenderer.on('search-results', (_, data) => { lastResults = data; renderResults(data); });
ipcRenderer.on('search-error', () => setScreen('<div class="crt-msg">검색 실패</div>'));

function renderResults(data) {
  const official = (data && data.official) || [];
  const playlists = (data && data.playlists) || [];
  const box = el('search-results');
  box.innerHTML = '';
  if (!official.length && !playlists.length) {
    box.innerHTML = '<div class="crt-msg">결과 없음</div>';
    return;
  }
  if (official.length) {
    box.appendChild(barEl('추천 · 공식 음원'));
    official.forEach(v => box.appendChild(videoCard(v, true)));
  }
  if (playlists.length) {
    box.appendChild(barEl('재생목록'));
    playlists.forEach(p => box.appendChild(playlistCard(p)));
  }
}

function barEl(text) {
  const d = document.createElement('div');
  d.className = 'crt-bar';
  d.innerHTML = `<span>${escHtml(text)}</span>`;
  return d;
}

function videoCard(item, official) {
  const card = document.createElement('div');
  card.className = 'res-card';
  card.title = '지금 재생';
  const thumb = item.thumb || `https://img.youtube.com/vi/${escHtml(item.videoId)}/mqdefault.jpg`;
  card.innerHTML = `
    <img class="res-thumb" src="${escHtml(thumb)}" alt="" loading="lazy">
    <div class="res-info">
      <div class="res-title">${escHtml(item.title)}${official ? '<span class="res-badge">공식</span>' : ''}</div>
      <div class="res-channel">${escHtml(item.channel)}</div>
    </div>
    <div class="res-btns">
      <button class="btn-icon play-btn" title="지금 재생">${PLAY_SVG}</button>
      <button class="btn-icon queue-btn" title="큐에 추가">${PLUS_SVG}</button>
    </div>`;
  const vid = { videoId: item.videoId, title: item.title, channel: item.channel };
  const play  = () => ipcRenderer.send('popup-action', { type: 'add-to-queue', video: vid, playNow: true });
  const queue = () => ipcRenderer.send('popup-action', { type: 'add-to-queue', video: vid, playNow: false });
  card.querySelector('.play-btn').addEventListener('click', e => { e.stopPropagation(); play(); });
  card.querySelector('.queue-btn').addEventListener('click', e => { e.stopPropagation(); queue(); });
  card.addEventListener('click', play);
  return card;
}

function playlistCard(item) {
  const card = document.createElement('div');
  card.className = 'res-card';
  card.title = '재생목록 열기';
  card.innerHTML = `
    <img class="res-thumb" src="${escHtml(item.thumb)}" alt="" loading="lazy">
    <div class="res-info">
      <div class="res-title">${escHtml(item.title)}</div>
      <div class="res-channel">${escHtml(item.channel)}</div>
    </div>
    <div class="res-btns">
      <button class="btn-icon open-btn" title="안의 곡 보기">${OPEN_SVG}</button>
      <button class="btn-icon add-btn" title="전체 추가">${PLUS_SVG}</button>
    </div>`;
  card.querySelector('.add-btn').addEventListener('click', e => { e.stopPropagation(); addPlaylist(item.playlistId); });
  card.querySelector('.open-btn').addEventListener('click', e => { e.stopPropagation(); openPlaylist(item); });
  card.addEventListener('click', () => openPlaylist(item));
  return card;
}

function addPlaylist(playlistId) {
  ipcRenderer.send('popup-action', { type: 'add-url', url: 'https://www.youtube.com/playlist?list=' + playlistId });
}

let openPlaylistId = null;
function openPlaylist(item) {
  openPlaylistId = item.playlistId;
  setScreen('<div class="loading-row"><div class="spinner"></div></div>');
  ipcRenderer.send('popup-playlist-items-request', item.playlistId);
}

// ── Playlist contents view ──
ipcRenderer.on('playlist-items', (_, data) => {
  const box = el('search-results');
  box.innerHTML = '';

  const bar = document.createElement('div');
  bar.className = 'crt-bar';
  bar.innerHTML = `
    <button class="crt-back-btn back-btn">◀ 뒤로</button>
    <span class="crt-bar-title">${escHtml(data.title || '재생목록')}</span>
    <button class="crt-back-btn addall-btn">전체 추가</button>`;
  bar.querySelector('.back-btn').addEventListener('click', goBackToResults);
  bar.querySelector('.addall-btn').addEventListener('click', () => addPlaylist(data.playlistId || openPlaylistId));
  box.appendChild(bar);

  if (!data.items || !data.items.length) {
    box.insertAdjacentHTML('beforeend', '<div class="crt-msg">비어 있는 재생목록</div>');
    return;
  }
  data.items.forEach(v => box.appendChild(videoCard(v, false)));
});

ipcRenderer.on('playlist-items-error', () => setScreen('<div class="crt-msg">재생목록을 불러오지 못했어</div>'));

function goBackToResults() {
  if (lastResults) renderResults(lastResults);
  else setScreen('<div class="crt-msg">▌ 재생목록을 검색하세요</div>');
}

function el(id) { return document.getElementById(id); }
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
