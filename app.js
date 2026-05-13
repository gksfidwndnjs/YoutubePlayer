'use strict';

const { ipcRenderer } = require('electron');
const path = require('path');

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  apiKey: '',
  queue: JSON.parse(localStorage.getItem('yt_queue') || '[]'),
  currentIndex: -1,
  currentVideo: null,
  playing: false,
  loading: false,
  settings: { audioQuality: 'best', autoAdvance: true, volume: 1 },
  playlists: [],
  activePlaylistId: null,
};

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
  setTimeout(() => t.remove(), 3000);
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
    const url = await ipcRenderer.invoke('get-audio-url', video.videoId, state.settings.audioQuality);
    audio.src = url;
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
const playPrev = () => { if (state.currentIndex > 0) playFromQueue(state.currentIndex - 1); };

// ── Queue ──────────────────────────────────────────────────────────────────

function saveQueue() {
  if (state.activePlaylistId) {
    const pl = getActivePlaylist();
    if (pl) {
      pl.tracks = [...state.queue];
      ipcRenderer.invoke('save-playlists', state.playlists);
    }
  } else {
    localStorage.setItem('yt_queue', JSON.stringify(state.queue));
  }
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
  state.queue.forEach((video, i) => {
    const card = document.createElement('div');
    card.className = 'video-card' + (i === state.currentIndex ? ' now-playing' : '');
    card.innerHTML = `
      <img class="video-thumb" src="${escHtml(thumbUrl(video.videoId))}" alt="" loading="lazy">
      <div class="video-card-info">
        <div class="video-card-title">${escHtml(video.title || video.videoId)}</div>
        <div class="video-card-channel">${escHtml(video.channel || '')}</div>
      </div>
      <div class="video-card-btns">
        <button class="btn-icon btn-3d remove-btn" title="Remove">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>`;
    card.addEventListener('click', () => playFromQueue(i));
    card.querySelector('.remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromQueue(i);
    });
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

function resyncWindowHeight() {
  if (!el('playlist-panel').classList.contains('open')) return;
  requestAnimationFrame(() => {
    const h = Math.round(el('app').getBoundingClientRect().height);
    ipcRenderer.send('set-exact-height', h);
  });
}

function switchToPlaylist(id) {
  const pl = state.playlists.find(p => p.id === id);
  if (!pl) return;
  resetPlayer('Select a track to play');
  state.activePlaylistId = id;
  state.queue = [...pl.tracks];
  renderQueue();
  resyncWindowHeight();
}

function switchToQueue() {
  resetPlayer('Add a video to start listening');
  state.activePlaylistId = null;
  state.queue = JSON.parse(localStorage.getItem('yt_queue') || '[]');
  renderQueue();
  resyncWindowHeight();
}

function deletePlaylist(id) {
  if (!confirm('Delete this playlist?')) return;
  state.playlists = state.playlists.filter(p => p.id !== id);
  ipcRenderer.invoke('save-playlists', state.playlists);
  if (state.activePlaylistId === id) switchToQueue();
  else renderQueue();
}

// ── Playlist panel ────────────────────────────────────────────────────────

function togglePlaylistPanel() {
  const panel = el('playlist-panel');
  const queueList = el('queue-list');
  const isOpen = panel.classList.contains('open');
  const chevron = el('playlist-panel-toggle').querySelector('polyline');

  if (isOpen) {
    const h = Math.round(queueList.getBoundingClientRect().height);
    panel.classList.remove('open');
    chevron?.setAttribute('points', '18 15 12 9 6 15');
    setTimeout(() => { if (h > 0) ipcRenderer.send('resize-window', -h); }, 310);
  } else {
    panel.classList.add('open');
    chevron?.setAttribute('points', '6 9 12 15 18 9');
    setTimeout(() => {
      const h = Math.round(queueList.getBoundingClientRect().height);
      if (h > 0) ipcRenderer.send('resize-window', h);
    }, 310);
  }
}

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
    state.queue = [...pl.tracks];
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
    const url = await ipcRenderer.invoke('get-audio-url', video.videoId, state.settings.audioQuality);
    const audio = el('youtube-player');
    audio.src = url;
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
  el('volume-icon').innerHTML = muted
    ? '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>'
    : '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
}

// ── Metal texture ──────────────────────────────────────────────────────────

function applyMetalTexture() {
  const { applyMetalTexture: apply } = require('./texture');
  apply(['player-bar', 'playlist-panel-header'].map(id => el(id)).filter(Boolean));
}

// ── Init sub-functions ────────────────────────────────────────────────────

function initAudio(audio) {
  audio.addEventListener('ended', () => { if (state.settings.autoAdvance !== false) playNext(); });
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
    if (state.playing && now - lastSaveTime > 5000) {
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
    el('pin-btn').classList.toggle('pinned', pinned);
    el('pin-btn').title = pinned ? 'Unpin' : 'Always on top';
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
    showToast('Settings saved', 'success');
  });

  ipcRenderer.on('send-playlist-state', () =>
    ipcRenderer.send('push-playlist-state', { playlists: state.playlists, activePlaylistId: state.activePlaylistId }));

  ipcRenderer.on('popup-search-request', async (_, query) => {
    if (!state.apiKey) { ipcRenderer.send('popup-search-response', { results: [], error: true }); return; }
    try {
      const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=15&key=${encodeURIComponent(state.apiKey)}`);
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

  const legacyKey = localStorage.getItem('yt_api_key');
  if (legacyKey && !saved.apiKey) {
    saved.apiKey = legacyKey;
    localStorage.removeItem('yt_api_key');
    ipcRenderer.invoke('save-settings', saved);
  }

  state.settings = Object.assign({ audioQuality: 'best', autoAdvance: true, volume: 1 }, saved);
  state.apiKey = state.settings.apiKey || '';
  state.playlists = Array.isArray(savedPlaylists) ? savedPlaylists : [];

  updateKeyIndicator();
  renderQueue();

  const audio = el('youtube-player');
  audio.volume = parseFloat(state.settings.volume ?? 1);
  el('volume-bar').value = audio.volume;
  syncTrack(el('volume-bar'));

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
    const h = Math.round(
      el('playlist-panel-header').getBoundingClientRect().height +
      el('player-bar').getBoundingClientRect().height
    );
    ipcRenderer.send('set-exact-height', h);
  });
}

document.addEventListener('DOMContentLoaded', init);
