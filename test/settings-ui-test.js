'use strict';
/**
 * Settings page UI smoke test (needs a real Electron window)
 *
 * Run: electron test/settings-ui-test.js
 * Output: test/out/settings-*.png
 *
 * Why written separately: the settings page structure just had a big change (added category nav
 * and search); plain Node unit tests can only assert source structure, not "clickable and displayed
 * correctly". Here we run a real renderer process: open settings, switch categories, search, screenshot.
 */

const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const UI = path.join(__dirname, '..', 'src', 'ui');

const SETTINGS = {
  adbPath: '',
  runtime: { isoPath: '', sourcePreference: 'auto', autoMirror: true, giteeToken: '', mirrorPrefix: '', downloadConnections: 8 },
  engine: {
    memoryMB: 4096, cores: 4, idleShutdownMinutes: 15, audio: true, liteMode: true,
    prewarm: true, priorityMode: 'balanced', deepTrim: false, mouseRightBack: true,
    mouseWheelMode: 'smooth', mouseSideButtons: false, keymapEnabled: true,
    resourceMode: 'balanced', renderSize: 'auto', dataPartitionGB: 6, fastDns: true,
    locale: 'zh-CN', chineseIme: true, keepSnapshot: true, logLimitKB: 2048,
  },
  display: {
    mode: 'window', portrait: '900x1600', autoFullscreenOnLaunch: false, landscape: false,
    orientationMode: 'auto', autoRotate: true, tabletMode: true, windowEmbed: true,
  },
  createShortcutOnInstall: true,
  createStartMenuShortcut: true,
  shortcutDir: '',
  sharedDir: path.join(process.env.USERPROFILE || '', 'ApkStartShared'),
  deviceSharedDir: '/sdcard/ApkStartShared',
  autoStart: true,
  notifyOnInstall: true,
  debug: { auto: true, intervalMin: 10, notify: true },
};

// These diagnostic-issue fixture strings are the text that the settings UI smoke test feeds into
// the renderer. They are intentionally left in the fixture's current language here because this
// smoke test is verifying the existing UI copy, not rewriting product copy; changing these would
// change what the test screenshot/check asserts against.
const DEBUG_ISSUES = [
  { code: 'device.unauthorized', category: 'device', severity: 'error', title: 'Android device not authorized for debugging', hint: 'A confirmation dialog will reappear after restarting the runtime.', fix: 'restartRuntime', detail: '' },
  { code: 'storage.diskLow', category: 'storage', severity: 'warn', title: 'Runtime disk space is tight', hint: 'Less than 8 GB remaining.', fix: 'disk', detail: '5120 MB left' },
  { code: 'settings.orientationConflict', category: 'settings', severity: 'warn', title: 'Screen orientation policy conflicts with current panel orientation', hint: 'Set the panel orientation to match the policy.', fix: 'orientation', detail: '' },
];

const OVERRIDES = {
  'settings:get': () => SETTINGS,
  'settings:set': () => SETTINGS,
  'app:info': () => ({ version: '0.6.0', isDev: true, dataDir: 'C:\\data', runtimeDir: 'C:\\data\\runtime' }),
  'apps:list': () => ({ apps: [] }),
  'assoc:status': () => ({ registered: false }),
  'doctor:profile': () => ({ profile: {}, text: 'Balanced · 4 cores / 4 GB / 720p' }),
  'doctor:selfCheck': () => ({ issues: [], accel: { ok: true }, free: 102400 }),
  'doctor:report': () => ({ ok: true, file: 'C:\\report.txt' }),
  'runtime:usage': () => ({ totalText: '8.2 GB', reclaimableText: '1.1 GB', count: 3 }),
  'runtime:status': () => ({ mode: 'builtin', backend: 'builtin', backendLabel: 'Builtin runtime', installed: true, vmRunning: false, deviceOnline: false, ready: false, phase: 'idle', needsSetup: null, error: '', env: { adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } }, accel: { ok: true }, network: null }),
  'runtime:dataInfo': () => ({ avdDir: 'C:\\data\\avd', configuredGB: 6, actualGB: 6 }),
  'android:status': () => ({ running: false, wifi: true, airplane: false, anim: true, volume: 50, font: 1, density: 320 }),
  'drivers:list': () => ({ drivers: [], errors: [] }),
  'preflight:run': () => ({ items: [] }),
  'autodebug:state': () => ({ issues: DEBUG_ISSUES, summary: { total: 3, errors: 1, warns: 2, infos: 0, health: 'error', byCategory: [] }, at: Date.now(), running: false }),
  'autodebug:run': () => ({ issues: DEBUG_ISSUES, summary: { total: 3, errors: 1, warns: 2, infos: 0, health: 'error', byCategory: [] }, at: Date.now(), running: false }),
  'autodebug:config': () => SETTINGS.debug,
  'app:startupInfo': () => ({ firstRun: false, tips: [] }),
  'app:updateCheck': () => ({ ok: true, current: '0.6.0', hasUpdate: false, sources: [] }),
  'runtime:log': () => [],
  'leftovers:scan': () => ({ items: [] }),
  'engine:resources': () => ({ memory: {}, cores: {} }),
  'display:state': () => ({ mode: 'window' }),
  'keymap:getPresets': () => ({ presets: [] }),
  'keymap:isEnabled': () => ({ enabled: true }),
};

// Remaining channels uniformly return empty object: all calls in app.js have .catch / empty-value fallback
const CHANNELS = [
  'apk:pick', 'apk:parse', 'apk:install', 'apk:reveal', 'dialog:openDir',
  'settings:restoreSystem', 'settings:refreshPointer', 'settings:unhook', 'settings:setSharedDir',
  'runtime:probe', 'runtime:start', 'runtime:stop', 'runtime:vcRedist', 'runtime:installVcRedist',
  'runtime:cleanup', 'runtime:resetData', 'runtime:repairNetwork', 'runtime:checkNetwork',
  'runtime:setDataSize', 'runtime:resetAndResize', 'runtime:autoDeploy', 'runtime:startInstaller',
  'runtime:markInstalled', 'runtime:resetInstall', 'app:confirm', 'display:set', 'display:toggle',
  'shortcut:rebuild', 'preflight:apply', 'drivers:import', 'drivers:openFolder',
  'drivers:exportTemplate', 'drivers:setEnabled', 'app:clearLocks', 'app:removeSelf',
  'app:clearOrphans', 'app:clearSnapshot', 'runtime:restart', 'assoc:register', 'assoc:unregister',
  'share:sync', 'share:open', 'shell:open', 'window:minimize', 'window:maximize', 'window:close',
  'window:hide', 'app:foreground', 'app:updateApply', 'app:updateCancel', 'app:updateOpen',
  'app:restart', 'app:pin', 'app:setOrientation', 'app:launch', 'app:stop', 'app:uninstall',
  'app:createShortcut', 'app:clearData', 'app:revealApk', 'android:set', 'android:open',
  'android:tune', 'android:permissions', 'android:grantAll', 'keymap:getMap', 'keymap:setMap',
  'keymap:setEnabled', 'keymap:applyPreset', 'leftovers:clean', 'provision:check',
  'provision:probeSources', 'provision:installAdb', 'provision:installQemu', 'provision:installEmulator',
  'provision:installSysimg', 'provision:installPlayImage', 'provision:installAehd',
  'provision:enableAccel', 'provision:enableVirtualization', 'provision:openWindowsFeatures',
  'provision:downloadIso', 'provision:createDisk', 'provision:importIso', 'provision:importDisk',
];

let passed = 0;
let failed = 0;
function step(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  OK ${name}${detail ? ` ${detail}` : ''}`); } else { failed++; console.error(`  FAIL ${name}${detail ? ` ${detail}` : ''}`); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  for (const ch of CHANNELS) ipcMain.handle(ch, async () => ({}));
  for (const [ch, fn] of Object.entries(OVERRIDES)) ipcMain.handle(ch, async (_e, ...args) => fn(...args));

  const win = new BrowserWindow({
    width: 1180, height: 860, show: false,
    backgroundColor: '#f4f7f5',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);   // 2=warning, 3=error
  });
  await win.loadFile(path.join(UI, 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const evalJs = (code) => win.webContents.executeJavaScript(code, true);

  console.log('\n[settings page · category nav]');
  // First open the settings popup (auto-detection results are fetched when settings opens and rendered)
  await evalJs(`document.getElementById('btnSettings').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const modalOpen = await evalJs(`document.getElementById('settingsMask').classList.contains('on')`);
  step('settings popup can open', modalOpen);

  const navInfo = await evalJs(`(() => ({
    items: document.querySelectorAll('#setNav .set-nav-item').length,
    cats: Array.from(document.querySelectorAll('#setNav .set-nav-item')).map(b => b.dataset.cat),
    groups: document.querySelectorAll('#settingsBody [data-cat]').length,
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
  }))()`);
  step('nav items rendered', navInfo.items === 8, `${navInfo.items} items`);
  // Note: categories are remembered (localStorage), so only assert "at the same moment only one
  // category's groups are shown"
  const oneCat = navInfo.visible.length > 0 && navInfo.visible.every((c) => c === navInfo.visible[0]);
  step('at the same moment only one category groups are shown', oneCat, `default visible: ${navInfo.visible.join(',')}`);

  // Tap Display & Window
  await evalJs(`document.querySelector('#setNav .set-nav-item[data-cat="display"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const afterSwitch = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
    on: document.querySelector('#setNav .set-nav-item.on') ? document.querySelector('#setNav .set-nav-item.on').dataset.cat : '',
  }))()`);
  step('after switching to Display & Window only that category is shown', afterSwitch.visible.length > 0 && afterSwitch.visible.every((c) => c === 'display'), `visible: ${afterSwitch.visible.join(',')}`);
  step('nav highlight follows the switch', afterSwitch.on === 'display', `highlighted: ${afterSwitch.on}`);

  await win.capturePage().then((img) => fs.writeFileSync(path.join(OUT, 'settings-display.png'), img.toPNG()));

  // Tap Diagnostics & Repair, look at auto-detection panel
  await evalJs(`document.querySelector('#setNav .set-nav-item[data-cat="diag"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const diag = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
    items: document.querySelectorAll('#autodebugList .dbg-item').length,
    groups: document.querySelectorAll('#autodebugList .dbg-group').length,
    text: (document.getElementById('autodebugStateText') || {}).textContent || '',
    fixBtns: document.querySelectorAll('#autodebugList .dbg-fix').length,
  }))()`);
  step('Diagnostics & Repair can see system checkup, drivers, and auto-detection', diag.visible.includes('diag') && diag.visible.length === 3, `visible: ${diag.visible.join(',')}`);
  step('auto-detection results rendered grouped by category', diag.groups >= 3 && diag.items === 3, `${diag.groups} groups / ${diag.items} items`);
  step('each problem has a Fix button', diag.fixBtns === 3, `${diag.fixBtns} buttons`);
  step('status line shows last detection time', /Last detection/.test(diag.text), diag.text);

  // Scroll to auto-detection panel then screenshot (wait for compositor to catch up, avoid shooting previous frame)
  await evalJs(`document.getElementById('autodebugGroup').scrollIntoView({ block: 'start' })`);
  await new Promise((r) => setTimeout(r, 900));
  await win.capturePage().then((img) => fs.writeFileSync(path.join(OUT, 'settings-diag.png'), img.toPNG()));

  console.log('\n[settings page · search]');
  await evalJs(`(() => { const s = document.getElementById('setSearch'); s.value = 'landscape'; s.dispatchEvent(new Event('input')); })()`);
  await new Promise((r) => setTimeout(r, 300));
  const search = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).length,
    names: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => (g.querySelector('.group-title')||{}).textContent),
    clearVisible: !document.getElementById('btnClearSearch').hidden,
  }))()`);
  step('search landscape can match groups', search.visible >= 1, `matched ${search.visible}: ${search.names.join(' / ')}`);
  step('matched items visible cross-category (not blocked by current category)', search.visible >= 1);
  step('clear button appears', search.clearVisible);

  await win.capturePage().then((img) => fs.writeFileSync(path.join(OUT, 'settings-search.png'), img.toPNG()));

  await evalJs(`document.getElementById('btnClearSearch').click()`);
  await new Promise((r) => setTimeout(r, 250));
  const afterClear = await evalJs(`(() => Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat))()`);
  step('after clearing search returns to current category', afterClear.length > 0 && afterClear.every((c) => c === 'diag'), `visible: ${afterClear.join(',')}`);

  console.log('\n[settings page · remembered category]');
  const remembered = await evalJs(`localStorage.getItem('apkstart.settings.cat')`);
  step('last-stayed category was remembered', remembered === 'diag', `remembered: ${remembered}`);

  console.log('\n[settings page · no render exceptions]');
  const realErrors = errors.filter((e) => !/Autofill|devtools|Request Autofill/i.test(e));
  step('console has no errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
