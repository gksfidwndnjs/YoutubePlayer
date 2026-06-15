const { app, BrowserWindow, ipcMain, session, screen, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { create: createYoutubeDl } = require('youtube-dl-exec');

// ── Constants ─────────────────────────────────────────────────────────────

// All popup/window dimensions below are in DESIGN px — multiplied by uiScale at use.
const POPUP_HEIGHTS = { menu: 420, settings: 380, playlist: 280 };
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
  popups.menu.win.webContents.send(data.error ? 'search-error' : 'search-results', data.results);
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

// Sets the full (tall) window height once on load. h is design px, bottom-anchored.
ipcMain.on('set-exact-height', (event, h) => {
  mainWinDesignMaxH = h;
  const win = BrowserWindow.fromWebContents(event.sender);
  const hDip = Math.round(h * mainUiScale);
  const { x, y, width, height } = win.getBounds();
  win.setBounds({ x, y: y + (height - hDip), width, height: hDip });
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
  applyUiScale(win, scale);
  const { x: ax, y: ay, width: aw, height: ah } = display.workArea;
  const width  = Math.round(DESIGN_WIDTH * scale);
  const height = Math.min(Math.round(mainWinDesignMaxH * scale), ah);
  const onRight  = corner === 'tr' || corner === 'br';
  const onBottom = corner === 'bl' || corner === 'br';
  win.setBounds({
    x: onRight  ? ax + aw - width  : ax,
    y: onBottom ? ay + ah - height : ay,
    width, height,
  });
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

function buildLocalAudioIndex() {
  const root = getMusicDir();
  const index = new Map();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(root, entry.name);
    for (const name of fs.readdirSync(sub)) {
      const m = name.match(/\[([\w-]{11})\]\.m4a$/);
      if (m) index.set(m[1], path.join(sub, name));
    }
  }
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

ipcMain.handle('download-track', async (_, videoId, playlistName) => {
  const root = getMusicDir();
  const sub = path.join(root, sanitizeFolderName(playlistName));
  if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true });
  await youtubeDl(YT_WATCH_URL(videoId), {
    format: 'bestaudio[ext=m4a]/bestaudio',
    output: path.join(sub, '%(title)s [%(id)s].%(ext)s'),
    embedThumbnail: true,
    ffmpegLocation: ffmpegPath,
    noPlaylist: true,
    noWarnings: true,
  });
  invalidateLocalAudioIndex();
  return { dir: sub };
});

ipcMain.handle('list-downloaded-ids', () => [...getLocalAudioIndex().keys()]);

ipcMain.handle('get-local-audio-path', (_, videoId) => findLocalAudioFile(videoId));

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

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  settingsPath  = path.join(app.getPath('userData'), 'settings.json');
  playlistsPath = path.join(app.getPath('userData'), 'playlists.json');

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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
