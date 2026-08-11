const { app, BrowserWindow, ipcMain, session, screen, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { create: createYoutubeDl } = require('youtube-dl-exec');
const { autoUpdater } = require('electron-updater');
const oauth = require('./oauth');

// ── Constants ─────────────────────────────────────────────────────────────

// All popup/window dimensions below are in DESIGN px — multiplied by uiScale at use.
const POPUP_HEIGHTS = { menu: 420, settings: 470, playlist: 280 };
const POPUP_BLUR_DEBOUNCE_MS = 300;
const AUDIO_CACHE_TTL_MS = 5 * 60 * 60 * 1000;
const AUDIO_URL_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const WIN_HEIGHT_MAX = 480;
// Consistent-sizing model: the UI is designed at DESIGN_WIDTH and scaled uniformly
// by uiScale = clamp(workArea.height / REFERENCE_HEIGHT, SCALE_MIN, SCALE_MAX).
// Height-based so different aspect ratios at the same height get the same size.
const DESIGN_WIDTH = 384;       // = legacy 1920/5, so 1080p looks pixel-identical to before
const REFERENCE_HEIGHT = 1080;  // workArea height that maps to uiScale = 1.0
const SCALE_MIN = 0.75;
const SCALE_MAX = 1.6;
const DEFAULT_DOWNLOAD_DIR_NAME = 'YTmusic';
const DEFAULT_PLAYLIST_FOLDER = 'Queue';
const YT_WATCH_URL = (id) => `https://www.youtube.com/watch?v=${id}`;
const YT_PLAYLIST_URL = (id) => `https://www.youtube.com/playlist?list=${id}`;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let youtubeDl;
let ffmpegPath;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Transparent windows misbehave on Windows multi-monitor (disappear / teleport on
// cross-monitor drag). These mitigations help transparent-window compositing/occlusion.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let settingsPath = null;
let playlistsPath = null;
let mainWindow = null;
let mainUiScale = 1;          // logical scale (design px → DIP), re-derived per monitor
let mainWinDesignMaxH = WIN_HEIGHT_MAX; // full (tall) window height in design px
let placedCorner = 'br';      // last corner the window was placed at (tl/tr/bl/br)
const popups = {
  menu:     { win: null },
  settings: { win: null },
  playlist: { win: null },
};

// ── JSON helpers ──────────────────────────────────────────────────────────

const readJSON  = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJSON = (p, data)     => fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');

// ── Popup factory ──────────────────────────────────────────────────────────

function openPopup(ref, file, height, mw, { onLoad, onBlur, onClosed } = {}) {
  if (ref.win && !ref.win.isDestroyed()) { ref.win.close(); return; }
  const { x, y, width } = mw.getBounds(); // width is already uiScale-scaled DIP
  ref.win = new BrowserWindow({
    width, height: Math.round(height * mainUiScale), x: x - width, y,
    parent: mw, frame: false, resizable: false,
    transparent: true, backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false },
  });
  ref.win.loadFile(file);
  ref.win.webContents.once('did-finish-load', () => {
    ref.win.webContents.setVisualZoomLevelLimits(1, 1);
    ref.win.webContents.setZoomFactor(mainUiScale);
    // Apply the user's font choice to every popup for a consistent look.
    const s = readJSON(settingsPath, {});
    ref.win.webContents.send('apply-font', { fontFamily: s.fontFamily, fontScale: s.fontScale });
    onLoad?.();
  });
  if (onBlur) ref.win.on('blur', onBlur);
  ref.win.on('closed', () => { ref.win = null; onClosed?.(); });
}

function sendToPopup(ref, channel, data) {
  if (ref.win && !ref.win.isDestroyed()) ref.win.webContents.send(channel, data);
}

// ── Popup IPC ─────────────────────────────────────────────────────────────

// Wires up an `open-*-popup` handler with blur-to-close debounce. `requestState`
// is the channel the main window listens on to push fresh state once loaded.
function registerPopup(ref, { openChannel, file, height, requestState }) {
  let blurClosedAt = 0;
  ipcMain.on(openChannel, (event) => {
    const mw = BrowserWindow.fromWebContents(event.sender);
    if (Date.now() - blurClosedAt < POPUP_BLUR_DEBOUNCE_MS) return;
    openPopup(ref, path.join(__dirname, file), height, mw, {
      onLoad: () => mw.webContents.send(requestState),
      onBlur: () => {
        if (ref.win && !ref.win.isDestroyed()) {
          blurClosedAt = Date.now();
          ref.win.close();
        }
      },
    });
  });
}

registerPopup(popups.menu, {
  openChannel: 'open-menu-popup',
  file: 'renderer/popups/menu.html',
  height: POPUP_HEIGHTS.menu,
  requestState: 'send-menu-state',
});

registerPopup(popups.settings, {
  openChannel: 'open-settings-popup',
  file: 'renderer/popups/settings.html',
  height: POPUP_HEIGHTS.settings,
  requestState: 'send-settings-state',
});

registerPopup(popups.playlist, {
  openChannel: 'open-playlist-popup',
  file: 'renderer/popups/playlist.html',
  height: POPUP_HEIGHTS.playlist,
  requestState: 'send-playlist-state',
});

ipcMain.on('push-menu-state', (_, state) => sendToPopup(popups.menu, 'init-state', state));
ipcMain.on('push-settings-state', (_, settings) => sendToPopup(popups.settings, 'settings-state', settings));
ipcMain.on('push-playlist-state', (_, state) => sendToPopup(popups.playlist, 'playlist-state', state));

ipcMain.on('popup-search-request', (_, query) => {
  mainWindow?.webContents.send('popup-search-request', query);
});

ipcMain.on('popup-search-response', (_, data) => {
  if (!popups.menu.win || popups.menu.win.isDestroyed()) return;
  popups.menu.win.webContents.send(data.error ? 'search-error' : 'search-results', data);
});

ipcMain.on('popup-playlist-items-request', (_, playlistId) => {
  mainWindow?.webContents.send('popup-playlist-items-request', playlistId);
});

ipcMain.on('popup-playlist-items-response', (_, data) => {
  if (!popups.menu.win || popups.menu.win.isDestroyed()) return;
  popups.menu.win.webContents.send(data.error ? 'playlist-items-error' : 'playlist-items', data);
});

ipcMain.on('settings-saved', (_, data) => {
  mainWindow?.webContents.send('settings-saved', data);
  if (popups.settings.win && !popups.settings.win.isDestroyed()) popups.settings.win.close();
});

ipcMain.on('popup-action', (_, action) => mainWindow?.webContents.send('popup-action', action));

// ── UI scale ────────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Logical scale derived from the display's height (stable across aspect ratios).
function computeUiScale(display) {
  return clamp(display.workArea.height / REFERENCE_HEIGHT, SCALE_MIN, SCALE_MAX);
}

// Page zoom only affects rendering, not getBoundingClientRect — so the renderer
// keeps reporting design px while everything scales uniformly on screen.
function applyUiScale(win, scale) {
  mainUiScale = scale;
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.setZoomFactor(scale);
}

// ── Window sizing ───────────────────────────────────────────────────────────
// No setShape: it breaks transparent-window compositing on secondary monitors (and
// repeatedly re-applying a shape during a native drag caused the cross-monitor
// teleport). The window stays a fixed (tall) size; rounded corners come from CSS
// (#player-area border-radius + overflow). The empty transparent area above the
// player (when collapsed) is made click-through via setIgnoreMouseEvents, toggled by
// the renderer based on cursor position. This keeps the OS window size constant so
// the playlist still slides open/closed in place (smooth) on every monitor.

// ── Window IPC ────────────────────────────────────────────────────────────

// Sets the full (tall) window height. h is design px. The window keeps whichever
// edge it's docked to, so growing/shrinking (e.g. the update bar appearing) expands
// away from that edge instead of sliding the widget off it.
ipcMain.on('set-exact-height', (event, h) => {
  mainWinDesignMaxH = h;
  const win = BrowserWindow.fromWebContents(event.sender);
  const hDip = Math.round(h * mainUiScale);
  const { x, y, width, height } = win.getBounds();
  const dockedTop = placedCorner === 'tl' || placedCorner === 'tr';
  win.setBounds({ x, y: dockedTop ? y : y + (height - hDip), width, height: hDip });
});

// Renderer's hit-test toggles click-through for the transparent empty area.
ipcMain.on('set-ignore-mouse', (event, ignore) => {
  BrowserWindow.fromWebContents(event.sender)?.setIgnoreMouseEvents(ignore, { forward: true });
});

// Window placement by buttons (replaces dragging, which teleported across monitors
// on Windows). A corner places the window flush to that corner of its current display;
// a monitor switch moves it to the next display keeping the same corner. Each placement
// re-derives uiScale for the target display so the widget stays consistently sized.
function displayOfWindow(win) {
  const b = win.getBounds();
  return screen.getDisplayNearestPoint({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) });
}

function placeWindow(win, display, corner) {
  placedCorner = corner;
  const scale = computeUiScale(display);
  const { x: ax, y: ay, width: aw, height: ah } = display.workArea;
  const width  = Math.round(DESIGN_WIDTH * scale);
  const height = Math.min(Math.round(mainWinDesignMaxH * scale), ah);
  const onRight  = corner === 'tr' || corner === 'br';
  const onBottom = corner === 'bl' || corner === 'br';
  const x = onRight  ? ax + aw - width  : ax;
  const y = onBottom ? ay + ah - height : ay;
  // setBounds converts this DIP rect to physical pixels using the scale factor of
  // the display the window currently sits on — not the target's. Crossing to a
  // monitor with a different DPI therefore mis-lands (Windows clamps it into a
  // corner of the wrong screen). Nudge the window onto the target display first
  // (its centre, far from any edge so it lands there under either scale factor) so
  // the real setBounds below is evaluated with the target display's DPI.
  win.setPosition(Math.round(ax + aw / 2), Math.round(ay + ah / 2));
  applyUiScale(win, scale);
  win.setBounds({ x, y, width, height });
}

ipcMain.on('win-set-corner', (event, corner) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) placeWindow(win, displayOfWindow(win), corner);
});

ipcMain.on('win-next-monitor', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const displays = screen.getAllDisplays();
  if (displays.length < 2) return;
  const cur = displayOfWindow(win);
  const idx = displays.findIndex((d) => d.id === cur.id);
  placeWindow(win, displays[(idx + 1) % displays.length], placedCorner);
});

ipcMain.on('minimize-window', (event) => BrowserWindow.fromWebContents(event.sender).minimize());
ipcMain.on('close-window',    (event) => BrowserWindow.fromWebContents(event.sender).close());

ipcMain.handle('toggle-always-on-top', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win.setAlwaysOnTop(!win.isAlwaysOnTop());
  return win.isAlwaysOnTop();
});

ipcMain.handle('app-version',    () => app.getVersion());
ipcMain.handle('get-settings',   () => readJSON(settingsPath, {}));
ipcMain.handle('save-settings',  (_, data) => writeJSON(settingsPath, data));
ipcMain.handle('get-playlists',  () => readJSON(playlistsPath, []));
ipcMain.handle('save-playlists', (_, data) => writeJSON(playlistsPath, data));

ipcMain.handle('get-playlist-info', async (_, playlistId) => {
  const raw = await youtubeDl(YT_PLAYLIST_URL(playlistId), {
    flatPlaylist: true, dumpSingleJson: true, noWarnings: true,
  });
  const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!info.entries?.length) throw new Error('Playlist is empty or unavailable');
  return {
    title: info.title || 'Untitled Playlist',
    tracks: info.entries
      .filter(e => e.id)
      .map(e => ({
        videoId: e.id,
        title: e.title || e.id,
        channel: e.uploader || e.channel || e.uploader_id || '',
      })),
  };
});

// ── Google account: sign in and import the user's own playlists ─────────────
// Owned playlists are often private, so tracks come from the YouTube Data API
// (with the OAuth token) rather than yt-dlp.
const YT_DATA_API = 'https://www.googleapis.com/youtube/v3';

async function ytData(pathAndQuery) {
  const token = await oauth.getAccessToken();
  const res = await fetch(`${YT_DATA_API}/${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function listMyPlaylists() {
  const ch = await ytData('channels?part=snippet,contentDetails&mine=true');
  const channel = ch.items?.[0];
  const account = channel?.snippet?.title || 'YouTube';
  const likesId = channel?.contentDetails?.relatedPlaylists?.likes;
  const playlists = [];
  if (likesId) playlists.push({ id: likesId, name: '👍 Liked videos', source: 'google' });
  let pageToken = '';
  do {
    const q = `playlists?part=snippet&mine=true&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const data = await ytData(q);
    for (const it of data.items || []) {
      playlists.push({ id: it.id, name: it.snippet.title || 'Untitled', source: 'google' });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return { account, playlists };
}

async function getMyPlaylistItems(playlistId) {
  const tracks = [];
  let pageToken = '';
  do {
    const q = `playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const data = await ytData(q);
    for (const it of data.items || []) {
      const vid = it.contentDetails?.videoId;
      const sn = it.snippet || {};
      // skip removed/private entries (no playable owner)
      if (!vid || sn.title === 'Private video' || sn.title === 'Deleted video') continue;
      tracks.push({ videoId: vid, title: sn.title || vid, channel: sn.videoOwnerChannelTitle || '' });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return tracks;
}

ipcMain.handle('google-status', () => ({
  signedIn: oauth.isSignedIn(), account: oauth.getAccount(), configured: oauth.isConfigured(),
}));

ipcMain.handle('google-sign-in', async () => {
  await oauth.signIn();
  const { account, playlists } = await listMyPlaylists();
  oauth.setAccount(account);
  // Hand the imported list to the main window for merging into state.
  mainWindow?.webContents.send('google-imported', { account, playlists });
  return { account, count: playlists.length };
});

ipcMain.handle('google-sign-out', () => {
  oauth.signOut();
  mainWindow?.webContents.send('google-signed-out');
  return true;
});

ipcMain.handle('google-playlist-items', (_, playlistId) => getMyPlaylistItems(playlistId));

// ── Audio cache ───────────────────────────────────────────────────────────

const audioCache = new Map();

function getCached(videoId, quality) {
  const key = `${videoId}:${quality}`;
  const entry = audioCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) { audioCache.delete(key); return null; }
  return entry.url;
}

function setCached(videoId, quality, url) {
  let expiresAt = Date.now() + AUDIO_CACHE_TTL_MS;
  try {
    const exp = new URL(url).searchParams.get('expire');
    if (exp) expiresAt = parseInt(exp) * 1000 - AUDIO_URL_EXPIRY_MARGIN_MS;
  } catch {}
  audioCache.set(`${videoId}:${quality}`, { url, expiresAt });
}

function getMusicDir() {
  const settings = readJSON(settingsPath, {});
  const dir = settings.musicDir || path.join(app.getPath('music'), DEFAULT_DOWNLOAD_DIR_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeFolderName(name) {
  return String(name || DEFAULT_PLAYLIST_FOLDER).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || DEFAULT_PLAYLIST_FOLDER;
}

// videoId → absolute file path. Built lazily by scanning the music dir once,
// then kept warm; invalidated on download or when the music dir changes.
let localAudioIndex = null;
let localAudioIndexDir = null;

// Downloads ask for m4a but fall back to whatever `bestaudio` yields (webm/opus/…),
// so the index must recognise every container yt-dlp can leave behind — otherwise a
// perfectly good file looks missing and the track gets downloaded again and again.
const AUDIO_FILE_RE = /\[([\w-]{11})\]\.(m4a|mp4|webm|weba|opus|ogg|oga|mp3|aac|flac|mka|wav)$/i;
const AUDIO_SCAN_DEPTH = 3;

function buildLocalAudioIndex() {
  const root = getMusicDir();
  const index = new Map();
  // Files normally live one level down (one folder per playlist), but the user may
  // have reorganised them — walk a few levels so moved files stay recognised.
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth > 0) walk(path.join(dir, entry.name), depth - 1);
        continue;
      }
      const m = entry.name.match(AUDIO_FILE_RE);
      if (m && !index.has(m[1])) index.set(m[1], path.join(dir, entry.name));
    }
  };
  walk(root, AUDIO_SCAN_DEPTH);
  localAudioIndex = index;
  localAudioIndexDir = root;
  return index;
}

function getLocalAudioIndex() {
  // Rebuild if never built or the music dir changed under us.
  if (!localAudioIndex || localAudioIndexDir !== getMusicDir()) return buildLocalAudioIndex();
  return localAudioIndex;
}

const invalidateLocalAudioIndex = () => { localAudioIndex = null; };

function findLocalAudioFile(videoId) {
  return getLocalAudioIndex().get(videoId) || null;
}

// execa's own message is just the command line; yt-dlp's actual reason is the last
// "ERROR:" line on stderr. Without this the UI could only ever say "failed".
function ytDlpErrorReason(err) {
  const lines = String(err?.stderr || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const errLine = [...lines].reverse().find(l => /^ERROR:/i.test(l));
  return errLine?.replace(/^ERROR:\s*/i, '')
    || lines[lines.length - 1]
    || err?.shortMessage || err?.message || String(err);
}

// Failures are worth keeping: a toast is gone in seconds and packaged builds have no
// console. The full stderr lands in userData/download-errors.log.
function logDownloadFailure(videoId, reason, err) {
  try {
    const stderr = String(err?.stderr || '').trim();
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'download-errors.log'),
      `[${new Date().toISOString()}] ${videoId} — ${reason}\n${stderr}\n\n`,
      'utf8',
    );
  } catch {}
}

ipcMain.handle('open-download-log', () => {
  const file = path.join(app.getPath('userData'), 'download-errors.log');
  return fs.existsSync(file) ? shell.openPath(file) : null;
});

ipcMain.handle('download-track', async (_, videoId, playlistName) => {
  // The renderer also guards on its cached id set, but that cache can be stale —
  // the on-disk index is the authority, so never spawn yt-dlp for a file we have.
  const existing = findLocalAudioFile(videoId);
  if (existing) return { dir: path.dirname(existing), skipped: true };
  const root = getMusicDir();
  const sub = path.join(root, sanitizeFolderName(playlistName));
  if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true });
  try {
    await youtubeDl(YT_WATCH_URL(videoId), {
      format: 'bestaudio[ext=m4a]/bestaudio',
      output: path.join(sub, '%(title)s [%(id)s].%(ext)s'),
      embedThumbnail: true,
      ffmpegLocation: ffmpegPath,
      noPlaylist: true,
      noWarnings: true,
    });
  } catch (err) {
    const reason = ytDlpErrorReason(err);
    logDownloadFailure(videoId, reason, err);
    throw new Error(reason);
  }
  invalidateLocalAudioIndex();
  return { dir: sub };
});

ipcMain.handle('list-downloaded-ids', () => [...getLocalAudioIndex().keys()]);

ipcMain.handle('get-local-audio-path', (_, videoId) => findLocalAudioFile(videoId));

// A music folder inside OneDrive is a trap: with Files On-Demand the downloaded
// tracks become cloud-only placeholders, so every playback makes OneDrive re-fetch
// the file and pop a Windows "downloading" notification — even though the app never
// re-downloads anything. Detect it so the renderer can warn once.
function cloudSyncRootOf(dir) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const target = norm(dir);
  for (const root of [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]) {
    if (!root) continue;
    const r = norm(root);
    if (target === r || target.startsWith(r + path.sep)) return root;
  }
  return /(^|[\\/])onedrive([\s-][^\\/]*)?([\\/]|$)/i.test(dir) ? 'OneDrive' : null;
}

// Being inside OneDrive is only a problem while the files are actually dehydrated —
// "always keep on this device" makes it a non-issue. A placeholder still reports its
// logical size but has no blocks allocated, so sampling a few files tells them apart.
function hasDehydratedFiles(limit = 20) {
  let checked = 0;
  for (const file of getLocalAudioIndex().values()) {
    if (checked++ >= limit) break;
    try {
      const st = fs.statSync(file);
      if (st.size > 0 && st.blocks === 0) return true;
    } catch {}
  }
  return false;
}

ipcMain.handle('music-dir-info', () => {
  const dir = getMusicDir();
  const cloudRoot = cloudSyncRootOf(dir);
  return { dir, cloudSync: cloudRoot && hasDehydratedFiles() ? cloudRoot : null };
});

// ── Moving the music library between folders ────────────────────────────────
// Changing the download folder used to strand every previous download: the app
// only looks in the current folder, so the old files silently stopped counting as
// downloaded. Offer to bring them along.

function listFilesRecursive(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listFilesRecursive(p, out);
    else out.push(p);
  }
  return out;
}

// Depth-first so children are gone before their parent is tried; only ever removes
// directories that are already empty.
function pruneEmptyDirs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name));
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {}
}

const formatSize = (bytes) => bytes >= 1024 ** 3
  ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
  : `${Math.round(bytes / 1024 ** 2)} MB`;

ipcMain.handle('migrate-music-dir', async (_, fromDir, toDir) => {
  if (!fromDir || !toDir) return { skipped: true };
  if (path.resolve(fromDir).toLowerCase() === path.resolve(toDir).toLowerCase()) return { skipped: true };

  const files = listFilesRecursive(fromDir);
  if (!files.length) return { skipped: true, empty: true };

  let totalBytes = 0;
  for (const f of files) { try { totalBytes += fs.statSync(f).size; } catch {} }

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['옮기기', '그대로 두기'],
    defaultId: 0,
    cancelId: 1,
    title: '음악 폴더 변경',
    message: `기존 폴더에 파일 ${files.length}개 (${formatSize(totalBytes)})가 있습니다.`,
    detail: `${fromDir}\n  ↓\n${toDir}\n\n새 폴더로 옮길까요?\n옮기지 않으면 기존에 받아둔 곡은 앱에서 인식되지 않아 다시 다운로드됩니다.`,
  });
  if (response !== 0) return { moved: 0, kept: true };

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  let moved = 0, skipped = 0, failed = 0, doneBytes = 0;
  for (let i = 0; i < files.length; i++) {
    const src = files[i];
    const dest = path.join(toDir, path.relative(fromDir, src));
    let size = 0;
    try { size = fs.statSync(src).size; } catch {}
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) {
        skipped++; // never clobber a file already at the destination
      } else {
        try {
          await fs.promises.rename(src, dest);
        } catch (err) {
          // rename can't cross volumes — fall back to copy, and only then drop the original
          if (err.code !== 'EXDEV') throw err;
          await fs.promises.copyFile(src, dest);
          await fs.promises.unlink(src);
        }
        moved++;
      }
    } catch (err) {
      failed++;
      console.error('[migrate]', src, err?.message || err);
    }
    doneBytes += size;
    send('task-progress', {
      label: '음악 폴더 이동 중',
      percent: ((i + 1) / files.length) * 100,
      detail: `${i + 1} / ${files.length} · ${formatSize(doneBytes)}`,
    });
  }

  pruneEmptyDirs(fromDir);
  invalidateLocalAudioIndex();
  send('update-progress-done', {});
  return { moved, skipped, failed, total: files.length };
});

ipcMain.handle('choose-music-dir', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: getMusicDir(),
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('get-audio-url', async (_, videoId, quality) => {
  const hit = getCached(videoId, quality);
  if (hit) return hit;
  const fmt = quality === 'standard'
    ? 'bestaudio[abr<=128]/bestaudio'
    : 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best';
  const raw = await youtubeDl(YT_WATCH_URL(videoId), {
    getUrl: true, format: fmt, noPlaylist: true, noWarnings: true,
  });
  const url = raw.trim().split('\n')[0];
  setCached(videoId, quality, url);
  return url;
});

// ── Window ────────────────────────────────────────────────────────────────

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { x: wx, y: wy, width: ww, height: wh } = display.workArea;
  // Set the scale up-front so set-exact-height (which arrives shortly after load)
  // already sees the right value, even before did-finish-load re-applies the zoom.
  mainUiScale = computeUiScale(display);
  const winWidth  = Math.round(DESIGN_WIDTH * mainUiScale);
  const winHeight = Math.min(Math.round(WIN_HEIGHT_MAX * mainUiScale), wh);
  const win = new BrowserWindow({
    width: winWidth, height: winHeight,
    x: wx + ww - winWidth, y: wy + wh - winHeight,
    icon: path.join(__dirname, '../assets/icon.ico'),
    resizable: false, frame: false,
    transparent: true, backgroundColor: '#00000000',
    webPreferences: {
      webSecurity: false, nodeIntegration: true,
      contextIsolation: false, backgroundThrottling: false,
    },
  });

  win.webContents.on('did-finish-load', () => applyUiScale(win, mainUiScale));
  // Note: the window keeps its launch-monitor size when dragged to another monitor.
  // We deliberately don't resize on monitor change — calling setBounds around a
  // native drag teleports the window in this environment.

  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  mainWindow = win;
}

// ── Auto-update (GitHub releases via electron-updater) ──────────────────────
// Only runs in the packaged (NSIS) build — in dev there's no app-update.yml and
// the updater would throw. New versions are downloaded in the background; once
// ready we offer a restart, and otherwise install on the next quit.
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  // Don't download silently — on launch, tell the user a new version exists and
  // let them choose. Only download (and later restart) on their confirmation.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // Progress is mirrored in two places: an in-app bar (visible while using the
  // widget) and the taskbar button (visible once it's minimised).
  const sendToMain = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  const setTaskbarProgress = (fraction) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(fraction);
  };
  const endProgress = (payload) => {
    setTaskbarProgress(-1); // -1 clears the taskbar bar
    sendToMain('update-progress-done', payload);
  };

  autoUpdater.on('error', (err) => {
    console.error('[updater]', err?.message || err);
    endProgress({ error: err?.message || String(err) });
  });

  autoUpdater.on('download-progress', (p) => {
    sendToMain('update-progress', {
      percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond,
    });
    setTaskbarProgress(clamp((p.percent || 0) / 100, 0, 1));
  });

  autoUpdater.on('update-available', async (info) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['업데이트', '나중에'],
      defaultId: 0,
      cancelId: 1,
      title: '업데이트 있음',
      message: `새로운 업데이트가 있습니다 (v${info.version}).`,
      detail: '지금 다운로드하여 업데이트할까요?',
    });
    if (response !== 0) return;
    // Show the bar immediately — the first download-progress event can take a while.
    sendToMain('update-progress', { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    setTaskbarProgress(0);
    autoUpdater.downloadUpdate().catch((e) => {
      console.error('[updater]', e?.message || e);
      endProgress({ error: e?.message || String(e) });
    });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    endProgress({ version: info.version });
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
      title: '업데이트 준비됨',
      message: `업데이트가 다운로드됐습니다 (v${info.version}).`,
      detail: '지금 재시작하면 적용됩니다. 나중을 선택하면 다음 종료 시 자동 적용됩니다.',
    });
    if (response === 0) autoUpdater.quitAndInstall(true, true);
  });

  autoUpdater.checkForUpdates()?.catch((err) => console.error('[updater]', err?.message || err));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  settingsPath  = path.join(app.getPath('userData'), 'settings.json');
  playlistsPath = path.join(app.getPath('userData'), 'playlists.json');
  oauth.init(path.join(app.getPath('userData'), 'google-token.json'));

  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const ytDlpPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'youtube-dl-exec', 'bin', binName)
    : path.join(__dirname, '../node_modules/youtube-dl-exec/bin', binName);
  youtubeDl = createYoutubeDl(ytDlpPath);

  const ffmpegStatic = require('ffmpeg-static');
  ffmpegPath = app.isPackaged
    ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
    : ffmpegStatic;
  session.defaultSession.setUserAgent(USER_AGENT);
  createWindow();
  setupAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
