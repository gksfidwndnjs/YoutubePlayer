const { app, BrowserWindow, ipcMain, session, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { create: createYoutubeDl } = require('youtube-dl-exec');

let youtubeDl;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let settingsPath = null;
let playlistsPath = null;
let mainWindow = null;
let mainWinVisibleHeight = null;
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
  const { x, y, width } = mw.getBounds();
  ref.win = new BrowserWindow({
    width, height, x, y: y - height,
    parent: mw, frame: false, resizable: false,
    transparent: true, backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false },
  });
  ref.win.loadFile(file);
  if (onLoad) ref.win.webContents.once('did-finish-load', onLoad);
  if (onBlur) ref.win.on('blur', onBlur);
  ref.win.on('closed', () => { ref.win = null; onClosed?.(); });
}

function sendToPopup(ref, channel, data) {
  if (ref.win && !ref.win.isDestroyed()) ref.win.webContents.send(channel, data);
}

// ── Popup IPC ─────────────────────────────────────────────────────────────

let menuBlurClosedAt = 0;

ipcMain.on('open-menu-popup', (event) => {
  const mw = BrowserWindow.fromWebContents(event.sender);
  if (Date.now() - menuBlurClosedAt < 300) return;
  openPopup(popups.menu, path.join(__dirname, 'renderer/popups/menu.html'), 420, mw, {
    onLoad: () => mw.webContents.send('send-menu-state'),
    onBlur: () => {
      if (popups.menu.win && !popups.menu.win.isDestroyed()) {
        menuBlurClosedAt = Date.now();
        popups.menu.win.close();
      }
    },
  });
});

ipcMain.on('push-menu-state', (_, state) => sendToPopup(popups.menu, 'init-state', state));

ipcMain.on('popup-search-request', (_, query) => {
  mainWindow?.webContents.send('popup-search-request', query);
});

ipcMain.on('popup-search-response', (_, data) => {
  if (!popups.menu.win || popups.menu.win.isDestroyed()) return;
  popups.menu.win.webContents.send(data.error ? 'search-error' : 'search-results', data.results);
});

let settingsBlurClosedAt = 0;

ipcMain.on('open-settings-popup', (event) => {
  const mw = BrowserWindow.fromWebContents(event.sender);
  if (Date.now() - settingsBlurClosedAt < 300) return;
  openPopup(popups.settings, path.join(__dirname, 'renderer/popups/settings.html'), 380, mw, {
    onLoad: () => mw.webContents.send('send-settings-state'),
    onBlur: () => {
      if (popups.settings.win && !popups.settings.win.isDestroyed()) {
        settingsBlurClosedAt = Date.now();
        popups.settings.win.close();
      }
    },
  });
});

ipcMain.on('push-settings-state', (_, settings) => sendToPopup(popups.settings, 'settings-state', settings));

ipcMain.on('settings-saved', (_, data) => {
  mainWindow?.webContents.send('settings-saved', data);
  if (popups.settings.win && !popups.settings.win.isDestroyed()) popups.settings.win.close();
});

let playlistBlurClosedAt = 0;

ipcMain.on('open-playlist-popup', (event) => {
  const mw = BrowserWindow.fromWebContents(event.sender);
  if (Date.now() - playlistBlurClosedAt < 300) return;
  openPopup(popups.playlist, path.join(__dirname, 'renderer/popups/playlist.html'), 280, mw, {
    onLoad:   () => mw.webContents.send('send-playlist-state'),
    onBlur:   () => {
      if (popups.playlist.win && !popups.playlist.win.isDestroyed()) {
        playlistBlurClosedAt = Date.now();
        popups.playlist.win.close();
      }
    },
  });
});

ipcMain.on('push-playlist-state', (_, state) => sendToPopup(popups.playlist, 'playlist-state', state));

ipcMain.on('popup-action', (_, action) => mainWindow?.webContents.send('popup-action', action));

// ── Window shape ──────────────────────────────────────────────────────────

function getWinScaleFactor(win) {
  const { x, y, width, height } = win.getBounds();
  const center = { x: x + Math.round(width / 2), y: y + Math.round(height / 2) };
  return screen.getDisplayNearestPoint(center).scaleFactor || 1;
}

function setWinShape(win, w, h) {
  const sf = getWinScaleFactor(win);
  win.setShape(roundedRectShape(Math.round(w * sf), Math.round(h * sf), Math.round(18 * sf)));
}

function applyCurrentShape(win) {
  const { width, height } = win.getBounds();
  const visH = mainWinVisibleHeight ?? height;
  const sf = getWinScaleFactor(win);
  if (visH < height) {
    const offsetY = Math.round((height - visH) * sf);
    win.setShape(
      roundedRectShape(Math.round(width * sf), Math.round(visH * sf), Math.round(18 * sf))
        .map(r => ({ ...r, y: r.y + offsetY }))
    );
  } else {
    setWinShape(win, width, height);
  }
}

function roundedRectShape(width, height, radius) {
  const rects = [];
  for (let y = 0; y < radius; y++) {
    const dx = Math.round(radius - Math.sqrt(radius * radius - (radius - y) * (radius - y)));
    rects.push({ x: dx, y, width: width - 2 * dx, height: 1 });
  }
  rects.push({ x: 0, y: radius, width, height: height - 2 * radius });
  for (let y = height - radius; y < height; y++) {
    const dy = y - (height - radius);
    const dx = Math.round(radius - Math.sqrt(radius * radius - dy * dy));
    rects.push({ x: dx, y, width: width - 2 * dx, height: 1 });
  }
  return rects;
}

// ── Window IPC ────────────────────────────────────────────────────────────

ipcMain.on('set-exact-height', (event, h) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { x, y, width, height } = win.getBounds();
  win.setBounds({ x, y: y + (height - h), width, height: h });
  setWinShape(win, width, h);
});

ipcMain.on('update-shape', (event, { visibleHeight }) => {
  mainWinVisibleHeight = visibleHeight;
  const win = BrowserWindow.fromWebContents(event.sender);
  const { width, height } = win.getBounds();
  const sf = getWinScaleFactor(win);
  const offsetY = Math.round((height - visibleHeight) * sf);
  const scaledW = Math.round(width * sf);
  const scaledH = Math.round(visibleHeight * sf);
  const radius = Math.round(18 * sf);
  win.setShape(
    roundedRectShape(scaledW, scaledH, radius).map(r => ({ ...r, y: r.y + offsetY }))
  );
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
  const raw = await youtubeDl(`https://www.youtube.com/playlist?list=${playlistId}`, {
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
  let expiresAt = Date.now() + 5 * 60 * 60 * 1000;
  try {
    const exp = new URL(url).searchParams.get('expire');
    if (exp) expiresAt = parseInt(exp) * 1000 - 5 * 60 * 1000;
  } catch {}
  audioCache.set(`${videoId}:${quality}`, { url, expiresAt });
}

ipcMain.handle('get-audio-url', async (_, videoId, quality) => {
  const hit = getCached(videoId, quality);
  if (hit) return hit;
  const fmt = quality === 'standard'
    ? 'bestaudio[abr<=128]/bestaudio'
    : 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best';
  const raw = await youtubeDl(`https://www.youtube.com/watch?v=${videoId}`, {
    getUrl: true, format: fmt, noPlaylist: true, noWarnings: true,
  });
  const url = raw.trim().split('\n')[0];
  setCached(videoId, quality, url);
  return url;
});

// ── Window ────────────────────────────────────────────────────────────────

function createWindow() {
  const { x: wx, y: wy, width: ww, height: wh } = screen.getPrimaryDisplay().workArea;
  const winWidth  = Math.round(ww / 5);
  const winHeight = Math.min(480, wh);
  const win = new BrowserWindow({
    width: winWidth, height: winHeight,
    x: wx + ww - winWidth, y: wy + wh - winHeight,
    resizable: false, frame: false,
    transparent: true, backgroundColor: '#00000000',
    webPreferences: {
      webSecurity: false, nodeIntegration: true,
      contextIsolation: false, backgroundThrottling: false,
    },
  });

  setWinShape(win, winWidth, winHeight);

  let moveTimer = null;
  win.on('moved', () => {
    // 즉시 shape 갱신 (DPI 클리핑 방지) — 현재 visible 높이 기준으로 적용
    applyCurrentShape(win);
    // 드래그 완료 후 새 모니터 기준으로 크기 재조정
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const fb = win.getBounds();
      const center = { x: fb.x + Math.round(fb.width / 2), y: fb.y + Math.round(fb.height / 2) };
      const display = screen.getDisplayNearestPoint(center);
      const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
      const newW = Math.round(dw / 5);
      const newH = fb.height; // 높이는 현재값 유지
      const newX = Math.max(dx, Math.min(fb.x, dx + dw - newW));
      const newY = Math.max(dy, Math.min(fb.y, dy + dh - newH));
      if (newW !== fb.width || newX !== fb.x || newY !== fb.y) {
        win.setBounds({ x: newX, y: newY, width: newW, height: newH });
        applyCurrentShape(win);
      }
    }, 300);
  });

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
  session.defaultSession.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
