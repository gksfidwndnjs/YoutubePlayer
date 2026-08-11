'use strict';

const { ipcRenderer } = require('electron');

// ── Constants ─────────────────────────────────────────────────────────────

const STORAGE_KEYS = { queue: 'yt_queue', apiKey: 'yt_api_key' };
const DEFAULT_SETTINGS = {
  audioQuality: 'best', autoAdvance: true, volume: 1,
  fontFamily: 'pixel', fontScale: 1, crtGlow: true,
};

// Font/scale/glow/8-bit all live in texture.applyFont (shared with the popups).
function applyFontSettings(s = state.settings) {
  require('./texture').applyFont(s);
}
const DEFAULT_PLAYLIST_FOLDER = 'Queue';
const TOAST_DURATION_MS = 3000;
// Errors now carry a reason worth reading, so they linger longer than a status blip.
const TOAST_ERROR_DURATION_MS = 9000;
const PLAYBACK_SAVE_INTERVAL_MS = 5000;
const SEARCH_MAX_RESULTS = 15;
const YT_SEARCH_API = 'https://www.googleapis.com/youtube/v3/search';
const LRCLIB_GET = 'https://lrclib.net/api/get';
const LRCLIB_SEARCH = 'https://lrclib.net/api/search';

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
  // Lyrics (LRCLIB). mode persists across tracks; lines/plain reset per track.
  lyrics: {
    mode: 'info',      // 'info' | 'lyrics'
    videoId: null,
    status: 'idle',    // 'idle' | 'loading' | 'synced' | 'plain' | 'none'
    lines: [],         // [{ time:Number(sec), text:String }] for synced
    activeIndex: -1,
  },
};

const lyricsCache = new Map(); // videoId -> { status, lines, plain }

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
      const reason = errorReason(err);
      console.error('[download]', video.videoId, reason);
      if (!silent) {
        showToast(`다운로드 실패: ${truncate(video.title || video.videoId, 20)} — ${truncate(reason, 90)}`, 'error');
      }
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
    } catch (err) {
      fail++;
      showToast(`다운로드 실패 (스킵): ${truncate(video.title || video.videoId, 20)} — ${truncate(errorReason(err), 90)}`, 'error');
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

// ipcRenderer.invoke wraps rejections as "Error invoking remote method 'x': Error: …";
// strip that so the user sees what actually went wrong.
const errorReason = (err) => String(err?.message || err)
  .replace(/^Error invoking remote method '[^']*':\s*/, '')
  .replace(/^Error:\s*/, '')
  .trim();

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  setTimeout(() => t.remove(), type === 'error' ? TOAST_ERROR_DURATION_MS : TOAST_DURATION_MS);
}

// ── ID / URL extraction ───────────────────────────────────────────────────

function extractPlaylistId(raw) {
  const m = raw.trim().match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Score a video search hit by how likely it is to be an official release, so we
// can surface "official audio" at the top of search results. Auto-generated
// "- Topic" channels and VEVO host the label's official audio; live/cover/remix
// uploads get penalised.
function officialScore(v) {
  const ch = (v.channel || '').toLowerCase();
  const t = (v.title || '').toLowerCase();
  let s = 0;
  if (/-\s*topic$/.test(ch)) s += 100;
  if (/vevo/.test(ch)) s += 60;
  if (/official/.test(ch)) s += 25;
  if (/official\s*(audio|music\s*video|video|mv|lyric)/.test(t)) s += 50;
  if (/공식/.test(t)) s += 30;
  if (/\b(cover|remix|live|lyrics?|reaction|sped\s*up|nightcore|8d|mashup|karaoke|instrumental)\b/.test(t)) s -= 40;
  return s;
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

// ── Lyrics (LRCLIB) ──────────────────────────────────────────────────────────

// YouTube titles are messy ("Artist - Song (Official Video) [4K]"). Strip the
// noise and split into { artist, title } for an LRCLIB lookup.
function parseTrackInfo(video) {
  const NOISE = /\b(official\s*(music\s*)?(video|audio|lyric[s]?|m\/?v)|lyric[s]?|audio|video|m\/?v|hd|4k|8k|mv|visualizer|color\s*coded|performance|live|remaster(ed)?)\b/gi;
  let t = (video.title || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[「」『』【】]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let artist = '';
  let title = t;
  const m = t.split(/\s+[-–—|]\s+/);
  if (m.length >= 2) {
    artist = m[0].trim();
    title = m.slice(1).join(' - ').trim();
  } else {
    // No separator: use the channel as the artist.
    artist = (video.channel || '')
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/\bVEVO\b/gi, '')
      .replace(/\bOfficial\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return { artist, title: title || t };
}

// Parse an LRC string into sorted [{ time, text }], dropping blank lines.
function parseLRC(lrc) {
  const out = [];
  for (const raw of String(lrc).split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+)(?:\.(\d+))?\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[(\d+):(\d+)(?:\.(\d+))?\]/g, '').trim();
    if (!text) continue;
    for (const s of stamps) {
      const min = parseInt(s[1], 10);
      const sec = parseInt(s[2], 10);
      const frac = s[3] ? parseFloat('0.' + s[3]) : 0;
      out.push({ time: min * 60 + sec + frac, text });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

async function lrclibFetch(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

// Returns { syncedLyrics, plainLyrics } or null.
async function fetchLyrics({ artist, title }, duration) {
  if (!title) return null;
  const dur = Math.round(duration || 0);
  // Exact match first (duration-disambiguated).
  try {
    const q = new URLSearchParams({ track_name: title, artist_name: artist });
    if (dur) q.set('duration', String(dur));
    const got = await lrclibFetch(`${LRCLIB_GET}?${q}`);
    if (got && (got.syncedLyrics || got.plainLyrics)) return got;
  } catch {}
  // Fallback: search, then pick the closest duration (or first hit).
  try {
    const q = new URLSearchParams({ track_name: title });
    if (artist) q.set('artist_name', artist);
    const hits = await lrclibFetch(`${LRCLIB_SEARCH}?${q}`);
    if (Array.isArray(hits) && hits.length) {
      const withLyrics = hits.filter(h => h.syncedLyrics || h.plainLyrics);
      if (!withLyrics.length) return null;
      if (dur) {
        withLyrics.sort((a, b) =>
          Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur));
      }
      return withLyrics[0];
    }
  } catch {}
  return null;
}

function resetLyrics() {
  state.lyrics.videoId = null;
  state.lyrics.status = 'idle';
  state.lyrics.lines = [];
  state.lyrics.activeIndex = -1;
  renderLyrics();
  refreshLyricsView();
}

// Fetch + store lyrics for the current track. Called once duration is known.
async function loadLyrics(video, duration) {
  if (!video) return;
  const videoId = video.videoId;
  state.lyrics.videoId = videoId;
  state.lyrics.activeIndex = -1;

  const cached = lyricsCache.get(videoId);
  if (cached) {
    applyLyricsResult(videoId, cached);
    return;
  }

  state.lyrics.status = 'loading';
  state.lyrics.lines = [];
  renderLyrics();
  refreshLyricsView(); // loading: keep the toggle enabled, decide X only after

  const data = await fetchLyrics(parseTrackInfo(video), duration);
  if (state.lyrics.videoId !== videoId) return; // track changed mid-fetch

  let result;
  if (data && data.syncedLyrics) {
    result = { status: 'synced', lines: parseLRC(data.syncedLyrics), plain: data.plainLyrics || '' };
    if (!result.lines.length) result.status = data.plainLyrics ? 'plain' : 'none';
  } else if (data && data.plainLyrics) {
    result = { status: 'plain', lines: [], plain: data.plainLyrics };
  } else {
    result = { status: 'none', lines: [], plain: '' };
  }
  lyricsCache.set(videoId, result);
  applyLyricsResult(videoId, result);
}

function applyLyricsResult(videoId, result) {
  if (state.lyrics.videoId !== videoId) return;
  state.lyrics.status = result.status;
  state.lyrics.lines = result.lines || [];
  state.lyrics.plain = result.plain || '';
  state.lyrics.activeIndex = -1;
  renderLyrics();
  refreshLyricsView();
}

const LYRIC_ICON_NOTE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
const LYRIC_ICON_X = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

const hasLyrics = () => state.lyrics.status === 'synced' && state.lyrics.lines.length > 0;
const isLyricsLoading = () => state.lyrics.status === 'loading';
// Toggling is allowed while lyrics exist OR are still loading (decide X only after).
const lyricsToggleable = () => hasLyrics() || isLyricsLoading();

// Sync the toggle button + which view shows. While loading the toggle stays
// enabled (lyrics view shows "불러오는 중…"); only after loading, a track with no
// synced lyrics gets the X + disabled button and song-info is forced.
function refreshLyricsView() {
  const btn = el('lyrics-toggle-btn');
  if (!btn) return;
  const ok = lyricsToggleable();
  btn.disabled = !ok;
  btn.innerHTML = ok ? LYRIC_ICON_NOTE : LYRIC_ICON_X;
  btn.title = ok ? '가사 / 곡 정보 전환' : '가사 없음';
  const showLyrics = ok && state.lyrics.mode === 'lyrics';
  el('info-view').classList.toggle('view-hidden', showLyrics);
  el('lyrics-view').classList.toggle('hidden', !showLyrics);
  btn.classList.toggle('active', showLyrics);
  if (showLyrics && hasLyrics()) {
    state.lyrics.activeIndex = -1;
    updateLyricHighlight(el('youtube-player').currentTime || 0);
  }
}

// Build the scrolling line list (one box per lyric). Loading shows a status
// message; other no-lyrics states are handled by refreshLyricsView (song-info).
function renderLyrics() {
  const scroll = el('lyrics-scroll');
  if (!scroll) return;
  const L = state.lyrics;
  L.lineH = 0; // re-measure after (re)build (font size may have changed)

  if (L.status === 'synced' && L.lines.length) {
    scroll.innerHTML = L.lines.map((_, i) => `<div class="lyric-line" data-i="${i}"></div>`).join('');
    const nodes = scroll.children;
    for (let i = 0; i < nodes.length; i++) nodes[i].textContent = L.lines[i].text;
    L.activeIndex = -1;
    // Jump to the top without animating the initial build.
    scroll.style.transition = 'none';
    scroll.style.transform = 'translateY(0)';
    void scroll.offsetWidth;
    scroll.style.transition = '';
  } else if (L.status === 'loading') {
    scroll.innerHTML = '<div class="lyric-line lyric-status"></div>';
    scroll.firstChild.textContent = '가사 불러오는 중…';
    scroll.style.transform = 'translateY(0)';
  } else {
    scroll.innerHTML = '';
    scroll.style.transform = 'translateY(0)';
  }
}

// Advance the highlighted line as playback moves, scrolling the list up so the
// current line rises to the top (out-going line slides up and fades). From timeupdate.
function updateLyricHighlight(currentTime) {
  const L = state.lyrics;
  if (L.mode !== 'lyrics' || L.status !== 'synced' || !L.lines.length) return;

  let idx = -1;
  for (let i = 0; i < L.lines.length; i++) {
    if (L.lines[i].time <= currentTime) idx = i; else break;
  }
  const eff = idx >= 0 ? idx : 0; // before the first line, sit on line 0
  if (eff === L.activeIndex) return;
  L.activeIndex = eff;

  const scroll = el('lyrics-scroll');
  const nodes = scroll.children;
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].classList.toggle('active', i === eff);
    nodes[i].classList.toggle('past', i < eff);
  }
  // Measure a line box lazily (only valid while the view is visible).
  if (!L.lineH && nodes[0]) L.lineH = nodes[0].offsetHeight;
  const LH = L.lineH || 18;
  scroll.style.transform = `translateY(${-eff * LH}px)`;
}

function setLyricsMode(mode) {
  state.lyrics.mode = mode;
  refreshLyricsView();
}

function toggleLyricsView() {
  if (!lyricsToggleable()) return; // disabled only after loading with no lyrics
  setLyricsMode(state.lyrics.mode === 'lyrics' ? 'info' : 'lyrics');
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
  resetLyrics(); // cleared now; fetched once duration is known (loadedmetadata)

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
  resetLyrics();
  updatePlayPauseBtn();
  renderQueue();
}

// ── URL add ────────────────────────────────────────────────────────────────

async function addPlaylistToQueue(playlistId) {
  showToast('Fetching playlist…');
  try {
    const { title, tracks } = await ipcRenderer.invoke('get-playlist-info', playlistId);
    if (!tracks.length) { showToast('Playlist is empty or unavailable', 'error'); return; }
    // ytId keeps the link to the source playlist so it can be refreshed later.
    const newPl = { id: Date.now().toString(), name: title, ytId: playlistId, tracks, lastRefresh: Date.now() };
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
  resetLyrics();
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

// ── Playlist auto-refresh ─────────────────────────────────────────────────
// Imported playlists go stale as the source changes upstream. On launch every
// linked playlist is re-fetched and reconciled: tracks deleted upstream are
// dropped, new ones appended. Local ordering and manual additions are preserved,
// so a refresh never scrambles a list the user has arranged.

// null → this playlist has no link to a source we can re-fetch (added before ytId
// was recorded, or a Google list whose tracks haven't been loaded yet).
async function fetchRemoteTracks(pl) {
  if (pl.source === 'google') return pl.loaded ? ipcRenderer.invoke('google-playlist-items', pl.id) : null;
  if (!pl.ytId) return null;
  const { tracks } = await ipcRenderer.invoke('get-playlist-info', pl.ytId);
  return tracks;
}

function reconcileTracks(local, remote) {
  const remoteById = new Map(remote.map(t => [t.videoId, t]));
  const localIds = new Set(local.map(t => t.videoId));
  // Keep local order, refresh titles/channels from upstream (videos get renamed).
  const kept = local.filter(t => remoteById.has(t.videoId)).map(t => ({ ...t, ...remoteById.get(t.videoId) }));
  const added = remote.filter(t => !localIds.has(t.videoId));
  return { tracks: [...kept, ...added], added: added.length, removed: local.length - kept.length };
}

// Returns { added, removed }, or null when there was nothing to refresh against.
async function refreshPlaylist(pl) {
  const remote = await fetchRemoteTracks(pl);
  // An empty result is more likely a hiccup (private/unavailable/quota) than a
  // genuinely emptied playlist — never wipe the user's tracks on that.
  if (!Array.isArray(remote) || !remote.length) return null;

  const result = reconcileTracks(pl.tracks || [], remote);
  pl.tracks = result.tracks;
  pl.lastRefresh = Date.now();

  if (pl.id === state.activePlaylistId) {
    const currentId = state.currentVideo?.videoId;
    state.queue = [...result.tracks];
    // The playing track may have shifted (or vanished) — re-anchor by video id.
    state.currentIndex = currentId ? state.queue.findIndex(v => v.videoId === currentId) : -1;
    renderQueue();
  }
  return result;
}

const canRefresh = (pl) => (pl.source === 'google' ? !!pl.loaded : !!pl.ytId);

// `verbose` (manual run) always reports the outcome; the launch run stays quiet
// unless something actually changed, so startup isn't noisy.
let refreshing = false;

async function refreshAllPlaylists({ verbose = false } = {}) {
  if (refreshing) return;
  const targets = state.playlists.filter(canRefresh);
  if (!targets.length) {
    if (verbose) {
      showToast(state.playlists.length
        ? '갱신할 수 있는 재생목록이 없습니다 — 원본 링크가 없는 목록은 URL로 다시 추가해야 합니다.'
        : '재생목록이 없습니다.', 'error');
    }
    return;
  }

  refreshing = true;
  if (verbose) showToast(`재생목록 ${targets.length}개 갱신 중…`);
  let added = 0, removed = 0, changed = 0, failed = 0, authExpired = false;
  try {
    for (const pl of targets) {
      try {
        const r = await refreshPlaylist(pl);
        if (r && (r.added || r.removed)) { added += r.added; removed += r.removed; changed++; }
      } catch (err) {
        const msg = String(err?.message || err);
        console.error('[refresh]', pl.name, msg);
        // An expired Google session fails every remaining playlist the same way —
        // stop and say so once instead of grinding through them all.
        if (/로그인이 만료|로그인이 필요/.test(msg)) { authExpired = true; break; }
        failed++;
      }
    }
    await ipcRenderer.invoke('save-playlists', state.playlists);
  } finally {
    refreshing = false;
  }

  ipcRenderer.send('push-playlist-state', { playlists: state.playlists, activePlaylistId: state.activePlaylistId });
  if (changed) {
    showToast(`재생목록 ${changed}개 갱신됨 (추가 ${added} / 삭제 ${removed})`, 'success');
  } else if (verbose && !authExpired) {
    showToast(`재생목록 ${targets.length}개 확인 — 변경 없음`, 'success');
  }
  if (authExpired) showToast('Google 로그인이 만료되어 갱신할 수 없습니다 — 설정에서 다시 로그인하세요.', 'error');
  else if (failed) showToast(`${failed}개는 갱신하지 못했습니다 (비공개이거나 네트워크 오류)`, 'error');
}

// ── Playlist panel ────────────────────────────────────────────────────────

// Collapsed content height in design px (zoom-independent — see main.js sizing).
const collapsedHeight = () =>
  el('playlist-panel-header').getBoundingClientRect().height
  + el('player-bar').getBoundingClientRect().height;

// The OS window is fixed at the full (expanded) height, so anything that changes the
// visible UI's height — the update bar appearing/disappearing — must resize it.
function syncWindowHeight() {
  requestAnimationFrame(() => {
    const bar = el('update-progress');
    const extra = bar.classList.contains('hidden') ? 0 : bar.getBoundingClientRect().height;
    // 280 = CSS #queue-list open max-height
    ipcRenderer.send('set-exact-height', Math.round(collapsedHeight() + extra + 280));
  });
}

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

// ── Long-task progress bar ─────────────────────────────────────────────────
// Shared by anything slow enough to need feedback: the ~120 MB update download
// and moving a music library between folders. The taskbar button mirrors it.

const toMB = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

function showProgress({ label = '작업 중', percent = 0, detail = '' }) {
  const box = el('update-progress');
  const wasHidden = box.classList.contains('hidden');
  box.classList.remove('hidden');

  const pct = Math.min(100, Math.max(0, percent));
  el('update-progress-fill').style.width = pct + '%';
  el('update-progress-label').textContent = `${label} ${Math.round(pct)}%`;
  el('update-progress-meta').textContent = detail;

  if (wasHidden) syncWindowHeight(); // the bar adds height to the visible UI
}

function hideProgress({ error, message } = {}) {
  el('update-progress').classList.add('hidden');
  syncWindowHeight();
  if (error) showToast(truncate(String(error), 100), 'error');
  else if (message) showToast(message, 'success');
}

// The updater reports bytes; translate that into the shared bar's shape.
function showUpdateProgress({ percent = 0, transferred = 0, total = 0, bytesPerSecond = 0 }) {
  showProgress({
    label: '업데이트 다운로드 중',
    percent,
    detail: total
      ? `${toMB(transferred)} / ${toMB(total)} MB${bytesPerSecond ? ` · ${toMB(bytesPerSecond)} MB/s` : ''}`
      : '준비 중…',
  });
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
    pendingPlaylist = { name: title, tracks, ytId: playlistId };
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
  const newPl = {
    id: Date.now().toString(), name,
    ytId: pendingPlaylist.ytId, tracks: pendingPlaylist.tracks, lastRefresh: Date.now(),
  };
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

// Offer to bring existing downloads along when the music folder changes. The
// prompt and the move both live in main; this just reports the outcome.
async function migrateMusicDir(from, to) {
  try {
    const r = await ipcRenderer.invoke('migrate-music-dir', from, to);
    if (r?.skipped) return;
    if (r?.kept) {
      showToast('기존 다운로드는 이전 폴더에 남겨뒀습니다.', 'error');
      return;
    }
    const parts = [`${r.moved}개 이동`];
    if (r.skipped) parts.push(`${r.skipped}개 건너뜀`);
    if (r.failed) parts.push(`${r.failed}개 실패`);
    showToast(`음악 폴더 이동 완료 — ${parts.join(' / ')}`, r.failed ? 'error' : 'success');
  } catch (err) {
    showToast(`폴더 이동 실패 — ${truncate(errorReason(err), 80)}`, 'error');
  }
}

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
    if (state.currentVideo) loadLyrics(state.currentVideo, audio.duration);
  });

  let seeking = false;
  let lastSaveTime = 0;
  audio.addEventListener('timeupdate', () => {
    if (seeking) return;
    el('progress-bar').value = audio.currentTime;
    el('time-current').textContent = formatTime(audio.currentTime);
    syncTrack(el('progress-bar'));
    updateLyricHighlight(audio.currentTime);
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

  el('lyrics-toggle-btn').addEventListener('click', toggleLyricsView);

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
  ipcRenderer.on('update-progress', (_, p) => showUpdateProgress(p));
  ipcRenderer.on('update-progress-done', (_, r) => hideProgress(
    r?.error ? { error: `업데이트 다운로드 실패 — ${r.error}` }
             : { message: r?.version ? `업데이트 다운로드 완료 (v${r.version})` : '' }));
  ipcRenderer.on('task-progress', (_, p) => showProgress(p));

  ipcRenderer.on('send-menu-state', () =>
    ipcRenderer.send('push-menu-state', { apiKey: state.apiKey }));

  ipcRenderer.on('send-settings-state', () =>
    ipcRenderer.send('push-settings-state', state.settings));

  ipcRenderer.on('settings-saved', async (_, data) => {
    // Resolve before/after rather than comparing the raw setting: an empty value
    // means "default Music folder", so the stored strings can differ while the
    // actual folder doesn't (and vice versa).
    const before = (await ipcRenderer.invoke('music-dir-info')).dir;
    state.settings = { ...state.settings, ...data };
    state.apiKey = data.apiKey || '';
    await ipcRenderer.invoke('save-settings', state.settings);
    applyFontSettings();
    updateKeyIndicator();
    showToast('Settings saved', 'success');

    const after = (await ipcRenderer.invoke('music-dir-info')).dir;
    if (after !== before) await migrateMusicDir(before, after);
    refreshDownloadedIds();
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
    if (!state.apiKey) { ipcRenderer.send('popup-search-response', { error: true }); return; }
    try {
      const key = encodeURIComponent(state.apiKey);
      const q = encodeURIComponent(query);
      const thumbOf = s => s?.thumbnails?.medium?.url || s?.thumbnails?.default?.url || '';
      const [plData, vidData] = await Promise.all([
        fetch(`${YT_SEARCH_API}?part=snippet&q=${q}&type=playlist&maxResults=${SEARCH_MAX_RESULTS}&key=${key}`).then(r => r.json()).catch(() => ({})),
        fetch(`${YT_SEARCH_API}?part=snippet&q=${q}&type=video&maxResults=10&key=${key}`).then(r => r.json()).catch(() => ({})),
      ]);
      if (plData.error && vidData.error) { ipcRenderer.send('popup-search-response', { error: true }); return; }

      const playlists = (plData.items || []).map(i => ({
        playlistId: i.id.playlistId,
        title: i.snippet.title,
        channel: i.snippet.channelTitle,
        thumb: thumbOf(i.snippet),
      }));

      const videos = (vidData.items || []).map(i => ({
        videoId: i.id.videoId,
        title: i.snippet.title,
        channel: i.snippet.channelTitle,
        thumb: thumbOf(i.snippet),
      }));
      const official = videos
        .map(v => ({ v, s: officialScore(v) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 3)
        .map(x => x.v);

      ipcRenderer.send('popup-search-response', { official, playlists });
    } catch { ipcRenderer.send('popup-search-response', { error: true }); }
  });

  ipcRenderer.on('popup-playlist-items-request', async (_, playlistId) => {
    try {
      const { title, tracks } = await ipcRenderer.invoke('get-playlist-info', playlistId);
      ipcRenderer.send('popup-playlist-items-response', {
        playlistId, title,
        items: tracks.map(t => ({ videoId: t.videoId, title: t.title, channel: t.channel })),
      });
    } catch { ipcRenderer.send('popup-playlist-items-response', { error: true }); }
  });

  ipcRenderer.on('popup-action', (_, action) => {
    switch (action.type) {
      case 'add-url':          addByUrl(action.url); break;
      case 'add-to-queue':     addToQueue(action.video, action.playNow); break;
      case 'switch-playlist':  switchToPlaylist(action.id); break;
      case 'switch-to-queue':  switchToQueue(); break;
      case 'delete-playlist':  deletePlaylist(action.id); break;
      case 'open-add-playlist': openAddPlaylistModal(); break;
      case 'refresh-playlists': refreshAllPlaylists({ verbose: true }); break;
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

// One-time first-run setup: only on a truly fresh install (no settings file yet).
// Lets the user pick the music storage folder before using the app.
function maybeShowFirstRunSetup(saved) {
  if (state.settings.setupComplete || Object.keys(saved || {}).length > 0) return;
  const modal = el('setup-modal');
  const input = el('setup-music-dir');
  input.value = state.settings.musicDir || '';
  modal.classList.remove('hidden');
  el('setup-browse-btn').onclick = async () => {
    const dir = await ipcRenderer.invoke('choose-music-dir');
    if (dir) input.value = dir;
  };
  el('setup-start-btn').onclick = async () => {
    state.settings.musicDir = input.value.trim();
    state.settings.setupComplete = true;
    await ipcRenderer.invoke('save-settings', state.settings);
    modal.classList.add('hidden');
  };
}

// With OneDrive's Files On-Demand, downloaded tracks can be turned into cloud-only
// placeholders: the app still sees the file (so the ✓ stays) but every playback makes
// OneDrive fetch it back, which Windows announces as a download. Warn once — the main
// process only reports this while files are genuinely dehydrated.
async function warnIfCloudSyncedMusicDir() {
  if (state.settings.cloudDirWarned) return;
  try {
    const { cloudSync } = await ipcRenderer.invoke('music-dir-info');
    if (!cloudSync) return;
    state.settings.cloudDirWarned = true;
    await ipcRenderer.invoke('save-settings', state.settings);
    showToast('음악 폴더가 OneDrive의 클라우드 전용 파일입니다. 재생할 때마다 OneDrive가 내려받아 알림이 뜹니다 — 폴더를 "이 장치에 항상 유지"로 설정하거나 OneDrive 밖으로 옮기세요.', 'error');
  } catch {}
}

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

  applyFontSettings();
  refreshLyricsView(); // initial: no track → X + disabled
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

  maybeShowFirstRunSetup(saved);

  window.addEventListener('beforeunload', saveLastPlayback);

  syncWindowHeight();

  // Restore first so the refresh can re-anchor on the track that's actually loaded.
  if (saved.lastPlayback?.currentIndex >= 0) {
    await restorePlayback(saved.lastPlayback).catch(() => {});
  }
  warnIfCloudSyncedMusicDir();
  refreshAllPlaylists();
}

document.addEventListener('DOMContentLoaded', init);
