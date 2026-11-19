'use strict';
/**
 * Logo rendering: offscreen-render build/logo.html with Electron -> multi-size PNG + ICO
 *   node_modules/electron/dist/electron.exe build/render-logo.js
 * Output: src/ui/assets/logo.png (512, for the UI/window icon)
 *         build/appicon.ico (16-256 multi-size, for .apk association and shortcuts)
 *         docs/images/logo.png (for the README)
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pngToIco } = require('../src/core/shortcut');

const ROOT = path.join(__dirname, '..');
const SIZE = 1024;

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.setContentSize(SIZE, SIZE);
  await win.loadFile(path.join(__dirname, 'logo.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const img = await win.webContents.capturePage();
  const full = img.toPNG();
  const base = require('electron').nativeImage.createFromBuffer(full);
  console.log('captured', base.getSize());

  const save = (size, file) => {
    const buf = size === SIZE ? full : base.resize({ width: size, height: size, quality: 'best' }).toPNG();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    console.log(' ->', path.relative(ROOT, file), size + 'px', Math.round(buf.length / 1024) + 'KB');
    return buf;
  };

  save(1024, path.join(ROOT, 'docs', 'images', 'logo.png'));
  save(512, path.join(ROOT, 'src', 'ui', 'assets', 'logo.png'));
  save(128, path.join(ROOT, 'src', 'ui', 'assets', 'logo-128.png'));

  const ico = pngToIco(full);
  fs.writeFileSync(path.join(ROOT, 'src', 'ui', 'assets', 'appicon.ico'), ico);
  console.log(' -> src/ui/assets/appicon.ico', Math.round(ico.length / 1024) + 'KB');

  app.exit(0);
});
