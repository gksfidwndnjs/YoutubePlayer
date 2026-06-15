'use strict';

const { ipcRenderer } = require('electron');

// ── Constants ─────────────────────────────────────────────────────────────

const STORAGE_KEYS = { queue: 'yt_queue', apiKey: 'yt_api_key' };
const DEFAULT_SETTINGS = { audioQuality: 'best', autoAdvance: true, volume: 1 };
const DEFAULT_PLAYLIST_FOLDER = 'Queue';
const TOAST_DURATION_MS = 3000;
const PLAYBACK_SAVE_INTERVAL_MS = 5000;
const SEARCH_MAX_RESULTS = 15;
const YT_SEARCH_API = 'https://www.googleapis.com/youtube/v3/search';

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  apiKey: '',
  queue: JSON.parse(localStorage.getItem(STORAGE_KEYS.queue) || '[]'),
  currentIndex: -1,
  currentVideo: null,
  playing: false,
  loading: false,
  settings: { ...DEFAULT_SETTINGS },
  playlists: [],
  activePlaylistId: null,
  playbackMode: 'once', // 'once' | 'repeat' | 'repeat-one'
  downloadedIds: new Set(),
  downloading: new Set(),
  batchActive: false,
};

async function refreshDownloadedIds() {
  try {
    const ids = await ipcRenderer.invoke('list-downloaded-ids');
    state.downloadedIds = new Set(ids);
    refreshDownloadStates();
  } catch {}
}

let downloadChain = Promise.resolve();

function downloadTrack(video, { silent = false } = {}) {
  if (state.downloadedIds.has(video.videoId) || state.downloading.has(video.videoId)) {
    return Promise.resolve();
  }
  state.downloading.add(video.videoId);
  refreshDownloadStates();
  let resolveOuter, rejectOuter;
  const outer = new Promise((res, rej) => { resolveOuter = res; rejectOuter = rej; });
  downloadChain = downloadChain.then(async () => {
    try {
      const playlistName = getActivePlaylist()?.name || DEFAULT_PLAYLIST_FOLDER;
      await ipcRenderer.invoke('download-track', video.videoId, playlistName);
      await refreshDownloadedIds();
      if (!silent) showToast(`다운로드 완료: ${truncate(video.title || video.videoId, 30)}`, 'success');
      resolveOuter();
    } catch (err) {
      if (!silent) showToast(`다운로드 실패: ${truncate(video.title || video.videoId, 30)}`, 'error');
      rejectOuter(err);
    } finally {
      state.downloading.delete(video.videoId);
      refreshDownloadStates();
    }
  });
  return outer;
}

async function downloadAll() {
  if (state.batchActive) return;
  const pending = state.queue.filter(v => !state.downloadedIds.has(v.videoId));
  if (!pending.length) return;
  state.batchActive = true;
  refreshDownloadStates();
  showToast(`일괄 다운로드 시작 (${pending.length}곡)`, 'success');
  let ok = 0, fail = 0;
  for (const video of pending) {
    try {
      await downloadTrack(video, { silent: true });
      ok++;
    } catch {
      fail++;
      showToast(`다운로드 실패 (스킵): ${truncate(video.title || video.videoId, 30)}`, 'error');
    }
  }
  state.batchActive = false;
  refreshDownloadStates();
  showToast(`일괄 다운로드 완료 (성공 ${ok} / 실패 ${fail})`, fail ? 'error' : 'success');
}

let pendingPlaylist = null;

// ── Utilities ─────────────────────────────────────────────────────────────

const el = (id) => document.getElementById(id);

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const truncate = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;

function formatTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function syncTrack(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--pct', pct + '%');
}

function showToast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  el('toast-container').appendChild(t);
  setTimeout(() => t.remove(), TOAST_DURATION_MS);
}

// ── ID / URL extraction ───────────────────────────────────────────────────

function extractPlaylistId(raw) {
  const m = raw.trim().match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function extractVideoId(raw) {
  const s = raw.trim();
  for (const re of [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ]) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

// ── Thumbnails / meta ─────────────────────────────────────────────────────

const thumbUrl   = (id) => `https://img.youtube.com/vi/${id}/mqdefault.jpg`;
const hqThumbUrl = (id) => `https://img.youtube.com/vi/${id}/hqdefault.jpg`;

// Prefer a downloaded local file; fall back to a streaming URL.
async function resolveAudioSrc(videoId) {
  const localPath = await ipcRenderer.invoke('get-local-audio-path', videoId);
  if (localPath) return 'file:///' + localPath.replace(/\\/g, '/');
  return ipcRenderer.invoke('get-audio-url', videoId, state.settings.audioQuality);
}

async function fetchVideoMeta(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (!res.ok) return null;
    const d = await res.json();
    return { title: d.title || 'Unknown title', channel: d.author_name || '' };
  } catch { return null; }
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function setAlbumArt(video) {
  const art = el('album-art');
  art.onerror = () => { art.src = thumbUrl(video.videoId); art.onerror = null; };
  art.src = hqThumbUrl(video.videoId);
  el('album-placeholder').style.display = 'none';
  art.style.display = 'block';
}

function updateVideoInfo(video) {
  el('video-title').textContent = video.title || video.videoId || 'NULL';
  el('video-channel').textContent = video.channel || 'NULL';
}

// ── Playback ───────────────────────────────────────────────────────────────

function setLoading(on) {
  state.loading = on;
  el('playpause-btn').disabled = on;
  el('progress-bar').disabled = on;
  if (on) {
    el('playpause-btn').innerHTML = '<div class="spinner"></div>';
    el('player-disc').classList.remove('spinning');
  } else {
    updatePlayPauseBtn();
  }
}

function updatePlayPauseBtn() {
  if (state.playing) {
    el('playpause-btn').title = 'Pause (Space)';
    el('playpause-btn').innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>
    </svg>`;
    el('player-disc').classList.add('spinning');
  } else {
    el('playpause-btn').title = 'Play (Space)';
    el('playpause-btn').innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
    el('player-disc').classList.remove('spinning');
  }
}

async function playVideo(video) {
  const audio = el('youtube-player');
  audio.pause();
  audio.src = '';

  state.currentVideo = video;
  state.playing = false;
  setLoading(true);
  setAlbumArt(video);
  updateVideoInfo(video);

  renderQueue();
  el('progress-bar').value = 0;
  el('time-current').textContent = '--:--';
  el('time-duration').textContent = '--:--';
  syncTrack(el('progress-bar'));

  try {
    audio.src = await resolveAudioSrc(video.videoId);
    await audio.play();
    state.playing = true;
    setLoading(false);
  } catch (err) {
    showToast(`Failed: ${video.title || video.videoId} — skipping`, 'error');
    setLoading(false);
    if (state.currentIndex < state.queue.length - 1) playNext();
  }
}

function togglePlayPause() {
  if (state.loading) return;
  if (!state.currentVideo) {
    if (state.queue.length > 0) playFromQueue(0);
    return;
  }
  const audio = el('youtube-player');
  if (state.playing) {
    audio.pause();
    state.playing = false;
  } else {
    audio.play().catch(() => {});
    state.playing = true;
  }
  updatePlayPauseBtn();
}

function playFromQueue(index) {
  if (index < 0 || index >= state.queue.length) return;
  state.currentIndex = index;
  playVideo(state.queue[index]);
}

const playNext = () => { if (state.currentIndex < state.queue.length - 1) playFromQueue(state.currentIndex + 1); };
const playPrev = () => {
  if (state.currentIndex > 0) playFromQueue(state.currentIndex - 1);
  else if (state.currentVideo) playFromQueue(0);
};

// ── Queue ──────────────────────────────────────────────────────────────────

function saveQueue() {
  if (state.activePlaylistId) {
    const pl = getActivePlaylist();
    if (pl) {
      pl.tracks = [...state.queue];
      ipcRenderer.invoke('save-playlists', state.playlists);
    }
  } else {
    localStorage.setItem(STORAGE_KEYS.queue, JSON.stringify(state.queue));
  }
}

const SPINNER_SVG = `<svg class="dl-spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2a10 10 0 0 1 10 10"/></svg>`;
const CHECK_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12 10 17 19 7"/></svg>`;
const DOWNLOAD_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>`;
const CLOSE_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

// Returns { icon, cls, title, disabled } for a track's download button.
function downloadBtnState(videoId) {
  if (state.downloading.has(videoId)) {
    return { icon: SPINNER_SVG, cls: ' loading', title: 'Downloading…', disabled: true };
  }
  if (state.downloadedIds.has(videoId)) {
    return { icon: CHECK_SVG, cls: ' downloaded', title: 'Already downloaded', disabled: true };
  }
  return { icon: DOWNLOAD_SVG, cls: '', title: 'Download audio + thumbnail', disabled: false };
}

function applyDownloadBtn(btn, video) {
  const { icon, cls, title, disabled } = downloadBtnState(video.videoId);
  btn.className = 'btn-icon btn-3d download-btn' + cls;
  btn.title = title;
  btn.disabled = disabled;
  btn.innerHTML = icon;
  btn.onclick = disabled ? null : (e) => { e.stopPropagation(); downloadTrack(video).catch(() => {}); };
}

function renderBatchRow() {
  const pendingCount = state.queue.filter(v => !state.downloadedIds.has(v.videoId)).length;
  const batchDisabled = state.batchActive || pendingCount === 0;
  const btn = el('queue-list')?.querySelector('.batch-dl-btn');
  if (!btn) return;
  btn.className = 'batch-dl-btn btn-3d' + (state.batchActive ? ' loading' : '');
  btn.disabled = batchDisabled;
  btn.innerHTML = `${state.batchActive ? SPINNER_SVG : DOWNLOAD_SVG}<span>${
    state.batchActive ? '다운로드 중…' : (pendingCount === 0 ? '모두 다운로드됨' : `일괄 다운로드 (${pendingCount}곡)`)
  }</span>`;
  btn.onclick = batchDisabled ? null : (e) => { e.stopPropagation(); downloadAll(); };
}

// Lightweight refresh of download-related UI without rebuilding the whole list.
function refreshDownloadStates() {
  renderBatchRow();
  const list = el('queue-list');
  if (!list) return;
  list.querySelectorAll('.video-card[data-vid]').forEach(card => {
    const videoId = card.dataset.vid;
    const btn = card.querySelector('.download-btn');
    if (btn) applyDownloadBtn(btn, state.queue.find(v => v.videoId === videoId) || { videoId });
  });
}

function renderQueue() {
  const pl = getActivePlaylist();
  const total = state.queue.length;
  const idx = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
  el('playlist-display-title').textContent = pl ? truncate(pl.name, 20) : 'Queue';
  el('playlist-display-meta').textContent = `(${idx} / ${total})`;

  const list = el('queue-list');
  if (!state.queue.length) {
    list.innerHTML = '<div class="empty-state">Your queue is empty</div>';
    return;
  }

  list.innerHTML = '';
  const batchRow = document.createElement('div');
  batchRow.className = 'queue-batch-row';
  batchRow.innerHTML = `<button class="batch-dl-btn btn-3d"></button>`;
  list.appendChild(batchRow);
  renderBatchRow();

  state.queue.forEach((video, i) => {
    const card = document.createElement('div');
    card.className = 'video-card' + (i === state.currentIndex ? ' now-playing' : '');
    card.dataset.vid = video.videoId;
    card.innerHTML = `
      <img class="video-thumb" src="${escHtml(thumbUrl(video.videoId))}" alt="" loading="lazy">
      <div class="video-card-info">
        <div class="video-card-title">${escHtml(video.title || video.videoId)}</div>
        <div class="video-card-channel">${escHtml(video.channel || '')}</div>
      </div>
      <div class="video-card-btns">
        <button class="btn-icon btn-3d download-btn"></button>
        <button class="btn-icon btn-3d remove-btn" title="Remove">${CLOSE_SVG}</button>
      </div>`;
    card.addEventListener('click', () => playFromQueue(i));
    card.querySelector('.remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromQueue(i);
    });
    applyDownloadBtn(card.querySelector('.download-btn'), video);
    list.appendChild(card);
  });
}

function addToQueue(video, playNow = false) {
  state.queue.push(video);
  saveQueue();
  renderQueue();
  showToast(`Added: ${truncate(video.title || video.videoId, 40)}`, 'success');
  if (playNow || state.currentIndex === -1) playFromQueue(state.queue.length - 1);
}

function removeFromQueue(index) {
  state.queue.splice(index, 1);
  if (state.currentIndex > index) state.currentIndex--;
  else if (state.currentIndex === index) state.currentIndex = Math.min(index, state.queue.length - 1);
  saveQueue();
  renderQueue();
}

function clearQueue() {
  state.queue = [];
  state.currentIndex = -1;
  state.currentVideo = null;
  state.playing = false;
  saveQueue();
  setLoading(false);

  const audio = el('youtube-player');
  audio.pause();
  audio.src = '';

  el('progress-bar').value = 0;
  el('time-current').textContent = '0:00';
  el('time-duration').textContent = '0:00';
  syncTrack(el('progress-bar'));
  el('album-art').style.display = 'none';
  el('album-art').src = '';
  el('album-placeholder').style.display = '';
  el('player-disc').classList.remove('spinning');
  el('video-title').textContent = 'NULL';
  el('video-channel').textContent = 'NULL';
  updatePlayPauseBtn();
  renderQueue();
}

// ── URL add ────────────────────────────────────────────────────────────────

async function addPlaylistToQueue(playlistId) {
  showToast('Fetching playlist…');
  try {
    const { title, tracks } = await ipcRenderer.invoke('get-playlist-info', playlistId);
    if (!tracks.length) { showToast('Playlist is empty or unavailable', 'error'); return; }
    const newPl = { id: Date.now().toString(), name: title, tracks };
    state.playlists.push(newPl);
    await ipcRenderer.invoke('save-playlists', state.playlists);
    switchToPlaylist(newPl.id);
    showToast(`Playlist "${truncate(title, 30)}" added (${tracks.length} tracks)`, 'success');
  } catch (err) {
    showToast('Playlist failed — ' + (err.message || err), 'error');
  }
}

async function addByUrl(raw) {
  const playlistId = extractPlaylistId(raw);
  if (playlistId) { await addPlaylistToQueue(playlistId); return; }
  const videoId = extractVideoId(raw);
  if (!videoId) { showToast('Invalid YouTube URL, video ID, or playlist', 'error'); return; }
  showToast('Fetching video info…');
  const meta = await fetchVideoMeta(videoId);
  addToQueue({ videoId, title: meta?.title || videoId, channel: meta?.channel || '' }, state.currentIndex === -1);
}

// ── Playlists ──────────────────────────────────────────────────────────────

const getActivePlaylist = () =>
  state.activePlaylistId ? state.playlists.find(p => p.id === state.activePlaylistId) || null : null;

function resetPlayer(titleText) {
  const audio = el('youtube-player');
  audio.pause(); audio.src = '';
  state.playing = false; state.currentVideo = null; state.currentIndex = -1;
  setLoading(false);
  el('video-title').textContent = 'NULL';
  el('video-channel').textContent = 'NULL';
  el('album-art').style.display = 'none';
  el('album-placeholder').style.display = '';
  el('player-disc').classList.remove('spinning');
  el('progress-bar').value = 0;
  el('time-current').textContent = '0:00';
  el('time-duration').textContent = '0:00';
  syncTrack(el('progress-bar'));
  updatePlayPauseBtn();
}

async function switchToPlaylist(id) {
  const pl = state.playlists.find(p => p.id === id);
  if (!pl) return;
  resetPlayer('Select a track to play');
  state.activePlaylistId = id;
  // Google playlists load their tracks lazily on first open (Data API).
  if (pl.source === 'google' && !pl.loaded) {
    state.queue = [];
    renderQueue();
    showToast('재생목록 불러오는 중…');
    try {
      pl.tracks = await ipcRenderer.invoke('google-playlist-items', pl.id);
      pl.loaded = true;
      ipcRenderer.invoke('save-playlists', state.playlists);
    } catch {
      showToast('재생목록을 불러오지 못했습니다. 설정에서 다시 로그인하세요.', 'error');
    }
    if (state.activePlaylistId !== id) return; // user switched away while loading
  }
  state.queue = [...(pl.tracks || [])];
  renderQueue();
}

function switchToQueue() {
  resetPlayer('Add a video to start listening');
  state.activePlaylistId = null;
  state.queue = JSON.parse(localStorage.getItem(STORAGE_KEYS.queue) || '[]');
  renderQueue();
}

function deletePlaylist(id) {
  if (!confirm('Delete this playlist?')) return;
  state.playlists = state.playlists.filter(p => p.id !== id);
  ipcRenderer.invoke('save-playlists', state.playlists);
  if (state.activePlaylistId === id) switchToQueue();
  else renderQueue();
}

// ── Playlist panel ────────────────────────────────────────────────────────

// Collapsed content height in design px (zoom-independent — see main.js sizing).
const collapsedHeight = () =>
  el('playlist-panel-header').getBoundingClientRect().height
  + el('player-bar').getBoundingClientRect().height;

// The OS window stays a fixed tall size; the playlist slides open/closed purely via
// CSS (#queue-list max-height transition) within it — no window resize, no setShape.
function togglePlaylistPanel() {
  const panel = el('playlist-panel');
  const isOpen = panel.classList.contains('open');
  const chevron = el('playlist-panel-toggle').querySelector('polyline');
  panel.classList.toggle('open', !isOpen);
  chevron?.setAttribute('points', isOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9');
  updateClickThrough(); // visible UI area changed
}

// ── Click-through for the transparent empty area ────────────────────────────
// The window is taller than its visible UI (the player sits at the bottom; the area
// above it is transparent when collapsed). setShape used to clip input there, but it
// breaks on secondary monitors — so instead we toggle whole-window click-through
// based on whether the cursor is over the actual UI (setIgnoreMouseEvents+forward).

let mouseIgnored = false;
function setIgnoreMouse(ignore) {
  if (ignore === mouseIgnored) return;
  mouseIgnored = ignore;
  ipcRenderer.send('set-ignore-mouse', ignore);
}

// An open modal/dropdown overlays the whole window, so input must stay live.
const overlayOpen = () =>
  !el('add-playlist-modal').classList.contains('hidden') ||
  !el('playlist-dropdown-menu').classList.contains('hidden') ||
  !el('position-popover').classList.contains('hidden');

function pointOverUI(x, y) {
  if (overlayOpen()) return true;
  const r = el('player-area').getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

let lastMouse = { x: -1, y: -1 };
function updateClickThrough(x = lastMouse.x, y = lastMouse.y) {
  if (x < 0) return;
  setIgnoreMouse(!pointOverUI(x, y));
}

document.addEventListener('mousemove', (e) => {
  lastMouse = { x: e.clientX, y: e.clientY };
  updateClickThrough(e.clientX, e.clientY);
});

// ── Window placement ─────────────────────────────────────────────────────────
// The window can't be dragged (native drag teleports across monitors on Windows),
// so it's repositioned with buttons: a corner snaps the widget to that corner of the
// current monitor; the monitor button cycles displays. Top corners flip the layout
// (body.dock-top) so the player sits at the top and the playlist expands downward.
const positionPopover = el('position-popover');
const isPopoverOpen = () => !positionPopover.classList.contains('hidden');

function closePositionPopover() {
  if (!isPopoverOpen()) return;
  positionPopover.classList.add('hidden');
  updateClickThrough();
}
function togglePositionPopover() {
  if (isPopoverOpen()) { closePositionPopover(); return; }
  positionPopover.classList.remove('hidden');
  const btn = el('position-btn').getBoundingClientRect();
  const pop = positionPopover.getBoundingClientRect();
  let top = btn.top - pop.height - 6;          // prefer above the button…
  if (top < 6) top = btn.bottom + 6;           // …else drop below it
  positionPopover.style.top = `${Math.round(top)}px`;
  positionPopover.style.left = `${Math.round(Math.max(6, btn.right - pop.width))}px`;
  updateClickThrough();
}

positionPopover.querySelectorAll('.pos-corner').forEach((btn) => {
  btn.addEventListener('click', () => {
    const corner = btn.dataset.corner;
    document.body.classList.toggle('dock-top', corner === 'tl' || corner === 'tr');
    ipcRenderer.send('win-set-corner', corner);
    closePositionPopover();
  });
});
el('pos-monitor-btn').addEventListener('click', () => ipcRenderer.send('win-next-monitor'));
el('position-btn').addEventListener('click', (e) => { e.stopPropagation(); togglePositionPopover(); });
document.addEventListener('mousedown', (e) => {
  if (isPopoverOpen() && !e.target.closest('#position-popover, #position-btn')) closePositionPopover();
});

// ── Add Playlist modal ────────────────────────────────────────────────────

function openAddPlaylistModal() {
  pendingPlaylist = null;
  el('add-playlist-url').value = '';
  el('add-playlist-name').value = '';
  el('add-playlist-info').textContent = '';
  el('add-playlist-preview').classList.add('hidden');
  el('add-playlist-save-btn').disabled = true;
  el('add-playlist-modal').classList.remove('hidden');
  el('add-playlist-url').focus();
}

function closeAddPlaylistModal() {
  el('add-playlist-modal').classList.add('hidden');
  pendingPlaylist = null;
}

async function fetchPlaylistForAdd() {
  const playlistId = extractPlaylistId(el('add-playlist-url').value.trim());
  if (!playlistId) { showToast('Invalid playlist URL', 'error'); return; }
  const btn = el('add-playlist-fetch-btn');
  btn.disabled = true; btn.textContent = 'Fetching…';
  try {
    const { title, tracks } = await ipcRenderer.invoke('get-playlist-info', playlistId);
    pendingPlaylist = { name: title, tracks };
    el('add-playlist-name').value = title;
    el('add-playlist-info').textContent = `${tracks.length} tracks fetched`;
    el('add-playlist-preview').classList.remove('hidden');
    el('add-playlist-save-btn').disabled = false;
    el('add-playlist-name').focus();
  } catch (err) {
    showToast('Failed to fetch — ' + (err.message || err), 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Fetch';
  }
}

function saveNewPlaylist() {
  if (!pendingPlaylist) return;
  const name = el('add-playlist-name').value.trim() || pendingPlaylist.name;
  const newPl = { id: Date.now().toString(), name, tracks: pendingPlaylist.tracks };
  state.playlists.push(newPl);
  ipcRenderer.invoke('save-playlists', state.playlists);
  closeAddPlaylistModal();
  showToast(`Playlist "${truncate(name, 30)}" saved`, 'success');
  switchToPlaylist(newPl.id);
}

// ── Playback state persistence ────────────────────────────────────────────

function saveLastPlayback() {
  if (!state.currentVideo || state.currentIndex < 0) return;
  state.settings.lastPlayback = {
    activePlaylistId: state.activePlaylistId || null,
    currentIndex: state.currentIndex,
    currentTime: el('youtube-player').currentTime || 0,
  };
  ipcRenderer.invoke('save-settings', state.settings);
}

async function restorePlayback(saved) {
  if (saved.activePlaylistId) {
    const pl = state.playlists.find(p => p.id === saved.activePlaylistId);
    if (!pl) return;
    state.activePlaylistId = saved.activePlaylistId;
    state.queue = [...(pl.tracks || [])];
  }
  const video = state.queue[saved.currentIndex];
  if (!video) return;

  state.currentIndex = saved.currentIndex;
  state.currentVideo = video;
  setAlbumArt(video);
  updateVideoInfo(video);
  renderQueue();
  setLoading(true);

  try {
    const audio = el('youtube-player');
    audio.src = await resolveAudioSrc(video.videoId);
    const t = saved.currentTime || 0;
    if (t > 0) {
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = t; }, { once: true });
    }
    setLoading(false);
    state.playing = false;
    updatePlayPauseBtn();
  } catch {
    setLoading(false);
  }
}

// ── Settings ──────────────────────────────────────────────────────────────

const openSettings = () => ipcRenderer.send('open-settings-popup');

function updateKeyIndicator() {
  el('key-indicator').className = 'key-dot ' + (state.apiKey ? 'has-key' : 'no-key');
}

function updateVolumeIcon() {
  const muted = el('youtube-player').muted || el('youtube-player').volume === 0;
  el('mute-btn').classList.toggle('active', muted);
  el('volume-icon').innerHTML = muted
    ? '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>'
    : '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
}

const REPEAT_MODES = ['once', 'repeat', 'repeat-one'];
const REPEAT_ICONS = {
  once: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="15" y2="12"/><polyline points="10 7 15 12 10 17"/><line x1="19" y1="6" x2="19" y2="18"/></svg>`,
  repeat: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
  'repeat-one': `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="14.5" text-anchor="middle" font-size="8" font-weight="700" fill="currentColor" stroke="none">1</text></svg>`,
};
const REPEAT_TITLES = { once: '한 번만 재생', repeat: '반복 재생', 'repeat-one': '한 곡 반복' };

function updateRepeatBtn() {
  const btn = el('repeat-btn');
  btn.innerHTML = REPEAT_ICONS[state.playbackMode];
  btn.title = REPEAT_TITLES[state.playbackMode];
  btn.classList.toggle('active', state.playbackMode !== 'once');
}

// ── Metal texture ──────────────────────────────────────────────────────────

function applyMetalTexture() {
  const { applyMetalTexture: apply } = require('./texture');
  apply(['player-bar', 'playlist-panel-header'].map(id => el(id)).filter(Boolean));
}

// ── Init sub-functions ────────────────────────────────────────────────────

function initAudio(audio) {
  audio.addEventListener('ended', () => {
    if (state.playbackMode === 'repeat-one') {
      playFromQueue(state.currentIndex);
    } else if (state.settings.autoAdvance !== false) {
      if (state.currentIndex < state.queue.length - 1) {
        playFromQueue(state.currentIndex + 1);
      } else if (state.playbackMode === 'repeat') {
        playFromQueue(0);
      }
    }
  });
  audio.addEventListener('loadedmetadata', () => {
    el('progress-bar').max = audio.duration;
    el('time-duration').textContent = formatTime(audio.duration);
    syncTrack(el('progress-bar'));
  });

  let seeking = false;
  let lastSaveTime = 0;
  audio.addEventListener('timeupdate', () => {
    if (seeking) return;
    el('progress-bar').value = audio.currentTime;
    el('time-current').textContent = formatTime(audio.currentTime);
    syncTrack(el('progress-bar'));
    const now = Date.now();
    if (state.playing && now - lastSaveTime > PLAYBACK_SAVE_INTERVAL_MS) {
      lastSaveTime = now;
      saveLastPlayback();
    }
  });

  el('progress-bar').addEventListener('mousedown', () => { seeking = true; });
  el('progress-bar').addEventListener('input', () => {
    el('time-current').textContent = formatTime(parseFloat(el('progress-bar').value));
    syncTrack(el('progress-bar'));
  });
  el('progress-bar').addEventListener('mouseup', () => {
    audio.currentTime = parseFloat(el('progress-bar').value);
    seeking = false;
  });

  el('volume-bar').addEventListener('input', () => {
    const vol = parseFloat(el('volume-bar').value);
    audio.volume = vol;
    audio.muted = vol === 0;
    syncTrack(el('volume-bar'));
    updateVolumeIcon();
  });
  el('volume-bar').addEventListener('change', () => {
    state.settings.volume = parseFloat(el('volume-bar').value);
    ipcRenderer.invoke('save-settings', state.settings);
  });
  el('mute-btn').addEventListener('click', () => {
    audio.muted = !audio.muted;
    if (!audio.muted && audio.volume === 0) {
      audio.volume = 0.5;
      el('volume-bar').value = 0.5;
      syncTrack(el('volume-bar'));
    }
    updateVolumeIcon();
  });
}

function initControls() {
  el('prev-btn').addEventListener('click', playPrev);
  el('next-btn').addEventListener('click', playNext);
  el('playpause-btn').addEventListener('click', togglePlayPause);

  el('minimize-btn').addEventListener('click', () => ipcRenderer.send('minimize-window'));
  el('close-btn').addEventListener('click', () => ipcRenderer.send('close-window'));
  el('pin-btn').addEventListener('click', async () => {
    const pinned = await ipcRenderer.invoke('toggle-always-on-top');
    el('pin-btn').classList.toggle('active', pinned);
    el('pin-btn').title = pinned ? 'Unpin' : 'Always on top';
  });

  el('repeat-btn').addEventListener('click', () => {
    state.playbackMode = REPEAT_MODES[(REPEAT_MODES.indexOf(state.playbackMode) + 1) % REPEAT_MODES.length];
    updateRepeatBtn();
  });

  el('add-search-toggle').addEventListener('click', () => ipcRenderer.send('open-menu-popup'));
  el('playlist-panel-toggle').addEventListener('click', togglePlaylistPanel);
  el('playlist-dropdown-btn').addEventListener('click', () => ipcRenderer.send('open-playlist-popup'));

  el('settings-btn').addEventListener('click', openSettings);

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === ' ')          { e.preventDefault(); togglePlayPause(); }
    if (e.key === 'ArrowRight' || e.key === 'n') playNext();
    if (e.key === 'ArrowLeft'  || e.key === 'p') playPrev();
  });
}

function initIPCHandlers() {
  ipcRenderer.on('send-menu-state', () =>
    ipcRenderer.send('push-menu-state', { apiKey: state.apiKey }));

  ipcRenderer.on('send-settings-state', () =>
    ipcRenderer.send('push-settings-state', state.settings));

  ipcRenderer.on('settings-saved', async (_, data) => {
    state.settings = { ...state.settings, ...data };
    state.apiKey = data.apiKey || '';
    await ipcRenderer.invoke('save-settings', state.settings);
    updateKeyIndicator();
    refreshDownloadedIds();
    showToast('Settings saved', 'success');
  });

  ipcRenderer.on('send-playlist-state', () =>
    ipcRenderer.send('push-playlist-state', { playlists: state.playlists, activePlaylistId: state.activePlaylistId }));

  // Google sign-in imported the user's playlists; merge them in (tracks load lazily).
  ipcRenderer.on('google-imported', async (_, { account, playlists }) => {
    const others = state.playlists.filter(p => p.source !== 'google');
    const imported = playlists.map(p => ({ ...p, tracks: [], loaded: false }));
    state.playlists = [...others, ...imported];
    await ipcRenderer.invoke('save-playlists', state.playlists);
    ipcRenderer.send('push-playlist-state', { playlists: state.playlists, activePlaylistId: state.activePlaylistId });
    showToast(`${account} · 재생목록 ${imported.length}개를 불러왔습니다`, 'success');
  });

  ipcRenderer.on('google-signed-out', async () => {
    const onGoogle = state.playlists.some(p => p.source === 'google' && p.id === state.activePlaylistId);
    state.playlists = state.playlists.filter(p => p.source !== 'google');
    await ipcRenderer.invoke('save-playlists', state.playlists);
    if (onGoogle) switchToQueue();
    ipcRenderer.send('push-playlist-state', { playlists: state.playlists, activePlaylistId: state.activePlaylistId });
    showToast('Google 로그아웃됨', 'success');
  });

  ipcRenderer.on('popup-search-request', async (_, query) => {
    if (!state.apiKey) { ipcRenderer.send('popup-search-response', { results: [], error: true }); return; }
    try {
      const res = await fetch(`${YT_SEARCH_API}?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${SEARCH_MAX_RESULTS}&key=${encodeURIComponent(state.apiKey)}`);
      const data = await res.json();
      if (data.error || !data.items?.length) { ipcRenderer.send('popup-search-response', { results: [] }); return; }
      ipcRenderer.send('popup-search-response', {
        results: data.items.map(i => ({ videoId: i.id.videoId, title: i.snippet.title, channel: i.snippet.channelTitle })),
      });
    } catch { ipcRenderer.send('popup-search-response', { results: [], error: true }); }
  });

  ipcRenderer.on('popup-action', (_, action) => {
    switch (action.type) {
      case 'add-url':          addByUrl(action.url); break;
      case 'add-to-queue':     addToQueue(action.video, action.playNow); break;
      case 'switch-playlist':  switchToPlaylist(action.id); break;
      case 'switch-to-queue':  switchToQueue(); break;
      case 'delete-playlist':  deletePlaylist(action.id); break;
      case 'open-add-playlist': openAddPlaylistModal(); break;
    }
    ipcRenderer.send('push-playlist-state', { playlists: state.playlists, activePlaylistId: state.activePlaylistId });
  });
}

function initPlaylistModal() {
  el('add-playlist-fetch-btn').addEventListener('click', fetchPlaylistForAdd);
  el('add-playlist-save-btn').addEventListener('click', saveNewPlaylist);
  el('add-playlist-cancel-btn').addEventListener('click', closeAddPlaylistModal);
  el('add-playlist-backdrop').addEventListener('click', closeAddPlaylistModal);
  el('add-playlist-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fetchPlaylistForAdd();
    if (e.key === 'Escape') closeAddPlaylistModal();
  });
  el('add-playlist-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveNewPlaylist();
    if (e.key === 'Escape') closeAddPlaylistModal();
  });
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  const [saved, savedPlaylists] = await Promise.all([
    ipcRenderer.invoke('get-settings'),
    ipcRenderer.invoke('get-playlists'),
  ]);

  const legacyKey = localStorage.getItem(STORAGE_KEYS.apiKey);
  if (legacyKey && !saved.apiKey) {
    saved.apiKey = legacyKey;
    localStorage.removeItem(STORAGE_KEYS.apiKey);
    ipcRenderer.invoke('save-settings', saved);
  }

  state.settings = { ...DEFAULT_SETTINGS, ...saved };
  state.apiKey = state.settings.apiKey || '';
  state.playlists = Array.isArray(savedPlaylists) ? savedPlaylists : [];

  updateKeyIndicator();
  renderQueue();
  refreshDownloadedIds();
  updateRepeatBtn();

  const audio = el('youtube-player');
  audio.volume = parseFloat(state.settings.volume ?? 1);
  el('volume-bar').value = audio.volume;
  syncTrack(el('volume-bar'));
  updateVolumeIcon();

  initAudio(audio);
  initControls();
  initIPCHandlers();
  initPlaylistModal();
  applyMetalTexture();

  window.addEventListener('beforeunload', saveLastPlayback);

  if (saved.lastPlayback?.currentIndex >= 0) {
    restorePlayback(saved.lastPlayback);
  }

  requestAnimationFrame(() => {
    // Window is fixed at the full (expanded) height; the playlist slides within it.
    const maxH = collapsedHeight() + 280; // 280 = CSS #queue-list open max-height
    ipcRenderer.send('set-exact-height', maxH);
  });
}

document.addEventListener('DOMContentLoaded', init);
