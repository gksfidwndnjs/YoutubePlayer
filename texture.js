'use strict';
const path = require('path');

function applyMetalTexture(targets) {
  try {
    const fs = require('fs');
    const metalPath = path.join(__dirname, 'assets', 'metal.png');
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

module.exports = { applyMetalTexture };
