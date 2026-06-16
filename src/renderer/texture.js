'use strict';
const path = require('path');

function applyMetalTexture(targets) {
  try {
    const fs = require('fs');
    const metalPath = path.join(__dirname, '../../assets', 'metal.png');
    const data = fs.readFileSync(metalPath);
    const blob = new Blob([data], { type: 'image/png' });
    const objectUrl = URL.createObjectURL(blob);
    const testImg = new Image();
    testImg.onload = () => {
      (targets || [document.body]).forEach(el => {
        if (!el) return;
        el.style.setProperty('background-image', `url('${objectUrl}')`, 'important');
        el.style.setProperty('background-size', '512px 512px', 'important');
        el.style.setProperty('background-repeat', 'repeat', 'important');
      });
    };
    testImg.src = objectUrl;
  } catch {}
}

// Keep FONT_STACKS in sync with app.js / settings.js.
const FONT_STACKS = {
  pixel:  "'RetroPixel', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif",
  gothic: "'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif",
  sans:   "system-ui, 'Segoe UI', 'Malgun Gothic', 'Noto Sans KR', sans-serif",
  mono:   "'Consolas', 'D2Coding', 'Courier New', monospace",
  serif:  "'Georgia', 'Batang', 'Noto Serif KR', serif",
};

function applyFont({ fontFamily, fontScale, crtGlow } = {}) {
  const stack = FONT_STACKS[fontFamily] || FONT_STACKS.pixel;
  const root = document.documentElement;
  root.style.setProperty('--app-font', stack);
  root.style.setProperty('--ui-scale', String(Number(fontScale) || 1));
  root.classList.toggle('glow-off', crtGlow === false);
}

module.exports = { applyMetalTexture, applyFont, FONT_STACKS };
