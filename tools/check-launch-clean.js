'use strict';
/**
 * End-to-end check that "opening an Android app shows only the Android app window":
 *   1) start a real ApkStart with a sandboxed APPDATA and install a test APK with `--apk` (this boots the emulator);
 *   2) then open the app with `--launch <package>`;
 *   3) enumerate visible top-level windows throughout: neither the emulator main window (Android Emulator - ...) nor the
 *      qemu / netsimd consoles may appear, and the app window must appear (proof that embed worked and the picture is inside it).
 *
 * Usage: node tools/check-launch-clean.js [apkPath]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const ROOT = path.join(__dirname, '..');
// Like the other two window tests, allows an external runtime/data directory (users often keep the runtime on D:)
const ENGINE = path.resolve(process.env.APKSTART_RUNTIME || path.join(ROOT, 'engine'));
const AVD_DIR = process.env.APKSTART_AVD_HOME || '';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const APK = process.argv[2] || path.join(os.tmpdir(), 'fdroid.apk');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

function launch(args, sandbox) {
  const env = { ...process.env, APPDATA: sandbox };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(ELECTRON, ['.', ...args], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}

(async () => {
  if (!fs.existsSync(APK)) throw new Error(`test APK not found: ${APK}`);
  const sandbox = path.join(os.tmpdir(), `apk-launch-${Date.now()}`);
  const appData = path.join(sandbox, 'apkstart');
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({
    runtime: { dir: ENGINE, avdDir: AVD_DIR }, engine: { prewarm: true },
  }));

  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ENGINE]);

  let pass = true;
  const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) pass = false; };

  // ---- 1) Install ----
  console.log('- Installing the APK (the first run cold-boots the emulator, about 40-90 seconds)...');
  let p = launch(['--apk', APK], sandbox);
  let pkg = '';
  for (let i = 0; i < 240; i += 1) {
    await sleep(1000);
    try {
      const apps = JSON.parse(fs.readFileSync(path.join(appData, 'apps.json'), 'utf8')).apps || [];
      if (apps.length && apps[0].package) { pkg = apps[0].package; break; }
    } catch (_) { /* not written yet */ }
    if (p.exitCode !== null) break;
  }
  check(!!pkg, `installation finished: ${pkg || '(timed out)'}`);
  // Wait for the first instance to **really exit** before starting the second: while the single-instance lock is held,
  // the second one exits at once, which looks like "the window never appears" rather than a launch failure (this cost hours once).
  try { p.kill(); } catch (_) { /* ignore */ }
  for (let i = 0; i < 30 && p.exitCode === null; i += 1) await sleep(500);
  await sleep(2000);

  if (!pkg) {
    agent.dispose();
    console.log('\nResult: FAILED (nothing was installed, skipping the rest)');
    process.exit(1);
  }

  // ---- 2) Open the app ----
  console.log('- Opening the app...');
  p = launch(['--launch', pkg], sandbox);
  let leaked = 0;
  let sawAppWin = false;
  const titles = new Set();
  // Cold boot 23s + app launch ~17s, so allow 120 seconds; the old 60s produced false failures on slow machines
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    const list = ((r && r.list) || []);
    for (const w of list) if (w.title) titles.add(w.title);
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] unexpected visible window:`, JSON.stringify(hit));
    }
    // App window = a titled window that is neither the emulator nor a console
    if (!sawAppWin) {
      sawAppWin = list.some((w) => {
        const t = String(w.title || '');
        return t && !bad(w) && !/ApkStart|WorkBuddy|Microsoft|Program Manager|设置|Edge|输入体验/.test(t);
      });
      if (sawAppWin) console.log(`[${((i + 1) * 0.5).toFixed(1)}s] app window appeared`);
    }
    if (sawAppWin && i > 40) break;
  }

  check(leaked === 0, `emulator/console windows never visible (${leaked} sightings)`);
  check(sawAppWin, 'app window appeared (so the picture is embedded in the window, not a standalone emulator window)');
  console.log('  Visible window titles:', JSON.stringify([...titles].slice(0, 12)));
  if (!pass) {
    console.log('--- tail of app.log ---');
    try {
      const log = fs.readFileSync(path.join(appData, 'logs', 'app.log'), 'utf8').trim().split('\n');
      console.log(log.slice(-12).join('\n'));
    } catch (_) { console.log('(no app.log)'); }
  }

  try { p.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  await sleep(1500);
  if (pass) {
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* ignore */ }
  } else {
    console.log(`  Sandbox kept at: ${sandbox}`);
  }
  console.log('');
  console.log(`Result: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
