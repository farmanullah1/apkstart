'use strict';
/**
 * End-to-end check that "opening the app shows only the app UI":
 *   1) start a real ApkStart with a sandboxed APPDATA (--smoke exits by itself after 6.5 seconds);
 *   2) place a fake app record in the sandbox to trigger "prewarm on open" -- the emulator cold-boots in the background;
 *   3) watch visible windows throughout via the window proxy: emulator main window / qemu console / netsim console must never appear;
 *   4) keep watching for 8 seconds after the app exits: no Android Emulator black window may be left on the desktop.
 *
 * Usage: node tools/check-quit-clean.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const ROOT = path.join(__dirname, '..');
// Both the runtime and the Android data directory may live on another drive (users move them), so point the env vars there
// instead of re-downloading the 1.4GB runtime or building an empty AVD on every run.
const ENGINE = path.resolve(process.env.APKSTART_RUNTIME || path.join(ROOT, 'engine'));
const AVD_DIR = process.env.APKSTART_AVD_HOME || '';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

(async () => {
  const sandbox = path.join(require('os').tmpdir(), `apk-quit-${Date.now()}`);
  const appData = path.join(sandbox, 'apkstart');
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, 'apps.json'), JSON.stringify({
    apps: [{ package: 'com.example.demo', label: 'Demo', installedAt: Date.now() }],
  }));
  fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({
    runtime: { dir: ENGINE, avdDir: AVD_DIR },
    engine: { prewarm: true },
  }));

  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ENGINE]);
  console.log('agent ready, port=', agent.port);

  // This environment sets ELECTRON_RUN_AS_NODE=1 globally (Electron degrades to plain Node),
  // so it must be removed entirely; an empty string still counts as "set" and nothing starts.
  const env = { ...process.env, APPDATA: sandbox };
  delete env.ELECTRON_RUN_AS_NODE;

  const proc = spawn(ELECTRON, ['.', '--smoke', path.join(sandbox, 'smoke.png')], {
    cwd: ROOT,
    env,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { out += c; });

  let leaked = 0;
  let exitedAt = 0;
  for (let i = 0; i < 70; i += 1) {
    await sleep(500);
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    const hit = ((r && r.list) || []).filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] unexpected visible window:`, JSON.stringify(hit));
    }
    if (!exitedAt && proc.exitCode !== null) {
      exitedAt = i;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] ApkStart exited, watching for another 8 seconds...`);
    }
    if (exitedAt && i - exitedAt >= 16) break;
  }

  const after = ((await agent.call({ cmd: 'windows' }, 5000).catch(() => null)) || {}).list || [];
  const left = after.filter(bad);
  console.log('Unexpected windows still on the desktop after exit:', JSON.stringify(left));
  console.log('');
  const ok = leaked === 0 && left.length === 0;
  console.log(`Result: ${ok ? 'PASS (no window visible at any point)' : 'FAIL'}`);
  if (out) console.log('--- app output ---\n' + out.trim().split('\n').slice(-6).join('\n'));

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  // The sandbox AVD is several GB, so clean it up afterwards (ignored when the emulator still holds those files)
  try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* ignore */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
