'use strict';
const { ipcRenderer } = require('electron');
const { applyMetalTexture } = require('../texture');
document.addEventListener('DOMContentLoaded', () => applyMetalTexture([document.getElementById('popup-frame')]));

ipcRenderer.on('settings-state', (_, settings) => {
  el('settings-api-key').value = settings.apiKey || '';
  el('settings-api-key').type = 'password';
  el('settings-key-toggle').textContent = 'Show';
  const qEl = document.querySelector(`input[name="audio-quality"][value="${settings.audioQuality || 'best'}"]`);
  if (qEl) qEl.checked = true;
  el('settings-autoadvance').checked = settings.autoAdvance !== false;
  el('settings-music-dir').value = settings.musicDir || '';
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
  ipcRenderer.send('settings-saved', { apiKey, audioQuality, autoAdvance, musicDir });
});

el('cancel-btn').addEventListener('click', () => window.close());
el('close-btn').addEventListener('click', () => window.close());

el('settings-api-key').addEventListener('keydown', e => { if (e.key === 'Escape') window.close(); });

function el(id) { return document.getElementById(id); }
