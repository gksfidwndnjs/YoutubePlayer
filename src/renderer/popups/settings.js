'use strict';
const { ipcRenderer } = require('electron');
const { applyMetalTexture, applyFont } = require('../texture');
document.addEventListener('DOMContentLoaded', () => applyMetalTexture([document.getElementById('popup-frame')]));

ipcRenderer.on('apply-font', (_, f) => applyFont(f));

// Read the current UI-page form values.
function currentFont() {
  return {
    fontFamily: (document.querySelector('input[name="font-family"]:checked') || {}).value || 'pixel',
    fontScale: parseFloat((document.querySelector('input[name="font-size"]:checked') || {}).value) || 1,
    crtGlow: el('settings-crt-glow').checked,
  };
}

// Live-preview font / 8-bit / glow in this window.
function previewFont() { applyFont(currentFont()); }

// ── Category tabs ─────────────────────────────────────────────────────────────
document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const page = tab.dataset.page;
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.settings-page').forEach(p => p.classList.toggle('active', p.dataset.page === page));
  });
});

ipcRenderer.on('settings-state', (_, settings) => {
  el('settings-api-key').value = settings.apiKey || '';
  el('settings-api-key').type = 'password';
  el('settings-key-toggle').textContent = 'Show';
  const qEl = document.querySelector(`input[name="audio-quality"][value="${settings.audioQuality || 'best'}"]`);
  if (qEl) qEl.checked = true;
  el('settings-autoadvance').checked = settings.autoAdvance !== false;
  el('settings-music-dir').value = settings.musicDir || '';

  const fam = settings.fontFamily || 'pixel';
  const famEl = document.querySelector(`input[name="font-family"][value="${fam}"]`);
  if (famEl) famEl.checked = true;
  const size = String(settings.fontScale ?? 1);
  const sizeEl = document.querySelector(`input[name="font-size"][value="${size}"]`);
  if (sizeEl) sizeEl.checked = true;
  el('settings-crt-glow').checked = settings.crtGlow !== false;
  previewFont();

  refreshGoogleStatus();
});

// Live-preview UI changes (font / size / glow / 8-bit) in this window.
['font-family', 'font-size'].forEach(name =>
  document.querySelectorAll(`input[name="${name}"]`).forEach(r =>
    r.addEventListener('change', previewFont)));
el('settings-crt-glow').addEventListener('change', previewFont);

// ── Google account ──────────────────────────────────────────────────────────
async function refreshGoogleStatus() {
  const { signedIn, account, configured } = await ipcRenderer.invoke('google-status');
  const btn = el('settings-google-btn');
  if (!configured) {
    el('settings-gstatus').textContent = '이 빌드에 Google 로그인이 설정되지 않음';
    btn.textContent = 'Google로 로그인';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  el('settings-gstatus').textContent = signedIn ? `로그인됨: ${account || 'YouTube'}` : '로그인 안 됨';
  btn.textContent = signedIn ? '로그아웃' : 'Google로 로그인';
}

el('settings-google-btn').addEventListener('click', async () => {
  const btn = el('settings-google-btn');
  const { signedIn } = await ipcRenderer.invoke('google-status');
  if (signedIn) {
    await ipcRenderer.invoke('google-sign-out');
    await refreshGoogleStatus();
    return;
  }
  btn.disabled = true;
  el('settings-gstatus').textContent = '브라우저에서 로그인 중…';
  try {
    const { account, count } = await ipcRenderer.invoke('google-sign-in');
    el('settings-gstatus').textContent = `로그인됨: ${account} · 재생목록 ${count}개`;
    btn.textContent = '로그아웃';
  } catch (e) {
    el('settings-gstatus').textContent = '로그인 실패: ' + (e.message || e);
  } finally {
    btn.disabled = false;
  }
});

el('settings-browse-dir').addEventListener('click', async () => {
  const dir = await ipcRenderer.invoke('choose-music-dir');
  if (dir) el('settings-music-dir').value = dir;
});

el('settings-key-toggle').addEventListener('click', () => {
  const input = el('settings-api-key');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  el('settings-key-toggle').textContent = show ? 'Hide' : 'Show';
});

el('save-btn').addEventListener('click', () => {
  const apiKey = el('settings-api-key').value.trim();
  const audioQuality = (document.querySelector('input[name="audio-quality"]:checked') || {}).value || 'best';
  const autoAdvance = el('settings-autoadvance').checked;
  const musicDir = el('settings-music-dir').value.trim();
  const fontFamily = (document.querySelector('input[name="font-family"]:checked') || {}).value || 'pixel';
  const fontScale = parseFloat((document.querySelector('input[name="font-size"]:checked') || {}).value) || 1;
  const crtGlow = el('settings-crt-glow').checked;
  ipcRenderer.send('settings-saved', { apiKey, audioQuality, autoAdvance, musicDir, fontFamily, fontScale, crtGlow });
});

el('cancel-btn').addEventListener('click', () => window.close());
el('close-btn').addEventListener('click', () => window.close());

el('settings-api-key').addEventListener('keydown', e => { if (e.key === 'Escape') window.close(); });

function el(id) { return document.getElementById(id); }
